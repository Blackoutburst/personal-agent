package dev.blackoutburst.companion

import java.util.Base64
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

internal const val OWNER_PHOTO_LIMIT = 192 * 1024
@Serializable data class OwnerDisplayProfile(val id: String, val displayName: String, val revision: Long, val photoVersion: String? = null)
@Serializable data class OwnerPhoto(val mime: String, val base64: String)
@Serializable data class OwnerProfileReply(val profile: OwnerDisplayProfile, val photo: OwnerPhoto? = null)
private val ownerProfileJson = Json { explicitNulls = true }
internal fun ownerDisplayName(value: String) = value.isNotBlank() && value == value.trim() && validText(value, 80, 320) &&
    value.none { it.code < 32 || it.code == 127 || it == '<' || it == '>' }
internal fun ownerPhotoBytes(photo: OwnerPhoto): ByteArray {
    if (photo.base64.length > 4 * ((OWNER_PHOTO_LIMIT + 2) / 3) || photo.mime !in setOf("image/jpeg", "image/png", "image/webp")) throw ApiException("INVALID_RESPONSE")
    val bytes = try { Base64.getDecoder().decode(photo.base64) } catch (_: Exception) { throw ApiException("INVALID_RESPONSE") }
    if (bytes.isEmpty() || bytes.size > OWNER_PHOTO_LIMIT || Base64.getEncoder().encodeToString(bytes) != photo.base64) throw ApiException("INVALID_RESPONSE")
    val detected = when {
        bytes.size >= 8 && bytes.take(8).map { it.toInt() and 255 } == listOf(137, 80, 78, 71, 13, 10, 26, 10) -> "image/png"
        bytes.size >= 3 && bytes.take(3).map { it.toInt() and 255 } == listOf(255, 216, 255) -> "image/jpeg"
        bytes.size >= 12 && String(bytes, 0, 4, Charsets.US_ASCII) == "RIFF" && String(bytes, 8, 4, Charsets.US_ASCII) == "WEBP" -> "image/webp"
        else -> null
    }
    if (detected != photo.mime) throw ApiException("INVALID_RESPONSE")
    return bytes
}
internal fun parseOwnerProfile(value: JsonElement): OwnerProfileReply = try {
    val result = ownerProfileJson.decodeFromJsonElement(OwnerProfileReply.serializer(), value)
    val p = result.profile
    if (!contactId(p.id) || !ownerDisplayName(p.displayName) || !contactRevision(p.revision) ||
        (p.photoVersion != null && !Regex("[a-f0-9]{64}").matches(p.photoVersion)) || (p.photoVersion == null) != (result.photo == null)) throw ApiException("INVALID_RESPONSE")
    result.photo?.let { ownerPhotoBytes(it) }; result
} catch (_: Exception) { throw ApiException("INVALID_RESPONSE") }
