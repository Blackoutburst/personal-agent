package dev.blackoutburst.companion

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

@Serializable data class Profile(val name: String, val character: String, val color: String, val timezone: String, val outfit: String = "auto")
@Serializable data class Runtime(val state: String, val provider: String? = null)
@Serializable data class CompanionInfo(val profile: Profile? = null, val runtime: Runtime, val wearing: String = "base")
@Serializable data class SavedProfile(val profile: Profile, val wearing: String = "base")
@Serializable data class WeatherNow(val code: Int, val temperature: Double, val wind: Double, val day: Boolean = true, val summary: String)
/** The owner's city for local weather (src/weather.mjs); wearing is only sent back after a change. */
@Serializable data class WeatherSnapshot(val place: String? = null, val current: WeatherNow? = null, val wearing: String? = null)
@Serializable data class ChatThread(val id: String, val title: String)
@Serializable data class Message(val id: String, val threadId: String, val role: String, val text: String, val requestId: String? = null,
    val feeling: String? = null, val attachments: List<Attachment> = emptyList(), val peer: PeerMessage? = null)
@Serializable data class TurnError(val code: String, val message: String, val resetsAt: String? = null)
@Serializable data class Turn(val requestId: String, val state: String, val error: TurnError? = null)
@Serializable data class Snapshot(
    val threads: List<ChatThread>, val threadId: String? = null, val messages: List<Message>,
    val cursor: String, val runtime: Runtime, val turn: Turn? = null,
)
@Serializable data class Event(
    val seq: Long, val threadId: String, val type: String, val message: Message? = null,
    val requestId: String? = null, val state: String? = null, val error: TurnError? = null,
)
@Serializable data class EventPage(val threadId: String, val events: List<Event>, val cursor: String, val lastSeq: Long, val hasMore: Boolean)
@Serializable data class AppSession(val token: String, val cookie: String, val expiresAt: Long, val user: AppUser? = null)
@Serializable data class AppUser(val username: String? = null)
@Serializable data class DiscordBot(val name: String, val inviteUrl: String)
@Serializable data class DiscordPairing(val code: String, val expiresAt: Long)
@Serializable data class DiscordUser(val name: String)
/** The owner's Discord bot link (docs/DISCORD.md). The token never comes back from the server. */
@Serializable data class DiscordStatus(
    val linked: Boolean, val state: String? = null, val problem: String? = null, val bot: DiscordBot? = null,
    val pairing: DiscordPairing? = null, val user: DiscordUser? = null,
)
@Serializable data class DiscordReply(val discord: DiscordStatus)

/** code: the server's error code (e.g. AUTHENTICATION_REQUIRED), or NETWORK when nothing came back. */
class ApiException(val code: String, val status: Int = 0) : IOException(code) {
    val signedOut get() = status == 401 || status == 403 || code == "AUTHENTICATION_REQUIRED" || code == "INVITATION_REQUIRED"
}

/**
 * JSON over HTTPS to blackoutburst.com. Requests carry the app session as the platform cookie and
 * the site origin, which is what the companion service and the platform accept.
 */
class Api(private val open: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection }, private val session: () -> Session?) {
    val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
    private val fileJson = Json { explicitNulls = false }
    private val companion = BuildConfig.SITE + BuildConfig.COMPANION_PATH
    private val transfers = FileTransfers(session, open)

