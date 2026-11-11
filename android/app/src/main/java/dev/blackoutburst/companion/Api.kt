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
import kotlinx.serialization.json.JsonNull
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
    val feeling: String? = null, val attachments: List<Attachment> = emptyList(), val peer: PeerMessage? = null,
    /** #61b: an "app" activity line's Board link and its quote of the companion's Board post (untrusted, plain text). */
    val url: String? = null, val preview: String? = null)
@Serializable data class TurnError(val code: String, val message: String, val resetsAt: String? = null)
@Serializable data class Turn(val requestId: String, val state: String, val error: TurnError? = null)
@Serializable data class Snapshot(
    val threads: List<ChatThread>, val threadId: String? = null, val messages: List<Message>,
    val cursor: String, val runtime: Runtime, val turn: Turn? = null,
    /** Set when this is an archived (read-only) chat. */
    val archivedAt: Long? = null,
)
@Serializable data class ArchivedThread(val id: String, val title: String, val startedAt: Long, val archivedAt: Long, val messages: Int)
@Serializable data class ArchivedThreads(val threads: List<ArchivedThread>)
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
/** Me › Connectors (#43): every link the companion has. state: connected, pending, error, not_connected, paused, unavailable. */
@Serializable data class Connector(val id: String, val name: String, val purpose: String, val state: String, val detail: String? = null,
    val actions: List<String> = emptyList())
@Serializable data class ConnectorList(val connectors: List<Connector>)
/** Reminders, release and topic watches and the schedule settings (src/scheduler.mjs, api/schedules). */
@Serializable data class Reminder(val id: String, val text: String, val dueAt: String, val state: String, val canCancel: Boolean = false)
@Serializable data class Routine(val enabled: Boolean, val localTime: String, val weekday: Int? = null)
/** boardWakeCap (#51): a number, JSON null for "no limit", or absent on an older server (then the empty object below). */
@Serializable data class ScheduleSettings(val heartbeatEnabled: Boolean, val quietStart: String, val quietEnd: String,
    val dailyDigest: Routine? = null, val weeklyCheckin: Routine? = null, val boardWakeCap: JsonElement = BOARD_CAP_ABSENT,
    val proactive: Proactive? = null) {
    val boardCapOffered: Boolean get() = boardWakeCap !is JsonObject
    val boardCapLimit: Int? get() = (boardWakeCap as? JsonPrimitive)?.takeUnless { it is kotlinx.serialization.json.JsonNull }?.content?.toIntOrNull()
}
val BOARD_CAP_ABSENT = JsonObject(emptyMap())
/** #54: the companion's own wakes (perDay 1 to 1440); null on an older server, which then hides the setting. */
@Serializable data class Proactive(val enabled: Boolean, val perDay: Int)
/** #54: own wakes per day, any whole number the owner types (server accepts 1 to 1440). */
const val PROACTIVE_MAX_PER_DAY = 1440
/** A follow-up the companion scheduled for itself (#54); shown read-only with a cancel button. */
@Serializable data class Followup(val id: String, val note: String, val dueAt: String, val state: String = "active", val canCancel: Boolean = true)
const val BOARD_CAP_DEFAULT = 200
@Serializable data class Digest(val at: String, val evidence: String, val urls: List<String> = emptyList())
@Serializable data class Watch(
    val id: String, val version: Long, val kind: String, val condition: String, val state: String,
    val nextCheckAt: String? = null, val lastCheckAt: String? = null, val lastResult: String? = null,
    val urls: List<String> = emptyList(), val evidence: String? = null, val consecutiveStale: Int = 0,
    val deliveryPending: Boolean = false, val intervalHours: Int? = null, val digests: List<Digest> = emptyList(),
) { val topic get() = kind == "topic_watch" }
@Serializable data class Schedules(val timezone: String, val settings: ScheduleSettings, val items: List<Reminder> = emptyList(),
    val releaseWatches: List<Watch> = emptyList(), val followups: List<Followup> = emptyList())

/** Calendar (#44, src/calendar.mjs). start is the owner's local time: "YYYY-MM-DDTHH:MM", or "YYYY-MM-DD" all day. */
@Serializable data class CalEvent(val id: String, val version: Long, val title: String, val allDay: Boolean, val start: String,
    val end: String? = null, val location: String? = null, val notes: String? = null, val yearly: Boolean = false, val repeat: String = if (yearly) "yearly" else "none", val reminderMinutes: Int? = null)
