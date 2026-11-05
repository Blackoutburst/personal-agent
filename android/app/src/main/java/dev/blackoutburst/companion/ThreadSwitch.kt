package dev.blackoutburst.companion

// #66: moving between conversations (main chat, a past chat, a Board sub-conversation, a notification tap).
// Like the web client's open()/select(), opening another conversation always shows it: nothing of the previous one
// (its reply in progress, an unconfirmed send, picked files, the read-only marker, the Board topic) stays on screen.

/** The state for showing [threadId] (null: the ongoing main chat) while its snapshot loads. */
internal fun UiState.showingThread(threadId: String?, boardTopic: String? = null, boardLabel: String? = null,
    boardArchived: Boolean = false, archivedAt: Long? = null): UiState = copy(
    threadId = threadId, boardThread = boardTopic, boardLabel = if (boardTopic == null) null else boardLabel,
    boardArchivedTopic = boardTopic != null && boardArchived, archivedAt = archivedAt,
    messages = emptyList(), turn = null, waitingFor = null, uploads = emptyList(), fileError = null, sendFailed = false)

/** A notification tap needs to switch only when that conversation is not already the one shown, in the same role. */
internal fun pushOpensThread(state: UiState, threadId: String, board: Boolean): Boolean =
    if (board) state.threadId != threadId || state.boardThread != threadId
    else state.threadId != threadId || state.boardThread != null || state.archivedAt != null

/** Only "Start a new chat" in flight holds the owner in place: its retry must stay on the chat it archives. */
internal fun canSwitchThread(state: UiState, archivePending: Boolean): Boolean = !state.archiving && !archivePending

/**
 * Tab requests from notification taps are counters in the model. The UI acts on each value once, so recreating the
 * screen (rotation, theme change) does not replay an old notification's tab. A sign-out starts the counters at 0 again.
 */
internal class NavRequests {
    private val handled = mutableMapOf<String, Long>()
    fun take(kind: String, value: Long): Boolean {
        if (value == (handled[kind] ?: 0L)) return false
        handled[kind] = value
        return value > 0
    }
}
