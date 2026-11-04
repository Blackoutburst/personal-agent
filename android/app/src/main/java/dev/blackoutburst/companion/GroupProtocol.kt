package dev.blackoutburst.companion

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

// Group chat (#53, docs/GROUP-CHAT.md, src/group-chat.mjs): owners and their companions in one conversation.
// Member ids are "owner:<label>" and "companion:<label>"; no companion UUID is ever exposed. Every field past the
// ids is optional so a newer server's additions (or an older one's omissions) still parse.
private val groupJson = Json { ignoreUnknownKeys = true; explicitNulls = false }
private val MEMBER_ID = Regex("(owner|companion):[a-z][a-z0-9-]{0,31}")
private val LABEL = Regex("[a-z][a-z0-9-]{0,31}")
private val GROUP_MIME = Regex("[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*")
const val GROUP_FILE_BYTES = 25L * 1024 * 1024
const val GROUP_NAME_CHARS = 60
const val GROUP_TEXT_CHARS = 8000

@Serializable data class GroupLook(val character: String = "pip", val color: String = "peach", val outfit: String = "base")
@Serializable data class GroupMember(
    val id: String, val kind: String, val label: String = "", val name: String = "",
    val photoVersion: String? = null, val you: Boolean = false, val look: GroupLook? = null,
    val owner: String? = null, val yours: Boolean = false,
)
@Serializable data class GroupAuthor(val kind: String, val ownerLabel: String? = null)
@Serializable data class GroupReplyRef(val id: String, val seq: Long = 0, val authorId: String? = null, val name: String = "", val preview: String = "")
@Serializable data class GroupFile(val id: String, val name: String, val mime: String = "application/octet-stream", val size: Long = 0) {
    val image get() = mime in IMAGE_TYPES
}
@Serializable data class GroupMessage(
    val id: String, val seq: Long, val groupId: String = "", val author: GroupAuthor = GroupAuthor("system"),
    val authorId: String? = null, val name: String = "", val text: String = "", val mentions: List<String> = emptyList(),
    val replyTo: GroupReplyRef? = null, val attachments: List<GroupFile> = emptyList(), val feeling: String? = null,
    val proactive: Boolean = false, val createdAt: Long = 0,
) { val system get() = author.kind == "system" }
@Serializable data class GroupSummary(
    val id: String, val name: String, val members: List<GroupMember> = emptyList(), val unread: Int = 0,
    val notify: String = "all", val lastSeq: Long = 0, val updatedAt: Long = 0,
    val preview: String? = null, val previewName: String? = null, val previewAuthorId: String? = null,
)
@Serializable data class GroupOwner(val id: String, val label: String, val name: String = "", val companionName: String? = null, val you: Boolean = false)
@Serializable data class GroupList(val groups: List<GroupSummary> = emptyList(), val unread: Int = 0, val owners: List<GroupOwner> = emptyList(), val seatbelt: Int = 0)
@Serializable data class GroupSnapshot(
    val group: GroupSummary, val messages: List<GroupMessage> = emptyList(), val cursor: String = "0",
    val hasOlder: Boolean = false, val typing: List<String> = emptyList(), val paused: Boolean = false,
)
@Serializable data class GroupEvents(
    val groupId: String, val name: String? = null, val messages: List<GroupMessage> = emptyList(), val cursor: String,
    val lastSeq: Long = 0, val hasMore: Boolean = false, val members: List<GroupMember>? = null,
    val typing: List<String> = emptyList(), val paused: Boolean = false,
)
@Serializable data class GroupPosted(val message: GroupMessage, val cursor: String? = null)
@Serializable data class GroupRead(val groupId: String, val unread: Int = 0)
@Serializable data class GroupSettings(val groupId: String, val notify: String)
@Serializable data class GroupLeft(val left: String, val unread: Int = 0)
@Serializable data class GroupPhoto(val member: String, val photo: OwnerPhoto? = null)

internal fun groupMemberId(value: String) = MEMBER_ID.matches(value)
internal fun groupLabel(value: String) = LABEL.matches(value)
/** What the server accepts as a group name: trimmed, at most 60 characters, no control characters or angle brackets. */
fun groupNameOk(value: String): Boolean {
    val name = value.trim().replace(Regex("\\s+"), " ")
    return name.isNotEmpty() && name.length <= GROUP_NAME_CHARS && validText(value, 200, 800) && value.none { it.code < 32 || it == '<' || it == '>' }
}

private inline fun <T> checked(block: () -> T): T = try { block() }
    catch (error: ApiException) { throw error } catch (_: Exception) { throw ApiException("INVALID_RESPONSE") }
private fun bad(): Nothing = throw ApiException("INVALID_RESPONSE")

