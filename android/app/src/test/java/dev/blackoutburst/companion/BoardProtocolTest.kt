package dev.blackoutburst.companion

import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class BoardProtocolTest {
    private val thread = "077234d7-35b5-4dab-b4ca-7ca44fab70ea"
    private val other = "5f7d082a-4ba8-4b0a-81bc-bb80103d471e"
    private fun inbox(rows: String, unread: Int = 2, any: Boolean = true) = Json.parseToJsonElement(
        """{"version":1,"synthetic":false,"threads":[$rows],"unread":$unread,"any":$any}""")
    private fun row(id: String = thread, extra: String = "") =
        """{"threadId":"$id","label":"#15 · Fix login","ticketNumber":15,"general":false,"archived":false,"unread":2,"updatedAt":1762257600000,"preview":"Codex asks whether to ship.","previewRole":"assistant"$extra}"""

    @Test fun parsesTheBoardTabListWithItsBadge() {
        val result = parseBoardInbox(inbox(row() + "," + row(other, "").replace("\"previewRole\":\"assistant\"", "\"previewRole\":\"user\"")))
        assertEquals(2, result.threads.size)
        assertEquals(2, result.unread)
        assertTrue(result.any)
        assertEquals("#15 · Fix login", result.threads[0].label)
        assertEquals(15, result.threads[0].ticketNumber)
        assertEquals("Codex asks whether to ship.", boardPreview(result.threads[0]))
        assertEquals("You: Codex asks whether to ship.", boardPreview(result.threads[1]))
    }

    @Test fun toleratesMissingOptionalFieldsAndUnknownOnes() {
        val result = parseBoardInbox(Json.parseToJsonElement("""{"threads":[{"threadId":"$thread","label":"Board","future":1}]}"""))
        assertEquals(0, result.unread); assertFalse(result.any)
        assertEquals(0, result.threads[0].unread); assertNull(result.threads[0].preview)
    }

    @Test fun refusesMalformedLists() {
        for (bad in listOf(inbox(row() + "," + row()), inbox(row("th1")), inbox(row(extra = ",\"unread\":-1").replace("\"unread\":2,", "")),
            inbox(row().replace("#15 · Fix login", "")), inbox(row(), unread = -3),
            inbox(row().replace("\"previewRole\":\"assistant\"", "\"previewRole\":\"system\"")))) {
            try { parseBoardInbox(bad); fail("accepted $bad") } catch (error: ApiException) { assertEquals("INVALID_RESPONSE", error.code) }
        }
    }

    @Test fun changesMustAnswerForTheSameThread() {
        val change = parseBoardChange(Json.parseToJsonElement("""{"version":1,"synthetic":false,"threadId":"$thread","archived":true,"unread":0}"""), thread)
        assertEquals(BoardChange(thread, 0, true), change)
        assertEquals(BoardChange(thread, 3, null), parseBoardChange(Json.parseToJsonElement("""{"threadId":"$thread","unread":3}"""), thread))
        try { parseBoardChange(Json.parseToJsonElement("""{"threadId":"$other","unread":0}"""), thread); fail() }
        catch (error: ApiException) { assertEquals("INVALID_RESPONSE", error.code) }
    }

    @Test fun boardPushesAreFlaggedWithoutText() {
        assertTrue(boardPush(mapOf("type" to "message", "threadId" to thread, "messageId" to other, "board" to "1")))
        assertFalse(boardPush(mapOf("type" to "message", "threadId" to thread, "messageId" to other)))
    }
}
