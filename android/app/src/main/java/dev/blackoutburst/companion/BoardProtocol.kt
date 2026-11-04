package dev.blackoutburst.companion

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

// The Board tab (#55, docs/BOARD-INBOX.md): the companion's Board messages, one sub-conversation per Board thread or
// ticket, out of the main chat. Every field past the ids is optional so an older server (no Board inbox) still parses.
private val boardJson = Json { ignoreUnknownKeys = true; explicitNulls = false }

@Serializable data class BoardTopic(
    val threadId: String, val label: String, val ticketNumber: Int? = null, val general: Boolean = false,
    val archived: Boolean = false, val unread: Int = 0, val updatedAt: Long = 0,
    val preview: String? = null, val previewRole: String? = null,
)
@Serializable data class BoardInbox(val threads: List<BoardTopic> = emptyList(), val unread: Int = 0, val any: Boolean = false)
data class BoardChange(val threadId: String, val unread: Int, val archived: Boolean? = null)

internal fun parseBoardInbox(value: JsonElement): BoardInbox = try {
    val result = boardJson.decodeFromJsonElement(BoardInbox.serializer(), value)
    if (result.threads.size > 200 || result.unread !in 0..1_000_000 || result.threads.map { it.threadId }.toSet().size != result.threads.size ||
        result.threads.any { !fileId(it.threadId) || it.label.isBlank() || !validText(it.label, 220, 880) || it.label.any { c -> c.code < 32 } ||
            it.unread !in 0..1_000_000 || it.updatedAt < 0 || (it.ticketNumber != null && it.ticketNumber <= 0) ||
            (it.preview != null && !validText(it.preview, 140, 560)) || (it.previewRole != null && it.previewRole !in setOf("user", "assistant")) })
        throw ApiException("INVALID_RESPONSE")
    result
} catch (error: ApiException) { throw error } catch (_: Exception) { throw ApiException("INVALID_RESPONSE") }

internal fun parseBoardChange(value: JsonElement, threadId: String): BoardChange = try {
    val body = value.jsonObject
    val unread = body.getValue("unread").jsonPrimitive.content.toInt()
    val archived = body["archived"]?.jsonPrimitive?.content?.toBooleanStrict()
    if (body["threadId"]?.jsonPrimitive?.content != threadId || unread !in 0..1_000_000) throw ApiException("INVALID_RESPONSE")
    BoardChange(threadId, unread, archived)
} catch (error: ApiException) { throw error } catch (_: Exception) { throw ApiException("INVALID_RESPONSE") }

/** "You: …" for the owner's own last message, else the companion's words. */
fun boardPreview(topic: BoardTopic): String? = topic.preview?.let { if (topic.previewRole == "user") "You: $it" else it }

/** A push for a Board sub-conversation carries board = "1" (src/push.mjs): the tap opens it in the Board tab. */
fun boardPush(data: Map<String, String>): Boolean = data["board"] == "1"