private fun checkMember(member: GroupMember) {
    if (!groupMemberId(member.id) || member.kind !in setOf("owner", "companion") || !member.id.startsWith(member.kind + ":") ||
        member.label.isNotEmpty() && member.id != member.kind + ":" + member.label || !validText(member.name, 200, 800) ||
        member.photoVersion?.let { it.length > 128 || !validText(it, 128, 128) } == true ||
        member.owner?.let { !groupMemberId(it) || !it.startsWith("owner:") } == true) bad()
}
private fun checkMembers(members: List<GroupMember>) {
    if (members.size > 64 || members.map { it.id }.toSet().size != members.size) bad()
    members.forEach(::checkMember)
}
private fun checkMessage(message: GroupMessage, groupId: String) {
    if (!fileId(message.id) || message.seq < 1 || message.groupId.isNotEmpty() && message.groupId != groupId ||
        message.author.kind !in setOf("owner", "companion", "system") ||
        message.authorId?.let { !groupMemberId(it) || !it.startsWith(message.author.kind + ":") } == true ||
        !validText(message.text, 100_000, 400_000) || !validText(message.name, 200, 800) ||
        message.mentions.size > 64 || message.mentions.any { !groupMemberId(it) } ||
        message.attachments.size > MAX_FILES || message.attachments.map { it.id }.toSet().size != message.attachments.size || message.createdAt < 0) bad()
    message.replyTo?.let { if (!fileId(it.id) || it.authorId?.let(::groupMemberId) == false || !validText(it.preview, 2000, 8000) || !validText(it.name, 200, 800)) bad() }
    message.attachments.forEach(::checkGroupFile)
}
internal fun checkGroupFile(file: GroupFile): GroupFile {
    if (!fileId(file.id) || !fileName(file.name) || file.mime.length > 255 || !GROUP_MIME.matches(file.mime) || file.size !in 0..GROUP_FILE_BYTES) bad()
    return file
}
private fun checkMessages(messages: List<GroupMessage>, groupId: String) {
    if (messages.size > 500 || messages.map { it.id }.toSet().size != messages.size) bad()
    messages.forEach { checkMessage(it, groupId) }
    if (messages.zipWithNext().any { (a, b) -> b.seq <= a.seq }) bad()
}
private fun checkSummary(group: GroupSummary) {
    if (!fileId(group.id) || group.name.isBlank() || !validText(group.name, 200, 800) || group.unread !in 0..1_000_000 ||
        group.notify !in setOf("all", "mentions") || group.lastSeq < 0 || group.updatedAt < 0 ||
        group.preview?.let { !validText(it, 2000, 8000) } == true || group.previewAuthorId?.let(::groupMemberId) == false) bad()
    checkMembers(group.members)
}
private fun checkTyping(typing: List<String>) { if (typing.size > 64 || typing.any { !groupMemberId(it) }) bad() }
private fun cursorOf(value: String): Long = value.toLongOrNull()?.takeIf { it >= 0 } ?: bad()

internal fun parseGroupList(value: JsonElement): GroupList = checked {
    val result = groupJson.decodeFromJsonElement(GroupList.serializer(), value)
    if (result.groups.size > 200 || result.groups.map { it.id }.toSet().size != result.groups.size || result.unread !in 0..10_000_000 ||
        result.owners.size > 200 || result.owners.any { !groupMemberId(it.id) || it.id != "owner:" + it.label || !groupLabel(it.label) || !validText(it.name, 200, 800) }) bad()
    result.groups.forEach(::checkSummary)
    result
}

internal fun parseGroupSnapshot(value: JsonElement, groupId: String? = null): GroupSnapshot = checked {
    val result = groupJson.decodeFromJsonElement(GroupSnapshot.serializer(), value)
    checkSummary(result.group)
    if (groupId != null && result.group.id != groupId) bad()
    cursorOf(result.cursor)
    checkMessages(result.messages, result.group.id)
    checkTyping(result.typing)
    result
}

internal fun parseGroupEvents(value: JsonElement, groupId: String, from: String): GroupEvents = checked {
    val result = groupJson.decodeFromJsonElement(GroupEvents.serializer(), value)
    val start = cursorOf(from); val end = cursorOf(result.cursor)
    if (result.groupId != groupId || end < start || result.messages.size > 100 ||
        result.messages.any { it.seq <= start || it.seq > end } || result.name?.let { it.isBlank() || !validText(it, 200, 800) } == true) bad()
    checkMessages(result.messages, groupId)
    result.members?.let(::checkMembers)
    checkTyping(result.typing)
    result
}

internal fun parseGroupPosted(value: JsonElement, groupId: String): GroupPosted = checked {
    val result = groupJson.decodeFromJsonElement(GroupPosted.serializer(), value)
    checkMessage(result.message, groupId)
    result
}

internal fun parseGroupRead(value: JsonElement, groupId: String): GroupRead = checked {
    val result = groupJson.decodeFromJsonElement(GroupRead.serializer(), value)
    if (result.groupId != groupId || result.unread !in 0..10_000_000) bad()
    result
}

internal fun parseGroupSettings(value: JsonElement, groupId: String): GroupSettings = checked {
    val result = groupJson.decodeFromJsonElement(GroupSettings.serializer(), value)
    if (result.groupId != groupId || result.notify !in setOf("all", "mentions")) bad()
    result
}

