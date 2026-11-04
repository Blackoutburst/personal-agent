package dev.blackoutburst.companion

import android.app.Application
import android.net.Uri
import android.provider.OpenableColumns
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** A file picked for the next group message: copied to the cache first, so a retry never reopens the picker's URI. */
data class GroupUpload(val key: String, val name: String, val local: File? = null, val progress: Long = 0, val total: Long = 0,
    val file: GroupFile? = null, val state: String = "preparing", val error: String? = null)

data class GroupState(
    /** The Group tab shows once the server answered the list (an older server has no /api/groups). */
    val available: Boolean = false,
    val groups: List<GroupSummary>? = null,
    val owners: List<GroupOwner> = emptyList(),
    val unread: Int = 0,
    val listLoading: Boolean = false,
    val listError: String? = null,
    val busy: Boolean = false,
    val error: String? = null,
    val notice: String? = null,
    /** The open conversation: its id, then its summary (name, members, notify) once loaded. */
    val openId: String? = null,
    val open: GroupSummary? = null,
    val messages: List<GroupMessage> = emptyList(),
    val loading: Boolean = false,
    val typing: List<String> = emptyList(),
    val paused: Boolean = false,
    val offline: Boolean = false,
    val replyTo: GroupMessage? = null,
    val uploads: List<GroupUpload> = emptyList(),
    val sending: Boolean = false,
    val sendFailed: Boolean = false,
    val fileError: String? = null,
    /** Owner pictures by "memberId|photoVersion". */
    val photos: Map<String, OwnerPhoto> = emptyMap(),
    /** Bumped when a notification tap asks for the Group tab. */
    val request: Long = 0,
) {
    val self: String? get() = open?.members?.let(::groupSelf)
    val canCreate: Boolean get() = owners.any { !it.you }
}

private data class PendingGroupPost(val requestId: String, val groupId: String, val text: String, val replyTo: String?, val files: List<String>)

/**
 * Group chat (#53) for CompanionModel: the list with its badge, one open conversation polled every 1.5 s while shown,
 * uploads, typing pings and read markers. Everything is dropped on sign-out (reset).
 */
class GroupChat(private val app: Application, private val scope: CoroutineScope, private val api: Api, private val signedOut: () -> Unit) {
    private val _state = MutableStateFlow(GroupState())
    val state: StateFlow<GroupState> = _state

    @Volatile private var epoch = 0L
    private var poller: Job? = null
    private var visible = false
    private var shown = false
    private var cursor = "0"
    private val syncing = Mutex()
    private var listAt = 0L
    private var readSent = 0L
    /** The open group's snapshot arrived: from then on only events are polled. */
    private var loaded = false
    private var typingSentAt = 0L
    private var typingOn = false
    private var pendingPost: PendingGroupPost? = null
    private var pendingOpen: String? = null
    private var createKey: String? = null
    private val uploadSources = mutableMapOf<String, Uri>()
    private val transfers = mutableMapOf<String, TransferCancellation>()
    private val uploadJobs = mutableMapOf<String, Job>()
    private val media = mutableMapOf<String, File>()
    private val mediaLock = Mutex()
    private val mediaTransfers = mutableSetOf<TransferCancellation>()
    private val photoTried = mutableSetOf<String>()

    private fun current(version: Long, groupId: String? = null) = version == epoch && (groupId == null || _state.value.openId == groupId)

    /** Sign-out or account switch: nothing of the previous owner's groups stays, on screen or in the cache. */
    fun reset() {
        epoch++
        poller?.cancel(); poller = null
        dropUploads()
        mediaTransfers.toList().forEach { it.cancel() }; mediaTransfers.clear(); media.clear(); photoTried.clear()
        File(app.cacheDir, "group-uploads").deleteRecursively(); File(app.cacheDir, "group-media").deleteRecursively()
        cursor = "0"; readSent = 0; loaded = false; typingOn = false; pendingPost = null; createKey = null; listAt = 0
        _state.value = GroupState(request = _state.value.request)
        presence()
    }

