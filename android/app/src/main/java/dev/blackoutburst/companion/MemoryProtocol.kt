package dev.blackoutburst.companion

import java.security.MessageDigest
import java.time.Instant
import java.time.LocalDate
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonObject

internal const val MEMORY_FILE_BYTES = 256 * 1024
internal const val MEMORY_TOTAL_BYTES = 2 * 1024 * 1024
private val REVISION = Regex("[a-f0-9]{64}")
private val MEMORY_ID = Regex("[a-f0-9]{16}")
private val DIARY_NAME = Regex("memory/(\\d{4}-\\d{2}-\\d{2})\\.md")

@Serializable data class MemoryItem(val id: String, val text: String, val line: Int)
@Serializable data class MemorySection(val title: String, val items: List<MemoryItem>)
@Serializable data class MemoryFile(val file: String, val content: String, val revision: String,
    val modifiedAtISO: String, val readOnly: Boolean, val sections: List<MemorySection>)
@Serializable data class Memories(val files: List<MemoryFile>, val revision: String,
    val changed: Boolean? = null, val removed: Boolean? = null, val cleared: Boolean? = null)
@Serializable data class MemoryExport(val format: String, val exportedAt: String, val files: List<MemoryFile>)
@Serializable private data class MemoryExportReply(val export: MemoryExport)
data class MemoryDraft(val file: String, val id: String, val line: Int, val expectedRevision: String,
    val text: String, val conflicted: Boolean = false)

private val memoryJson = Json { explicitNulls = false }
internal fun writableMemory(file: String) = file == "USER.md" || file == "MEMORY.md"
internal fun allowedMemory(file: String): Boolean = writableMemory(file) || DIARY_NAME.matchEntire(file)?.let {
    runCatching { LocalDate.parse(it.groupValues[1]) }.isSuccess
} == true
internal fun memoryRevision(value: String) = REVISION.matches(value)
internal fun memoryItemId(value: String) = MEMORY_ID.matches(value)
internal fun validCorrection(value: String): Boolean = value.isNotBlank() && validText(value, 4000, 16000) &&
    '\n' !in value && '\r' !in value && '\t' !in value
private fun validInstant(value: String) = runCatching { Instant.parse(value) }.isSuccess

/** Full content is authoritative. Section items locate controls; they never duplicate the prose view. */
private fun checkedMemoryFiles(files: List<MemoryFile>) {
    if (files.size > 1024 || files.map { it.file }.toSet().size != files.size) throw ApiException("INVALID_RESPONSE")
    var total = 0L
    var bullets = 0
    files.forEach { file ->
        val bytes = file.content.toByteArray(Charsets.UTF_8)
        total += bytes.size
        if (!allowedMemory(file.file) || file.readOnly == writableMemory(file.file) ||
            !validText(file.content, MEMORY_FILE_BYTES, MEMORY_FILE_BYTES) || total > MEMORY_TOTAL_BYTES ||
            !memoryRevision(file.revision) || !validInstant(file.modifiedAtISO) ||
            MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) } != file.revision) throw ApiException("INVALID_RESPONSE")
        val lines = file.content.split('\n')
        val items = file.sections.flatMap { section ->
            if (!validText(section.title, MEMORY_FILE_BYTES, MEMORY_FILE_BYTES) || '\n' in section.title || '\r' in section.title) throw ApiException("INVALID_RESPONSE")
            section.items
        }
        bullets += items.size
        if (bullets > 10000) throw ApiException("INVALID_RESPONSE")
        if (items.map { it.id }.toSet().size != items.size || items.map { it.line }.toSet().size != items.size ||
            items.any { !memoryItemId(it.id) || it.line !in lines.indices || it.text.isBlank() ||
                !validText(it.text, MEMORY_FILE_BYTES, MEMORY_FILE_BYTES) || '\n' in it.text || '\r' in it.text }) throw ApiException("INVALID_RESPONSE")
    }
}

internal fun parseMemories(raw: JsonElement, flag: String? = null): Memories = try {
    val expected = setOf("files", "revision") + listOfNotNull(flag)
    if (raw.jsonObject.keys != expected) throw ApiException("INVALID_RESPONSE")
    val value = memoryJson.decodeFromJsonElement(Memories.serializer(), raw)
    if (!memoryRevision(value.revision) || flag == "changed" && value.changed == null ||
        flag == "removed" && value.removed == null || flag == "cleared" && value.cleared == null) throw ApiException("INVALID_RESPONSE")
    checkedMemoryFiles(value.files)
    value
} catch (_: Exception) { throw ApiException("INVALID_RESPONSE") }

internal fun parseMemoryExport(raw: JsonElement): MemoryExport = try {
    val value = memoryJson.decodeFromJsonElement(MemoryExportReply.serializer(), raw).export
    if (value.format != "companion-memory-v1" || !validInstant(value.exportedAt)) throw ApiException("INVALID_RESPONSE")
    checkedMemoryFiles(value.files)
    value
} catch (_: Exception) { throw ApiException("INVALID_RESPONSE") }

internal fun memoryExportBytes(value: MemoryExport): ByteArray {
    checkedMemoryFiles(value.files)
    return memoryJson.encodeToString(MemoryExport.serializer(), value).toByteArray(Charsets.UTF_8).also {
        if (it.size > 16 * 1024 * 1024) throw ApiException("TOO_LARGE")
    }
}

internal fun memoryFileTitle(file: String): String = when (file) {
    "USER.md" -> "About you"
    "MEMORY.md" -> "Our memories"
    else -> "Diary · ${file.removePrefix("memory/").removeSuffix(".md") }"
}
internal fun memoryProblem(error: ApiException): String = when {
    error.code == "CANCELLED" -> "Export cancelled."
    error.code == "MEMORY_BUSY" -> "Finish or stop the current reply, then retry this change."
    error.code == "MEMORY_CONFLICT" || error.status == 409 -> "The notes changed. The latest version has been loaded; your correction draft is kept. Review it before editing again."
    error.code == "TOO_LARGE" || error.code == "MEMORY_TOO_LARGE" -> "These notes are too large to open safely."
    error.code == "MEMORY_NOT_FOUND" -> "That note is no longer available. Reload the notes."
    error.code == "NETWORK" || error.status >= 500 -> "That change could not be confirmed. Reload the notes before trying again."
    else -> "The memory request could not be completed. Try again."
}