@Serializable data class CalOccurrence(val eventId: String? = null, val holiday: Boolean = false, val title: String, val date: String,
    val allDay: Boolean, val start: String, val end: String? = null, val location: String? = null, val yearly: Boolean = false,
    val repeat: String = if (yearly) "yearly" else "none", val reminderMinutes: Int? = null)
@Serializable data class CalendarView(val timezone: String, val today: String, val from: String, val days: Int, val holidaysFr: Boolean = false,
    val occurrences: List<CalOccurrence> = emptyList(), val events: List<CalEvent> = emptyList(), val total: Int = 0)
@Serializable data class CalEventReply(val event: CalEvent)
data class EventDraft(val title: String, val allDay: Boolean, val start: String, val end: String?, val location: String?,
    val notes: String?, val repeat: String, val reminderMinutes: Int?)

/** Only plain http(s) links without credentials are ever shown as tappable sources. */
fun safeLink(url: String): Boolean = url.length <= 2048 && runCatching {
    val parsed = java.net.URI(url)
    (parsed.scheme == "https" || parsed.scheme == "http") && parsed.host != null && parsed.rawUserInfo == null
}.getOrDefault(false)

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
    suspend fun ownerProfile(): OwnerProfileReply = parseOwnerProfile(post(companion + "api/owner-profile", buildJsonObject { put("action", "get") }))
    suspend fun saveOwnerProfile(displayName: String, expectedRevision: Long, photo: OwnerPhoto?, changePhoto: Boolean): OwnerProfileReply {
        if (!ownerDisplayName(displayName) || !contactRevision(expectedRevision)) throw ApiException("INVALID_REQUEST")
        if (changePhoto) photo?.let { ownerPhotoBytes(it) }
        val result = parseOwnerProfile(post(companion + "api/owner-profile", buildJsonObject {
            put("action", "set"); put("displayName", displayName); put("expectedRevision", expectedRevision)
            if (changePhoto) put("photo", photo?.let { buildJsonObject { put("mime", it.mime); put("base64", it.base64) } } ?: JsonNull)
        }))
        if (result.profile.revision != expectedRevision + 1 || result.profile.displayName != displayName) throw ApiException("INVALID_RESPONSE")
        return result
    }
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

    suspend fun connectors(): List<Connector> = call<ConnectorList>("api/companion", buildJsonObject { put("action", "connectors") }).connectors
    suspend fun setConnector(id: String, enabled: Boolean): List<Connector> =
        call<ConnectorList>("api/companion", buildJsonObject { put("action", "setConnector"); put("id", id); put("enabled", enabled) }).connectors
    /** GitHub (#45): this owner's own fine-grained token. The reply is the Connectors list; the token never comes back. */
    suspend fun githubLink(token: String): List<Connector> =
        call<ConnectorList>("api/companion", buildJsonObject { put("action", "githubLink"); put("token", token) }).connectors
    suspend fun githubUnlink(): List<Connector> = call<ConnectorList>("api/companion", buildJsonObject { put("action", "githubUnlink") }).connectors
    suspend fun xKeyLink(token: String): List<Connector> =
        call<ConnectorList>("api/companion", buildJsonObject { put("action", "xKeyLink"); put("token", token) }).connectors
    suspend fun xKeyUnlink(): List<Connector> = call<ConnectorList>("api/companion", buildJsonObject { put("action", "xKeyUnlink") }).connectors
    suspend fun discord(): DiscordStatus = call<DiscordReply>("api/companion", buildJsonObject { put("action", "discord") }).discord
    suspend fun discordLink(token: String): DiscordStatus =
        call<DiscordReply>("api/companion", buildJsonObject { put("action", "discordLink"); put("token", token) }).discord
    suspend fun discordUnlink(): DiscordStatus = call<DiscordReply>("api/companion", buildJsonObject { put("action", "discordUnlink") }).discord
    /** Android push (docs/PUSH.md): this install's FCM token, bound by the server to the signed-in owner. */
    suspend fun schedules(): Schedules = scheduleCall(buildJsonObject { put("action", "list") })
    suspend fun cancelReminder(id: String): Schedules =
        scheduleCall(buildJsonObject { put("action", "cancel"); put("input", buildJsonObject { put("id", id) }) })
    /** operation: pause, resume, cancel or edit (with condition and/or intervalHours). Reuse requestId on an exact retry. */
    suspend fun updateWatch(requestId: String, watch: Watch, operation: String, condition: String? = null, intervalHours: Int? = null): Schedules =
        scheduleCall(buildJsonObject { put("action", "updateWatch"); put("input", buildJsonObject {
            put("requestId", requestId); put("id", watch.id); put("expectedVersion", watch.version); put("operation", operation)
            condition?.let { put("condition", it) }; intervalHours?.let { put("intervalHours", it) }
        }) })
    suspend fun cancelFollowup(id: String): Schedules =
        scheduleCall(buildJsonObject { put("action", "cancelFollowup"); put("input", buildJsonObject { put("id", id) }) })
    suspend fun configureSchedules(input: JsonObject): Schedules =
        scheduleCall(buildJsonObject { put("action", "configure"); put("input", input) })
    suspend fun calendar(from: String?, days: Int): CalendarView = call("api/schedules", buildJsonObject {
        put("action", "calendar"); put("input", buildJsonObject { from?.let { put("from", it) }; put("days", days) })
    })
    suspend fun createEvent(requestId: String, draft: EventDraft): CalEvent = call<CalEventReply>("api/schedules", buildJsonObject {
        put("action", "createEvent"); put("input", buildJsonObject { put("requestId", requestId); put("event", eventJson(draft)) })
    }).event
    suspend fun updateEvent(event: CalEvent, draft: EventDraft): CalEvent = call<CalEventReply>("api/schedules", buildJsonObject {
        put("action", "updateEvent"); put("input", buildJsonObject { put("id", event.id); put("expectedVersion", event.version); put("event", eventJson(draft)) })
    }).event
    suspend fun deleteEvent(id: String) { post(companion + "api/schedules", buildJsonObject { put("action", "deleteEvent"); put("input", buildJsonObject { put("id", id) }) }) }
    suspend fun calendarSettings(holidaysFr: Boolean) {
        post(companion + "api/schedules", buildJsonObject { put("action", "calendarSettings"); put("input", buildJsonObject { put("holidaysFr", holidaysFr) }) })
    }
    private fun eventJson(draft: EventDraft) = buildJsonObject {
        put("title", draft.title); put("allDay", draft.allDay); put("start", draft.start); draft.end?.let { put("end", it) }
        draft.location?.let { put("location", it) }; draft.notes?.let { put("notes", it) }; put("repeat", draft.repeat)
        draft.reminderMinutes?.let { put("reminderMinutes", it) }
    }
    private suspend fun scheduleCall(body: JsonObject): Schedules {
        val raw = post(companion + "api/schedules", body)
        return verified {
            val value = decode<Schedules>(raw)
            if (value.releaseWatches.size > 20 || value.items.size > 500 || value.followups.size > 50) throw ApiException("INVALID_RESPONSE")
            value.copy(releaseWatches = value.releaseWatches.map { watch ->
                watch.copy(urls = watch.urls.filter(::safeLink), digests = watch.digests.map { it.copy(urls = it.urls.filter(::safeLink)) })
            })
        }
    }
    suspend fun pushRegister(token: String) { post(companion + "api/companion", buildJsonObject { put("action", "pushRegister"); put("token", token) }) }
    suspend fun pushUnregister(token: String) { post(companion + "api/companion", buildJsonObject { put("action", "pushUnregister"); put("token", token) }) }
    /** #59: this app is in active use (foreground, touched recently), with the conversation on screen, or no longer is. */
    suspend fun clientActive(client: String, active: Boolean, threadId: String?) {
        post(companion + "api/companion", buildJsonObject {
            put("action", "clientActive"); put("client", client); put("active", active); threadId?.let { put("threadId", it) }
        })
    }

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
    /** "New chat": archives the chat and returns the id of the fresh ongoing chat. */
    suspend fun archiveThread(threadId: String, requestId: String): String {
        if (!fileId(threadId) || !requestKey(requestId)) throw ApiException("INVALID_REQUEST")
        val raw = post(companion + "api/conversation", buildJsonObject {
            put("action", "archiveThread"); put("threadId", threadId); put("requestId", requestId)
        })
        return verified {
            val result = raw.jsonObject
            val fresh = result["threadId"]?.jsonPrimitive?.content
            if (result.keys != setOf("version", "synthetic", "archivedThreadId", "threadId", "requestId") ||
                result["version"].toString() != "1" || result["synthetic"].toString() != "false" ||
                result["archivedThreadId"]?.jsonPrimitive?.content != threadId || result["requestId"]?.jsonPrimitive?.content != requestId ||
                fresh == null || !fileId(fresh)) throw ApiException("INVALID_RESPONSE")
            fresh
        }
    }
    suspend fun archivedThreads(): List<ArchivedThread> {
        val raw = post(companion + "api/conversation", buildJsonObject { put("action", "archivedThreads") })
        return verified {
            val list = decode<ArchivedThreads>(raw).threads
            if (list.size > 200 || list.any { !fileId(it.id) || it.title.isBlank() || it.title.length > 80 || it.messages < 0 }) throw ApiException("INVALID_RESPONSE")
            list
        }
    }
    /** Board tab (#55): the Board sub-conversations (open or archived), with unread counts. An older server answers 400. */
    suspend fun boardInbox(archived: Boolean = false): BoardInbox = parseBoardInbox(post(companion + "api/conversation", buildJsonObject {
        put("action", "boardInbox"); if (archived) put("archived", true)
    }))
    suspend fun boardRead(threadId: String): BoardChange {
        if (!fileId(threadId)) throw ApiException("INVALID_REQUEST")
        return parseBoardChange(post(companion + "api/conversation", buildJsonObject { put("action", "boardRead"); put("threadId", threadId) }), threadId)
    }
    suspend fun boardArchive(threadId: String, archived: Boolean): BoardChange {
        if (!fileId(threadId)) throw ApiException("INVALID_REQUEST")
        return parseBoardChange(post(companion + "api/conversation", buildJsonObject {
            put("action", "boardArchive"); put("threadId", threadId); put("archived", archived)
        }), threadId)
    }
    /** Ops tab (#75): C-chan's agents, read-only (POST api/studio). 403 or 404 on a server or member without Ops. */
    suspend fun ops(): OpsSnapshot = parseOps(post(companion + "api/studio", buildJsonObject { put("action", "ops") }))
    suspend fun opsMessages(ticketId: String): OpsHistory {
        if (!Regex("[A-Za-z0-9_-]{1,100}").matches(ticketId)) throw ApiException("INVALID_REQUEST")
        return parseOpsHistory(post(companion + "api/studio", buildJsonObject { put("action", "opsMessages"); put("ticketId", ticketId) }))
    }
    // ---- Group chat (#53, src/group-chat.mjs): POST api/groups. An older server answers 404 (the tab then stays hidden). ----
    private suspend fun group(body: JsonObject): JsonElement = post(companion + "api/groups", body)
    private fun checkGroupId(groupId: String) { if (!fileId(groupId)) throw ApiException("INVALID_REQUEST") }
    suspend fun groups(): GroupList = parseGroupList(group(buildJsonObject { put("action", "list") }))
    suspend fun createGroup(requestId: String, members: List<String>, name: String?): GroupSnapshot {
        if (!requestKey(requestId) || members.isEmpty() || members.size > 16 || members.any { !groupLabel(it) } || name?.let(::groupNameOk) == false)
            throw ApiException("INVALID_REQUEST")
        return parseGroupSnapshot(group(buildJsonObject {
            put("action", "create"); put("requestId", requestId)
            put("members", buildJsonArray { members.forEach { add(it) } }); name?.let { put("name", it.trim()) }
        }))
    }
    suspend fun groupSnapshot(groupId: String): GroupSnapshot {
        checkGroupId(groupId)
        return parseGroupSnapshot(group(buildJsonObject { put("action", "snapshot"); put("groupId", groupId) }), groupId)
    }
    suspend fun groupEvents(groupId: String, cursor: String): GroupEvents {
        checkGroupId(groupId); if (groupCursorOf(cursor) == null) throw ApiException("INVALID_REQUEST")
        return parseGroupEvents(group(buildJsonObject { put("action", "events"); put("groupId", groupId); put("cursor", cursor) }), groupId, cursor)
    }
    suspend fun groupPost(groupId: String, requestId: String, text: String, replyTo: String?, attachments: List<String>): GroupPosted {
        checkGroupId(groupId); checkedFileIds(attachments)
        if (!requestKey(requestId) || !validText(text, GROUP_TEXT_CHARS, 32768) || text.isBlank() && attachments.isEmpty() ||
            replyTo?.let(::fileId) == false) throw ApiException("INVALID_REQUEST")
        return parseGroupPosted(group(buildJsonObject {
            put("action", "post"); put("groupId", groupId); put("requestId", requestId); put("text", text)
            replyTo?.let { put("replyTo", it) }
            if (attachments.isNotEmpty()) put("attachments", buildJsonArray { attachments.forEach { add(it) } })
        }), groupId)
    }
    suspend fun groupTyping(groupId: String, active: Boolean) {
        checkGroupId(groupId)
        group(buildJsonObject { put("action", "typing"); put("groupId", groupId); put("active", active) })
    }
    suspend fun groupRead(groupId: String, seq: Long): GroupRead {
        checkGroupId(groupId); if (seq < 0) throw ApiException("INVALID_REQUEST")
        return parseGroupRead(group(buildJsonObject { put("action", "read"); put("groupId", groupId); put("seq", seq) }), groupId)
    }
    suspend fun renameGroup(groupId: String, name: String): GroupSnapshot {
        checkGroupId(groupId); if (!groupNameOk(name)) throw ApiException("INVALID_REQUEST")
        return parseGroupSnapshot(group(buildJsonObject { put("action", "rename"); put("groupId", groupId); put("name", name.trim()) }), groupId)
    }
    suspend fun addGroupMembers(groupId: String, members: List<String>): GroupSnapshot {
        checkGroupId(groupId); if (members.isEmpty() || members.size > 16 || members.any { !groupLabel(it) }) throw ApiException("INVALID_REQUEST")
        return parseGroupSnapshot(group(buildJsonObject {
            put("action", "addMembers"); put("groupId", groupId); put("members", buildJsonArray { members.forEach { add(it) } })
        }), groupId)
    }
    suspend fun leaveGroup(groupId: String): GroupLeft {
        checkGroupId(groupId)
        return parseGroupLeft(group(buildJsonObject { put("action", "leave"); put("groupId", groupId) }), groupId)
    }
    suspend fun groupNotify(groupId: String, notify: String): GroupSettings {
        checkGroupId(groupId); if (notify !in setOf("all", "mentions")) throw ApiException("INVALID_REQUEST")
        return parseGroupSettings(group(buildJsonObject { put("action", "settings"); put("groupId", groupId); put("notify", notify) }), groupId)
    }
    suspend fun groupPhoto(member: String): OwnerPhoto? {
        if (!groupMemberId(member) || !member.startsWith("owner:")) throw ApiException("INVALID_REQUEST")
        return parseGroupPhoto(group(buildJsonObject { put("action", "photo"); put("member", member) }), member)
    }
    suspend fun groupUpload(groupId: String, key: String, name: String, source: java.io.File, cancel: TransferCancellation,
        progress: (Long) -> Unit): GroupFile = transfers.groupUpload(groupId, key, name, source, cancel, progress)
    suspend fun groupDownload(file: GroupFile, destination: java.io.File, cancel: TransferCancellation): java.io.File =
        transfers.groupDownload(file, destination, cancel)

    suspend fun upload(threadId: String, key: String, name: String, source: java.io.File,
        cancel: TransferCancellation, voice: Boolean = false, progress: (Long) -> Unit): Attachment = transfers.upload(threadId, key, name, source, cancel, voice, progress)
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
    /** The owner is typing in this chat (or stopped): a reply still waiting for more texts keeps waiting. Only a hint. */
    suspend fun typing(threadId: String, active: Boolean) {
        if (!fileId(threadId)) throw ApiException("INVALID_REQUEST")
        post(companion + "api/conversation", buildJsonObject { put("action", "typing"); put("threadId", threadId); put("active", active) })
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
