package dev.blackoutburst.companion

import android.app.Application
import android.net.Uri
import android.provider.OpenableColumns
import android.provider.DocumentsContract
import java.io.File
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import java.time.LocalTime
import java.time.ZoneId
import kotlinx.coroutines.Job
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

enum class Gate { Loading, SignedOut, Ready }

/** #59: the app counts as in active use for this long after the last touch; reported this often while it is. */
private const val ACTIVE_INPUT_MS = 120_000L
private const val ACTIVE_BEAT_MS = 20_000L

data class UiState(
    val scope: Long = 0,
    val gate: Gate = Gate.Loading,
    val signingIn: Boolean = false,
    val signInError: String? = null,
    val username: String? = null,
    val profile: Profile? = null,
    /** The outfit she wears now (the server picks it when automatic). */
    val wearing: String = "base",
    val runtime: Runtime? = null,
    val threadId: String? = null,
    /** Bumped when a notification tap asks for the Chat tab. */
    val chatRequest: Long = 0,
    /** Ask for the notification permission now (once, after the first message the owner sends). */
    val askNotifications: Boolean = false,
    val chatLoading: Boolean = false,
    val messages: List<Message> = emptyList(),
    val turn: Turn? = null,
    /** The request id of a message that was sent and has no reply yet. */
    val waitingFor: String? = null,
    val sending: Boolean = false,
    val sendFailed: Boolean = false,
    val uploads: List<PendingUpload> = emptyList(),
    val fileError: String? = null,
    /** A recorded voice message is being uploaded and sent / was not confirmed (retry or discard). */
    val voiceSending: Boolean = false,
    val voiceFailed: Boolean = false,
    val archiving: Boolean = false,
    val archiveFailed: Boolean = false,
    /** Set while an archived (read-only) chat is open. */
    val archivedAt: Long? = null,
    val pastChats: List<ArchivedThread>? = null,
    val pastChatsLoading: Boolean = false,
    val pastChatsFailed: Boolean = false,
    val offline: Boolean = false,
    val happyUntil: Long = 0,
    val memories: List<MemoryFile>? = null,
    val memoriesFailed: Boolean = false,
    val memoryRevision: String? = null,
    val memoryLoading: Boolean = false,
    val memoryBusy: Boolean = false,
    val memoryError: String? = null,
    val memoryErrorCode: String? = null,
    val memoryNotice: String? = null,
    val memoryDraft: MemoryDraft? = null,
    val personality: Personality? = null,
    val personalityDraft: PersonalityDraft? = null,
    val personalityVersion: PersonalityVersion? = null,
    val personalityLoading: Boolean = false,
    val personalityVersionLoading: Boolean = false,
    val personalityBusy: Boolean = false,
    val personalityError: String? = null,
    val personalityErrorCode: String? = null,
    val personalityNotice: String? = null,
    val contacts: List<CompanionContact>? = null,
    val contactsLoading: Boolean = false,
    val contactsBusy: Boolean = false,
    val contactsConfirmed: Boolean = false,
    val contactsError: String? = null,
    val contactsNotice: String? = null,
    val ownerProfile: OwnerProfileReply? = null,
    val ownerProfileLoading: Boolean = false,
    val ownerProfileBusy: Boolean = false,
    val ownerProfileConfirmed: Boolean = false,
    val ownerProfileError: String? = null,
    val ownerProfileNotice: String? = null,
    val weather: WeatherSnapshot? = null,
    val weatherBusy: Boolean = false,
    val weatherError: String? = null,
    val saving: Boolean = false,
    val discord: DiscordStatus? = null,
    val discordBusy: Boolean = false,
    val discordError: String? = null,
    val connectors: List<Connector>? = null,
    val connectorsBusy: Boolean = false,
    val connectorsError: String? = null,
    /** Calendar (#44, month grid #47), the Calendar tab. calendarMonth: "2026-11"; calendarDay: the selected day. */
    val calendar: CalendarView? = null,
    val calendarMonth: String? = null,
    val calendarDay: String? = null,
    val calendarBusy: Boolean = false,
    val calendarError: String? = null,
    val calendarNotice: String? = null,
    /** Me › Watches and schedule settings (api/schedules). */
    val schedules: Schedules? = null,
    val schedulesLoading: Boolean = false,
    val schedulesBusy: Boolean = false,
    val schedulesError: String? = null,
    val schedulesNotice: String? = null,
    /** A watch change whose result never came back: retried only on request, with the same request id. */
    val watchRetry: WatchChange? = null,
    /** Board tab (#55): the list shown (open or archived), the badge, and the Board sub-conversation open in the chat. */
    val boardTopics: List<BoardTopic>? = null,
    val boardShowArchived: Boolean = false,
    val boardUnread: Int = 0,
    val boardAny: Boolean = false,
    val boardLoading: Boolean = false,
    val boardBusy: Boolean = false,
    val boardError: String? = null,
    val boardThread: String? = null,
    val boardLabel: String? = null,
    val boardArchivedTopic: Boolean = false,
    /** Bumped when a notification tap asks for the Board tab. */
    val boardRequest: Long = 0,
) {
    val name get() = profile?.name ?: "Your companion"
    val replying get() = turn?.state == "streaming" || waitingFor != null
}

