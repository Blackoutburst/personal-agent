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

    // #61b: a silent Board wake's activity line (role "app") in a Board conversation.
    @Test fun appActivityLinesParseAndUnknownRolesAreSkippedNotFatal() {
        val note = "8b3b0f0e-8f7a-4c55-9a43-2f0c1c7a9d10"
        val line = Message(note, thread, "app", "Claude answered on the Board.", url = "https://board.example/?thread=th1&message=p1", preview = "Fixed <b>it</b>.")
        val unknown = Message("a9e1c3b4-1d2e-4f5a-8b6c-7d8e9f0a1b2c", thread, "event", "Something new")
        val snapshot = Snapshot(listOf(ChatThread(thread, "#15 · Fix login")), thread, listOf(line, unknown), "2", Runtime("ready", "claude"))
        val decoded = Json { ignoreUnknownKeys = true }.decodeFromString(Snapshot.serializer(), Json.encodeToString(Snapshot.serializer(), snapshot))
        assertEquals(listOf(line), checkedSnapshot(decoded, thread).messages)
        val page = EventPage(thread, listOf(Event(1, thread, "message", message = line), Event(2, thread, "message", message = unknown)), "2", 2, false)
        val checked = checkedEventPage(page, thread, "0")
        assertEquals(line, checked.events[0].message)
        assertEquals("noop", checked.events[1].type); assertNull(checked.events[1].message)
        assertEquals(line.copy(url = null, preview = null), checkedMessage(line.copy(url = null, preview = null), thread))
        for (bad in listOf(line.copy(url = "javascript:alert(1)"), line.copy(url = "https://user:pw@board.example/"), line.copy(url = "https://board.example/ x"),
            line.copy(requestId = "wake-x"), line.copy(feeling = "happy"), line.copy(text = ""), line.copy(text = "x".repeat(301)),
            line.copy(preview = "x".repeat(201)), line.copy(role = "assistant"))) {
            try { checkedMessage(bad, thread); fail("Expected INVALID_RESPONSE for $bad") } catch (error: ApiException) { assertEquals("INVALID_RESPONSE", error.code) }
        }
        assertEquals("https://board.example/?thread=th1", boardLink("https://board.example/?thread=th1"))
        assertNull(boardLink("file:///etc/passwd"))
    }

    @Test fun badgeReadsOneToNineThenNinePlus() {
        assertEquals("1", badgeText(1)); assertEquals("9", badgeText(9))
        assertEquals("9+", badgeText(10)); assertEquals("9+", badgeText(250))
        assertEquals("0", badgeText(-3))
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