    suspend fun companionInfo(): CompanionInfo = call("api/companion", buildJsonObject { put("action", "get") })
    suspend fun weather(): WeatherSnapshot = call("api/companion", buildJsonObject { put("action", "weather") })
    suspend fun setWeatherPlace(place: String): WeatherSnapshot =
        call("api/companion", buildJsonObject { put("action", "setWeatherPlace"); put("place", place.trim().take(100)) })
    suspend fun contacts(): ContactReply = parseContacts(post(companion + "api/companion", buildJsonObject { put("action", "contacts") }))
    suspend fun setContact(id: String, enabled: Boolean, expectedRevision: Long): ContactReply {
        if (!contactId(id) || !contactRevision(expectedRevision)) throw ApiException("INVALID_REQUEST")
        val result = parseContacts(post(companion + "api/companion", buildJsonObject {
            put("action", "setContact"); put("id", id); put("enabled", enabled); put("expectedRevision", expectedRevision)
        }))
        val selected = result.contacts.firstOrNull { it.id == id }
        if (selected == null || selected.enabled != enabled || selected.revision < expectedRevision) throw ApiException("INVALID_RESPONSE")
        return result
    }
    suspend fun setProfile(profile: Profile): SavedProfile = decode(
        post(companion + "api/companion", buildJsonObject {
            put("action", "setProfile")
            put("profile", json.encodeToJsonElement(Profile.serializer(), profile))
        }))
    suspend fun memories(): Memories = parseMemories(post(companion + "api/companion", buildJsonObject { put("action", "memory") }))
    suspend fun editMemory(file: String, id: String, text: String, expectedRevision: String): Memories {
        checkMemoryChange(file, id, expectedRevision)
        if (!validCorrection(text)) throw ApiException("INVALID_REQUEST")
        return parseMemories(post(companion + "api/companion", buildJsonObject {
            put("action", "editMemory"); put("file", file); put("id", id); put("text", text); put("expectedRevision", expectedRevision)
        }), "changed")
    }
    suspend fun forget(file: String, id: String, expectedRevision: String): Memories {
        checkMemoryChange(file, id, expectedRevision)
        return parseMemories(post(companion + "api/companion", buildJsonObject {
            put("action", "forget"); put("file", file); put("id", id); put("expectedRevision", expectedRevision)
        }), "removed")
    }
    suspend fun forgetAllMemory(expectedRevision: String): Memories {
        if (!memoryRevision(expectedRevision)) throw ApiException("INVALID_REQUEST")
        return parseMemories(post(companion + "api/companion", buildJsonObject {
            put("action", "forgetAll"); put("expectedRevision", expectedRevision); put("confirm", true)
        }), "cleared")
    }
    suspend fun exportMemory(): MemoryExport = parseMemoryExport(post(companion + "api/companion", buildJsonObject { put("action", "exportMemory") }))
    suspend fun personality(): Personality = parsePersonality(post(companion + "api/companion", buildJsonObject { put("action", "personality") }))
    suspend fun personalityVersion(revision: String): PersonalityVersion {
        if (!memoryRevision(revision)) throw ApiException("INVALID_REQUEST")
        return parsePersonalityVersion(post(companion + "api/companion", buildJsonObject {
            put("action", "personalityVersion"); put("revision", revision)
        }), revision)
    }
    suspend fun editPersonality(content: String, expectedRevision: String): Personality {
        if (!validPersonalityContent(content) || !memoryRevision(expectedRevision)) throw ApiException("INVALID_REQUEST")
        return parsePersonality(post(companion + "api/companion", buildJsonObject {
            put("action", "editPersonality"); put("content", content); put("expectedRevision", expectedRevision)
        }), mutation = true)
    }
    suspend fun restorePersonality(revision: String, expectedRevision: String): Personality {
        if (!memoryRevision(revision) || !memoryRevision(expectedRevision)) throw ApiException("INVALID_REQUEST")
        return parsePersonality(post(companion + "api/companion", buildJsonObject {
            put("action", "restorePersonality"); put("revision", revision); put("expectedRevision", expectedRevision); put("confirm", true)
        }), mutation = true)
    }
    private fun checkMemoryChange(file: String, id: String, revision: String) {
        if (!writableMemory(file) || !memoryItemId(id) || !memoryRevision(revision)) throw ApiException("INVALID_REQUEST")
    }

    suspend fun discord(): DiscordStatus = call<DiscordReply>("api/companion", buildJsonObject { put("action", "discord") }).discord
    suspend fun discordLink(token: String): DiscordStatus =
        call<DiscordReply>("api/companion", buildJsonObject { put("action", "discordLink"); put("token", token) }).discord
    suspend fun discordUnlink(): DiscordStatus = call<DiscordReply>("api/companion", buildJsonObject { put("action", "discordUnlink") }).discord

