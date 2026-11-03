package dev.blackoutburst.companion

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.*
import org.junit.Test

class ContactProtocolTest {
    private val peerId = "9d65d641-4c69-42cd-98b0-820863aa1829"
    private val thread = "077234d7-35b5-4dab-b4ca-7ca44fab70ea"
    private val messageId = "5f7d082a-4ba8-4b0a-81bc-bb80103d471e"
    private val date = "2026-11-03T04:13:00.000Z"
    private val peer = PeerMessage("received", peerId, "Pip", "Blackout", date)
    private val contact = CompanionContact(peerId, "Pip", "Blackout", false, false, 0)
    private val owner = Session("alice-synthetic-token", "app_session", Long.MAX_VALUE)
    private fun rawContacts(vararg rows: CompanionContact) = Json.parseToJsonElement(Json.encodeToString(ContactReply(rows.toList())))
    private fun peerMessage(metadata: PeerMessage = peer, text: String = "A precise message.\n<script>not code</script>") =
        Message(messageId, thread, "peer", text, peer = metadata)
    private fun rawMessage(message: Message = peerMessage()) = Json.encodeToString(message)
    private fun snapshot(message: String) = """{"version":1,"synthetic":false,"threads":[{"id":"$thread","title":"Own chat"}],"threadId":"$thread","messages":[$message],"cursor":"1","runtime":{"state":"ready"}}"""
    private fun events(message: String) = """{"version":1,"synthetic":false,"threadId":"$thread","events":[{"seq":1,"threadId":"$thread","type":"message","message":$message}],"cursor":"1","lastSeq":1,"hasMore":false}"""
    private fun refused(block: () -> Unit) {
        try { block(); fail("Expected refusal") } catch (error: ApiException) { assertEquals("INVALID_RESPONSE", error.code) }
    }

    @Test fun contactFlagsAreIndependentCanonicalValuesAndSafeRevisionBoundsAreExact() {
        assertEquals(contact, parseContacts(rawContacts(contact)).contacts.single())
        assertFalse(parseContacts(rawContacts(contact)).contacts.single().enabled)
        val waiting = contact.copy(enabled = true)
        assertFalse(parseContacts(rawContacts(waiting)).contacts.single().peerEnabled)
        assertEquals(9007199254740991L, parseContacts(rawContacts(contact.copy(revision = 9007199254740991L))).contacts.single().revision)
        assertTrue(parseContacts(rawContacts()).contacts.isEmpty())
        for (bad in listOf(contact.copy(id = "../other"), contact.copy(id = peerId.replace("42cd", "12cd")),
            contact.copy(name = ""), contact.copy(ownerLabel = " "), contact.copy(name = " Pip"),
            contact.copy(ownerLabel = "other\nowner"), contact.copy(name = "x".repeat(81)),
            contact.copy(name = "\ud800"), contact.copy(revision = -1), contact.copy(revision = 9007199254740992L)))
            refused { parseContacts(rawContacts(bad)) }
        refused { parseContacts(rawContacts(contact, contact)) }
        refused { parseContacts(rawContacts(*(1..33).map { contact.copy(id = UUID.randomUUID().toString()) }.toTypedArray())) }
        refused { parseContacts(Json.parseToJsonElement("{\"contacts\":[],\"owner\":\"other\"}")) }
    }

    @Test fun actualContactsApiUsesOnlyOwnAuthenticatedSettingsAndExactReviewedCas() = runBlocking {
        val calls = mutableListOf<Connection>()
        val api = api(calls) { body ->
            val selected = if (body.getValue("action").jsonPrimitive.content == "setContact") contact.copy(enabled = true, revision = 1) else contact
            200 to Json.encodeToString(ContactReply(listOf(selected)))
        }
        assertFalse(api.contacts().contacts.single().enabled)
        assertTrue(api.setContact(peerId, true, 0).contacts.single().enabled)
        assertEquals(setOf("action"), calls[0].body().keys)
        assertEquals(setOf("action", "id", "enabled", "expectedRevision"), calls[1].body().keys)
        assertEquals("setContact", calls[1].body().getValue("action").jsonPrimitive.content)
        assertEquals(peerId, calls[1].body().getValue("id").jsonPrimitive.content)
        assertEquals("0", calls[1].body().getValue("expectedRevision").toString())
        calls.forEach {
            assertEquals(BuildConfig.SITE + BuildConfig.COMPANION_PATH + "api/companion", it.url.toString())
            assertEquals("app_session=alice-synthetic-token", it.getRequestProperty("Cookie"))
            assertEquals(BuildConfig.SITE, it.getRequestProperty("Origin")); assertFalse(it.instanceFollowRedirects)
            assertFalse(it.url.toString().contains("token"))
        }
        val count = calls.size
        for ((id, revision) in listOf("bad" to 0L, peerId to -1L, peerId to 9007199254740992L)) {
            try { api.setContact(id, true, revision); fail("Invalid selector") }
            catch (error: ApiException) { assertEquals("INVALID_REQUEST", error.code) }
        }
        assertEquals(count, calls.size)
    }

