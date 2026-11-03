package dev.blackoutburst.companion

import java.security.MessageDigest
import java.time.Instant
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonObject

internal const val PERSONALITY_BYTES = 256 * 1024
@Serializable data class PersonalityHistory(val revision: String, val observedAtISO: String,
    val modifiedAtISO: String, val source: String)
@Serializable data class Personality(val file: String, val content: String, val revision: String,
    val modifiedAtISO: String, val history: List<PersonalityHistory>, val historyLimit: Int,
    val changed: Boolean? = null)
@Serializable data class PersonalityVersion(val revision: String, val content: String,
    val observedAtISO: String, val modifiedAtISO: String, val source: String)
@Serializable private data class PersonalityVersionReply(val version: PersonalityVersion)
data class PersonalityDraft(val content: String, val expectedRevision: String, val conflicted: Boolean = false)
data class PersonalityRestore(val targetRevision: String, val expectedRevision: String, val scope: Long)

private val personalityJson = Json { explicitNulls = false }
internal fun validPersonalityContent(value: String) = validText(value, PERSONALITY_BYTES, PERSONALITY_BYTES)
private fun personalityHash(content: String) = MessageDigest.getInstance("SHA-256")
    .digest(content.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
private fun instant(value: String) = runCatching { Instant.parse(value) }.isSuccess
private fun metadata(revision: String, observed: String, modified: String, source: String): Boolean =
    memoryRevision(revision) && instant(observed) && instant(modified) &&
        source in setOf("settled_turn", "owner_edit", "owner_restore", "before_owner_change")

internal fun parsePersonality(raw: JsonElement, mutation: Boolean = false): Personality = try {
    val fields = setOf("file", "content", "revision", "modifiedAtISO", "history", "historyLimit") +
        if (mutation) setOf("changed") else emptySet()
    if (raw.jsonObject.keys != fields) throw ApiException("INVALID_RESPONSE")
    val value = personalityJson.decodeFromJsonElement(Personality.serializer(), raw)
    if (value.file != "SOUL.md" || !validPersonalityContent(value.content) || !memoryRevision(value.revision) ||
        personalityHash(value.content) != value.revision || !instant(value.modifiedAtISO) || value.historyLimit != 20 ||
        value.history.size > 20 || value.history.map { it.revision }.toSet().size != value.history.size ||
        value.history.any { !metadata(it.revision, it.observedAtISO, it.modifiedAtISO, it.source) } ||
        mutation && value.changed == null) throw ApiException("INVALID_RESPONSE")
    value
} catch (_: Exception) { throw ApiException("INVALID_RESPONSE") }

internal fun parsePersonalityVersion(raw: JsonElement, requested: String): PersonalityVersion = try {
    val value = personalityJson.decodeFromJsonElement(PersonalityVersionReply.serializer(), raw).version
    if (value.revision != requested || !validPersonalityContent(value.content) || personalityHash(value.content) != value.revision ||
        !metadata(value.revision, value.observedAtISO, value.modifiedAtISO, value.source)) throw ApiException("INVALID_RESPONSE")
    value
} catch (_: Exception) { throw ApiException("INVALID_RESPONSE") }

/** Linear, position-independent common edges; the complete changed middle is shown, not an LCS guess. */
data class PersonalityLineDiff(val unchangedBefore: Int, val removed: List<String>, val added: List<String>, val unchangedAfter: Int)
internal fun personalityLineDiff(current: String, target: String): PersonalityLineDiff {
    val before = current.split('\n'); val after = target.split('\n')
    var prefix = 0; var suffix = 0
    while (prefix < before.size && prefix < after.size && before[prefix] == after[prefix]) prefix++
    while (suffix < before.size - prefix && suffix < after.size - prefix &&
        before[before.lastIndex - suffix] == after[after.lastIndex - suffix]) suffix++
    return PersonalityLineDiff(prefix, before.subList(prefix, before.size - suffix), after.subList(prefix, after.size - suffix), suffix)
}

internal fun personalityProblem(error: ApiException) = when (error.code) {
    "PERSONALITY_BUSY" -> "Finish or stop the current reply, wait for it to stop, then retry this change."
    "PERSONALITY_CONFLICT" -> "The personality changed. Review the latest version; your draft is kept."
    "PERSONALITY_NOT_FOUND" -> "That observed version is no longer available. Reload the history."
    "PERSONALITY_TOO_LARGE", "TOO_LARGE" -> "The personality file is too large to open safely."
    else -> "This request could not be confirmed. Reload the personality before trying again."
}