    suspend fun snapshot(threadId: String? = null): Snapshot {
        val raw = post(companion + "api/conversation", buildJsonObject {
            put("action", "snapshot"); threadId?.let { put("threadId", it) }
        })
        val result = decode<Snapshot>(raw)
        validateMessages(raw.jsonObject["messages"])
        return checkedSnapshot(result, threadId)
    }
    suspend fun createThread(requestId: String, title: String): ChatThread {
        val raw = post(companion + "api/conversation", buildJsonObject {
            put("action", "createThread"); put("requestId", requestId); put("title", title)
        })
        return verified { decode(raw.jsonObject.getValue("thread")) }
    }
    suspend fun submit(requestId: String, threadId: String, text: String, attachments: List<String> = emptyList()): String {
        checkedFileIds(attachments)
        if (!requestKey(requestId) || !fileId(threadId) || !validText(text, 8000, 32768) || text.isBlank() && attachments.isEmpty()) throw ApiException("INVALID_REQUEST")
        val raw = post(companion + "api/conversation", buildJsonObject {
            put("action", "submit"); put("requestId", requestId); put("threadId", threadId); put("text", text)
            if (attachments.isNotEmpty()) put("attachments", buildJsonArray { attachments.forEach { add(it) } })
        })
        return verified {
            val accepted = raw.jsonObject.getValue("accepted").jsonObject
            val id = accepted.getValue("messageId").jsonPrimitive.content
            if (accepted["requestId"]?.jsonPrimitive?.content != requestId || accepted["threadId"]?.jsonPrimitive?.content != threadId || !fileId(id)) throw ApiException("INVALID_RESPONSE")
            id
        }
    }
    suspend fun events(threadId: String, cursor: String): EventPage {
        val raw = post(companion + "api/conversation", buildJsonObject {
            put("action", "events"); put("threadId", threadId); put("cursor", cursor)
        })
        val result = decode<EventPage>(raw)
        (raw.jsonObject["events"] as? JsonArray)?.forEach { event -> event.jsonObject["message"]?.let { validateMessages(JsonArray(listOf(it))) } }
        return checkedEventPage(result, threadId, cursor)
    }
    suspend fun deleteThread(threadId: String, requestId: String) {
        if (!fileId(threadId) || !requestKey(requestId)) throw ApiException("INVALID_REQUEST")
        val raw = post(companion + "api/conversation", buildJsonObject {
            put("action", "deleteThread"); put("threadId", threadId); put("requestId", requestId)
        })
        verified {
            val result = raw.jsonObject
            if (result.keys != setOf("version", "synthetic", "deletedThreadId", "requestId") ||
                result["version"].toString() != "1" || result["synthetic"].toString() != "false" ||
                result["deletedThreadId"]?.jsonPrimitive?.content != threadId || result["requestId"]?.jsonPrimitive?.content != requestId) throw ApiException("INVALID_RESPONSE")
        }
    }
    suspend fun upload(threadId: String, key: String, name: String, source: java.io.File,
        cancel: TransferCancellation, progress: (Long) -> Unit): Attachment = transfers.upload(threadId, key, name, source, cancel, progress)
    suspend fun download(file: Attachment, destination: java.io.File, cancel: TransferCancellation,
        progress: (Long) -> Unit = {}): java.io.File = transfers.download(file, destination, cancel, progress)
    suspend fun removeFile(id: String) {
        if (!fileId(id)) throw ApiException("INVALID_REQUEST")
        val raw = post(companion + "api/files/remove", buildJsonObject { put("id", id) })
        verified { if (raw.jsonObject["removed"].toString() != "true") throw ApiException("INVALID_RESPONSE") }
    }
    private fun validateMessages(value: JsonElement?) = verified {
        val messages = value as? JsonArray ?: throw ApiException("INVALID_RESPONSE")
        messages.forEach { message ->
            if (message.jsonObject["role"]?.jsonPrimitive?.content == "peer") {
                checkedPeerEnvelope(message)
                return@forEach
            }
            if (message.jsonObject.containsKey("peer")) throw ApiException("INVALID_RESPONSE")
            val files = message.jsonObject["attachments"] ?: return@forEach
            val decoded = try { fileJson.decodeFromJsonElement<List<Attachment>>(files) } catch (_: Exception) { throw ApiException("INVALID_RESPONSE") }
            checkedFiles(decoded)
            val direction = if (message.jsonObject["role"]?.jsonPrimitive?.content == "user") "user" else "companion"
            if (decoded.any { it.direction != direction }) throw ApiException("INVALID_RESPONSE")
        }
    }
    suspend fun cancel(requestId: String, threadId: String) {
        post(companion + "api/conversation", buildJsonObject {
            put("action", "cancel"); put("requestId", requestId); put("threadId", threadId)
        })
    }

