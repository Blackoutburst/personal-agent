package dev.blackoutburst.companion

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.nio.file.Files
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class AttachmentsTest {
    private fun attachment(bytes: ByteArray = byteArrayOf()): Attachment {
        val id = UUID.randomUUID().toString()
        return Attachment(id, "hello world.gif", "image/gif", bytes.size.toLong(),
            MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }, "user", "/api/files/$id")
    }
    private fun denied(code: String, block: () -> Unit) {
        try { block(); fail("Expected $code") } catch (error: ApiException) { assertEquals(code, error.code) }
    }
    private fun owner(name: String = "alice") = Session("$name-private-token", "app_session", Long.MAX_VALUE)
    private fun temporary(block: (File) -> Unit) {
        val folder = Files.createTempDirectory("companion-files-synthetic-").toFile()
        try { block(folder) } finally { folder.deleteRecursively() }
    }

    @Test fun attachmentBoundaryAcceptsEmptyFilesAndDownloadOnlyTypesButRejectsUnsafeMetadata() {
        val file = attachment()
        assertEquals(0, checkedAttachment(file).size)
        assertEquals("application/x-custom", checkedAttachment(file.copy(mime = "application/x-custom")).mime)
        assertEquals("image/svg+xml", checkedAttachment(file.copy(mime = "image/svg+xml")).mime)
        assertFalse("SVG must not enter the image decoder", "image/svg+xml" in IMAGE_TYPES)
        assertEquals(1000, checkedAttachment(file.copy(caption = "🙂".repeat(500))).caption!!.length)
        val invalid = listOf(
            file.copy(id = "../secret"), file.copy(url = "https://elsewhere.invalid${file.url}"),
            file.copy(url = "//elsewhere.invalid${file.url}"), file.copy(url = file.url + "?token=secret"),
            file.copy(url = file.url + "/../other"), file.copy(url = "/api/files/${UUID.randomUUID()}"),
            file.copy(name = "../hello"), file.copy(name = "bad\\name"), file.copy(name = "bad\nname"),
            file.copy(name = "x".repeat(201)), file.copy(name = "\ud800"), file.copy(mime = "image/png\ntext/html"),
            file.copy(mime = "image/png; charset=utf-8"), file.copy(size = -1), file.copy(size = MAX_FILE_BYTES + 1),
            file.copy(sha256 = "not-a-hash"), file.copy(direction = "system"), file.copy(caption = "x".repeat(1001)))
        invalid.forEach { denied("INVALID_RESPONSE") { checkedAttachment(it) } }
        denied("INVALID_RESPONSE") { checkedFiles(listOf(file, file)) }
        denied("INVALID_RESPONSE") { checkedFiles(List(9) { attachment() }) }
        checkedFileIds(List(8) { UUID.randomUUID().toString() })
        listOf(listOf(file.id, file.id), List(9) { UUID.randomUUID().toString() }, listOf("file-not-a-uuid")).forEach {
            denied("INVALID_REQUEST") { checkedFileIds(it) }
        }
    }

    @Test fun rawUploadUsesCapturedOwnerAndExactPrivateCopyOnUncertainRetry() = temporary { folder -> runBlocking {
        val bytes = "synthetic image bytes".toByteArray()
        val local = File(folder, "private-copy").apply { writeBytes(bytes) }
        val file = attachment(bytes).copy(name = "hello world 🌙.gif")
        var session = owner()
        val calls = mutableListOf<FakeConnection>()
        val api = FileTransfers({ session }) { url ->
            FakeConnection(url, Json.encodeToString(mapOf("file" to file)).toByteArray()).also {
                it.loseAck = calls.isEmpty(); calls += it
                // An owner switch after starting this operation cannot replace its cookie midway.
                if (calls.size == 1) session = owner("bob")
            }
        }
        val thread = UUID.randomUUID().toString(); val key = "stable_upload_key"
        try { api.upload(thread, key, file.name, local, TransferCancellation()) {}; fail("Lost ACK must be uncertain") }
        catch (error: ApiException) { assertEquals("NETWORK", error.code); assertFalse(error.toString().contains("private-token")) }
        session = owner()
        assertEquals(file, api.upload(thread, key, file.name, local, TransferCancellation()) {})
        assertEquals(2, calls.size)
        calls.forEach { connection ->
            assertEquals(BuildConfig.SITE + BuildConfig.COMPANION_PATH.trimEnd('/') + "/api/files", connection.url.toString())
            assertEquals("POST", connection.requestMethod)
            assertEquals("application/octet-stream", connection.getRequestProperty("Content-Type"))
            assertEquals("app_session=alice-private-token", connection.getRequestProperty("Cookie"))
            assertEquals(BuildConfig.SITE, connection.getRequestProperty("Origin"))
            assertEquals("hello%20world%20%F0%9F%8C%99.gif", connection.getRequestProperty("X-File-Name"))
            assertEquals(thread, connection.getRequestProperty("X-Thread-Id"))
            assertEquals(key, connection.getRequestProperty("X-Request-Id"))
            assertArrayEquals(bytes, connection.sent.toByteArray())
            assertEquals(bytes.size.toLong(), connection.fixedBytes)
            assertFalse(connection.instanceFollowRedirects)
        }
    } }

    @Test fun filesOnlyMessagesSurviveHistoryAndEventsWithoutAcceptingPartialInvalidPages() {
        val thread = UUID.randomUUID().toString()
        val upload = attachment()
        val input = Message(UUID.randomUUID().toString(), thread, "user", "", "stable_request", attachments = listOf(upload))
        val output = Message(UUID.randomUUID().toString(), thread, "assistant", "", "stable_request",
            attachments = listOf(attachment().copy(direction = "companion", caption = "Your file")))
        val snapshot = Snapshot(listOf(ChatThread(thread, "Files")), thread, listOf(input, output), "3", Runtime("ready", "claude"))
        val restored = Json.decodeFromString<Snapshot>(Json.encodeToString(snapshot))
        assertEquals(snapshot, checkedSnapshot(restored, thread))
        assertEquals(upload, restored.messages.first().attachments.single())
        val page = EventPage(thread, listOf(Event(1, thread, "message", message = input),
            Event(2, thread, "message", message = output), Event(3, thread, "turn", requestId = "stable_request", state = "complete")), "3", 3, false)
        assertEquals(page, checkedEventPage(Json.decodeFromString(Json.encodeToString(page)), thread, "0"))
        val malformed = output.copy(attachments = listOf(output.attachments.single().copy(url = "https://foreign.invalid/file")))
        denied("INVALID_RESPONSE") { checkedEventPage(page.copy(events = listOf(page.events.first(), page.events[1].copy(message = malformed), page.events.last())), thread, "0") }
        denied("INVALID_RESPONSE") { checkedEventPage(page.copy(events = page.events.drop(1)), thread, "0") }
        denied("INVALID_RESPONSE") { checkedSnapshot(snapshot.copy(messages = listOf(input.copy(attachments = List(9) { attachment() }))), thread) }
        denied("INVALID_RESPONSE") { checkedSnapshot(snapshot.copy(messages = listOf(input.copy(threadId = UUID.randomUUID().toString()))), thread) }
        // Legacy text-only JSON continues to decode with no attachment field.
        val legacy = """{"id":"${UUID.randomUUID()}","threadId":"$thread","role":"user","text":"hello"}"""
        assertTrue(checkedMessage(Json.decodeFromString(legacy), thread).attachments.isEmpty())
    }

    @Test fun onlyTheSameCommittedMessageAndFileSetCanConfirmAnUncertainSubmission() {
        val thread = UUID.randomUUID().toString(); val a = attachment(); val b = attachment()
        val pending = PendingSend("stable-send", thread, " exact text ", listOf(a, b))
        val confirmed = Message(UUID.randomUUID().toString(), thread, "user", pending.text, pending.requestId, attachments = listOf(b, a))
        assertTrue(matchesSubmission(confirmed, pending))
        assertEquals(listOf(a.id, b.id), pending.files.map { it.id }) // Retry retains the original order.
        listOf(confirmed.copy(role = "assistant"), confirmed.copy(threadId = UUID.randomUUID().toString()),
            confirmed.copy(requestId = "another-send"), confirmed.copy(text = pending.text.trim()),
            confirmed.copy(attachments = listOf(a))).forEach { assertFalse(matchesSubmission(it, pending)) }
    }

    @Test fun downloadsVerifyTheWholeBodyAndRemovePartialOrCorruptCopies() = temporary { folder -> runBlocking {
        val bytes = ByteArray(70_000) { (it % 127).toByte() }; val file = attachment(bytes)
        val calls = mutableListOf<FakeConnection>()
        val api = FileTransfers({ owner() }) { url -> FakeConnection(url, bytes).also { calls += it } }
        val output = File(folder, "verified")
        assertEquals(output, api.download(file, output, TransferCancellation()))
        assertArrayEquals(bytes, output.readBytes())
        assertEquals("GET", calls.single().requestMethod)
        assertFalse(calls.single().url.toString().contains("private-token"))
        assertEquals("app_session=alice-private-token", calls.single().getRequestProperty("Cookie"))
        val corrupt = File(folder, "corrupt")
        try { api.download(file.copy(sha256 = "0".repeat(64)), corrupt, TransferCancellation()); fail("Hash mismatch") }
        catch (error: ApiException) { assertEquals("INVALID_RESPONSE", error.code) }
        assertFalse(corrupt.exists())
        val cancelled = File(folder, "cancelled"); val cancellation = TransferCancellation()
        try { api.download(file, cancelled, cancellation) { cancellation.cancel() }; fail("Cancellation") }
        catch (error: ApiException) { assertEquals("CANCELLED", error.code) }
        assertFalse(cancelled.exists()); assertTrue(calls.last().disconnected)
        val empty = File(folder, "empty")
        val emptyApi = FileTransfers({ owner() }) { url -> FakeConnection(url, byteArrayOf()) }
        emptyApi.download(attachment(), empty, TransferCancellation())
        assertEquals(0, empty.length())
    } }

    @Test fun redirectsAndAuthFailuresNeverExposeTokensOrReachAnotherHost() = temporary { folder -> runBlocking {
        val file = attachment(); val calls = mutableListOf<FakeConnection>()
        for (status in listOf(302, 401, 403)) {
            val api = FileTransfers({ owner() }) { url -> FakeConnection(url, "private-token-canary".toByteArray(), status).also { calls += it } }
            val destination = File(folder, "result-$status")
            try { api.download(file, destination, TransferCancellation()); fail("HTTP denial") }
            catch (error: ApiException) {
                assertEquals(status, error.status); assertEquals(status in listOf(401, 403), error.signedOut)
                assertFalse(error.toString().contains("canary")); assertFalse(error.toString().contains("private-token"))
            }
            assertFalse(destination.exists()); assertFalse(calls.last().instanceFollowRedirects)
        }
        assertEquals(3, calls.size)
        val unauthenticated = FileTransfers({ null }) { throw AssertionError("Must not open a connection") }
        try { unauthenticated.download(file, File(folder, "anonymous"), TransferCancellation()); fail("Session required") }
        catch (error: ApiException) { assertTrue(error.signedOut) }
    } }

    private class FakeConnection(url: URL, private val bytes: ByteArray, private val status: Int = 200) : HttpURLConnection(url) {
        val sent = ByteArrayOutputStream()
        var fixedBytes = -1L
        var loseAck = false
        var disconnected = false
        override fun connect() {}
        override fun usingProxy() = false
        override fun disconnect() { disconnected = true }
        override fun getOutputStream() = sent
        override fun getInputStream() = ByteArrayInputStream(bytes)
        override fun getErrorStream() = ByteArrayInputStream(bytes)
        override fun getResponseCode(): Int { if (loseAck) throw IOException("synthetic lost ACK"); return status }
        override fun getHeaderField(name: String?): String? = null
        override fun setFixedLengthStreamingMode(length: Long) { fixedBytes = length; super.setFixedLengthStreamingMode(length) }
    }
}
