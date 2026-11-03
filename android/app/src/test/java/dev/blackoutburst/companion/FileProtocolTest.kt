package dev.blackoutburst.companion

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
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

class FileProtocolTest {
    private val thread = UUID.randomUUID().toString()
    private val fresh = UUID.randomUUID().toString()
    private val message = UUID.randomUUID().toString()
    private val fileId = UUID.randomUUID().toString()
    private val file = Attachment(fileId, "empty.txt", "application/octet-stream", 0,
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "user", "/api/files/$fileId")
    private val owner = Session("synthetic-private-token", "app_session", Long.MAX_VALUE)

    @Test fun filesOnlySubmitAndDeleteUseExactStablePayloadsAndRefuseInjectedFileIds() = runBlocking {
        val calls = mutableListOf<Connection>()
        var loseAck = true
        val api = Api(open = { url -> Connection(url) { body ->
            when (body["action"]?.jsonPrimitive?.content) {
                "submit" -> {
                    if (loseAck) { loseAck = false; throw IOException("synthetic lost ACK") }
                    """{"version":1,"synthetic":false,"accepted":{"requestId":"stable-send","threadId":"$thread","messageId":"$message"}}"""
                }
                "archiveThread" -> """{"version":1,"synthetic":false,"archivedThreadId":"$thread","threadId":"$fresh","requestId":"stable-archive"}"""
                else -> throw AssertionError("Unexpected operation")
            }
        }.also { calls += it } }) { owner }
        try { api.submit("stable-send", thread, "", listOf(file.id)); fail("Lost ACK") }
        catch (error: ApiException) { assertEquals("NETWORK", error.code) }
        assertEquals(1, calls.size)
        assertEquals(message, api.submit("stable-send", thread, "", listOf(file.id)))
        assertArrayEquals(calls[0].sent.toByteArray(), calls[1].sent.toByteArray())
        val body = calls[1].body()
        assertEquals(setOf("action", "requestId", "threadId", "text", "attachments"), body.keys)
        assertEquals("", body.getValue("text").jsonPrimitive.content)
        assertEquals("[\"${file.id}\"]", body.getValue("attachments").toString())
        for (bad in listOf(listOf(file.id, file.id), List(9) { UUID.randomUUID().toString() }, listOf("https://foreign.invalid/file"))) {
            try { api.submit("must-not-forward", thread, "", bad); fail("Invalid file IDs") }
            catch (error: ApiException) { assertEquals("INVALID_REQUEST", error.code) }
        }
        assertEquals(2, calls.size)
        assertEquals(fresh, api.archiveThread(thread, "stable-archive")); api.archiveThread(thread, "stable-archive")
        assertArrayEquals(calls[2].sent.toByteArray(), calls[3].sent.toByteArray())
        assertEquals(setOf("action", "threadId", "requestId"), calls[2].body().keys)
        calls.forEach {
            assertEquals(BuildConfig.SITE + BuildConfig.COMPANION_PATH + "api/conversation", it.url.toString())
            assertEquals("app_session=synthetic-private-token", it.getRequestProperty("Cookie"))
            assertFalse(it.instanceFollowRedirects)
        }
    }

    @Test fun actualApiPreservesFileOnlySnapshotAndEventMetadataAndRejectsForeignMetadata() = runBlocking {
        val outgoing = file.copy(direction = "companion", caption = "Your file")
        var metadata = Json.encodeToString(outgoing)
        var extraEvent = ""
        val api = Api(open = { url -> Connection(url) { body ->
            val msg = """{"id":"$message","threadId":"$thread","role":"assistant","text":"","attachments":[$metadata]}"""
            when (body["action"]?.jsonPrimitive?.content) {
                "snapshot" -> """{"version":1,"synthetic":false,"threads":[{"id":"$thread","title":"Files"}],"threadId":"$thread","messages":[$msg],"cursor":"1","runtime":{"state":"ready","provider":"claude"}}"""
                "events" -> """{"version":1,"synthetic":false,"threadId":"$thread","events":[{"seq":1,"threadId":"$thread","type":"message","message":$msg}$extraEvent],"cursor":"1","lastSeq":1,"hasMore":false}"""
                else -> throw AssertionError("Unexpected operation")
            }
        } }) { owner }
        assertEquals(outgoing, api.snapshot(thread).messages.single().attachments.single())
        assertEquals(outgoing, api.events(thread, "0").events.single().message!!.attachments.single())
        for (bad in listOf(outgoing.copy(url = "https://foreign.invalid/api/files/$fileId"),
            outgoing.copy(mime = "text/html\r\nLocation: https://foreign.invalid"))) {
            metadata = Json.encodeToString(bad)
            try { api.snapshot(thread); fail("Invalid metadata") } catch (error: ApiException) { assertEquals("INVALID_RESPONSE", error.code) }
        }
        metadata = Json.encodeToString(outgoing).dropLast(1) + ",\"owner\":\"must-not-enter-state\"}"
        try { api.events(thread, "0"); fail("Unexpected private metadata") } catch (error: ApiException) { assertEquals("INVALID_RESPONSE", error.code) }
        metadata = Json.encodeToString(outgoing)
        extraEvent = """,{"seq":2,"threadId":"$thread","type":"message","message":{"id":"${UUID.randomUUID()}","threadId":"$thread","role":"system","text":"must not apply"}}"""
        try { api.events(thread, "0"); fail("Entire malformed page must fail") } catch (error: ApiException) { assertEquals("INVALID_RESPONSE", error.code) }
    }

    @Test fun archiveAckCannotConfirmAnotherThreadOrRequest() = runBlocking {
        for (body in listOf(
            """{"version":1,"synthetic":false,"archivedThreadId":"${UUID.randomUUID()}","threadId":"$fresh","requestId":"stable-archive"}""",
            """{"version":1,"synthetic":false,"archivedThreadId":"$thread","threadId":"$fresh","requestId":"other-request"}""",
            """{"version":1,"synthetic":false,"archivedThreadId":"$thread","threadId":"https://foreign.invalid","requestId":"stable-archive"}""")) {
            val api = Api(open = { url -> Connection(url) { body } }) { owner }
            try { api.archiveThread(thread, "stable-archive"); fail("Wrong archive ACK") }
            catch (error: ApiException) { assertEquals("INVALID_RESPONSE", error.code) }
        }
    }

    @Test fun malformedAcknowledgementsStayTypedFailuresInsteadOfStrandingTheComposer() = runBlocking {
        for (body in listOf("{}", "[]", "{\"accepted\":null}", "{\"accepted\":{\"messageId\":[]}}")) {
            val api = Api(open = { url -> Connection(url) { body } }) { owner }
            try { api.submit("stable-send", thread, "", listOf(file.id)); fail("Malformed ACK") }
            catch (error: ApiException) { assertEquals("INVALID_RESPONSE", error.code) }
        }
    }

    private class Connection(url: URL, private val reply: (JsonObject) -> String) : HttpURLConnection(url) {
        val sent = ByteArrayOutputStream()
        private var response: ByteArray? = null
        fun body() = Json.parseToJsonElement(sent.toString("UTF-8")).jsonObject
        override fun connect() {}
        override fun usingProxy() = false
        override fun disconnect() {}
        override fun getOutputStream() = sent
        override fun getResponseCode(): Int { if (response == null) response = reply(body()).toByteArray(); return 200 }
        override fun getInputStream() = ByteArrayInputStream(response ?: throw AssertionError("Response code must be checked"))
    }
}