    /** Exchanges the one-time code from the account page for the app's own session. */
    suspend fun exchange(code: String, verifier: String): AppSession = decode(
        post(BuildConfig.SITE + "/api/account/app/session", buildJsonObject {
            put("app", SignIn.APP); put("code", code); put("verifier", verifier)
        }, authenticated = false))

    /** Ends the session on the server too. Failures are ignored: the app forgets it either way. */
    suspend fun signOut() {
        runCatching { post(BuildConfig.SITE + "/api/account/logout", JsonObject(emptyMap())) }
    }

    private suspend inline fun <reified T> call(path: String, body: JsonObject): T =
        decode(post(companion + path, body))

    private inline fun <reified T> decode(value: JsonElement): T = try { json.decodeFromJsonElement(value) }
        catch (_: Exception) { throw ApiException("INVALID_RESPONSE") }
    private inline fun <T> verified(block: () -> T): T = try { block() }
        catch (error: ApiException) { throw error }
        catch (_: Exception) { throw ApiException("INVALID_RESPONSE") }

    private suspend fun post(url: String, body: JsonObject, authenticated: Boolean = true): JsonElement {
        val owner = if (authenticated) session()?.takeUnless { it.expired } ?: throw ApiException("AUTHENTICATION_REQUIRED", 401) else null
        return withContext(Dispatchers.IO) {
            val connection = try { open(URL(url)) } catch (_: Exception) { throw ApiException("NETWORK") }
            try {
                connection.requestMethod = "POST"
                connection.connectTimeout = 15_000
                connection.readTimeout = 30_000
                connection.instanceFollowRedirects = false
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.setRequestProperty("Accept", "application/json")
                connection.setRequestProperty("Origin", BuildConfig.SITE)
                owner?.let { connection.setRequestProperty("Cookie", "${it.cookie}=${it.token}") }
                val status = try {
                    connection.outputStream.use { it.write(body.toString().toByteArray()) }
                    connection.responseCode
                } catch (_: IOException) { throw ApiException("NETWORK") }
                val stream = if (status in 200..299) connection.inputStream else connection.errorStream
                val bytes = stream?.use { input -> input.readNBytes(LIMIT + 1).also { if (it.size > LIMIT) throw ApiException("TOO_LARGE", status) } } ?: ByteArray(0)
                val text = verified { Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString() }
                val parsed = runCatching { json.parseToJsonElement(text) }.getOrNull()
                if (status !in 200..299) throw ApiException(errorCode(parsed) ?: "HTTP_$status", status)
                parsed ?: throw ApiException("INVALID_RESPONSE", status)
            } catch (error: ApiException) {
                throw error
            } catch (_: Exception) {
                throw ApiException("NETWORK")
            } finally {
                connection.disconnect()
            }
        }
    }

    // The companion answers {error:{code}}, the platform {error:"code"}.
    private fun errorCode(body: JsonElement?): String? {
        val error = (body as? JsonObject)?.get("error") ?: return null
        if (error is JsonPrimitive) return error.contentOrNull
        return ((error as? JsonObject)?.get("code") as? JsonPrimitive)?.contentOrNull
    }

    private companion object { const val LIMIT = 16 * 1024 * 1024 }
}