internal fun parseGroupLeft(value: JsonElement, groupId: String): GroupLeft = checked {
    val result = groupJson.decodeFromJsonElement(GroupLeft.serializer(), value)
    if (result.left != groupId || result.unread !in 0..10_000_000) bad()
    result
}

internal fun parseGroupPhoto(value: JsonElement, member: String): OwnerPhoto? = checked {
    val result = groupJson.decodeFromJsonElement(GroupPhoto.serializer(), value)
    if (result.member != member) bad()
    result.photo?.also { ownerPhotoBytes(it) }
}

internal fun parseGroupUpload(value: JsonObject): GroupFile = checked {
    checkGroupFile(groupJson.decodeFromJsonElement(GroupFile.serializer(), value.getValue("file").jsonObject))
}

// ---- Helpers the views use (pure, unit-tested) ----

/** The signed-in owner's member id in this group ("owner:<label>"), or null when the server did not say. */
fun groupSelf(members: List<GroupMember>): String? = members.firstOrNull { it.kind == "owner" && it.you }?.id

/** "Alice: hello" for the list row; "You: …" for the owner's own last message. */
fun groupPreview(group: GroupSummary): String? {
    val text = group.preview?.takeIf { it.isNotBlank() } ?: return null
    val self = groupSelf(group.members)
    return when {
        group.previewAuthorId != null && group.previewAuthorId == self -> "You: $text"
        !group.previewName.isNullOrBlank() -> "${group.previewName}: $text"
        else -> text
    }
}

/** "Alice is typing…" from the server's typing list, without the signed-in owner. Companions count while their turn runs. */
fun typingLine(typing: List<String>, members: List<GroupMember>, self: String?): String? {
    val names = typing.distinct().filter { it != self }.map { id -> members.firstOrNull { it.id == id }?.name?.takeIf { it.isNotBlank() } ?: "Someone" }
    return when (names.size) {
        0 -> null
        1 -> "${names[0]} is typing…"
        2 -> "${names[0]} and ${names[1]} are typing…"
        else -> "${names.size} people are typing…"
    }
}

/** The "@query" being typed right before the cursor (an @ at the start or after a space), or null. */
fun mentionQuery(text: String, cursor: Int): String? {
    if (cursor < 0 || cursor > text.length) return null
    val before = text.substring(0, cursor)
    val match = Regex("(^|\\s)@([^\\s@]{0,32})$").find(before) ?: return null
    return match.groupValues[2]
}

/** Members whose name (or owner label) starts with the query, the signed-in owner left out. */
fun mentionCandidates(query: String, members: List<GroupMember>, self: String?): List<GroupMember> {
    val wanted = query.lowercase()
    return members.filter { it.id != self && it.name.isNotBlank() }
        .filter { it.name.lowercase().startsWith(wanted) || it.kind == "owner" && it.label.startsWith(wanted) || wanted.isNotEmpty() && it.name.lowercase().contains(" $wanted") }
        .take(8)
}

/** Replaces the "@query" before the cursor with "@Name "; returns the new text and cursor. */
fun insertMention(text: String, cursor: Int, name: String): Pair<String, Int> {
    val query = mentionQuery(text, cursor) ?: return text to cursor
    val start = cursor - query.length - 1
    val inserted = "@$name "
    val rest = text.substring(cursor).let { if (it.startsWith(" ")) it.substring(1) else it }
    return text.substring(0, start) + inserted + rest to start + inserted.length
}

/** New or changed messages merged in seq order, the newest 500 kept. */
fun mergeGroupMessages(current: List<GroupMessage>, incoming: List<GroupMessage>): List<GroupMessage> {
    if (incoming.isEmpty()) return current
    val byId = LinkedHashMap<String, GroupMessage>()
    current.forEach { byId[it.id] = it }
    incoming.forEach { byId[it.id] = it }
    return byId.values.sortedBy { it.seq }.takeLast(500)
}

/** A push for a group message (src/push.mjs): type "group" with the group's id; never the text. */
fun groupPush(data: Map<String, String>): Boolean = data["type"] == "group" && data["group"] == "1" &&
    data["groupId"]?.let(::fileId) == true && data["messageId"]?.let(::fileId) == true

/** The notification text for a group push: the author's words when they could be fetched. */
fun groupNotificationText(data: Map<String, String>, message: GroupMessage?): String {
    val fallback = if (data["mention"] == "1") "You were mentioned" else "New message"
    message ?: return fallback
    val text = notificationText(message.text).ifBlank { message.attachments.firstOrNull()?.let { if (it.image) "Sent a picture" else "Sent a file" } ?: "" }
    if (text.isBlank()) return fallback
    return if (message.name.isNotBlank()) "${message.name}: $text" else text
}

/** The reply quote's text: a one-line preview of the message being answered. */
fun replyPreview(message: GroupMessage): String {
    val text = notificationText(message.text, 140)
    return text.ifBlank { message.attachments.firstOrNull()?.name ?: "" }
}

internal fun groupCursorOf(value: String) = value.toLongOrNull()?.takeIf { it >= 0 }