    /** Signed in and ready: the list (and badge) now, then the polling loop. */
    fun start() {
        if (poller?.isActive == true) return
        val version = epoch
        poller = scope.launch {
            pendingOpen?.let { pendingOpen = null; open(it, force = true) }
            while (isActive && current(version)) {
                if (!visible) { delay(1000); continue }
                val now = _state.value
                if (now.openId != null && shown && !now.loading) syncOpen(version)
                if (System.currentTimeMillis() - listAt > if (shown && now.openId == null) 10_000L else 30_000L) refreshList(version)
                delay(if (now.openId != null && shown) 1500 else 2000)
            }
        }
    }

    fun setVisible(value: Boolean) {
        visible = value; presence()
        if (value) { markRead(); if (shown) scope.launch { refreshList(epoch) } }
    }

    /** The Group tab is on screen (or not): reads are only marked, and polling only runs fast, while it is. */
    fun setShown(value: Boolean) {
        if (shown == value) return
        shown = value; presence()
        if (value) markRead() else stopTyping()
    }

    private fun presence() { Push.openGroup = if (visible && shown) _state.value.openId else null }

    private fun failed(error: ApiException, version: Long): Boolean {
        if (!current(version)) return true
        if (error.signedOut) { signedOut(); return true }
        return false
    }

    // ---- The list ----

    fun loadList() { _state.update { it.copy(listLoading = it.groups == null) }; scope.launch { refreshList(epoch) } }

    private suspend fun refreshList(version: Long) {
        listAt = System.currentTimeMillis()
        try {
            val list = api.groups()
            if (!current(version)) return
            _state.update { state ->
                state.copy(available = true, groups = list.groups, owners = list.owners, unread = list.unread, listLoading = false, listError = null,
                    open = state.open?.let { open -> list.groups.firstOrNull { it.id == open.id }?.let { open.copy(notify = it.notify) } ?: open })
            }
        } catch (error: ApiException) {
            if (failed(error, version)) return
            // An older server has no group chat (404, or 400/405 from a stricter router): the tab stays hidden.
            val missing = error.status in setOf(400, 404, 405, 501)
            _state.update { it.copy(listLoading = false, available = if (missing && it.openId == null) false else it.available,
                listError = if (missing) null else "Your groups could not be loaded. Trying again…") }
        }
    }

    // ---- One conversation ----

    /** A notification was tapped: the Group tab on that group. Before sign-in finished, it opens once ready. */
    fun openFromPush(groupId: String, ready: Boolean) {
        if (!fileId(groupId)) return
        _state.update { it.copy(request = it.request + 1, available = true) }
        if (!ready) { pendingOpen = groupId; return }
        if (_state.value.openId != groupId) open(groupId, force = true)
    }

    fun open(groupId: String, force: Boolean = false) {
        val now = _state.value
        if (!fileId(groupId)) return
        if (now.openId == groupId) return
        if (!force && (now.sending || now.busy)) return
        stopTyping(); dropUploads(); pendingPost = null
        cursor = "0"; readSent = 0; loaded = false
        val known = now.groups?.firstOrNull { it.id == groupId }
        _state.update { it.copy(openId = groupId, open = known, messages = emptyList(), loading = true, typing = emptyList(), paused = false,
            replyTo = null, uploads = emptyList(), sending = false, sendFailed = false, fileError = null, error = null, notice = null) }
        presence()
        val version = epoch
        scope.launch { loadSnapshot(groupId, version) }
    }

    /** Back to the list. Files picked and not sent are dropped. */
    fun close() {
        if (_state.value.sending) return
        stopTyping(); dropUploads(); pendingPost = null
        cursor = "0"; readSent = 0; loaded = false
        _state.update { it.copy(openId = null, open = null, messages = emptyList(), loading = false, typing = emptyList(), paused = false,
            replyTo = null, uploads = emptyList(), sendFailed = false, fileError = null, error = null) }
        presence()
        scope.launch { refreshList(epoch) }
    }

    private suspend fun loadSnapshot(groupId: String, version: Long) = syncing.withLock {
        try {
            val snapshot = api.groupSnapshot(groupId)
            if (!current(version, groupId)) return@withLock
            cursor = snapshot.cursor; loaded = true
            _state.update { it.copy(open = snapshot.group, messages = snapshot.messages, typing = snapshot.typing, paused = snapshot.paused,
                loading = false, offline = false, error = null) }
            loadPhotos(snapshot.group.members)
        } catch (error: ApiException) {
            if (failed(error, version) || !current(version, groupId)) return@withLock
            if (error.status == 404) gone(groupId)
            else _state.update { it.copy(loading = false, offline = error.code == "NETWORK", error = "This group could not be loaded. Trying again…") }
        }
        if (current(version, groupId)) markRead()
    }