data class WatchChange(val requestId: String, val watch: Watch, val operation: String, val condition: String? = null, val intervalHours: Int? = null)

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
    private var failedSend: PendingSend? = null
    private var pendingArchive: PendingArchive? = null
    private var createKey: String? = null
    @Volatile private var scope = 0L
    /** A picker result that arrived while the chat was reloading (see attachFiles). */
    private var pendingPick: Pair<List<Uri>, Long>? = null
    private val creating = Mutex()
    private val uploadSources = mutableMapOf<String, Uri>()
    private val transfers = mutableMapOf<String, TransferCancellation>()
    private val uploadJobs = mutableMapOf<String, Job>()
    private val mediaTransfers = mutableSetOf<TransferCancellation>()
    private val mediaLock = Mutex()
    private val mediaCache = mutableMapOf<String, File>()
    @Volatile private var memoryEpoch = 0L
    private var memoryJob: Job? = null
    private val memoryExports = mutableSetOf<TransferCancellation>()
    @Volatile private var personalityEpoch = 0L
    private var personalityVersionEpoch = 0L
    private var personalityJob: Job? = null
    private var personalityVersionJob: Job? = null
    @Volatile private var contactsEpoch = 0L
    private var contactsJob: Job? = null
    @Volatile private var ownerProfileEpoch = 0L
    private var ownerProfileJob: Job? = null
    // Notification taps that arrive before sign-in finished; the Board tab's topics and read marker (#55).
    private var pendingThread: String? = null
    private var pendingBoard = false
    private var boardAt = 0L
    private var boardReadKey: String? = null
    private val boardTopics = mutableMapOf<String, BoardTopic>()
    /** Group chat (#53): its own state and polling; reset with every sign-out or account switch. */
    val groups = GroupChat(application, viewModelScope, api) { signedOut() }

    init {
        // An interrupted prior process must not leave an unbounded or reusable private media cache.
        invalidateFiles()
        _state.value = UiState(scope = scope)
        load()
    }

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
        val version = scope
        viewModelScope.launch {
            if (!current(version)) return@launch
            try {
                val session = api.exchange(code, pending.verifier)
                if (!current(version)) return@launch
                invalidateFiles(); groups.reset()
                store.session = Session(session.token, session.cookie, session.expiresAt, session.user?.username)
                _state.update { UiState(scope = scope, gate = Gate.Loading) }
                load()
            } catch (error: ApiException) {
                if (!current(version)) return@launch
                _state.update { it.copy(signingIn = false, signInError = if (error.code == "NETWORK") "Couldn't reach the server. Please try again." else "That sign-in didn't work. Please try again.") }
            }
        }
    }

    /** The browser was closed without coming back through the link. */
    fun signInAbandoned() { if (store.pending != null || _state.value.signingIn) _state.update { it.copy(signingIn = false) } }

    fun signOut() {
        val previousSession = store.session
        endActive(Api { previousSession })
        // Stop this phone's notifications for that account before the session goes away.
        viewModelScope.launch { Push.unregister(Api { previousSession }) }
        // Fence the display immediately, even while logout is in flight.
        invalidateFiles(); groups.reset()
        store.session = null
        _state.value = UiState(scope = scope, gate = Gate.SignedOut)
        val version = scope
        viewModelScope.launch {
            Api { previousSession }.signOut()
            if (current(version)) signedOut()
        }
    }

    private fun signedOut() {
        endActive(null)
        invalidateFiles(); groups.reset()
        store.session = null
        poller?.cancel()
        cursor = "0"
        boardTopics.clear(); boardReadKey = null
        _state.value = UiState(scope = scope, gate = Gate.SignedOut)
    }

    // ---- Companion ----

    fun load() {
        val session = store.session
        if (session == null || session.expired) { signedOut(); return }
        val version = scope
        viewModelScope.launch {
            if (!current(version)) return@launch
            try {
                val info = api.companionInfo()
                if (!current(version)) return@launch
                _state.update { it.copy(gate = Gate.Ready, username = session.username, profile = info.profile, wearing = info.wearing, runtime = info.runtime, offline = false) }
                Push.register(getApplication(), api)
                pendingThread?.let { id -> pendingThread = null
                    if (pendingBoard) { pendingBoard = false; _state.update { it.copy(threadId = id, boardThread = id) } }
                    else if (id != _state.value.threadId) _state.update { it.copy(threadId = id) } }
                resync()
                refreshBoard(version)
                startPolling()
                groups.start()
            } catch (error: ApiException) {
                if (!current(version)) return@launch
                if (error.signedOut) signedOut()
                else { _state.update { it.copy(gate = Gate.Ready, username = session.username, offline = true) }; startPolling(); groups.start() }
            }
        }
    }

    // ---- Notifications (docs/PUSH.md) ----


    /** A notification was tapped: show the Chat tab on that conversation, or the Board tab on a Board sub-conversation. */
    fun openThread(threadId: String, board: Boolean = false) {
        if (board) {
            _state.update { it.copy(boardRequest = it.boardRequest + 1) }
            if (_state.value.gate != Gate.Ready) { pendingThread = threadId; pendingBoard = true; return }
            if (threadId != _state.value.threadId || _state.value.boardThread != threadId) openBoardTopic(threadId, force = true)
            return
        }
        _state.update { it.copy(chatRequest = it.chatRequest + 1) }
        if (_state.value.gate != Gate.Ready) { pendingThread = threadId; pendingBoard = false; return }
        if (threadId == _state.value.threadId) return
        _state.update { it.copy(threadId = threadId, boardThread = null, messages = emptyList(), turn = null) }
        viewModelScope.launch { guarded { resync() } }
    }

    /** A group notification was tapped (#53): the Group tab on that group. */
    fun openGroup(groupId: String) = groups.openFromPush(groupId, _state.value.gate == Gate.Ready)

    // ---- Board inbox (#55, docs/BOARD-INBOX.md) ----


    /** The Board tab's list (open, or archived) and the badge. */
    fun loadBoard(archived: Boolean = _state.value.boardShowArchived) {
        val version = scope
        _state.update { it.copy(boardShowArchived = archived, boardLoading = true, boardError = null,
            boardTopics = if (it.boardShowArchived == archived) it.boardTopics else null) }
        viewModelScope.launch { refreshBoard(version) }
    }

    private suspend fun refreshBoard(version: Long = scope) {
        boardAt = System.currentTimeMillis()
        val archived = _state.value.boardShowArchived
        try {
            val open = api.boardInbox(false)
            val shown = if (archived) api.boardInbox(true) else open
            if (!current(version)) return
            (open.threads + shown.threads).forEach { boardTopics[it.threadId] = it }
            _state.update { state ->
                val topic = state.boardThread?.let { boardTopics[it] }
                state.copy(boardTopics = if (state.boardShowArchived == archived) shown.threads else state.boardTopics,
                    boardUnread = open.unread, boardAny = open.any || state.boardThread != null, boardLoading = false, boardError = null,
                    boardLabel = topic?.label ?: state.boardLabel, boardArchivedTopic = topic?.archived ?: state.boardArchivedTopic)
            }
        } catch (error: ApiException) {
            if (!current(version)) return
            if (error.signedOut) { signedOut(); return }
            // An older server has no Board inbox (400): the tab simply stays hidden.
            _state.update { it.copy(boardLoading = false, boardError = if (error.status == 400) null else "The Board inbox could not be loaded. Try again in a moment.") }
        }
    }

    /** Opens a Board sub-conversation in the Board tab. Replies there are about its ticket. */
    fun openBoardTopic(threadId: String, force: Boolean = false) {
        val now = _state.value
        if (!fileId(threadId)) return
        if (!force && (now.sending || now.archiving || pendingArchive != null || now.uploads.isNotEmpty())) return
        // A notification tap wins over files picked for another chat: they are dropped, never sent here.
        if (now.uploads.isNotEmpty()) dropUploads()
        cursor = "0"; boardReadKey = null
        val topic = boardTopics[threadId]
        _state.update { it.copy(threadId = threadId, boardThread = threadId, boardLabel = topic?.label, boardArchivedTopic = topic?.archived == true,
            archivedAt = null, messages = emptyList(), turn = null, waitingFor = null, fileError = null, uploads = emptyList()) }
        viewModelScope.launch { guarded { resync() } }
    }

    /** Leaves a Board sub-conversation for the main chat (the Board tab shows its list again). */
    fun leaveBoardTopic() {
        val now = _state.value
        if (now.boardThread == null || now.sending || now.archiving || now.uploads.isNotEmpty()) return
        cursor = "0"; boardReadKey = null
        _state.update { it.copy(threadId = null, boardThread = null, boardLabel = null, boardArchivedTopic = false, archivedAt = null,
            messages = emptyList(), turn = null, waitingFor = null, uploads = emptyList(), fileError = null) }
        val version = scope
        viewModelScope.launch { guarded { resync() }; refreshBoard(version) }
    }

    /** Done (archived) or reopened. A new Board message or a reply reopens an archived topic by itself. */
    fun archiveBoardTopic(threadId: String, archived: Boolean, onDone: () -> Unit = {}) {
        if (_state.value.boardBusy) return
        val version = scope
        _state.update { it.copy(boardBusy = true, boardError = null) }
        viewModelScope.launch {
            try {
                val change = api.boardArchive(threadId, archived)
                if (!current(version)) return@launch
                boardTopics[threadId]?.let { boardTopics[threadId] = it.copy(archived = archived, unread = if (archived) 0 else it.unread) }
                _state.update { it.copy(boardBusy = false, boardUnread = change.unread,
                    boardArchivedTopic = if (it.boardThread == threadId) archived else it.boardArchivedTopic) }
                onDone()
                refreshBoard(version)
            } catch (error: ApiException) {
                if (!current(version)) return@launch
                if (error.signedOut) { signedOut(); return@launch }
                _state.update { it.copy(boardBusy = false, boardError = "That change was not confirmed. Try again.") }
            }
        }
    }

    private fun dropUploads() {
        transfers.values.toList().forEach { it.cancel() }; transfers.clear()
        uploadJobs.values.toList().forEach { it.cancel() }; uploadJobs.clear()
        uploadSources.clear()
        _state.update { it.copy(uploads = emptyList()) }
    }

    /** A Board sub-conversation on screen is read: marked when it opens and when a new companion message arrives. */
    private fun markBoardRead() {
        val state = _state.value
        val threadId = state.boardThread ?: return
        if (!visible || state.threadId != threadId || state.chatLoading) return
        val key = threadId + ":" + (state.messages.lastOrNull { it.role == "assistant" && it.text.isNotEmpty() }?.id ?: "")
        if (key == boardReadKey) return
        boardReadKey = key
        val version = scope
        viewModelScope.launch {
            try { val change = api.boardRead(threadId); if (current(version)) _state.update { it.copy(boardUnread = change.unread) } }
            catch (error: ApiException) { if (current(version)) { if (error.signedOut) signedOut() else boardReadKey = null } }
        }
    }

    fun notificationsAsked() {
        Push.markAsked(getApplication())
        _state.update { it.copy(askNotifications = false) }
    }

    /** Turns notifications on or off for this phone and tells the server. */
    fun setNotifications(enabled: Boolean) {
        Push.setEnabled(getApplication(), enabled)
        viewModelScope.launch { if (enabled) Push.register(getApplication(), api) else Push.unregister(api) }
    }

    fun setVisible(value: Boolean) {
        visible = value
        if (value) lastInput = System.currentTimeMillis()
        reportActive()
        groups.setVisible(value)
        if (value && _state.value.gate == Gate.Ready) { viewModelScope.launch { guarded { resync() }; refreshWearing() }; startPolling() }
    }

    // ---- #59: active client. While the app is in front and was touched in the last 2 minutes it tells the server every
    // 20 s (with the conversation on screen), so the owner's other devices get no push for a message read here. ----
    private val activeClient = java.util.UUID.randomUUID().toString()
    @Volatile private var lastInput = 0L
    private var chatShown = false
    private var activeJob: Job? = null
    private var activeReported = false
    private var activeThread: String? = null
    /** An older server without the action: stop asking until the app restarts. */
    private var activeUnsupported = false

    private fun activeNow() = !activeUnsupported && visible && _state.value.gate == Gate.Ready &&
        System.currentTimeMillis() - lastInput < ACTIVE_INPUT_MS
    private fun threadOnScreen() = _state.value.let { if (chatShown && !it.chatLoading) it.threadId else null }

    /** Any touch or key in the app (MainActivity.onUserInteraction). */
    fun userInput() {
        lastInput = System.currentTimeMillis()
        if (!activeReported) reportActive()
    }

    /** The Chat (or a Board sub-conversation) is on screen, or not. */
    fun setChatShown(value: Boolean) {
        if (chatShown == value) return
        chatShown = value; reportActive()
    }

    private fun reportActive() {
        if (activeNow()) {
            if (activeJob?.isActive != true) activeJob = viewModelScope.launch {
                while (isActive && activeNow()) { activeBeat(); delay(ACTIVE_BEAT_MS) }
                // Ended by the input timeout: the owner walked away, so the conversation on screen does not count as seen.
                if (activeReported) activeIdle(api, if (System.currentTimeMillis() - lastInput >= ACTIVE_INPUT_MS) null else activeThread)
            } else if (activeReported && threadOnScreen() != activeThread) viewModelScope.launch { activeBeat() }
        } else if (activeReported) {
            activeJob?.cancel(); activeJob = null
            val thread = activeThread
            viewModelScope.launch { activeIdle(api, thread) }
        }
    }

    private suspend fun activeBeat() {
        val thread = threadOnScreen()
        activeReported = true; activeThread = thread
        try { api.clientActive(activeClient, true, thread) }
        catch (error: ApiException) { if (error.status == 400) { activeUnsupported = true; activeReported = false } }
    }

    private suspend fun activeIdle(api: Api, thread: String?) {
        activeReported = false; activeThread = null
        try { api.clientActive(activeClient, false, thread) } catch (_: ApiException) { /* the server forgets it on its own */ }
    }

    /** Sign-out: tell the server with the old session (if any), then forget. */
    private fun endActive(previous: Api?) {
        activeJob?.cancel(); activeJob = null
        val thread = activeThread
        if (activeReported && previous != null) viewModelScope.launch { activeIdle(previous, thread) }
        activeReported = false; activeThread = null
    }

    private var wearingAt = 0L
    /** Her outfit follows the time of day: asked again when the app comes back and every 10 minutes. */
    private suspend fun refreshWearing() {
        val version = scope
        wearingAt = System.currentTimeMillis()
        guarded { val info = api.companionInfo(); if (current(version)) _state.update { it.copy(wearing = info.wearing, runtime = info.runtime) } }
    }

    fun saveProfile(name: String, character: String, color: String, outfit: String, done: () -> Unit) {
        val version = scope
        val timezone = _state.value.profile?.timezone ?: ZoneId.systemDefault().id
        _state.update { it.copy(saving = true) }
        viewModelScope.launch {
            if (!current(version)) return@launch
            guarded {
                val saved = api.setProfile(Profile(name.trim(), character, color, timezone, outfit))
                if (!current(version)) return@guarded
                _state.update { it.copy(profile = saved.profile, wearing = saved.wearing) }
                done()
            }
            if (current(version)) _state.update { it.copy(saving = false) }
        }
    }

    // ---- Weather: the owner's city; the outfit and the companion follow the local weather. ----
    fun loadWeather() {
        val version = scope
        viewModelScope.launch {
            try { val result = api.weather(); if (current(version)) _state.update { it.copy(weather = result, weatherError = null) } }
            catch (error: ApiException) {
                if (!current(version)) return@launch
                if (error.signedOut) signedOut() else _state.update { it.copy(weatherError = "The weather could not be loaded.") }
            }
        }
    }

    fun saveWeather(place: String) {
        if (_state.value.weatherBusy) return
        val version = scope
        _state.update { it.copy(weatherBusy = true, weatherError = null) }
        viewModelScope.launch {
            try {
                val result = api.setWeatherPlace(place)
                if (current(version)) _state.update { it.copy(weather = result, wearing = result.wearing ?: it.wearing) }
            } catch (error: ApiException) {
                if (!current(version)) return@launch
                if (error.signedOut) signedOut()
                else _state.update { it.copy(weatherError = when (error.code) {
                    "PLACE_NOT_FOUND" -> "That place was not found. Try a nearby city."
                    "NETWORK" -> "Connection lost. Try again."
                    else -> "The weather service is unavailable right now. Try again later."
                }) }
            } finally { if (current(version)) _state.update { it.copy(weatherBusy = false) } }
        }
    }

    // ---- Connectors (#43) ----
    fun loadConnectors() {
        val version = scope
        viewModelScope.launch {
            try { val result = api.connectors(); if (current(version)) _state.update { it.copy(connectors = result, connectorsError = null) } }
            catch (error: ApiException) {
                if (!current(version)) return@launch
                if (error.signedOut) signedOut() else _state.update { it.copy(connectorsError = "Connectors could not be loaded.") }
            }
        }
    }

    /** GitHub (#45). link: the pasted token, or null to disconnect. onDone runs after a successful change. */
    fun github(token: String?, onDone: () -> Unit = {}) {
        if (_state.value.connectorsBusy) return
        val version = scope
        _state.update { it.copy(connectorsBusy = true, connectorsError = null) }
        viewModelScope.launch {
            try {
                val result = if (token != null) api.githubLink(token) else api.githubUnlink()
                if (current(version)) { _state.update { it.copy(connectors = result) }; onDone() }
            } catch (error: ApiException) {
                if (!current(version)) return@launch
                if (error.signedOut) signedOut() else _state.update { it.copy(connectorsError = if (error.code == "INVALID_TOKEN")
                    "GitHub didn’t accept that token. Check it starts with github_pat_ and hasn’t expired." else "GitHub could not be reached. Try again in a moment.") }
            } finally { if (current(version)) _state.update { it.copy(connectorsBusy = false) } }
        }
    }

    /** X / Twitter (#46): the owner's optional X API key, or null to remove it. Posts are read through FxTwitter either way. */
    fun xKey(token: String?, onDone: () -> Unit = {}) {
        if (_state.value.connectorsBusy) return
        val version = scope
        _state.update { it.copy(connectorsBusy = true, connectorsError = null) }
        viewModelScope.launch {
            try {
                val result = if (token != null) api.xKeyLink(token) else api.xKeyUnlink()
                if (current(version)) { _state.update { it.copy(connectors = result) }; onDone() }
            } catch (error: ApiException) {
                if (!current(version)) return@launch
                if (error.signedOut) signedOut() else _state.update { it.copy(connectorsError = when (error.code) {
                    "X_INVALID_KEY" -> "That doesn’t look like an X API bearer token."
                    "X_KEY_REJECTED" -> "X didn’t accept that key. Check it is the app’s bearer token and the app has credits."
                    else -> "X could not be reached. Try again in a moment." }) }
            } finally { if (current(version)) _state.update { it.copy(connectorsBusy = false) } }
        }
    }

    fun setConnector(id: String, enabled: Boolean) {
        if (_state.value.connectorsBusy) return
        val version = scope
        _state.update { it.copy(connectorsBusy = true, connectorsError = null) }
        viewModelScope.launch {
            try { val result = api.setConnector(id, enabled); if (current(version)) _state.update { it.copy(connectors = result) } }
            catch (error: ApiException) {
                if (!current(version)) return@launch
                if (error.signedOut) signedOut() else _state.update { it.copy(connectorsError = "That change could not be saved. Reload and try again.") }
            } finally { if (current(version)) _state.update { it.copy(connectorsBusy = false) } }
        }
    }

    // ---- Calendar (#44, api/schedules) ----
    /** month: "2026-11" to show; null means this month (and today selected). The grid covers whole Monday-first weeks. */
    fun loadCalendar(month: String? = _state.value.calendarMonth, day: String? = null) {
        val version = scope
        _state.update { it.copy(calendarBusy = true) }
        viewModelScope.launch {
            try {
                val today = if (month == null || _state.value.calendar == null) api.calendar(null, 1).today else _state.value.calendar!!.today
                val shown = java.time.YearMonth.parse(month ?: today.take(7))
                val (from, days) = monthGrid(shown)
                val result = api.calendar(from.toString(), days)
                val selected = day ?: _state.value.calendarDay?.takeIf { month != null && it.take(7) == shown.toString() }
                    ?: if (today.take(7) == shown.toString()) today else shown.atDay(1).toString()
                if (current(version)) _state.update { it.copy(calendar = result, calendarMonth = shown.toString(), calendarDay = selected, calendarError = null) }
            } catch (error: ApiException) {
                if (!current(version)) return@launch
                if (error.signedOut) signedOut() else _state.update { it.copy(calendarError = "Your calendar could not be loaded.") }
            } catch (_: Exception) {
                if (current(version)) _state.update { it.copy(calendarError = "Your calendar could not be loaded.") }
            } finally { if (current(version)) _state.update { it.copy(calendarBusy = false) } }
        }
    }
    fun calendarShift(months: Long) {
        val month = _state.value.calendarMonth ?: return
        if (_state.value.calendarBusy) return
        _state.update { it.copy(calendarNotice = null) }
        loadCalendar(java.time.YearMonth.parse(month).plusMonths(months).toString())
    }
    fun calendarToday() { _state.update { it.copy(calendarNotice = null) }; loadCalendar(null) }
    /** A tap on a day: select it, moving to its month when it is a leading or trailing day. */
    fun selectDay(day: String) {
        if (day.take(7) == _state.value.calendarMonth) _state.update { it.copy(calendarDay = day) } else loadCalendar(day.take(7), day)
    }

    private fun mutateCalendar(done: String, call: suspend () -> Unit, after: () -> Unit = {}) {
        if (_state.value.calendarBusy) return
        val version = scope
        _state.update { it.copy(calendarBusy = true, calendarError = null, calendarNotice = null) }
        viewModelScope.launch {
            try {
                call()
                if (current(version)) { _state.update { it.copy(calendarNotice = done) }; after() }
            } catch (error: ApiException) {
                if (!current(version)) return@launch
                if (error.signedOut) { signedOut(); return@launch }
                _state.update { it.copy(calendarError = when {
                    error.code == "CALENDAR_CONFLICT" || error.status == 404 -> "This event changed somewhere else. Here is the current calendar."
                    error.code == "CALENDAR_CAPACITY" -> "The calendar is full (500 events)."
                    error.code == "CALENDAR_INVALID_REQUEST" -> "Check the dates: the end must not be before the start."
                    error.code == "NETWORK" -> "Connection lost. The change may or may not have been saved."
                    else -> "That change could not be saved."
                }) }
            } finally { if (current(version)) _state.update { it.copy(calendarBusy = false) } }
            if (current(version)) loadCalendar()
        }
    }
    /** existing == null creates; requestId stays the same while one editor is open, so a resend never duplicates. */
    fun saveEvent(existing: CalEvent?, requestId: String, draft: EventDraft, onSaved: () -> Unit) =
        mutateCalendar(if (existing == null) "Event added." else "Event saved.",
            { if (existing == null) api.createEvent(requestId, draft) else api.updateEvent(existing, draft) }, onSaved)
    fun deleteEvent(event: CalEvent, onDone: () -> Unit) = mutateCalendar("Event deleted.", { api.deleteEvent(event.id) }, onDone)
    fun setHolidays(on: Boolean) = mutateCalendar(if (on) "French public holidays shown." else "Holidays hidden.", { api.calendarSettings(on) })

    // ---- Watches, reminders and schedule settings (api/schedules) ----
    fun loadSchedules() {
        val version = scope
        if (_state.value.schedulesBusy) return
        _state.update { it.copy(schedulesLoading = true) }
        viewModelScope.launch {
            try {
                val result = api.schedules()
                if (current(version)) _state.update { it.copy(schedules = result, schedulesError = null) }
            } catch (error: ApiException) {
                if (!current(version)) return@launch
                if (error.signedOut) signedOut() else _state.update { it.copy(schedulesError = "Your watches and reminders could not be loaded.") }
            } finally { if (current(version)) _state.update { it.copy(schedulesLoading = false) } }
        }
    }

    private fun mutateSchedules(done: String, call: suspend () -> Schedules, failed: (ApiException) -> Unit = {}) {
        if (_state.value.schedulesBusy) return
        val version = scope
        _state.update { it.copy(schedulesBusy = true, schedulesError = null, schedulesNotice = null) }
        viewModelScope.launch {
            var reload = false
            try {
                val result = call()
                if (current(version)) _state.update { it.copy(schedules = result, schedulesNotice = done) }
            } catch (error: ApiException) {
                if (!current(version)) return@launch
                if (error.signedOut) { signedOut(); return@launch }
                failed(error)
                reload = error.status == 409 || error.status == 404
                _state.update { it.copy(schedulesError = when {
                    reload -> "This changed somewhere else. Here is the current state; check it before trying again."
                    error.code == "NETWORK" -> "Connection lost. The change may or may not have been saved."
                    else -> "That change could not be saved."
                }) }
            } finally { if (current(version)) _state.update { it.copy(schedulesBusy = false) } }
            if (reload && current(version)) loadSchedules()
        }
    }

    fun cancelReminder(reminder: Reminder) = mutateSchedules("Reminder cancelled.", { api.cancelReminder(reminder.id) })
    fun cancelFollowup(followup: Followup) = mutateSchedules("Follow-up cancelled.", { api.cancelFollowup(followup.id) })

    fun changeWatch(watch: Watch, operation: String, condition: String? = null, intervalHours: Int? = null) =
        sendWatchChange(WatchChange(java.util.UUID.randomUUID().toString(), watch, operation, condition, intervalHours))

    fun retryWatchChange() { _state.value.watchRetry?.let(::sendWatchChange) }
    fun dropWatchChange() { _state.update { it.copy(watchRetry = null) }; loadSchedules() }

    private fun sendWatchChange(change: WatchChange) {
        _state.update { it.copy(watchRetry = null) }
        mutateSchedules(when (change.operation) { "pause" -> "Watch paused."; "resume" -> "Watch resumed."; "cancel" -> "Watch cancelled."; else -> "Watch saved." },
            { api.updateWatch(change.requestId, change.watch, change.operation, change.condition, change.intervalHours) },
            { error -> if (error.code == "NETWORK" || error.status >= 500) _state.update { it.copy(watchRetry = change) } })
    }

    /** Saves only the given schedule settings (quiet hours, check-ins, daily digest, weekly check-in). */
    fun configureSchedules(input: kotlinx.serialization.json.JsonObject) =
        mutateSchedules("Settings saved.", { api.configureSchedules(input) })

    // ---- Discord (docs/DISCORD.md) ----

    fun loadDiscord() {
        val version = scope
        viewModelScope.launch { if (current(version)) guarded { val status = api.discord(); if (current(version)) _state.update { it.copy(discord = status) } } }
    }

    fun linkDiscord(token: String) = discordCall { api.discordLink(token.trim()) }
    fun unlinkDiscord() = discordCall { api.discordUnlink() }

    private fun discordCall(block: suspend () -> DiscordStatus) {
        val version = scope
        _state.update { it.copy(discordBusy = true, discordError = null) }
        viewModelScope.launch {
            if (!current(version)) return@launch
            try {
                val status = block()
                if (!current(version)) return@launch
                _state.update { it.copy(discord = status, discordBusy = false) }
                loadConnectors()
            } catch (error: ApiException) {
                if (!current(version)) return@launch
                if (error.signedOut) { signedOut(); return@launch }
                val message = when (error.code) {
                    "INVALID_TOKEN" -> "That token didn’t work. Copy it again from your bot’s page (Bot → Reset Token)."
                    "BOT_IN_USE" -> "This bot is already linked to another companion. Create a new bot for this one."
                    else -> "Discord couldn’t be reached. Try again in a moment."
                }
                _state.update { it.copy(discordBusy = false, discordError = message) }
            }
        }
    }

    // ---- The human's display identity (kept separate from the companion). ----
    private fun ownerProfileCurrent(version: Long, request: Long) = current(version) && ownerProfileEpoch == request
    fun loadOwnerProfile() {
        if (_state.value.ownerProfileBusy) return
        val version = scope; val request = ++ownerProfileEpoch; ownerProfileJob?.cancel()
        _state.update { it.copy(ownerProfileLoading = true, ownerProfileConfirmed = false, ownerProfileError = null, ownerProfileNotice = null) }
        ownerProfileJob = viewModelScope.launch {
            if (!ownerProfileCurrent(version, request)) return@launch
            try {
                val result = api.ownerProfile()
                if (ownerProfileCurrent(version, request)) _state.update { it.copy(ownerProfile = result, ownerProfileConfirmed = true) }
            } catch (error: ApiException) {
                if (!ownerProfileCurrent(version, request)) return@launch
                if (error.signedOut) { signedOut(); return@launch }
                _state.update { it.copy(ownerProfileError = "Your profile could not be loaded. Try Reload profile.") }
            } finally { if (ownerProfileCurrent(version, request)) _state.update { it.copy(ownerProfileLoading = false) } }
        }
    }
    fun saveOwnerProfile(displayName: String, photo: OwnerPhoto?, changePhoto: Boolean, expectedScope: Long) {
        val shown = _state.value
        if (!current(expectedScope) || shown.ownerProfileBusy || shown.ownerProfileLoading || !shown.ownerProfileConfirmed) return
        val before = shown.ownerProfile ?: return
        val request = ++ownerProfileEpoch; ownerProfileJob?.cancel()
        _state.update { it.copy(ownerProfileBusy = true, ownerProfileConfirmed = false, ownerProfileError = null, ownerProfileNotice = null) }
        ownerProfileJob = viewModelScope.launch {
            if (!ownerProfileCurrent(expectedScope, request)) return@launch
            try {
                val result = api.saveOwnerProfile(displayName.trim(), before.profile.revision, photo, changePhoto)
                if (ownerProfileCurrent(expectedScope, request)) _state.update { it.copy(ownerProfile = result, ownerProfileConfirmed = true, ownerProfileNotice = "Profile saved.") }
            } catch (error: ApiException) {
                if (!ownerProfileCurrent(expectedScope, request)) return@launch
                if (error.signedOut) { signedOut(); return@launch }
                _state.update { it.copy(ownerProfileError = if (error.code == "PROFILE_CONFLICT")
                    "Your profile changed elsewhere. Your draft is still here. Reload before another edit."
                    else "The save was not confirmed. Your draft is still here. Reload to check the saved profile.") }
            } finally { if (ownerProfileCurrent(expectedScope, request)) _state.update { it.copy(ownerProfileBusy = false) } }
        }
    }

    // ---- Contacts: consent settings only. Sending remains in the owner's native turn. ----

    private fun contactsCurrent(version: Long, request: Long) = current(version) && contactsEpoch == request
    fun loadContacts() {
        if (_state.value.contactsBusy) return
        val version = scope; val request = ++contactsEpoch
        contactsJob?.cancel()
        _state.update { it.copy(contactsLoading = true, contactsConfirmed = false, contactsError = null, contactsNotice = null) }
        contactsJob = viewModelScope.launch {
            if (!contactsCurrent(version, request)) return@launch
            try {
                val result = api.contacts()
                if (contactsCurrent(version, request)) _state.update { it.copy(contacts = result.contacts, contactsConfirmed = true) }
            } catch (error: ApiException) {
                if (!contactsCurrent(version, request)) return@launch
                if (error.signedOut) { signedOut(); return@launch }
                _state.update { it.copy(contactsError = "Contacts could not be loaded. Reload to try again.") }
            } finally { if (contactsCurrent(version, request)) _state.update { it.copy(contactsLoading = false) } }
        }
    }
    /** The switch passes the exact canonical contact revision shown to this owner. No optimistic flip. */
    fun setContact(id: String, enabled: Boolean, expectedRevision: Long, expectedScope: Long) {
        if (!current(expectedScope) || _state.value.contactsBusy || _state.value.contactsLoading || !_state.value.contactsConfirmed) return
        val request = ++contactsEpoch
        contactsJob?.cancel()
        _state.update { it.copy(contactsBusy = true, contactsConfirmed = false, contactsError = null, contactsNotice = null) }
        contactsJob = viewModelScope.launch {
            if (!contactsCurrent(expectedScope, request)) return@launch
            try {
                val result = api.setContact(id, enabled, expectedRevision)
                if (!contactsCurrent(expectedScope, request)) return@launch
                _state.update { it.copy(contacts = result.contacts, contactsConfirmed = true,
                    contactsNotice = if (enabled) "Contact enabled for your companion. The other owner must also enable it."
                    else "Contact disabled for your companion. Delivered messages stay in chat history.") }
            } catch (error: ApiException) {
                if (!contactsCurrent(expectedScope, request)) return@launch
                if (error.signedOut) { signedOut(); return@launch }
                if (error.code == "CONTACT_CONFLICT") {
                    val fresh = try { api.contacts() } catch (failure: ApiException) {
                        if (contactsCurrent(expectedScope, request) && failure.signedOut) signedOut()
                        null
                    }
                    if (!contactsCurrent(expectedScope, request)) return@launch
                    _state.update { it.copy(contacts = fresh?.contacts ?: it.contacts, contactsConfirmed = fresh != null,
                        contactsError = if (fresh != null) "Contact settings changed. The latest settings are loaded; review them before choosing again."
                        else "Contact settings changed, but the latest settings could not be loaded. Reload before choosing again.") }
                } else _state.update { it.copy(contactsError = contactProblem(error)) }
            } finally { if (contactsCurrent(expectedScope, request)) _state.update { it.copy(contactsBusy = false) } }
        }
    }

    // ---- Personality: full owner-private SOUL bytes and observed history, never chat proposals. ----

    private fun personalityCurrent(version: Long, request: Long) = current(version) && personalityEpoch == request
    fun loadPersonality() {
        if (_state.value.personalityBusy) return
        val version = scope; val request = ++personalityEpoch
        personalityJob?.cancel(); personalityVersionJob?.cancel(); personalityVersionEpoch++
        _state.update { it.copy(personalityLoading = true, personalityError = null, personalityErrorCode = null,
            personalityVersion = null, personalityVersionLoading = false) }
        personalityJob = viewModelScope.launch {
            if (!personalityCurrent(version, request)) return@launch
            try {
                val result = api.personality()
                if (personalityCurrent(version, request)) _state.update {
                    it.copy(personality = result, personalityDraft = it.personalityDraft?.let { draft ->
                        draft.copy(conflicted = draft.conflicted || draft.expectedRevision != result.revision)
                    })
                }
            } catch (error: ApiException) {
                if (!personalityCurrent(version, request)) return@launch
                if (error.signedOut) { signedOut(); return@launch }
                _state.update { it.copy(personalityError = personalityProblem(error), personalityErrorCode = error.code) }
            } finally { if (personalityCurrent(version, request)) _state.update { it.copy(personalityLoading = false) } }
        }
    }
    fun editPersonality(expectedScope: Long) {
        if (!current(expectedScope) || _state.value.personalityBusy || _state.value.personalityLoading || _state.value.personalityDraft != null) return
        val value = _state.value.personality ?: return
        _state.update { it.copy(personalityDraft = PersonalityDraft(value.content, value.revision), personalityNotice = null) }
    }
    fun updatePersonalityDraft(content: String, expectedScope: Long) {
        if (!current(expectedScope) || _state.value.personalityBusy || !validPersonalityContent(content)) return
        val draft = _state.value.personalityDraft ?: return
        _state.update { it.copy(personalityDraft = draft.copy(content = content)) }
    }
    fun closePersonalityDraft(expectedScope: Long) {
        if (current(expectedScope) && !_state.value.personalityBusy) _state.update { it.copy(personalityDraft = null) }
    }
    fun savePersonalityDraft(expectedScope: Long) {
        val draft = _state.value.personalityDraft ?: return
        if (!current(expectedScope) || draft.conflicted || !validPersonalityContent(draft.content)) return
        mutatePersonality(expectedScope, { api.editPersonality(draft.content, draft.expectedRevision) }, "Personality saved.")
    }
    fun selectPersonalityVersion(revision: String, expectedScope: Long) {
        if (!current(expectedScope) || !memoryRevision(revision) || _state.value.personalityBusy || _state.value.personalityLoading) return
        val request = personalityEpoch; val selected = ++personalityVersionEpoch
        personalityVersionJob?.cancel()
        _state.update { it.copy(personalityVersion = null, personalityVersionLoading = true, personalityError = null, personalityErrorCode = null) }
        personalityVersionJob = viewModelScope.launch {
            if (!personalityCurrent(expectedScope, request) || selected != personalityVersionEpoch) return@launch
            try {
                val result = api.personalityVersion(revision)
                if (personalityCurrent(expectedScope, request) && selected == personalityVersionEpoch)
                    _state.update { it.copy(personalityVersion = result) }
            } catch (error: ApiException) {
                if (!personalityCurrent(expectedScope, request) || selected != personalityVersionEpoch) return@launch
                if (error.signedOut) { signedOut(); return@launch }
                _state.update { it.copy(personalityError = personalityProblem(error), personalityErrorCode = error.code) }
            } finally {
                if (personalityCurrent(expectedScope, request) && selected == personalityVersionEpoch)
                    _state.update { it.copy(personalityVersionLoading = false) }
            }
        }
    }
    /** Both revisions came from the owner-reviewed confirmation; never substitute a later current revision. */
    fun restorePersonality(confirmation: PersonalityRestore) {
        if (!current(confirmation.scope)) return
        mutatePersonality(confirmation.scope,
            { api.restorePersonality(confirmation.targetRevision, confirmation.expectedRevision) }, "Observed personality version restored.")
    }
    private fun mutatePersonality(expectedScope: Long, operation: suspend () -> Personality, notice: String) {
        if (!current(expectedScope) || _state.value.personalityBusy) return
        val request = ++personalityEpoch
        personalityJob?.cancel(); personalityVersionJob?.cancel(); personalityVersionEpoch++
        _state.update { it.copy(personalityBusy = true, personalityLoading = false, personalityVersionLoading = false,
            personalityError = null, personalityErrorCode = null, personalityNotice = null) }
        personalityJob = viewModelScope.launch {
            if (!personalityCurrent(expectedScope, request)) return@launch
            try {
                val result = operation()
                if (!personalityCurrent(expectedScope, request)) return@launch
                _state.update { it.copy(personality = result, personalityDraft = null, personalityVersion = null,
                    personalityNotice = if (result.changed == true) notice else "This personality version is already current.") }
            } catch (error: ApiException) {
                if (!personalityCurrent(expectedScope, request)) return@launch
                if (error.signedOut) { signedOut(); return@launch }
                if (error.code == "PERSONALITY_CONFLICT") {
                    _state.update { it.copy(personalityDraft = it.personalityDraft?.copy(conflicted = true)) }
                    val fresh = try { api.personality() } catch (failure: ApiException) {
                        if (personalityCurrent(expectedScope, request) && failure.signedOut) signedOut()
                        null
                    }
                    if (!personalityCurrent(expectedScope, request)) return@launch
                    _state.update { it.copy(personality = fresh ?: it.personality, personalityErrorCode = error.code,
                        personalityError = if (fresh != null) "The personality changed. The latest version is loaded; any draft is kept. Review before changing it."
                        else "The personality changed, but the latest version could not be loaded. Any draft is kept. Reload before changing it.") }
                } else _state.update { it.copy(personalityError = personalityProblem(error), personalityErrorCode = error.code) }
            } finally { if (personalityCurrent(expectedScope, request)) _state.update { it.copy(personalityBusy = false) } }
        }
    }

    fun loadMemories() {
        if (_state.value.memoryBusy) return
        val version = scope
        val request = ++memoryEpoch
        memoryJob?.cancel()
        _state.update { it.copy(memoriesFailed = false, memoryLoading = true, memoryError = null, memoryErrorCode = null) }
        memoryJob = viewModelScope.launch {
            if (!memoryCurrent(version, request)) return@launch
            try {
                val result = api.memories()
                if (memoryCurrent(version, request)) _state.update { it.copy(memories = result.files, memoryRevision = result.revision, memoriesFailed = false) }
            } catch (error: ApiException) {
                if (!memoryCurrent(version, request)) return@launch
                if (error.signedOut) { signedOut(); return@launch }
                _state.update { it.copy(memoriesFailed = true, memoryError = "The notes could not be loaded. Try again.", memoryErrorCode = error.code) }
            } finally { if (memoryCurrent(version, request)) _state.update { it.copy(memoryLoading = false) } }
        }
    }

    private fun memoryCurrent(version: Long, request: Long) = current(version) && memoryEpoch == request

    fun editMemory(file: MemoryFile, item: MemoryItem, expectedScope: Long) {
        if (!current(expectedScope) || file.readOnly || !writableMemory(file.file) || _state.value.memoryBusy) return
        _state.update { it.copy(memoryDraft = MemoryDraft(file.file, item.id, item.line, file.revision, item.text), memoryError = null, memoryErrorCode = null, memoryNotice = null) }
    }
    fun updateMemoryDraft(text: String, expectedScope: Long) {
        if (!current(expectedScope) || _state.value.memoryBusy) return
        val draft = _state.value.memoryDraft ?: return
        if ('\n' in text || '\r' in text || '\t' in text || !validText(text, MEMORY_FILE_BYTES, MEMORY_FILE_BYTES) ||
            (text.length > 4000 && text.length >= draft.text.length)) return
        _state.update { it.copy(memoryDraft = draft.copy(text = text)) }
    }
    fun closeMemoryDraft(expectedScope: Long) {
        if (current(expectedScope) && !_state.value.memoryBusy) _state.update { it.copy(memoryDraft = null) }
    }
    fun saveMemoryDraft(expectedScope: Long) {
        val draft = _state.value.memoryDraft ?: return
        if (!current(expectedScope) || draft.conflicted || !validCorrection(draft.text)) return
        mutateMemory(expectedScope, closeDraft = true,
            operation = { api.editMemory(draft.file, draft.id, draft.text, draft.expectedRevision) },
            notice = { if (it.changed == true) "Correction saved." else "This correction is already saved." })
    }
    fun forget(file: MemoryFile, item: MemoryItem, expectedScope: Long) {
        if (!current(expectedScope) || file.readOnly || !writableMemory(file.file)) return
        mutateMemory(expectedScope, operation = { api.forget(file.file, item.id, file.revision) }, notice = {
            if (it.removed == true) "Removed from memory. Past chats aren't changed." else "That note is no longer in memory."
        })
    }
    fun forgetAllMemory(revision: String, expectedScope: Long) {
        if (!current(expectedScope)) return
        mutateMemory(expectedScope, closeDraft = true, operation = { api.forgetAllMemory(revision) },
            notice = { if (it.cleared == true) "Memory notes and diary cleared. Past chats aren't changed." else "Memory notes and diary are already clear. Past chats aren't changed." })
    }
    private fun mutateMemory(expectedScope: Long, closeDraft: Boolean = false,
        operation: suspend () -> Memories, notice: (Memories) -> String) {
        if (!current(expectedScope) || _state.value.memoryBusy) return
        val request = ++memoryEpoch
        memoryJob?.cancel(); memoryExports.toList().forEach { it.cancel() }
        _state.update { it.copy(memoryBusy = true, memoryLoading = false, memoryError = null, memoryErrorCode = null, memoryNotice = null) }
        memoryJob = viewModelScope.launch {
            if (!memoryCurrent(expectedScope, request)) return@launch
            try {
                val result = operation()
                if (!memoryCurrent(expectedScope, request)) return@launch
                _state.update { it.copy(memories = result.files, memoryRevision = result.revision, memoriesFailed = false,
                    memoryDraft = if (closeDraft) null else it.memoryDraft, memoryNotice = notice(result)) }
            } catch (error: ApiException) {
                if (!memoryCurrent(expectedScope, request)) return@launch
                if (error.signedOut) { signedOut(); return@launch }
                if (error.code == "MEMORY_CONFLICT") {
                    _state.update { it.copy(memoryDraft = it.memoryDraft?.copy(conflicted = true)) }
                    val fresh = try { api.memories() } catch (failure: ApiException) {
                        if (memoryCurrent(expectedScope, request) && failure.signedOut) signedOut()
                        null
                    }
                    if (!memoryCurrent(expectedScope, request)) return@launch
                    _state.update { it.copy(memories = fresh?.files ?: it.memories, memoryRevision = fresh?.revision ?: it.memoryRevision,
                        memoryErrorCode = error.code, memoryError = when {
                            fresh != null && it.memoryDraft != null -> memoryProblem(error)
                            fresh != null -> "The notes changed. The latest version has been loaded. Review it before trying again."
                            it.memoryDraft != null -> "The notes changed, but the latest version could not be loaded. Your draft is kept. Reload before editing again."
                            else -> "The notes changed, but the latest version could not be loaded. Reload before trying again."
                        }) }
                } else _state.update { it.copy(memoryError = memoryProblem(error), memoryErrorCode = error.code) }
            } finally { if (memoryCurrent(expectedScope, request)) _state.update { it.copy(memoryBusy = false) } }
        }
    }

    /** A fresh owner-only export; an older read cannot write after a local correction, forget or owner reset. */
    suspend fun exportMemory(destination: Uri, expectedScope: Long, cancel: TransferCancellation) {
        val request = memoryEpoch
        try {
            if (!memoryCurrent(expectedScope, request)) throw ApiException("CANCELLED")
            memoryExports.add(cancel)
            cancel.check()
            val exported = api.exportMemory()
            if (!memoryCurrent(expectedScope, request)) throw ApiException("CANCELLED")
            cancel.check()
            val bytes = memoryExportBytes(exported)
            withContext(Dispatchers.IO) {
                if (!memoryCurrent(expectedScope, request)) throw ApiException("CANCELLED")
                val resolver = getApplication<Application>().contentResolver
                resolver.openOutputStream(destination, "wt")?.use { output ->
                    var offset = 0
                    while (offset < bytes.size) {
                        cancel.check(); if (!memoryCurrent(expectedScope, request)) throw ApiException("CANCELLED")
                        val length = minOf(64 * 1024, bytes.size - offset)
                        output.write(bytes, offset, length); offset += length
                    }
                    cancel.check(); if (!memoryCurrent(expectedScope, request)) throw ApiException("CANCELLED")
                } ?: throw ApiException("FILE_UNAVAILABLE")
            }
            cancel.check(); if (!memoryCurrent(expectedScope, request)) throw ApiException("CANCELLED")
        } catch (error: Exception) {
            runCatching { DocumentsContract.deleteDocument(getApplication<Application>().contentResolver, destination) }
            if (error is ApiException && error.signedOut && memoryCurrent(expectedScope, request)) signedOut()
            throw error
        } finally { memoryExports.remove(cancel) }
    }

    // ---- Chat ----

    private fun current(version: Long, threadId: String? = null) = version == scope &&
        (threadId == null || _state.value.threadId == threadId)

    private fun invalidateFiles(stopPolling: Boolean = true) {
        scope++
        ownerProfileEpoch++; ownerProfileJob?.cancel(); ownerProfileJob = null
        _state.update { it.copy(ownerProfile = null, ownerProfileLoading = false, ownerProfileBusy = false,
            ownerProfileConfirmed = false, ownerProfileError = null, ownerProfileNotice = null) }
        contactsEpoch++; contactsJob?.cancel(); contactsJob = null
        _state.update { it.copy(contacts = null, contactsLoading = false, contactsBusy = false,
            contactsConfirmed = false, contactsError = null, contactsNotice = null) }
        personalityEpoch++; personalityVersionEpoch++
        personalityJob?.cancel(); personalityJob = null; personalityVersionJob?.cancel(); personalityVersionJob = null
        _state.update { it.copy(personality = null, personalityDraft = null, personalityVersion = null,
            personalityLoading = false, personalityVersionLoading = false, personalityBusy = false,
            personalityError = null, personalityErrorCode = null, personalityNotice = null) }
        memoryEpoch++; memoryJob?.cancel(); memoryJob = null
        memoryExports.toList().forEach { it.cancel() }; memoryExports.clear()
        _state.update { it.copy(scope = scope, memories = null, memoryRevision = null, memoriesFailed = false,
            memoryLoading = false, memoryBusy = false, memoryError = null, memoryErrorCode = null, memoryNotice = null, memoryDraft = null) }
        if (stopPolling) { poller?.cancel(); poller = null }
        transfers.values.toList().forEach { it.cancel() }; transfers.clear()
        uploadJobs.values.toList().forEach { it.cancel() }; uploadJobs.clear()
        mediaTransfers.toList().forEach { it.cancel() }; mediaTransfers.clear()
        uploadSources.clear(); mediaCache.clear()
        File(getApplication<Application>().cacheDir, "attachment-uploads").deleteRecursively()
        File(getApplication<Application>().cacheDir, "attachment-media").deleteRecursively()
        // A voice message belongs to the owner who recorded it: a sign-out or switch drops it.
        failedVoice = null; File(getApplication<Application>().cacheDir, "voice-recordings").deleteRecursively()
        _state.update { it.copy(voiceSending = false, voiceFailed = false) }
        failedSend = null; pendingArchive = null; createKey = null
    }

    private suspend fun ensureThread(version: Long): String = creating.withLock {
        if (!current(version)) throw ApiException("CANCELLED")
        _state.value.threadId?.let { return@withLock it }
        val key = createKey ?: Pkce.randomToken(16).also { createKey = it }
        val thread = api.createThread(key, "Companion")
        if (!current(version)) throw ApiException("CANCELLED")
        if (!fileId(thread.id)) throw ApiException("INVALID_RESPONSE")
        createKey = null; cursor = "0"
        _state.update { it.copy(threadId = thread.id, messages = emptyList(), turn = null) }
        thread.id
    }

    /** Picker results belong to the chat that launched the picker, not whichever owner is now visible. */
    fun attachFiles(uris: List<Uri>, expectedScope: Long) {
        val state = _state.value
        if (uris.isEmpty() || !current(expectedScope) || state.gate != Gate.Ready) return
        // Coming back from the system picker restarts the app's chat resync, which is still loading when
        // Android delivers the result: keep the pick and attach it as soon as the chat is loaded (#32).
        if (state.chatLoading) { pendingPick = uris to expectedScope; return }
        if (state.sending || failedSend != null || pendingArchive != null) {
            _state.update { it.copy(fileError = "Wait for the current message to finish, then attach the files again.") }; return
        }
        if (state.uploads.size + uris.size > MAX_FILES) { _state.update { it.copy(fileError = "Choose at most eight files for one message.") }; return }
        val entries = uris.map { uri ->
            val key = Pkce.randomToken(16); uploadSources[key] = uri
            PendingUpload(key, state.threadId ?: "", "Preparing file…")
        }
        _state.update { it.copy(uploads = it.uploads + entries, fileError = null) }
        entries.forEach { startUpload(it.key, expectedScope) }
    }

    /** A problem before any file was picked (e.g. no camera app), shown where upload errors show. */
    fun attachProblem(message: String) { _state.update { it.copy(fileError = message) } }

    fun retryUpload(key: String) {
        if (failedSend != null || _state.value.sending || pendingArchive != null) return
        val entry = _state.value.uploads.firstOrNull { it.key == key && it.state == "error" } ?: return
        startUpload(entry.key, scope)
    }

    private fun startUpload(key: String, version: Long) {
        if (uploadJobs[key]?.isActive == true) return
        val cancellation = TransferCancellation(); transfers[key] = cancellation
        uploadJobs[key] = viewModelScope.launch {
            try {
                val threadId = ensureThread(version)
                var entry = _state.value.uploads.firstOrNull { it.key == key } ?: return@launch
                if (entry.local == null) {
                    updateUpload(key, version) { it.copy(threadId = threadId, state = "preparing", error = null) }
                    val uri = uploadSources[key] ?: throw ApiException("FILE_UNAVAILABLE")
                    val prepared = withContext(Dispatchers.IO) {
                        val resolver = getApplication<Application>().contentResolver
                        var name = "file"
                        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { row ->
                            if (row.moveToFirst()) {
                                val nameIndex = row.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                                if (nameIndex >= 0 && !row.isNull(nameIndex)) name = row.getString(nameIndex)
                                val sizeIndex = row.getColumnIndex(OpenableColumns.SIZE)
                                if (sizeIndex >= 0 && !row.isNull(sizeIndex) && row.getLong(sizeIndex) > MAX_FILE_BYTES) throw ApiException("FILE_TOO_LARGE")
                            }
                        }
                        if (!fileName(name)) throw ApiException("INVALID_FILE_NAME")
                        val folder = File(getApplication<Application>().cacheDir, "attachment-uploads/$version").apply { mkdirs() }
                        val local = File(folder, key)
                        try {
                            resolver.openInputStream(uri)?.use { input -> local.outputStream().use { output ->
                                val buffer = ByteArray(64 * 1024); var size = 0L
                                while (true) { cancellation.check(); val count = input.read(buffer); if (count < 0) break
                                    size += count; if (size > MAX_FILE_BYTES) throw ApiException("FILE_TOO_LARGE")
                                    output.write(buffer, 0, count)
                                }
                            } } ?: throw ApiException("FILE_UNAVAILABLE")
                            name to local
                        } catch (error: Exception) { local.delete(); throw error }
                    }
                    if (!current(version, threadId)) { prepared.second.delete(); return@launch }
                    entry = entry.copy(threadId = threadId, name = prepared.first, local = prepared.second, total = prepared.second.length())
                }
                updateUpload(key, version) { entry.copy(state = "uploading", progress = 0, error = null) }
                val local = entry.local ?: throw ApiException("FILE_UNAVAILABLE")
                val file = api.upload(threadId, key, entry.name, local, cancellation) { sent ->
                    updateUpload(key, version) { it.copy(progress = sent) }
                }
                if (!current(version, threadId)) return@launch
                updateUpload(key, version) { it.copy(file = file, state = "ready", progress = local.length(), error = null) }
            } catch (error: CancellationException) {
                // withContext may discard a completed IO result when cancellation wins its return dispatch.
                File(getApplication<Application>().cacheDir, "attachment-uploads/$version/$key").delete()
                throw error
            }
            catch (error: Exception) {
                if (!current(version)) return@launch
                val failure = error as? ApiException ?: ApiException("FILE_UNAVAILABLE")
                if (failure.signedOut) { signedOut(); return@launch }
                updateUpload(key, version) { it.copy(state = "error", error = fileProblem(failure.code)) }
            } finally { if (transfers[key] === cancellation) transfers.remove(key) }
        }
    }

    private fun updateUpload(key: String, version: Long, change: (PendingUpload) -> PendingUpload) {
        if (current(version)) _state.update { it.copy(uploads = it.uploads.map { entry -> if (entry.key == key) change(entry) else entry }) }
    }

    fun removeUpload(key: String) {
        if (_state.value.sending || failedSend != null) return
        val entry = _state.value.uploads.firstOrNull { it.key == key } ?: return
        if (entry.state == "removing") return
        transfers.remove(key)?.cancel(); uploadJobs.remove(key)?.cancel(); uploadSources.remove(key)
        if (entry.file == null) {
            entry.local?.delete()
            _state.update { it.copy(uploads = it.uploads.filterNot { item -> item.key == key }, fileError = null) }
            return
        }
        val version = scope
        updateUpload(key, version) { it.copy(state = "removing", error = null) }
        viewModelScope.launch {
            if (!current(version, entry.threadId)) return@launch
            try { api.removeFile(entry.file.id) }
            catch (error: ApiException) {
                if (!current(version, entry.threadId)) return@launch
                if (error.signedOut) { signedOut(); return@launch }
                if (!(error.status == 404 && error.code == "NOT_FOUND")) {
                    updateUpload(key, version) { it.copy(state = "remove-error", error = if (error.status == 409)
                        "This file is already attached. Delete its conversation to remove it." else "Removal was not confirmed. Retry removal.") }
                    return@launch
                }
                // A fresh authenticated absence confirms an earlier removal whose ACK was lost.
            }
            if (!current(version, entry.threadId)) return@launch
            entry.local?.delete(); mediaCache.remove(entry.file.id)?.delete()
            _state.update { it.copy(uploads = it.uploads.filterNot { item -> item.key == key }, fileError = null) }
        }
    }

    private var typingSentAt = 0L
    private var typingOn = false

    /** The draft changed: tells the server the owner is typing (at most every 3 s) or stopped, like the "typing…"
     *  a person sees, so a reply still waiting for more texts keeps waiting. Only a hint; a failure is ignored. */
    fun draftChanged(text: String) {
        val state = _state.value
        val threadId = state.threadId ?: return
        if (state.gate != Gate.Ready || state.archivedAt != null || state.chatLoading) return
        val writing = text.isNotBlank()
        val now = System.currentTimeMillis()
        val active = when {
            writing && now - typingSentAt > 3000 -> true
            !writing && typingOn -> false
            else -> return
        }
        typingOn = active; typingSentAt = if (active) now else 0L
        viewModelScope.launch { try { api.typing(threadId, active) } catch (_: ApiException) { } }
    }

    // ---- Voice messages ----
    private var failedVoice: PendingVoice? = null

    /** Where the next recording goes (app cache, deleted once sent or discarded). */
    fun voiceRecordingFile(): File =
        File(getApplication<Application>().cacheDir, "voice-recordings").apply { mkdirs() }.let { File(it, Pkce.randomToken(16) + ".m4a") }

    /** While recording, the companion sees the owner as typing, so a reply waiting for more texts keeps waiting. */
    fun recordingVoice(active: Boolean) {
        val state = _state.value
        val threadId = state.threadId ?: return
        if (state.gate != Gate.Ready || state.archivedAt != null || state.chatLoading) return
        typingOn = active; typingSentAt = if (active) System.currentTimeMillis() else 0L
        viewModelScope.launch { try { api.typing(threadId, active) } catch (_: ApiException) { } }
    }

    /** Uploads a recording as a voice message and sends it on its own. An unconfirmed send keeps the recording for Retry. */
    fun sendVoice(local: File, expectedScope: Long = scope) {
        val now = _state.value
        if (!current(expectedScope) || now.gate != Gate.Ready || now.archivedAt != null || now.chatLoading || now.voiceSending ||
            now.sending || failedSend != null || pendingArchive != null || failedVoice != null) { local.delete(); return }
        failedVoice = PendingVoice(Pkce.randomToken(16), Pkce.randomToken(16), local)
        deliverVoice(expectedScope)
    }
    fun retryVoice() { if (failedVoice != null && !_state.value.voiceSending) deliverVoice(scope) }
    fun discardVoice() {
        if (_state.value.voiceSending) return
        failedVoice?.local?.delete(); failedVoice = null
        _state.update { it.copy(voiceFailed = false, fileError = null) }
    }
    private fun deliverVoice(version: Long) {
        typingOn = false; typingSentAt = 0L
        _state.update { it.copy(voiceSending = true, voiceFailed = false, fileError = null) }
        viewModelScope.launch {
            var pending = failedVoice ?: return@launch
            try {
                val threadId = pending.threadId ?: ensureThread(version)
                pending = pending.copy(threadId = threadId); failedVoice = pending
                val file = pending.file ?: api.upload(threadId, pending.key, "Voice message.m4a", pending.local, TransferCancellation(), voice = true) { }
                pending = pending.copy(file = file); failedVoice = pending
                if (!current(version, threadId)) return@launch
                val messageId = api.submit(pending.requestId, threadId, "", listOf(file.id))
                if (!current(version, threadId)) return@launch
                failedVoice = null; pending.local.delete()
                _state.update { state ->
                    val mine = Message(messageId, threadId, "user", "", pending.requestId, attachments = listOf(file))
                    val finished = state.turn?.let { it.requestId == pending.requestId && it.state != "streaming" } == true
                    state.copy(voiceSending = false, waitingFor = if (finished) state.waitingFor else pending.requestId,
                        messages = if (state.messages.any { it.id == messageId }) state.messages else state.messages + mine)
                }
                startPolling()
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) {
                if (!current(version)) return@launch
                val failure = error as? ApiException ?: ApiException("NETWORK")
                if (failure.signedOut) { signedOut(); return@launch }
                val committed = _state.value.messages.any { it.role == "user" && it.requestId == pending.requestId }
                if (committed) { failedVoice = null; pending.local.delete(); _state.update { it.copy(voiceSending = false) }; startPolling(); return@launch }
                val retryable = failure.code == "NETWORK" || failure.status >= 500 || failure.code == "INVALID_RESPONSE"
                if (!retryable) { failedVoice = null; pending.local.delete() }
                _state.update { it.copy(voiceSending = false, voiceFailed = retryable, fileError = voiceProblem(failure.code, retryable)) }
            }
        }
    }

    fun send(text: String, expectedScope: Long = scope, onSent: () -> Unit) {
        if (!current(expectedScope)) return
        val now = _state.value
        if (now.archivedAt != null || now.chatLoading || now.sending || now.voiceSending || pendingArchive != null || now.uploads.any { it.state != "ready" }) return
        val files = now.uploads.mapNotNull { it.file }.toList()
        val retry = failedSend
        if (retry == null && (!validText(text, 8000, 32768) || text.isBlank() && files.isEmpty())) return
        val version = scope
        typingOn = false; typingSentAt = 0L // sending ends typing on the server
        _state.update { it.copy(sending = true, sendFailed = false) }
        viewModelScope.launch {
            if (!current(version)) return@launch
            try {
                val threadId = retry?.threadId ?: ensureThread(version)
                val pending = retry ?: PendingSend(Pkce.randomToken(16), threadId, text, files)
                failedSend = pending
                val messageId = api.submit(pending.requestId, threadId, pending.text, pending.files.map { it.id })
                if (!current(version, threadId)) return@launch
                failedSend = null
                val app = getApplication<Application>()
                if (Push.configured && Push.enabled(app) && !Push.asked(app) && !Push.permitted(app)) _state.update { it.copy(askNotifications = true) }
                _state.update { state ->
                    val mine = Message(messageId, threadId, "user", pending.text, pending.requestId, attachments = pending.files)
                    val finished = state.turn?.let { it.requestId == pending.requestId && it.state != "streaming" } == true
                    state.copy(sending = false, waitingFor = if (finished) null else pending.requestId,
                        uploads = emptyList(), fileError = null,
                        messages = if (state.messages.any { it.id == messageId }) state.messages else state.messages + mine)
                }
                now.uploads.forEach { it.local?.delete(); uploadSources.remove(it.key) }
                onSent()
                startPolling()
            } catch (error: ApiException) {
                if (!current(version)) return@launch
                if (error.signedOut) { signedOut(); return@launch }
                val recoverable = error.code == "NETWORK" || error.status >= 500
                val uncertain = recoverable || error.code in setOf("INVALID_RESPONSE", "TOO_LARGE")
                val committed = failedSend?.let { pending -> _state.value.messages.any { matchesSubmission(it, pending) } } == true
                if (recoverable && committed) {
                    failedSend = null
                    _state.update { it.copy(sending = false, sendFailed = false, uploads = emptyList(), fileError = null) }
                    now.uploads.forEach { it.local?.delete(); uploadSources.remove(it.key) }
                    onSent(); startPolling(); return@launch
                }
                if (!uncertain) failedSend = null
                _state.update { it.copy(sending = false, sendFailed = uncertain, offline = error.code == "NETWORK",
                    fileError = if (uncertain) "Send was not confirmed. Retry sends the same message and files." else fileProblem(error.code)) }
            }
        }
    }

    /** "New chat", after the UI's confirmation: the chat moves to Past chats and a fresh one opens. Retry keeps the same request. */
    fun archiveThread(expectedScope: Long = scope) {
        if (!current(expectedScope)) return
        val previous = pendingArchive
        val threadId = previous?.threadId ?: _state.value.threadId ?: return
        val now = _state.value
        if (now.archiving || previous == null && (now.archivedAt != null || now.sending || now.replying)) return
        val request = previous ?: PendingArchive(Pkce.randomToken(16), threadId)
        if (previous == null) { invalidateFiles(); pendingArchive = request }
        val version = scope
        _state.update { it.copy(scope = version, archiving = true, archiveFailed = false, uploads = emptyList(), fileError = null) }
        viewModelScope.launch {
            if (!current(version)) return@launch
            try {
                val fresh = api.archiveThread(request.threadId, request.requestId)
                if (!current(version)) return@launch
                pendingArchive = null; cursor = "0"
                _state.update { it.copy(threadId = fresh, archivedAt = null, messages = emptyList(), turn = null, waitingFor = null,
                    sending = false, sendFailed = false, archiving = false, archiveFailed = false, pastChats = null) }
                guarded { resync() }; startPolling()
            } catch (error: ApiException) {
                if (!current(version)) return@launch
                if (error.signedOut) { signedOut(); return@launch }
                val message = when (error.code) {
                    "BUSY" -> "Wait for the current reply to finish, then start a new chat."
                    else -> "Starting a new chat was not confirmed. Retry before sending another message."
                }
                if (error.code == "BUSY" || error.code == "ARCHIVED") pendingArchive = null
                _state.update { it.copy(archiving = false, archiveFailed = pendingArchive != null, fileError = message) }
            }
        }
    }

    /** Loads the list of archived chats for the Past chats sheet. */
    fun loadPastChats() {
        val version = scope
        _state.update { it.copy(pastChatsLoading = true, pastChatsFailed = false) }
        viewModelScope.launch {
            try {
                val list = api.archivedThreads()
                if (current(version)) _state.update { it.copy(pastChats = list, pastChatsLoading = false) }
            } catch (error: ApiException) {
                if (!current(version)) return@launch
                if (error.signedOut) { signedOut(); return@launch }
                _state.update { it.copy(pastChatsLoading = false, pastChatsFailed = true) }
            }
        }
    }

    /** Opens an archived chat read-only. */
    fun openArchived(threadId: String) {
        val now = _state.value
        if (!fileId(threadId) || now.sending || now.archiving || pendingArchive != null || now.uploads.isNotEmpty()) return
        cursor = "0"
        _state.update { it.copy(threadId = threadId, archivedAt = null, messages = emptyList(), turn = null, waitingFor = null, fileError = null) }
        viewModelScope.launch { guarded { resync() } }
    }

    /** Leaves an archived chat for the ongoing one. */
    fun backToCurrent() {
        if (_state.value.archivedAt == null) return
        cursor = "0"
        _state.update { it.copy(threadId = null, archivedAt = null, messages = emptyList(), turn = null, waitingFor = null) }
        viewModelScope.launch { guarded { resync() } }
    }

    suspend fun mediaFile(file: Attachment, expectedScope: Long, cancel: TransferCancellation,
        progress: (Long) -> Unit): File = mediaLock.withLock {
        if (!current(expectedScope)) throw ApiException("CANCELLED")
        mediaCache[file.id]?.takeIf { it.isFile }?.let { return@withLock it }
        mediaTransfers.add(cancel)
        val folder = File(getApplication<Application>().cacheDir, "attachment-media/$expectedScope").apply { mkdirs() }
        val destination = File(folder, Pkce.randomToken(16))
        try {
            val result = api.download(file, destination, cancel, progress)
            if (!current(expectedScope)) { result.delete(); throw ApiException("CANCELLED") }
            mediaCache[file.id] = result
            // Bound temporary media to 200 MiB; original server files remain available for another download.
            while (mediaCache.values.sumOf { it.length() } > 2 * MAX_FILE_BYTES && mediaCache.size > 1) {
                val old = mediaCache.entries.first { it.key != file.id }; old.value.delete(); mediaCache.remove(old.key)
            }
            result
        } catch (error: ApiException) {
            if (current(expectedScope) && error.signedOut) signedOut()
            throw error
        } finally { mediaTransfers.remove(cancel) }
    }

    suspend fun saveAttachment(file: Attachment, destination: Uri, expectedScope: Long,
        cancel: TransferCancellation, progress: (Long) -> Unit) {
        try {
            val local = mediaFile(file, expectedScope, cancel, progress)
            withContext(Dispatchers.IO) {
                if (!current(expectedScope)) throw ApiException("CANCELLED")
                val resolver = getApplication<Application>().contentResolver
                resolver.openOutputStream(destination, "wt")?.use { output -> local.inputStream().use { input ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) { cancel.check(); if (!current(expectedScope)) throw ApiException("CANCELLED")
                        val count = input.read(buffer); if (count < 0) break; output.write(buffer, 0, count) }
                } } ?: throw ApiException("FILE_UNAVAILABLE")
            }
        } catch (error: Exception) {
            runCatching { DocumentsContract.deleteDocument(getApplication<Application>().contentResolver, destination) }
            throw error
        }
    }

    override fun onCleared() { invalidateFiles(); super.onCleared() }

    fun stop(expectedScope: Long = scope) {
        if (!current(expectedScope)) return
        val state = _state.value
        val requestId = state.turn?.takeIf { it.state == "streaming" }?.requestId ?: state.waitingFor ?: return
        val threadId = state.threadId ?: return
        val version = scope
        viewModelScope.launch { if (current(version, threadId)) guarded { api.cancel(requestId, threadId) } }
    }

    fun mood(typing: Boolean, now: Long = System.currentTimeMillis()): Mood {
        val state = _state.value
        val turn = state.turn
        if (state.sending || state.waitingFor != null) return Mood.Thinking
        if (turn?.state == "streaming")
            return if (state.messages.any { it.role == "assistant" && it.requestId == turn.requestId && (it.text.isNotEmpty() || it.attachments.isNotEmpty()) }) Mood.Talking else Mood.Thinking
        if (now < state.happyUntil) return Mood.Happy
        if (typing) return Mood.Listening
        val zone = runCatching { ZoneId.of(state.profile?.timezone ?: "") }.getOrDefault(ZoneId.systemDefault())
        val hour = LocalTime.now(zone).hour
        return if (hour >= 23 || hour < 7) Mood.Sleepy else Mood.Idle
    }

    /** The face the companion chose for the reply it is writing or has just written. */
    fun feeling(now: Long = System.currentTimeMillis()): String? {
        val state = _state.value
        val turn = state.turn ?: return null
        if (turn.state != "streaming" && !(turn.state == "complete" && now < state.happyUntil)) return null
        return state.messages.lastOrNull { it.role == "assistant" && it.requestId == turn.requestId }?.feeling
    }

    // ---- Sync ----

    private fun startPolling() {
        if (poller?.isActive == true) return
        poller = viewModelScope.launch {
            while (isActive && _state.value.gate == Gate.Ready) {
                if (!visible) { delay(1000); continue }
                guarded { sync() }
                if (System.currentTimeMillis() - wearingAt > 10 * 60_000L) refreshWearing()
                if (System.currentTimeMillis() - boardAt > 30_000L) refreshBoard()
                delay(if (_state.value.replying || _state.value.sending) 500 else 3000)
            }
        }
    }

    private suspend fun resync() = syncing.withLock {
        var version = scope; var requested = _state.value.threadId
        _state.update { it.copy(chatLoading = true) }
        try {
            val snapshot = try { api.snapshot(requested) } catch (error: ApiException) {
                if (error.status != 404 || requested == null || !current(version) || _state.value.threadId != requested) throw error
                // A deletion from another device wins over this device's cached files, pending writes and history.
                invalidateFiles(stopPolling = false); version = scope; requested = null; cursor = "0"
                _state.update { it.copy(scope = version, threadId = null, boardThread = null, messages = emptyList(), turn = null,
                    waitingFor = null, uploads = emptyList(), sending = false, sendFailed = false,
                    fileError = "That conversation is no longer available.") }
                try { api.snapshot() } catch (failure: ApiException) {
                    if (current(version) && failure.signedOut) signedOut()
                    throw failure
                }
            }
            if (!current(version) || _state.value.threadId != requested) return@withLock
            cursor = snapshot.cursor
            _state.update { state ->
                val waiting = state.waitingFor?.takeIf { id -> snapshot.turn?.requestId != id && snapshot.messages.none { it.role == "assistant" && it.requestId == id } }
                state.copy(threadId = snapshot.threadId, archivedAt = snapshot.archivedAt, messages = snapshot.messages, runtime = snapshot.runtime,
                    turn = snapshot.turn ?: state.turn?.takeIf { it.state != "streaming" }, waitingFor = waiting, offline = false)
            }
        } finally {
            if (current(version)) {
                _state.update { it.copy(chatLoading = false) }
                pendingPick?.let { (uris, pickScope) -> pendingPick = null; attachFiles(uris, pickScope) }
                markBoardRead()
            }
        }
    }

    private suspend fun sync() {
        if (pendingArchive != null) return
        val version = scope
        val threadId = _state.value.threadId ?: return resync()
        val needsResync = syncing.withLock {
            var more = true
            while (more) {
                val page = try { api.events(threadId, cursor) } catch (error: ApiException) {
                    if (error.status == 400 || error.status == 404 || error.status == 409) return@withLock true else throw error
                }
                if (!current(version, threadId)) return@withLock false
                if (page.threadId != threadId) return@withLock true
                applyEvents(page.events)
                cursor = page.cursor
                more = page.hasMore
            }
            false
        }
        if (!current(version, threadId)) return
        if (needsResync) { resync(); if (!current(version, threadId)) return }
        _state.update { it.copy(offline = false) }
        markBoardRead()
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
                        happyUntil = if (happy && finished) System.currentTimeMillis() + 5000 else state.happyUntil)
                }
                else -> state
            }
        }
    }

    /** Runs a server call; false when it failed. A lost session signs out, a lost connection shows. */
    private suspend fun guarded(block: suspend () -> Unit): Boolean {
        val version = scope
        return try { block(); current(version) }
        catch (error: ApiException) {
            if (current(version)) {
                if (error.signedOut) signedOut() else if (error.code == "NETWORK") _state.update { it.copy(offline = true) }
            }
            false
        }
    }
}

