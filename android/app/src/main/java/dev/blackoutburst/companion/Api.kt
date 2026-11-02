package dev.blackoutburst.companion

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

@Serializable data class Profile(val name: String, val character: String, val color: String, val timezone: String, val outfit: String = "auto")
@Serializable data class Runtime(val state: String, val provider: String? = null)
@Serializable data class CompanionInfo(val profile: Profile? = null, val runtime: Runtime, val wearing: String = "base")
@Serializable data class SavedProfile(val profile: Profile, val wearing: String = "base")
@Serializable data class MemoryItem(val id: String, val text: String)
@Serializable data class MemorySection(val title: String, val items: List<MemoryItem>)
@Serializable data class MemoryFile(val file: String, val sections: List<MemorySection>)
@Serializable data class Memories(val files: List<MemoryFile>)
@Serializable data class ChatThread(val id: String, val title: String)
@Serializable data class Message(val id: String, val threadId: String, val role: String, val text: String, val requestId: String? = null, val feeling: String? = null)
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
    val signedOut get() = status == 401 || code == "AUTHENTICATION_REQUIRED" || code == "INVITATION_REQUIRED"
}

/**
 * JSON over HTTPS to blackoutburst.com. Requests carry the app session as the platform cookie and
 * the site origin, which is what the companion service and the platform accept.
 */
class Api(private val session: () -> Session?) {
    val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
    private val companion = BuildConfig.SITE + BuildConfig.COMPANION_PATH

    suspend fun companionInfo(): CompanionInfo = call("api/companion", buildJsonObject { put("action", "get") })
    suspend fun setProfile(profile: Profile): SavedProfile = json.decodeFromJsonElement(
        post(companion + "api/companion", buildJsonObject {
            put("action", "setProfile")
            put("profile", json.encodeToJsonElement(Profile.serializer(), profile))
        }))
    suspend fun memories(): Memories = call("api/companion", buildJsonObject { put("action", "memory") })
    suspend fun forget(file: String, id: String): Memories = call("api/companion", buildJsonObject {
        put("action", "forget"); put("file", file); put("id", id)
    })

    suspend fun discord(): DiscordStatus = call<DiscordReply>("api/companion", buildJsonObject { put("action", "discord") }).discord
    suspend fun discordLink(token: String): DiscordStatus =
        call<DiscordReply>("api/companion", buildJsonObject { put("action", "discordLink"); put("token", token) }).discord
    suspend fun discordUnlink(): DiscordStatus = call<DiscordReply>("api/companion", buildJsonObject { put("action", "discordUnlink") }).discord

    suspend fun snapshot(threadId: String? = null): Snapshot = call("api/conversation", buildJsonObject {
        put("action", "snapshot"); threadId?.let { put("threadId", it) }
    })
    suspend fun createThread(requestId: String, title: String): ChatThread = json.decodeFromJsonElement(
        post(companion + "api/conversation", buildJsonObject {
            put("action", "createThread"); put("requestId", requestId); put("title", title)
        }).jsonObject.getValue("thread"))
    suspend fun submit(requestId: String, threadId: String, text: String): String =
        post(companion + "api/conversation", buildJsonObject {
            put("action", "submit"); put("requestId", requestId); put("threadId", threadId); put("text", text)
        }).jsonObject.getValue("accepted").jsonObject.getValue("messageId").jsonPrimitive.content
    suspend fun events(threadId: String, cursor: String): EventPage = call("api/conversation", buildJsonObject {
        put("action", "events"); put("threadId", threadId); put("cursor", cursor)
    })
    suspend fun cancel(requestId: String, threadId: String) {
        post(companion + "api/conversation", buildJsonObject {
            put("action", "cancel"); put("requestId", requestId); put("threadId", threadId)
        })
    }

    /** Exchanges the one-time code from the account page for the app's own session. */
    suspend fun exchange(code: String, verifier: String): AppSession = json.decodeFromJsonElement(
        post(BuildConfig.SITE + "/api/account/app/session", buildJsonObject {
            put("app", SignIn.APP); put("code", code); put("verifier", verifier)
        }, authenticated = false))

    /** Ends the session on the server too. Failures are ignored: the app forgets it either way. */
    suspend fun signOut() {
        runCatching { post(BuildConfig.SITE + "/api/account/logout", JsonObject(emptyMap())) }
    }

    private suspend inline fun <reified T> call(path: String, body: JsonObject): T =
        json.decodeFromJsonElement(post(companion + path, body))

    private suspend fun post(url: String, body: JsonObject, authenticated: Boolean = true): JsonElement =
        withContext(Dispatchers.IO) {
            val connection = try { URL(url).openConnection() as HttpURLConnection } catch (_: Exception) { throw ApiException("NETWORK") }
            try {
                connection.requestMethod = "POST"
                connection.connectTimeout = 15_000
                connection.readTimeout = 30_000
                connection.instanceFollowRedirects = false
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.setRequestProperty("Accept", "application/json")
                connection.setRequestProperty("Origin", BuildConfig.SITE)
                if (authenticated) session()?.let { connection.setRequestProperty("Cookie", "${it.cookie}=${it.token}") }
                val status = try {
                    connection.outputStream.use { it.write(body.toString().toByteArray()) }
                    connection.responseCode
                } catch (_: IOException) { throw ApiException("NETWORK") }
                val stream = if (status in 200..299) connection.inputStream else connection.errorStream
                val text = stream?.use { input -> input.readNBytes(LIMIT + 1).also { if (it.size > LIMIT) throw ApiException("TOO_LARGE", status) } }
                    ?.toString(Charsets.UTF_8).orEmpty()
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

    // The companion answers {error:{code}}, the platform {error:"code"}.
    private fun errorCode(body: JsonElement?): String? {
        val error = (body as? JsonObject)?.get("error") ?: return null
        if (error is JsonPrimitive) return error.contentOrNull
        return ((error as? JsonObject)?.get("code") as? JsonPrimitive)?.contentOrNull
    }

    private companion object { const val LIMIT = 16 * 1024 * 1024 }
}