    private fun gone(groupId: String) {
        if (_state.value.openId != groupId) return
        dropUploads(); pendingPost = null
        _state.update { it.copy(openId = null, open = null, messages = emptyList(), loading = false, sending = false, sendFailed = false,
            uploads = emptyList(), replyTo = null, notice = "That group is no longer available.", groups = it.groups?.filter { group -> group.id != groupId }) }
        presence()
    }

    private suspend fun syncOpen(version: Long) {
        val groupId = _state.value.openId ?: return
        if (!loaded) { loadSnapshot(groupId, version); return }
        val reload = syncing.withLock {
            try {
                var more = true
                while (more) {
                    val page = api.groupEvents(groupId, cursor)
                    if (!current(version, groupId)) return@withLock false
                    cursor = page.cursor
                    _state.update { state ->
                        state.copy(messages = mergeGroupMessages(state.messages, page.messages), typing = page.typing, paused = page.paused,
                            open = state.open?.let { open -> open.copy(name = page.name ?: open.name, members = page.members ?: open.members) },
                            offline = false, error = null)
                    }
                    page.members?.let(::loadPhotos)
                    more = page.hasMore && page.messages.isNotEmpty()
                }
                false
            } catch (error: ApiException) {
                if (failed(error, version) || !current(version, groupId)) return@withLock false
                when {
                    error.status == 404 -> { gone(groupId); false }
                    error.status == 400 -> true
                    else -> { _state.update { it.copy(offline = error.code == "NETWORK") }; false }
                }
            }
        }
        if (reload && current(version, groupId)) loadSnapshot(groupId, version)
        if (current(version, groupId)) markRead()
    }

    /** The conversation on screen is read up to its newest message. */
    private fun markRead() {
        val state = _state.value
        val groupId = state.openId ?: return
        if (!visible || !shown || state.loading) return
        val seq = state.messages.lastOrNull()?.seq ?: return
        if (seq <= readSent) return
        readSent = seq
        val version = epoch
        scope.launch {
            try {
                val read = api.groupRead(groupId, seq)
                if (current(version)) _state.update { it.copy(unread = read.unread, groups = it.groups?.map { group -> if (group.id == groupId) group.copy(unread = 0) else group }) }
            } catch (error: ApiException) { if (!failed(error, version) && readSent == seq) readSent = 0 }
        }
    }

    // ---- Owner pictures (cached by photoVersion) ----

    private fun loadPhotos(members: List<GroupMember>) {
        val version = epoch
        for (member in members) {
            val photoVersion = member.photoVersion ?: continue
            if (member.kind != "owner") continue
            val key = member.id + "|" + photoVersion
            if (key in photoTried || key in _state.value.photos) continue
            photoTried += key
            scope.launch {
                try {
                    val photo = api.groupPhoto(member.id)
                    if (current(version) && photo != null) _state.update { it.copy(photos = it.photos + (key to photo)) }
                } catch (error: ApiException) { if (!failed(error, version)) photoTried -= key }
            }
        }
    }

    // ---- Writing ----

    fun reply(message: GroupMessage?) { if (message == null || !message.system) _state.update { it.copy(replyTo = message) } }

    /** Typing pings: active every 4 s while the draft has text, inactive once it is cleared. Only a hint. */
    fun draftChanged(text: String) {
        val groupId = _state.value.openId ?: return
        val now = System.currentTimeMillis()
        val active = when {
            text.isNotBlank() && now - typingSentAt > 4000 -> true
            text.isBlank() && typingOn -> false
            else -> return
        }
        typingOn = active; typingSentAt = if (active) now else 0L
        scope.launch { try { api.groupTyping(groupId, active) } catch (_: ApiException) { } }
    }

    private fun stopTyping() {
        val groupId = _state.value.openId
        if (!typingOn || groupId == null) return
        typingOn = false; typingSentAt = 0L
        scope.launch { try { api.groupTyping(groupId, false) } catch (_: ApiException) { } }
    }

