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
    val chatLoading: Boolean = false,
    val messages: List<Message> = emptyList(),
    val turn: Turn? = null,
    /** The request id of a message that was sent and has no reply yet. */
    val waitingFor: String? = null,
    val sending: Boolean = false,
    val sendFailed: Boolean = false,
    val uploads: List<PendingUpload> = emptyList(),
    val fileError: String? = null,
    val deleting: Boolean = false,
    val deleteFailed: Boolean = false,
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
    val saving: Boolean = false,
    val discord: DiscordStatus? = null,
    val discordBusy: Boolean = false,
    val discordError: String? = null,
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
    private var failedSend: PendingSend? = null
    private var pendingDelete: PendingDelete? = null
    private var createKey: String? = null
    @Volatile private var scope = 0L
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
                invalidateFiles()
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
        // Fence the display immediately, even while logout is in flight.
        invalidateFiles()
        store.session = null
        _state.value = UiState(scope = scope, gate = Gate.SignedOut)
        val version = scope
        viewModelScope.launch {
            Api { previousSession }.signOut()
            if (current(version)) signedOut()
        }
    }

    private fun signedOut() {
        invalidateFiles()
        store.session = null
        poller?.cancel()
        cursor = "0"
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
                resync()
                startPolling()
            } catch (error: ApiException) {
                if (!current(version)) return@launch
                if (error.signedOut) signedOut()
                else { _state.update { it.copy(gate = Gate.Ready, username = session.username, offline = true) }; startPolling() }
            }
        }
    }

    fun setVisible(value: Boolean) {
        visible = value
        if (value && _state.value.gate == Gate.Ready) { viewModelScope.launch { guarded { resync() }; refreshWearing() }; startPolling() }
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
        failedSend = null; pendingDelete = null; createKey = null
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
        if (!current(expectedScope) || state.gate != Gate.Ready || state.chatLoading || state.sending || state.replying || failedSend != null || pendingDelete != null) return
        if (uris.isEmpty()) return
        if (state.uploads.size + uris.size > MAX_FILES) { _state.update { it.copy(fileError = "Choose at most eight files for one message.") }; return }
        val entries = uris.map { uri ->
            val key = Pkce.randomToken(16); uploadSources[key] = uri
            PendingUpload(key, state.threadId ?: "", "Preparing file…")
        }
        _state.update { it.copy(uploads = it.uploads + entries, fileError = null) }
        entries.forEach { startUpload(it.key, expectedScope) }
    }

    fun retryUpload(key: String) {
        if (failedSend != null || _state.value.sending || pendingDelete != null) return
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

    fun send(text: String, expectedScope: Long = scope, onSent: () -> Unit) {
        if (!current(expectedScope)) return
        val now = _state.value
        if (now.chatLoading || now.sending || now.replying || pendingDelete != null || now.uploads.any { it.state != "ready" }) return
        val files = now.uploads.mapNotNull { it.file }.toList()
        val retry = failedSend
        if (retry == null && (!validText(text, 8000, 32768) || text.isBlank() && files.isEmpty())) return
        val version = scope
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

    /** Called only after the UI's destructive-action confirmation. Retry retains this exact request. */
    fun deleteThread(expectedScope: Long = scope) {
        if (!current(expectedScope)) return
        val previous = pendingDelete
        val threadId = previous?.threadId ?: _state.value.threadId ?: return
        if (_state.value.deleting) return
        val request = previous ?: PendingDelete(Pkce.randomToken(16), threadId)
        if (previous == null) { invalidateFiles(); pendingDelete = request }
        val version = scope
        _state.update { it.copy(scope = version, deleting = true, deleteFailed = false, chatLoading = false, uploads = emptyList(), fileError = null,
            messages = emptyList(), turn = null, waitingFor = null, sending = false, sendFailed = false) }
        viewModelScope.launch {
            if (!current(version)) return@launch
            try {
                api.deleteThread(request.threadId, request.requestId)
                if (!current(version)) return@launch
                pendingDelete = null; cursor = "0"
                _state.update { it.copy(threadId = null, messages = emptyList(), turn = null, waitingFor = null,
                    sending = false, sendFailed = false, deleting = false, deleteFailed = false) }
                // A lost refresh after a verified deletion cannot turn it back into an uncertain delete.
                guarded { resync() }; startPolling()
            } catch (error: ApiException) {
                if (!current(version)) return@launch
                if (error.signedOut) { signedOut(); return@launch }
                _state.update { it.copy(deleting = false, deleteFailed = true, fileError = "Deletion was not confirmed. Retry deletion before sending another message.") }
            }
        }
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
                _state.update { it.copy(scope = version, threadId = null, messages = emptyList(), turn = null,
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
                state.copy(threadId = snapshot.threadId, messages = snapshot.messages, runtime = snapshot.runtime,
                    turn = snapshot.turn ?: state.turn?.takeIf { it.state != "streaming" }, waitingFor = waiting, offline = false)
            }
        } finally { if (current(version)) _state.update { it.copy(chatLoading = false) } }
    }

    private suspend fun sync() {
        if (pendingDelete != null) return
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

fun fileProblem(code: String): String = when (code) {
    "FILE_TOO_LARGE", "TOO_LARGE", "BODY_TOO_LARGE", "HTTP_413" -> "That file is too large. Files allow 25 MB; supported videos allow 100 MB."
    "FILE_QUOTA", "QUOTA_EXCEEDED", "FILE_QUOTA_EXCEEDED", "QUOTA" -> "Your file storage is full. Delete an old conversation to make room."
    "INVALID_FILE_NAME" -> "That file's name is not supported. Rename it and choose it again."
    "NETWORK", "HTTP_503" -> "The transfer was not confirmed. Retry uses the same file and request."
    "CANCELLED" -> "Transfer cancelled."
    "INVALID_RESPONSE" -> "The file response could not be verified. Try again."
    else -> "The file could not be transferred. Try again or choose another file."
}