    @Test fun conflictIsNotRetriedAndWrongOrUncertainAcknowledgementsCannotFlipTheSetting() = runBlocking {
        val calls = mutableListOf<Connection>(); var code = "CONTACT_CONFLICT"
        val api = api(calls) { 409 to """{"error":{"code":"$code","message":"PRIVATE PATH CANARY"}}""" }
        repeat(2) {
            try { api.setContact(peerId, true, 9); fail("Stale") }
            catch (error: ApiException) { assertEquals(code, error.code); assertEquals(409, error.status); assertFalse(error.toString().contains("CANARY")) }
        }
        assertArrayEquals(calls[0].sent.toByteArray(), calls[1].sent.toByteArray())
        assertEquals(2, calls.size) // Explicit calls only; no silent newer-CAS retry.
        for (body in listOf("{}", Json.encodeToString(ContactReply(emptyList())),
            Json.encodeToString(ContactReply(listOf(contact.copy(enabled = false, revision = 10)))),
            Json.encodeToString(ContactReply(listOf(contact.copy(enabled = true, revision = 8)))))) {
            val bad = api(mutableListOf()) { 200 to body }
            try { bad.setContact(peerId, true, 9); fail("Unconfirmed target/value/revision") }
            catch (error: ApiException) { assertEquals("INVALID_RESPONSE", error.code) }
        }
    }

    @Test fun peerCardsSurviveActualSnapshotAndEventsWithoutBecomingOwnerSubmissions() = runBlocking {
        val calls = mutableListOf<Connection>(); var message = peerMessage()
        val api = api(calls) { body -> 200 to if (body.getValue("action").jsonPrimitive.content == "snapshot") snapshot(rawMessage(message)) else events(rawMessage(message)) }
        val received = api.snapshot(thread).messages.single()
        assertEquals(message, received); assertEquals("From Pip (Blackout's companion)", peerAttribution(received.peer!!))
        assertEquals("A precise message.\n<script>not code</script>", received.text)
        assertFalse(matchesSubmission(received, PendingSend("owner-request", thread, received.text, emptyList())))
        message = peerMessage(peer.copy(direction = "sent"))
        val sent = api.events(thread, "0").events.single().message!!
        assertEquals("Sent to Pip", peerAttribution(sent.peer!!)); assertNull(sent.requestId); assertNull(sent.feeling); assertTrue(sent.attachments.isEmpty())
        assertTrue(calls.all { it.url.toString().endsWith("api/conversation") }) // Reading own activity only.
    }

    @Test fun rawPeerEnvelopeRefusesLegacyFieldsEvenNullOrEmptyAndUnknownNestedAuthority() = runBlocking {
        val good = rawMessage()
        val invalid = listOf(
            good.dropLast(1) + ",\"requestId\":null}", good.dropLast(1) + ",\"feeling\":null}",
            good.dropLast(1) + ",\"attachments\":[]}", good.dropLast(1) + ",\"owner\":\"other\"}",
            good.replace("\"sentAtISO\"", "\"authority\":\"owner\",\"sentAtISO\""),
            good.replace("\"role\":\"peer\"", "\"role\":\"assistant\""),
            rawMessage(peerMessage().copy(peer = null)), rawMessage(peerMessage().copy(role = "system")))
        for (message in invalid) {
            val api = api(mutableListOf()) { body -> 200 to if (body.getValue("action").jsonPrimitive.content == "snapshot") snapshot(message) else events(message) }
            try { api.snapshot(thread); fail("Invalid snapshot peer") } catch (error: ApiException) { assertEquals("INVALID_RESPONSE", error.code) }
            try { api.events(thread, "0"); fail("Invalid event peer") } catch (error: ApiException) { assertEquals("INVALID_RESPONSE", error.code) }
        }
    }

