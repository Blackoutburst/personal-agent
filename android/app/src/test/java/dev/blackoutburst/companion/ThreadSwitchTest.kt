package dev.blackoutburst.companion

import org.junit.Assert.*
import org.junit.Test

// #66: changing conversations on Android.
class ThreadSwitchTest {
    private val main = "077234d7-35b5-4dab-b4ca-7ca44fab70ea"
    private val topic = "5f7d082a-4ba8-4b0a-81bc-bb80103d471e"
    private val other = "8b3b0f0e-8f7a-4c55-9a43-2f0c1c7a9d10"
    private val past = "a9e1c3b4-1d2e-4f5a-8b6c-7d8e9f0a1b2c"
    private val upload = PendingUpload("k1", main, "photo.jpg")

    private fun onTopic() = UiState(threadId = topic, boardThread = topic, boardLabel = "#15 · Fix login", boardArchivedTopic = true,
        messages = listOf(Message("m1", topic, "assistant", "Topic reply")), turn = Turn("r1", "streaming"), waitingFor = "r2",
        uploads = listOf(upload), fileError = "x", sendFailed = true)

    @Test fun openingAnotherTopicShowsNothingOfThePreviousOne() {
        val next = onTopic().showingThread(other, boardTopic = other, boardLabel = "#16 · Other", boardArchived = false)
        assertEquals(other, next.threadId); assertEquals(other, next.boardThread)
        assertEquals("#16 · Other", next.boardLabel); assertFalse(next.boardArchivedTopic)
        assertTrue(next.messages.isEmpty()); assertNull(next.turn); assertNull(next.waitingFor)
        assertTrue(next.uploads.isEmpty()); assertNull(next.fileError); assertFalse(next.sendFailed)
        // A reply still waiting in the previous conversation no longer shows as typing in this one.
        assertFalse(next.replying)
    }

    @Test fun leavingATopicForTheMainChatClearsTheTopic() {
        val next = onTopic().showingThread(null)
        assertNull(next.threadId); assertNull(next.boardThread); assertNull(next.boardLabel); assertFalse(next.boardArchivedTopic)
        assertNull(next.archivedAt); assertFalse(next.replying); assertTrue(next.uploads.isEmpty())
    }

    @Test fun aPastChatIsReadOnlyAtOnceAndBackClearsIt() {
        val start = UiState(threadId = main, messages = listOf(Message("m1", main, "user", "hi")), uploads = listOf(upload), sendFailed = true)
        val archived = start.showingThread(past, archivedAt = 1762257600000)
        assertEquals(past, archived.threadId); assertEquals(1762257600000, archived.archivedAt)
        assertNull(archived.boardThread); assertTrue(archived.messages.isEmpty()); assertTrue(archived.uploads.isEmpty()); assertFalse(archived.sendFailed)
        val back = archived.showingThread(null)
        assertNull(back.threadId); assertNull(back.archivedAt)
        // Another past chat from there.
        assertEquals(other, archived.showingThread(other, archivedAt = 1).threadId)
    }

    @Test fun aNotificationSwitchesUnlessThatConversationIsAlreadyShownTheSameWay() {
        val chat = UiState(threadId = main)
        assertFalse(pushOpensThread(chat, main, board = false))
        assertTrue(pushOpensThread(chat, other, board = false))
        assertTrue(pushOpensThread(chat, topic, board = true))
        val board = UiState(threadId = topic, boardThread = topic)
        assertFalse(pushOpensThread(board, topic, board = true))
        assertTrue(pushOpensThread(board, other, board = true))
        assertTrue(pushOpensThread(board, main, board = false))
        // The same id shown as a Board topic or read-only used to be skipped and the tap left it there.
        assertTrue(pushOpensThread(board, topic, board = false))
        assertTrue(pushOpensThread(UiState(threadId = main, archivedAt = 1), main, board = false))
        // A main thread id selected but not marked as a topic is opened as a topic.
        assertTrue(pushOpensThread(UiState(threadId = topic), topic, board = true))
    }

    @Test fun onlyANewChatInFlightHoldsTheOwnerInPlace() {
        assertTrue(canSwitchThread(UiState(uploads = listOf(upload)), archivePending = false))
        assertTrue(canSwitchThread(UiState(sending = true, sendFailed = true, voiceSending = true), archivePending = false))
        assertFalse(canSwitchThread(UiState(archiving = true), archivePending = false))
        assertFalse(canSwitchThread(UiState(), archivePending = true))
    }

    @Test fun eachNotificationTabIsTakenOnce() {
        val requests = NavRequests()
        assertFalse(requests.take("chat", 0))
        assertTrue(requests.take("chat", 1))
        // The screen is recreated (rotation, dark mode): the same request is not replayed.
        assertFalse(requests.take("chat", 1))
        assertFalse(requests.take("board", 0))
        assertTrue(requests.take("board", 1))
        assertTrue(requests.take("chat", 2))
        // A sign-out starts the model's counters again: the next notification still counts.
        assertFalse(requests.take("chat", 0))
        assertTrue(requests.take("chat", 1))
    }
}
