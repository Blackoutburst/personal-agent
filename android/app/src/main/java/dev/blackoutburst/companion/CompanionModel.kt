package dev.blackoutburst.companion

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import java.time.LocalTime
import java.time.ZoneId
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

enum class Gate { Loading, SignedOut, Ready }

data class UiState(
    val gate: Gate = Gate.Loading,
    val signingIn: Boolean = false,
    val signInError: String? = null,
    val username: String? = null,
    val profile: Profile? = null,
    val runtime: Runtime? = null,
    val threadId: String? = null,
    val messages: List<Message> = emptyList(),
    val turn: Turn? = null,
    /** The request id of a message that was sent and has no reply yet. */
    val waitingFor: String? = null,
    val sending: Boolean = false,
    val sendFailed: Boolean = false,
    val offline: Boolean = false,
    val happyUntil: Long = 0,
    val memories: List<MemoryFile>? = null,
    val memoriesFailed: Boolean = false,
    val saving: Boolean = false,
) {
    val name get() = profile?.name ?: "Your companion"
    val replying get() = turn?.state == "streaming" || waitingFor != null
}

class CompanionModel(application: Application) : AndroidViewModel(application) {
    private val store = SessionStore(application)
    private val settings = application.getSharedPreferences("settings", android.content.Context.MODE_PRIVATE)
    private val _theme = MutableStateFlow(
        ThemeChoice.entries.firstOrNull { it.name == settings.getString("theme", null) } ?: ThemeChoice.System)
    val theme: StateFlow<ThemeChoice> = _theme
    private val api = Api { store.session }
    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state

    private var cursor = "0"
    private val syncing = Mutex()
    private var poller: Job? = null
    private var visible = false
    private var failedSend: Pair<String, String>? = null // (requestId, text): a retry reuses the id

    init { load() }

    fun setTheme(choice: ThemeChoice) {
        _theme.value = choice
        settings.edit().putString("theme", choice.name).apply()
    }

    // ---- Sign-in ----

    fun startSignIn(): Uri {
        val (pending, uri) = SignIn.start()
        store.pending = pending
        _state.update { it.copy(signingIn = true, signInError = null) }
        return uri
    }

    fun signInLink(uri: Uri) {
        val pending = store.pending
        val code = SignIn.codeFrom(uri, pending)
        store.pending = null
        if (code == null || pending == null) {
            _state.update { it.copy(signingIn = false, signInError = "That sign-in link didn't work. Please try again.") }
            return
        }
        viewModelScope.launch {
            try {
                val session = api.exchange(code, pending.verifier)
                store.session = Session(session.token, session.cookie, session.expiresAt, session.user?.username)
                _state.update { UiState(gate = Gate.Loading) }
                load()
            } catch (error: ApiException) {
                _state.update { it.copy(signingIn = false, signInError = if (error.code == "NETWORK") "Couldn't reach the server. Please try again." else "That sign-in didn't work. Please try again.") }
            }
        }
    }

    /** The browser was closed without coming back through the link. */
    fun signInAbandoned() { if (store.pending != null || _state.value.signingIn) _state.update { it.copy(signingIn = false) } }

    fun signOut() {
        viewModelScope.launch {
            api.signOut()
            signedOut()
        }
    }

    private fun signedOut() {
        store.session = null
        poller?.cancel()
        cursor = "0"
        _state.value = UiState(gate = Gate.SignedOut)
    }

    // ---- Companion ----

    fun load() {
        val session = store.session
        if (session == null || session.expired) { signedOut(); return }
        viewModelScope.launch {
            try {
                val info = api.companionInfo()
                _state.update { it.copy(gate = Gate.Ready, username = session.username, profile = info.profile, runtime = info.runtime, offline = false) }
                resync()
                startPolling()
            } catch (error: ApiException) {
                if (error.signedOut) signedOut()
                else { _state.update { it.copy(gate = Gate.Ready, username = session.username, offline = true) }; startPolling() }
            }
        }
    }

    fun setVisible(value: Boolean) {
        visible = value
        if (value && _state.value.gate == Gate.Ready) { viewModelScope.launch { guarded { resync() } }; startPolling() }
    }

    fun saveProfile(name: String, character: String, color: String, done: () -> Unit) {
        val timezone = _state.value.profile?.timezone ?: ZoneId.systemDefault().id
        _state.update { it.copy(saving = true) }
        viewModelScope.launch {
            guarded {
                val profile = api.setProfile(Profile(name.trim(), character, color, timezone))
                _state.update { it.copy(profile = profile) }
                done()
            }
            _state.update { it.copy(saving = false) }
        }
    }

    fun loadMemories() {
        viewModelScope.launch {
            _state.update { it.copy(memoriesFailed = false) }
            if (!guarded { val memories = api.memories(); _state.update { it.copy(memories = memories.files) } })
                _state.update { it.copy(memoriesFailed = true) }
        }
    }

    fun forget(file: String, id: String) {
        viewModelScope.launch {
            guarded { val memories = api.forget(file, id); _state.update { it.copy(memories = memories.files) } }
        }
    }

    // ---- Chat ----

