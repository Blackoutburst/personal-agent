package dev.blackoutburst.companion

import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonObject

private val CONTACT_ID = Regex("[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}")
private const val MAX_SAFE_REVISION = 9007199254740991L
private val contactJson = Json { explicitNulls = false }
private val peerDateFormat = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)
@Serializable data class CompanionContact(val id: String, val name: String, val ownerLabel: String,
    val enabled: Boolean, val peerEnabled: Boolean, val revision: Long)
@Serializable data class ContactReply(val contacts: List<CompanionContact>)
@Serializable data class PeerMessage(val direction: String, val companionId: String, val name: String,
    val ownerLabel: String, val sentAtISO: String)

internal fun contactId(value: String) = CONTACT_ID.matches(value)
internal fun contactRevision(value: Long) = value in 0..MAX_SAFE_REVISION
private fun contactLabel(value: String) = value.isNotBlank() && value.trim() == value &&
    validText(value, 80, 320) && value.none { it.code < 32 }
internal fun checkedPeer(peer: PeerMessage): PeerMessage {
    if (peer.direction !in setOf("sent", "received") || !contactId(peer.companionId) ||
        !contactLabel(peer.name) || !contactLabel(peer.ownerLabel) ||
        !Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z").matches(peer.sentAtISO) ||
        runCatching { peerDateFormat.format(Instant.parse(peer.sentAtISO)) == peer.sentAtISO }.getOrDefault(false) == false)
        throw ApiException("INVALID_RESPONSE")
    return peer
}
internal fun parseContacts(value: JsonElement): ContactReply = try {
    val result = contactJson.decodeFromJsonElement(ContactReply.serializer(), value)
    if (result.contacts.size > 32 || result.contacts.map { it.id }.toSet().size != result.contacts.size ||
        result.contacts.any { !contactId(it.id) || !contactLabel(it.name) || !contactLabel(it.ownerLabel) || !contactRevision(it.revision) })
        throw ApiException("INVALID_RESPONSE")
    result
} catch (_: Exception) { throw ApiException("INVALID_RESPONSE") }

/** Raw keys matter: a peer card cannot carry an owner request, feeling, files or hidden role metadata. */
internal fun checkedPeerEnvelope(value: JsonElement) {
    try {
        val fields = value.jsonObject
        if (fields.keys != setOf("id", "threadId", "role", "text", "peer")) throw ApiException("INVALID_RESPONSE")
        val peer = contactJson.decodeFromJsonElement(PeerMessage.serializer(), fields.getValue("peer"))
        checkedPeer(peer)
    } catch (_: Exception) { throw ApiException("INVALID_RESPONSE") }
}
internal fun peerAttribution(peer: PeerMessage): String = if (peer.direction == "sent")
    "Sent to ${peer.name.ifBlank { "Companion" }}" else
    "From ${peer.name.ifBlank { "Companion" }} (${peer.ownerLabel.ifBlank { "Owner" }}'s companion)"
internal fun contactProblem(error: ApiException) = when (error.code) {
    "CONTACT_CONFLICT" -> "Contact settings changed. Reload and review them before trying again."
    "CONTACT_NOT_FOUND" -> "This contact is no longer available. Reload contacts."
    else -> "That contact change could not be confirmed. Reload contacts before trying again."
}