    @Test fun peerMetadataRolesTextAndThreadBoundsFailBeforeAnyCardIsAccepted() {
        val good = peerMessage()
        assertEquals(good, checkedMessage(good, thread))
        for (bad in listOf(good.copy(threadId = UUID.randomUUID().toString()), good.copy(text = " "), good.copy(text = "x".repeat(4001)),
            good.copy(text = "bad\u0000text"), good.copy(requestId = "forged-owner-turn"), good.copy(feeling = "happy"),
            good.copy(role = "user"), good.copy(role = "assistant"), good.copy(peer = peer.copy(direction = "reply")),
            good.copy(peer = peer.copy(companionId = "not-a-companion")), good.copy(peer = peer.copy(name = "x".repeat(81))),
            good.copy(peer = peer.copy(ownerLabel = "Owner\tsecret")), good.copy(peer = peer.copy(sentAtISO = "2026-11-03T04:13:00Z")),
            good.copy(peer = peer.copy(sentAtISO = "2026-11-03T04:13:00.000+01:00")),
            good.copy(peer = peer.copy(sentAtISO = "2016-12-31T23:59:60.000Z")))) refused { checkedMessage(bad, thread) }
        assertEquals(4000, checkedMessage(good.copy(text = "🙂".repeat(2000)), thread).text.length)
        val ordinary = Message(messageId, thread, "user", "Still my own chat", "request")
        assertEquals(ordinary, checkedMessage(ordinary, thread))
    }

    @Test fun peerCannotSmuggleFilesAndAWholeEventPageFailsOnOneMalformedPeer() = runBlocking {
        val file = Attachment(UUID.randomUUID().toString(), "private.txt", "text/plain", 1, "a".repeat(64), "companion", "/api/files/invalid")
        refused { checkedMessage(peerMessage().copy(attachments = listOf(file)), thread) }
        val correct = rawMessage(); val wrong = rawMessage(peerMessage(peer.copy(direction = "broadcast")))
        val body = """{"threadId":"$thread","events":[{"seq":1,"threadId":"$thread","type":"message","message":$correct},{"seq":2,"threadId":"$thread","type":"message","message":$wrong}],"cursor":"2","lastSeq":2,"hasMore":false}"""
        val api = api(mutableListOf()) { 200 to body }
        try { api.events(thread, "0"); fail("Entire page must refuse") } catch (error: ApiException) { assertEquals("INVALID_RESPONSE", error.code) }
    }

    @Test fun contactsRequestsCaptureTheirOwnerBeforeIoAndSubsequentRequestsUseTheNewOwner() = runBlocking {
        var current = owner; val calls = mutableListOf<Connection>()
        val api = Api(open = { url ->
            current = Session("bob-synthetic-token", "app_session", Long.MAX_VALUE)
            Connection(url) { 200 to Json.encodeToString(ContactReply(listOf(contact))) }.also { calls += it }
        }) { current }
        api.contacts(); api.contacts()
        assertEquals("app_session=alice-synthetic-token", calls[0].getRequestProperty("Cookie"))
        assertEquals("app_session=bob-synthetic-token", calls[1].getRequestProperty("Cookie"))
    }

    private fun api(calls: MutableList<Connection>, reply: (JsonObject) -> Pair<Int, String>) =
        Api(open = { url -> Connection(url, reply).also { calls += it } }) { owner }
    private class Connection(url: URL, private val reply: (JsonObject) -> Pair<Int, String>) : HttpURLConnection(url) {
        val sent = ByteArrayOutputStream(); private var result: Pair<Int, String>? = null
        fun body() = Json.parseToJsonElement(sent.toString("UTF-8")).jsonObject
        override fun connect() {}
        override fun disconnect() {}
        override fun usingProxy() = false
        override fun getOutputStream() = sent
        override fun getResponseCode(): Int { if (result == null) result = reply(body()); return result!!.first }
        override fun getInputStream() = ByteArrayInputStream(result!!.second.toByteArray())
        override fun getErrorStream() = ByteArrayInputStream(result!!.second.toByteArray())
    }
}