internal data class PendingVoice(val key: String, val requestId: String, val local: File, val threadId: String? = null, val file: Attachment? = null)

fun voiceProblem(code: String, retryable: Boolean): String = when {
    retryable -> "Your voice message was not sent. Retry sends the same recording."
    code == "FILE_NOT_VOICE" -> "That recording could not be read. Try recording again."
    code == "FILE_TOO_LARGE" -> "Voice messages can be up to 5 minutes."
    code == "INVALID_FILE" -> "Voice messages are not available right now."
    else -> fileProblem(code)
}

fun fileProblem(code: String): String = when (code) {
    "FILE_TOO_LARGE", "TOO_LARGE", "BODY_TOO_LARGE", "HTTP_413" -> "That file is too large. Files allow 25 MB; supported videos allow 100 MB."
    "FILE_QUOTA", "QUOTA_EXCEEDED", "FILE_QUOTA_EXCEEDED", "QUOTA" -> "Your file storage is full. Delete an old conversation to make room."
    "INVALID_FILE_NAME" -> "That file's name is not supported. Rename it and choose it again."
    "NETWORK", "HTTP_503" -> "The transfer was not confirmed. Retry uses the same file and request."
    "CANCELLED" -> "Transfer cancelled."
    "INVALID_RESPONSE" -> "The file response could not be verified. Try again."
    else -> "The file could not be transferred. Try again or choose another file."
}