    /** Sends the draft with the ready files (and the reply). After an unconfirmed send, the same request is retried. */
    fun send(text: String, onSent: () -> Unit) {
        val state = _state.value
        val groupId = state.openId ?: return
        if (state.sending || state.loading || state.uploads.any { it.state != "ready" }) return
        val post = pendingPost?.takeIf { it.groupId == groupId } ?: run {
            val files = state.uploads.mapNotNull { it.file?.id }
            if (text.isBlank() && files.isEmpty() || text.length > GROUP_TEXT_CHARS) return
            PendingGroupPost(Pkce.randomToken(16), groupId, text, state.replyTo?.id, files)
        }
        pendingPost = post
        typingOn = false; typingSentAt = 0L
        val version = epoch
        _state.update { it.copy(sending = true, sendFailed = false, fileError = null) }
        scope.launch {
            try {
                val posted = api.groupPost(post.groupId, post.requestId, post.text, post.replyTo, post.files)
                if (!current(version, groupId)) return@launch
                pendingPost = null
                uploadSources.clear()
                _state.value.uploads.forEach { it.local?.delete() }
                _state.update { it.copy(sending = false, sendFailed = false, uploads = emptyList(), replyTo = null,
                    messages = mergeGroupMessages(it.messages, listOf(posted.message))) }
                onSent()
                markRead()
            } catch (error: ApiException) {
                if (failed(error, version) || !current(version, groupId)) return@launch
                val uncertain = error.code == "NETWORK" || error.status >= 500
                if (!uncertain) pendingPost = null
                if (error.status == 404) { gone(groupId); return@launch }
                _state.update { it.copy(sending = false, sendFailed = uncertain, offline = error.code == "NETWORK",
                    fileError = if (uncertain) "Send was not confirmed. Retry sends the same message." else groupProblem(error)) }
            }
        }
    }

    // ---- Files ----

    fun attachFiles(uris: List<Uri>) {
        val state = _state.value
        val groupId = state.openId ?: return
        if (uris.isEmpty()) return
        if (state.sending || pendingPost != null) { _state.update { it.copy(fileError = "Wait for the current message to finish, then attach the files again.") }; return }
        if (state.uploads.size + uris.size > MAX_FILES) { _state.update { it.copy(fileError = "Choose at most eight files for one message.") }; return }
        val entries = uris.map { uri -> val key = Pkce.randomToken(16); uploadSources[key] = uri; GroupUpload(key, "Preparing file…") }
        _state.update { it.copy(uploads = it.uploads + entries, fileError = null) }
        entries.forEach { startUpload(it.key, groupId, epoch) }
    }

    fun attachProblem(message: String) { _state.update { it.copy(fileError = message) } }

    fun retryUpload(key: String) {
        val groupId = _state.value.openId ?: return
        if (_state.value.sending || pendingPost != null) return
        if (_state.value.uploads.none { it.key == key && it.state == "error" }) return
        startUpload(key, groupId, epoch)
    }

    /** Unsent uploads are only dropped here; the server forgets files never posted after a day. */
    fun removeUpload(key: String) {
        if (_state.value.sending || pendingPost != null) return
        transfers.remove(key)?.cancel(); uploadJobs.remove(key)?.cancel(); uploadSources.remove(key)
        _state.value.uploads.firstOrNull { it.key == key }?.local?.delete()
        _state.update { it.copy(uploads = it.uploads.filterNot { upload -> upload.key == key }, fileError = null) }
    }

    private fun dropUploads() {
        transfers.values.toList().forEach { it.cancel() }; transfers.clear()
        uploadJobs.values.toList().forEach { it.cancel() }; uploadJobs.clear()
        uploadSources.clear()
        _state.value.uploads.forEach { it.local?.delete() }
        _state.update { it.copy(uploads = emptyList()) }
    }

    private fun updateUpload(key: String, version: Long, groupId: String, change: (GroupUpload) -> GroupUpload) {
        if (current(version, groupId)) _state.update { it.copy(uploads = it.uploads.map { entry -> if (entry.key == key) change(entry) else entry }) }
    }