    fun send(text: String, onSent: () -> Unit) {
        val message = text.trim()
        val now = _state.value
        if (message.isEmpty() || now.sending || now.replying || message.length > 8000) return
        val requestId = failedSend?.takeIf { it.second == message }?.first ?: Pkce.randomToken(16)
        _state.update { it.copy(sending = true, sendFailed = false) }
        viewModelScope.launch {
            try {
                val threadId = now.threadId ?: api.createThread(Pkce.randomToken(16), "Companion").id.also { created ->
                    cursor = "0"
                    _state.update { it.copy(threadId = created, messages = emptyList(), turn = null) }
                }
                val messageId = api.submit(requestId, threadId, message)
                failedSend = null
                _state.update { state ->
                    val mine = Message(messageId, threadId, "user", message, requestId)
                    state.copy(sending = false, waitingFor = requestId, turn = null,
                        messages = if (state.messages.any { it.id == messageId }) state.messages else state.messages + mine)
                }
                onSent()
                startPolling()
            } catch (error: ApiException) {
                if (error.signedOut) { signedOut(); return@launch }
                failedSend = requestId to message
                _state.update { it.copy(sending = false, sendFailed = true, offline = error.code == "NETWORK") }
            }
        }
    }

    fun stop() {
        val state = _state.value
        val requestId = state.turn?.takeIf { it.state == "streaming" }?.requestId ?: state.waitingFor ?: return
        val threadId = state.threadId ?: return
        viewModelScope.launch { guarded { api.cancel(requestId, threadId) } }
    }

    fun mood(typing: Boolean, now: Long = System.currentTimeMillis()): Mood {
        val state = _state.value
        val turn = state.turn
        if (state.sending || state.waitingFor != null) return Mood.Thinking
        if (turn?.state == "streaming")
            return if (state.messages.any { it.role == "assistant" && it.requestId == turn.requestId && it.text.isNotEmpty() }) Mood.Talking else Mood.Thinking
        if (now < state.happyUntil) return Mood.Happy
        if (typing) return Mood.Listening
        val zone = runCatching { ZoneId.of(state.profile?.timezone ?: "") }.getOrDefault(ZoneId.systemDefault())
        val hour = LocalTime.now(zone).hour
        return if (hour >= 23 || hour < 7) Mood.Sleepy else Mood.Idle
    }

    // ---- Sync ----

    private fun startPolling() {
        if (poller?.isActive == true) return
        poller = viewModelScope.launch {
            while (isActive && _state.value.gate == Gate.Ready) {
                if (!visible) { delay(1000); continue }
                guarded { sync() }
                delay(if (_state.value.replying || _state.value.sending) 500 else 3000)
            }
        }
    }

    private suspend fun resync() = syncing.withLock {
        val snapshot = api.snapshot(_state.value.threadId)
        cursor = snapshot.cursor
        _state.update { state ->
            val waiting = state.waitingFor?.takeIf { id -> snapshot.turn?.requestId != id && snapshot.messages.none { it.role == "assistant" && it.requestId == id } }
            state.copy(threadId = snapshot.threadId, messages = snapshot.messages, runtime = snapshot.runtime,
                turn = snapshot.turn ?: state.turn?.takeIf { it.state != "streaming" }, waitingFor = waiting, offline = false)
        }
    }

    private suspend fun sync() {
        val threadId = _state.value.threadId ?: return resync()
        val needsResync = syncing.withLock {
            var more = true
            while (more) {
                val page = try { api.events(threadId, cursor) } catch (error: ApiException) {
                    if (error.status == 400 || error.status == 404 || error.status == 409) return@withLock true else throw error
                }
                if (page.threadId != threadId) return@withLock true
                applyEvents(page.events)
                cursor = page.cursor
                more = page.hasMore
            }
            false
        }
        if (needsResync) resync()
        _state.update { it.copy(offline = false) }
    }

    private fun applyEvents(events: List<Event>) = _state.update { start ->
        events.fold(start) { state, event ->
            when (event.type) {
                "message" -> {
                    val message = event.message ?: return@fold state
                    val index = state.messages.indexOfFirst { it.id == message.id }
                    val messages = if (index < 0) (state.messages + message).takeLast(500)
                    else state.messages.toMutableList().also { it[index] = message }
                    state.copy(messages = messages)
                }
                "turn" -> {
                    val turn = Turn(event.requestId ?: return@fold state, event.state ?: return@fold state, event.error)
                    val finished = turn.state != "streaming"
                    val happy = turn.state == "complete" && (state.turn?.requestId == turn.requestId || state.waitingFor == turn.requestId)
                    state.copy(turn = turn,
                        waitingFor = state.waitingFor?.takeIf { it != turn.requestId },
                        happyUntil = if (happy && finished) System.currentTimeMillis() + 3500 else state.happyUntil)
                }
                else -> state
            }
        }
    }

    /** Runs a server call; false when it failed. A lost session signs out, a lost connection shows. */
    private suspend fun guarded(block: suspend () -> Unit): Boolean = try {
        block(); true
    } catch (error: ApiException) {
        if (error.signedOut) signedOut() else if (error.code == "NETWORK") _state.update { it.copy(offline = true) }
        false
    }
}
