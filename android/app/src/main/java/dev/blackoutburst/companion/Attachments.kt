package dev.blackoutburst.companion

import java.io.File
import java.net.HttpURLConnection
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.serialization.Serializable

const val MAX_FILES = 8
const val MAX_FILE_BYTES = 100L * 1024 * 1024
private val FILE_ID = Regex("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")
private val REQUEST_KEY = Regex("[A-Za-z0-9._-]{1,80}")
private val MIME = Regex("[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*")
val IMAGE_TYPES = setOf("image/png", "image/jpeg", "image/gif", "image/webp")
val VIDEO_TYPES = setOf("video/mp4", "video/webm")
val AUDIO_TYPES = setOf("audio/mpeg", "audio/wav", "audio/ogg", "audio/flac", "audio/mp4")

@Serializable
data class Attachment(val id: String, val name: String, val mime: String, val size: Long,
    val sha256: String, val direction: String, val url: String, val caption: String? = null)

internal fun validText(value: String, maximum: Int, bytes: Int): Boolean {
    if (value.length > maximum || value.toByteArray(Charsets.UTF_8).size > bytes ||
        value.any { it.code < 32 && it != '\n' && it != '\r' && it != '\t' || it.code == 127 }) return false
    var i = 0
    while (i < value.length) {
        val unit = value[i++]
        if (unit.isHighSurrogate()) { if (i == value.length || !value[i++].isLowSurrogate()) return false }
        else if (unit.isLowSurrogate()) return false
    }
    return true
}
internal fun fileId(value: String): Boolean = FILE_ID.matches(value)
internal fun requestKey(value: String): Boolean = REQUEST_KEY.matches(value)
internal fun fileName(value: String): Boolean = value.isNotBlank() && validText(value, 200, 800) &&
    value.none { it.code < 32 || it == '/' || it == '\\' }

internal fun checkedAttachment(file: Attachment): Attachment {
    if (!fileId(file.id) || file.url != "/api/files/${file.id}" || !fileName(file.name) ||
        file.mime.length > 255 || !MIME.matches(file.mime) || file.size !in 0..MAX_FILE_BYTES ||
        !Regex("[a-f0-9]{64}").matches(file.sha256) || file.direction !in setOf("user", "companion") ||
        file.caption?.let { !validText(it, 1000, 4000) } == true) throw ApiException("INVALID_RESPONSE")
    return file
}
internal fun checkedFiles(files: List<Attachment>): List<Attachment> {
    if (files.size > MAX_FILES || files.map { it.id }.toSet().size != files.size) throw ApiException("INVALID_RESPONSE")
    return files.map(::checkedAttachment)
}
internal fun checkedFileIds(ids: List<String>) {
    if (ids.size > MAX_FILES || ids.toSet().size != ids.size || ids.any { !fileId(it) }) throw ApiException("INVALID_REQUEST")
}
internal fun checkedMessage(message: Message, threadId: String): Message {
    if (message.role == "peer") {
        if (!fileId(message.id) || message.threadId != threadId || message.text.isBlank() ||
            !validText(message.text, 4000, 16000) || message.requestId != null || message.feeling != null ||
            message.attachments.isNotEmpty() || message.peer == null) throw ApiException("INVALID_RESPONSE")
        checkedPeer(message.peer)
        return message
    }
    if (!fileId(message.id) || message.threadId != threadId || message.role !in setOf("user", "assistant") ||
        message.peer != null ||
        !validText(message.text, if (message.role == "user") 8000 else 100000, if (message.role == "user") 32768 else 400000) ||
        message.requestId?.let { !requestKey(it) } == true) throw ApiException("INVALID_RESPONSE")
    val files = checkedFiles(message.attachments)
    if (files.any { it.direction != if (message.role == "user") "user" else "companion" } ||
        message.role == "user" && message.text.isBlank() && files.isEmpty()) throw ApiException("INVALID_RESPONSE")
    return message
}
internal fun checkedSnapshot(snapshot: Snapshot, requested: String?): Snapshot {
    if (snapshot.cursor.toLongOrNull()?.let { it >= 0 } != true || snapshot.threads.size > 200 || snapshot.messages.size > 500 ||
        snapshot.threads.map { it.id }.toSet().size != snapshot.threads.size ||
        snapshot.threads.any { !fileId(it.id) } || snapshot.messages.map { it.id }.toSet().size != snapshot.messages.size ||
        requested != null && snapshot.threadId != requested ||
        snapshot.threadId == null && (snapshot.messages.isNotEmpty() || snapshot.threads.isNotEmpty()) ||
        snapshot.threadId != null && snapshot.threads.none { it.id == snapshot.threadId }) throw ApiException("INVALID_RESPONSE")
    snapshot.threadId?.let { thread -> snapshot.messages.forEach { checkedMessage(it, thread) } }
    return snapshot
}
internal fun checkedEventPage(page: EventPage, threadId: String, from: String): EventPage {
    val start = from.toLongOrNull()?.takeIf { it >= 0 } ?: throw ApiException("INVALID_REQUEST")
    val end = page.cursor.toLongOrNull() ?: throw ApiException("INVALID_RESPONSE")
    if (page.threadId != threadId || page.events.size > 100 || end < start || page.lastSeq < end ||
        end != (page.events.lastOrNull()?.seq ?: start) || page.hasMore != (end < page.lastSeq) ||
        page.events.isEmpty() && page.hasMore) throw ApiException("INVALID_RESPONSE")
    page.events.forEachIndexed { index, event ->
        if (event.threadId != threadId || event.seq < 1 || event.seq != start + index + 1) throw ApiException("INVALID_RESPONSE")
        when (event.type) {
            "message" -> checkedMessage(event.message ?: throw ApiException("INVALID_RESPONSE"), threadId)
            "turn" -> if (event.requestId?.let(::requestKey) != true || event.state !in setOf("streaming", "complete", "cancelled", "error")) throw ApiException("INVALID_RESPONSE")
            "noop" -> Unit
            else -> throw ApiException("INVALID_RESPONSE")
        }
    }
    return page
}

/** A copied picker file and stable key survive a lost upload ACK; no URI is reopened on retry. */
data class PendingUpload(val key: String, val threadId: String, val name: String, val local: File? = null,
    val progress: Long = 0, val total: Long = 0, val file: Attachment? = null,
    val state: String = "preparing", val error: String? = null)
internal data class PendingSend(val requestId: String, val threadId: String, val text: String, val files: List<Attachment>)
internal data class PendingDelete(val requestId: String, val threadId: String)
internal fun matchesSubmission(message: Message, pending: PendingSend): Boolean = message.role == "user" &&
    message.threadId == pending.threadId && message.requestId == pending.requestId && message.text == pending.text &&
    message.attachments.map { it.id }.toSet() == pending.files.map { it.id }.toSet()

/** Disconnects a blocking HttpURLConnection as well as cancelling the UI coroutine. */
class TransferCancellation {
    private val cancelled = AtomicBoolean(false)
    @Volatile private var connection: HttpURLConnection? = null
    fun check() { if (cancelled.get()) throw ApiException("CANCELLED") }
    fun bind(value: HttpURLConnection) { connection = value; if (cancelled.get()) { value.disconnect(); check() } }
    fun release() { connection = null }
    fun cancel() { cancelled.set(true); connection?.disconnect() }
}

fun fileSize(size: Long): String = when {
    size >= 1024 * 1024 -> "%.1f MB".format(java.util.Locale.ROOT, size / (1024.0 * 1024))
    size >= 1024 -> "%.1f KB".format(java.util.Locale.ROOT, size / 1024.0)
    else -> "$size B"
}