    private fun startUpload(key: String, groupId: String, version: Long) {
        if (uploadJobs[key]?.isActive == true) return
        val cancellation = TransferCancellation(); transfers[key] = cancellation
        uploadJobs[key] = scope.launch {
            try {
                var entry = _state.value.uploads.firstOrNull { it.key == key } ?: return@launch
                if (entry.local == null) {
                    updateUpload(key, version, groupId) { it.copy(state = "preparing", error = null) }
                    val uri = uploadSources[key] ?: throw ApiException("FILE_UNAVAILABLE")
                    val (name, local) = withContext(Dispatchers.IO) {
                        val resolver = app.contentResolver
                        var name = "file"
                        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { row ->
                            if (row.moveToFirst()) {
                                val nameIndex = row.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                                if (nameIndex >= 0 && !row.isNull(nameIndex)) name = row.getString(nameIndex)
                                val sizeIndex = row.getColumnIndex(OpenableColumns.SIZE)
                                if (sizeIndex >= 0 && !row.isNull(sizeIndex) && row.getLong(sizeIndex) > GROUP_FILE_BYTES) throw ApiException("FILE_TOO_LARGE")
                            }
                        }
                        if (!fileName(name)) throw ApiException("INVALID_FILE_NAME")
                        val folder = File(app.cacheDir, "group-uploads/$version").apply { mkdirs() }
                        val local = File(folder, key)
                        try {
                            resolver.openInputStream(uri)?.use { input -> local.outputStream().use { output ->
                                val buffer = ByteArray(64 * 1024); var size = 0L
                                while (true) { cancellation.check(); val count = input.read(buffer); if (count < 0) break
                                    size += count; if (size > GROUP_FILE_BYTES) throw ApiException("FILE_TOO_LARGE")
                                    output.write(buffer, 0, count) }
                            } } ?: throw ApiException("FILE_UNAVAILABLE")
                            if (local.length() == 0L) throw ApiException("FILE_UNAVAILABLE")
                            name to local
                        } catch (error: Exception) { local.delete(); throw error }
                    }
                    if (!current(version, groupId)) { local.delete(); return@launch }
                    entry = entry.copy(name = name, local = local, total = local.length())
                }
                updateUpload(key, version, groupId) { entry.copy(state = "uploading", progress = 0, error = null) }
                val local = entry.local ?: throw ApiException("FILE_UNAVAILABLE")
                val file = api.groupUpload(groupId, key, entry.name, local, cancellation) { sent -> updateUpload(key, version, groupId) { it.copy(progress = sent) } }
                updateUpload(key, version, groupId) { it.copy(file = file, state = "ready", progress = local.length(), error = null) }
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) {
                if (!current(version, groupId)) return@launch
                val failure = error as? ApiException ?: ApiException("FILE_UNAVAILABLE")
                if (failure.signedOut) { signedOut(); return@launch }
                updateUpload(key, version, groupId) { it.copy(state = "error", error = groupFileProblem(failure.code)) }
            } finally { if (transfers[key] === cancellation) transfers.remove(key) }
        }
    }

    /** A group file in the private cache (downloaded once per sign-in), for inline images and saving. */
    suspend fun mediaFile(file: GroupFile, cancel: TransferCancellation): File = mediaLock.withLock {
        val version = epoch
        media[file.id]?.takeIf { it.isFile }?.let { return@withLock it }
        mediaTransfers.add(cancel)
        try {
            val folder = File(app.cacheDir, "group-media/$version").apply { mkdirs() }
            val result = api.groupDownload(file, File(folder, Pkce.randomToken(16)), cancel)
            if (!current(version)) { result.delete(); throw ApiException("CANCELLED") }
            media[file.id] = result
            while (media.values.sumOf { it.length() } > 200L * 1024 * 1024 && media.size > 1) {
                val old = media.entries.first { it.key != file.id }; old.value.delete(); media.remove(old.key)
            }
            result
        } catch (error: ApiException) {
            if (current(version) && error.signedOut) signedOut()
            throw error
        } finally { mediaTransfers.remove(cancel) }
    }

    suspend fun saveFile(file: GroupFile, destination: Uri, cancel: TransferCancellation) {
        val local = mediaFile(file, cancel)
        withContext(Dispatchers.IO) {
            app.contentResolver.openOutputStream(destination, "wt")?.use { output -> local.inputStream().use { it.copyTo(output) } }
                ?: throw ApiException("FILE_UNAVAILABLE")
        }
    }

    // ---- Managing groups ----

    /** The create dialog keeps one request id while it is open, so a retry never makes two groups. */
    fun beginCreate() { createKey = Pkce.randomToken(16); _state.update { it.copy(error = null) } }

    fun create(labels: List<String>, name: String?, onDone: () -> Unit) {
        if (_state.value.busy || labels.isEmpty()) return
        val key = createKey ?: Pkce.randomToken(16).also { createKey = it }
        mutate({ api.createGroup(key, labels, name?.trim()?.takeIf { it.isNotEmpty() }) }) { snapshot ->
            createKey = null
            onDone()
            showSnapshot(snapshot)
        }
    }

    fun rename(name: String, onDone: () -> Unit) {
        val groupId = _state.value.openId ?: return
        mutate({ api.renameGroup(groupId, name) }) { snapshot -> onDone(); if (_state.value.openId == groupId) applySnapshot(snapshot) }
    }

    fun addMembers(labels: List<String>, onDone: () -> Unit) {
        val groupId = _state.value.openId ?: return
        if (labels.isEmpty()) return
        mutate({ api.addGroupMembers(groupId, labels) }) { snapshot -> onDone(); if (_state.value.openId == groupId) applySnapshot(snapshot) }
    }

    fun setNotify(notify: String) {
        val groupId = _state.value.openId ?: return
        mutate({ api.groupNotify(groupId, notify) }) { result ->
            _state.update { it.copy(open = it.open?.takeIf { open -> open.id == groupId }?.copy(notify = result.notify) ?: it.open,
                groups = it.groups?.map { group -> if (group.id == groupId) group.copy(notify = result.notify) else group },
                notice = if (result.notify == "mentions") "Notifications: only when you are mentioned." else "Notifications: every message.") }
        }
    }

    fun leave(onDone: () -> Unit = {}) {
        val groupId = _state.value.openId ?: return
        mutate({ api.leaveGroup(groupId) }) { result ->
            onDone()
            gone(groupId)
            _state.update { it.copy(unread = result.unread, notice = "You left the group.") }
            scope.launch { refreshList(epoch) }
        }
    }

    private fun showSnapshot(snapshot: GroupSnapshot) {
        stopTyping(); dropUploads(); pendingPost = null; readSent = 0
        _state.update { it.copy(openId = snapshot.group.id, replyTo = null, sendFailed = false, fileError = null, notice = null) }
        applySnapshot(snapshot)
        presence()
        scope.launch { refreshList(epoch) }
    }

    private fun applySnapshot(snapshot: GroupSnapshot) {
        cursor = snapshot.cursor; loaded = true
        _state.update { it.copy(open = snapshot.group, messages = mergeGroupMessages(snapshot.messages, emptyList()), typing = snapshot.typing,
            paused = snapshot.paused, loading = false,
            groups = it.groups?.map { group -> if (group.id == snapshot.group.id) snapshot.group else group }) }
        loadPhotos(snapshot.group.members)
        markRead()
    }

    private fun <T> mutate(call: suspend () -> T, done: (T) -> Unit) {
        if (_state.value.busy) return
        val version = epoch
        _state.update { it.copy(busy = true, error = null, notice = null) }
        scope.launch {
            try {
                val result = call()
                if (!current(version)) return@launch
                _state.update { it.copy(busy = false) }
                done(result)
            } catch (error: ApiException) {
                if (failed(error, version)) return@launch
                _state.update { it.copy(busy = false, error = groupProblem(error)) }
            }
        }
    }
}

fun groupProblem(error: ApiException): String = when {
    error.code == "NETWORK" -> "Connection lost. The change may or may not have been saved; check and try again."
    error.code == "CAPACITY" -> "You are in too many groups. Leave one first."
    error.code == "CONFLICT" -> "This conflicts with an earlier request. Close and try again."
    error.code == "FILE_NOT_AVAILABLE" -> "A file is no longer available. Remove it and attach it again."
    error.status == 404 -> "That group is no longer available."
    error.code == "INVALID_REQUEST" -> "That was not accepted. Check the name (up to 60 characters) and try again."
    else -> "That did not work. Try again in a moment."
}

fun groupFileProblem(code: String): String = when (code) {
    "FILE_TOO_LARGE", "TOO_LARGE", "HTTP_413" -> "That file is too large. Group files allow 25 MB."
    "FILE_QUOTA", "HTTP_507" -> "Group file storage is full."
    else -> fileProblem(code)
}
