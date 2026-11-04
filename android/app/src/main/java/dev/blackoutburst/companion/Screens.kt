package dev.blackoutburst.companion

import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.platform.LocalContext
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.DropdownMenu
import androidx.activity.result.PickVisualMediaRequest
import android.net.Uri
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.delay

/** The app's colors in one theme. The characters keep their own colors in both. */
data class Tones(
    val top: Color, val bottom: Color, val ink: Color, val soft: Color, val line: Color,
    val card: Color, val mine: Color, val danger: Color, val dark: Boolean,
    /** The companion's chat bubble: lighter than cards in dark mode so it stands out from the background. */
    val bubble: Color = card, val bubbleLine: Color = Color.Transparent,
)

val LightTones = Tones(Color(0xFFFFF6EE), Color(0xFFFDEFF3), Color(0xFF3A2E39), Color(0xFF8A7A86), Color(0xFFF1E4E0),
    Color.White, Color(0xFFFFE3D3), Color(0xFFC0504D), dark = false)
val DarkTones = Tones(Color(0xFF231B22), Color(0xFF2C2029), Color(0xFFF6ECEF), Color(0xFFB8A7B2), Color(0xFF4A3C47),
    Color(0xFF362A33), Color(0xFF5B3F37), Color(0xFFFF8A80), dark = true,
    bubble = Color(0xFF4D3D48), bubbleLine = Color(0xFF5E4C58))

internal val LocalTones = staticCompositionLocalOf { LightTones }
private val Cream: Color @Composable get() = LocalTones.current.top
private val Blush: Color @Composable get() = LocalTones.current.bottom
private val Ink: Color @Composable get() = LocalTones.current.ink
private val Soft: Color @Composable get() = LocalTones.current.soft
private val Line: Color @Composable get() = LocalTones.current.line
private val Card: Color @Composable get() = LocalTones.current.card
private val Mine: Color @Composable get() = LocalTones.current.mine
private val Danger: Color @Composable get() = LocalTones.current.danger

/** System follows the phone's dark mode setting. */
enum class ThemeChoice(val label: String) { System("System"), Light("Light"), Dark("Dark") }

@Composable
fun tonesFor(choice: ThemeChoice): Tones = when (choice) {
    ThemeChoice.System -> if (isSystemInDarkTheme()) DarkTones else LightTones
    ThemeChoice.Light -> LightTones
    ThemeChoice.Dark -> DarkTones
}

private enum class Tab(val label: String) { Chat("Chat"), Group("Groups"), Board("Board"), Calendar("Calendar"), Me("Me") }
/** Sections of the Me tab; memories come first. */
private enum class MeSection(val label: String) { Memories("Memories"), Profile("Your profile"), Companion("Companion"), Watches("Watches"), Connectors("Connectors"), Settings("Settings") }

@Composable
fun CompanionApp(model: CompanionModel, tones: Tones, openBrowser: (android.net.Uri) -> Unit) {
    val state by model.state.collectAsStateWithLifecycle()
    val memoryExport = rememberMemoryExport(model, state.scope)
    val scheme = if (tones.dark) darkColorScheme(primary = tones.ink, background = tones.top, surface = tones.card, onSurface = tones.ink, onSurfaceVariant = tones.soft)
    else lightColorScheme(primary = tones.ink, background = tones.top, surface = tones.card, onSurface = tones.ink, onSurfaceVariant = tones.soft)
    CompositionLocalProvider(LocalTones provides tones) { MaterialTheme(colorScheme = scheme) {
        Box(
            Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Cream, Blush)))
                .statusBarsPadding().navigationBarsPadding().imePadding()
        ) {
            when (state.gate) {
                Gate.Loading -> Gentle(state, Mood.Thinking, "One moment…")
                Gate.SignedOut -> SignInScreen(state) { openBrowser(model.startSignIn()) }
                Gate.Ready -> if (state.profile == null) LookScreen(model, state, first = true) else Home(model, state, memoryExport)
            }
        }
    } }
}

@Composable
private fun Gentle(state: UiState, mood: Mood, text: String) {
    Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        CompanionCharacter(state.profile?.character ?: "pip", state.profile?.color ?: "peach", mood, Modifier.size(180.dp), outfit = state.wearing)
        Spacer(Modifier.height(16.dp))
        Text(text, color = Soft, fontSize = 17.sp, textAlign = TextAlign.Center)
    }
}

@Composable
private fun SignInScreen(state: UiState, signIn: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        CompanionCharacter("pip", "peach", Mood.Sleepy, Modifier.size(200.dp), label = "A sleepy companion")
        Spacer(Modifier.height(20.dp))
        Text("Hello there", fontSize = 28.sp, fontWeight = FontWeight.ExtraBold, color = Ink)
        Spacer(Modifier.height(8.dp))
        Text("Sign in with your blackoutburst.com account to meet your companion.", color = Soft, fontSize = 17.sp, textAlign = TextAlign.Center)
        Spacer(Modifier.height(28.dp))
        Pill(if (state.signingIn) "Waiting for the browser…" else "Sign in", enabled = true, onClick = signIn)
        state.signInError?.let { Spacer(Modifier.height(14.dp)); Text(it, color = Danger, textAlign = TextAlign.Center) }
    }
}

@Composable
private fun Home(model: CompanionModel, state: UiState, memoryExport: MemoryExportControl) {
    var tab by rememberSaveable { mutableStateOf(Tab.Chat) }
    LaunchedEffect(state.chatRequest) { if (state.chatRequest > 0) tab = Tab.Chat }
    // Board tab (#55): a notification for a Board sub-conversation opens it there; leaving the tab returns to the main chat.
    LaunchedEffect(state.boardRequest) { if (state.boardRequest > 0) tab = Tab.Board }
    LaunchedEffect(tab) { if (tab == Tab.Board) model.loadBoard() else model.leaveBoardTopic() }
    // Group tab (#53): a group notification opens that group there; the tab shows once the server has group chat.
    val groups by model.groups.state.collectAsStateWithLifecycle()
    LaunchedEffect(groups.request) { if (groups.request > 0) tab = Tab.Group }
    LaunchedEffect(tab) { model.groups.setShown(tab == Tab.Group) }
    val chatOnScreen = tab == Tab.Chat || (tab == Tab.Board && state.boardThread != null && state.threadId == state.boardThread)
    LaunchedEffect(chatOnScreen) { model.setChatShown(chatOnScreen) }
    DisposableEffect(Unit) { onDispose { model.groups.setShown(false); model.setChatShown(false) } }
    // Notifications (docs/PUSH.md): asked once, right after the first message the owner sends.
    val askPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { model.notificationsAsked() }
    LaunchedEffect(state.askNotifications) { if (state.askNotifications) askPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS) }
    Column(Modifier.fillMaxSize()) {
        Box(Modifier.weight(1f)) {
            when (tab) {
                Tab.Chat -> ChatScreen(model, state)
                Tab.Group -> GroupsTab(model)
                Tab.Board -> if (state.boardThread != null && state.threadId == state.boardThread) ChatScreen(model, state) else BoardScreen(model, state)
                Tab.Calendar -> CalendarScreen(model, state)
                Tab.Me -> MeScreen(model, state, memoryExport) { tab = Tab.Chat }
            }
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
            // The Board tab shows once the owner has a Board conversation (an older server never reports one).
            val shownTabs = Tab.entries.filter {
                (it != Tab.Board || state.boardAny || state.boardThread != null || tab == Tab.Board) &&
                    (it != Tab.Group || tab == Tab.Group || groups.openId != null ||
                        groups.available && (!groups.groups.isNullOrEmpty() || groups.canCreate))
            }
            for (item in shownTabs) {
                val selected = item == tab
                Row(Modifier.clip(RoundedCornerShape(50)).background(if (selected) Card else Color.Transparent)
                    .clickable(role = Role.Tab) { if (item == Tab.Board && tab == Tab.Board) model.leaveBoardTopic(); tab = item }
                    .padding(horizontal = when { shownTabs.size >= 5 -> 10.dp; shownTabs.size == 4 -> 16.dp; else -> 22.dp }, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    val label = @Composable { Text(item.label, color = if (selected) Ink else Soft, fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium, fontSize = 16.sp) }
                    // Board badge (#61): unread Board conversations, 1-9 then 9+, cleared as each one is opened.
                    if (item == Tab.Board && state.boardUnread > 0) {
                        BadgedBox(modifier = Modifier.padding(end = 6.dp), badge = { Badge(containerColor = Color(0xFFEE8F64), contentColor = Color(0xFF3A2E39),
                            modifier = Modifier.semantics { contentDescription = "${state.boardUnread} unread" }) { Text(badgeText(state.boardUnread)) } }) { label() }
                    } else label()
                    if (item == Tab.Group && groups.unread > 0) { Spacer(Modifier.size(6.dp)); UnreadDot(groups.unread) }
                }
            }
        }
    }
}

// ---- Chat ----

@Composable
private fun ChatScreen(model: CompanionModel, state: UiState) {
    var draft by rememberSaveable(state.scope) { mutableStateOf("") }
    var confirmNew by remember(state.scope) { mutableStateOf(false) }
    var showChats by remember(state.scope) { mutableStateOf(false) }
    var pickerScope by remember { mutableLongStateOf(state.scope) }
    // Voice messages: one recording at a time; the bar replaces the composer while it runs.
    val context = LocalContext.current
    val recorder = remember { VoiceRecorder(context) }
    var recordingSince by remember { mutableStateOf<Long?>(null) }
    val stopRecording = { send: Boolean ->
        val result = recorder.stop(send); recordingSince = null
        model.recordingVoice(false)
        if (result != null) model.sendVoice(result.first, state.scope)
        else if (send) model.attachProblem("That was too short to send.")
    }
    DisposableEffect(state.scope) { onDispose { if (recorder.active) { recorder.stop(false); recordingSince = null } } }
    LaunchedEffect(recordingSince) {
        val since = recordingSince ?: return@LaunchedEffect
        // While recording the owner counts as typing.
        while (true) { model.recordingVoice(true); delay(3000) }
    }
    LaunchedEffect(recordingSince) {
        val since = recordingSince ?: return@LaunchedEffect
        // At the limit the message is sent as it is.
        delay(VOICE_MAX_MS - (android.os.SystemClock.elapsedRealtime() - since))
        if (recordingSince == since) stopRecording(true)
    }
    var tick by remember { mutableLongStateOf(0L) }
    LaunchedEffect(Unit) { while (true) { delay(1000); tick = System.currentTimeMillis() } }
    val mood = remember(state, draft.isNotBlank(), tick) { model.mood(draft.isNotBlank()) }
    val list = rememberLazyListState()
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val dismissKeyboard = { focus.clearFocus(); keyboard?.hide() }
    // Only a person dragging the history closes the keyboard; scrolling to a new reply must not.
    LaunchedEffect(list) { list.interactionSource.interactions.collect { if (it is DragInteraction.Start) dismissKeyboard() } }
    val shown = state.messages.filter { it.text.isNotEmpty() || it.attachments.isNotEmpty() }
    // A Board sub-conversation (#55): its topic bar instead of Chats; replies here are about that ticket.
    val onBoard = state.boardThread != null && state.threadId == state.boardThread
    LaunchedEffect(shown.size, shown.lastOrNull()?.text?.length) { if (shown.isNotEmpty()) list.animateScrollToItem(shown.size - 1) }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(16.dp, 8.dp), verticalAlignment = Alignment.CenterVertically) {
            CompanionCharacter(state.profile!!.character, state.profile.color, mood, Modifier.size(96.dp), label = "${state.name}, ${MOOD_TEXT[mood]}",
                outfit = state.wearing, feeling = remember(state, tick) { model.feeling() })
            Spacer(Modifier.size(12.dp))
            Column(Modifier.weight(1f)) {
                Text(state.name, fontSize = 24.sp, fontWeight = FontWeight.ExtraBold, color = Ink)
                Text(MOOD_TEXT.getValue(mood), color = Soft, fontSize = 15.sp)
            }
            if (!onBoard) ActionButton(enabled = !state.archiving, onClick = { showChats = true; model.loadPastChats() }) { Text("Chats") }
        }
        if (onBoard) BoardTopicBar(model, state, state.threadId!!)
        LazyColumn(Modifier.weight(1f).fillMaxWidth().pointerInput(Unit) { detectTapGestures(onTap = { dismissKeyboard() }) },
            state = list, verticalArrangement = Arrangement.spacedBy(8.dp),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp)) {
            if (shown.isEmpty()) item {
                Text("Say hello to ${state.name}!", Modifier.fillMaxWidth().padding(top = 40.dp), color = Soft, textAlign = TextAlign.Center, fontSize = 17.sp)
            }
            items(shown, key = { it.id }) { Bubble(model, it, state.scope) }
            // The reply arrives bubble by bubble: the companion keeps "typing" under them until it is done.
            if (state.replying) item(key = "typing") { TypingBubble() }
        }
        note(state)?.let {
            Text(it, Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp), color = Soft, fontSize = 14.sp, textAlign = TextAlign.Center)
        }
        state.fileError?.let { Text(it, Modifier.fillMaxWidth().padding(horizontal = 16.dp), color = Danger, fontSize = 14.sp) }
        if (state.voiceFailed) Row(Modifier.padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ActionButton(onClick = { model.retryVoice() }) { Text("Retry voice message") }
            ActionButton(onClick = { model.discardVoice() }) { Text("Discard") }
        }
        if (state.voiceSending) Text("Sending voice message…", Modifier.padding(horizontal = 16.dp), color = Soft, fontSize = 14.sp)
        if (state.uploads.isNotEmpty()) Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            state.uploads.forEach { upload ->
                UploadCard(model, upload, state.sending || state.sendFailed, Modifier.width(260.dp))
            }
        }
        if (state.archiveFailed) ActionButton(onClick = { model.archiveThread(state.scope) }) { Text("Retry new chat") }
        if (state.archiving) Text("Starting a new chat…", Modifier.padding(horizontal = 16.dp), color = Soft)
        if (state.archivedAt != null) Row(Modifier.fillMaxWidth().padding(12.dp, 8.dp).clip(RoundedCornerShape(16.dp)).background(Card).padding(14.dp, 10.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Text("Archived chat · ended ${chatDate(state.archivedAt)} · read-only", Modifier.weight(1f), color = Soft, fontSize = 14.sp)
            ActionButton(onClick = { model.backToCurrent() }) { Text("Back to chat") }
        } else if (recordingSince != null) RecordingBar(recordingSince!!, onCancel = { stopRecording(false) }, onSend = { stopRecording(true) },
            Modifier.padding(12.dp, 6.dp))
        else Row(Modifier.fillMaxWidth().padding(12.dp, 6.dp), verticalAlignment = Alignment.Bottom) {
            AttachMenu(enabled = !state.chatLoading && !state.sending && !state.sendFailed && !state.archiving && !state.archiveFailed && state.uploads.size < MAX_FILES,
                onLaunch = { pickerScope = state.scope }, onPicked = { uris -> model.attachFiles(uris, pickerScope) }, onProblem = model::attachProblem)
            Spacer(Modifier.size(8.dp))
            OutlinedTextField(draft, { if (it.length <= 8000) { draft = it; model.draftChanged(it) } }, Modifier.weight(1f),
                placeholder = { Text("Write a message…") }, shape = RoundedCornerShape(24.dp), maxLines = 5,
                enabled = !state.chatLoading && !state.sending && !state.sendFailed && !state.archiving && !state.archiveFailed,
                textStyle = TextStyle(fontSize = 17.sp, color = Ink),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Default),
                colors = OutlinedTextFieldDefaults.colors(focusedContainerColor = Card, unfocusedContainerColor = Card,
                    focusedBorderColor = Line, unfocusedBorderColor = Line))
            Spacer(Modifier.size(8.dp))
            // Like Discord: while the box is empty the mic stands where Send is; typing turns it into Send.
            // While a reply runs, Stop shows next to the mic: they can keep texting or talking, and messages
            // sent close together get one reply.
            val empty = draft.isBlank() && state.uploads.isEmpty() && !state.sendFailed
            if (empty) {
                if (state.replying) { RoundButton("Stop", "■") { model.stop(state.scope) }; Spacer(Modifier.size(8.dp)) }
                MicButton(enabled = !state.chatLoading && !state.sending && !state.voiceSending && !state.voiceFailed && !state.archiving && !state.archiveFailed,
                    onRecord = {
                        if (recorder.start(model.voiceRecordingFile())) recordingSince = recorder.startedAt
                        else model.attachProblem("The microphone could not start. Try again.")
                    }, onProblem = model::attachProblem)
            }
            else RoundButton(if (state.sendFailed) "Retry send" else "Send", if (state.sendFailed) "↻" else "↑",
                enabled = (draft.isNotBlank() || state.uploads.isNotEmpty() || state.sendFailed) && !state.chatLoading && !state.sending && !state.archiving && !state.archiveFailed && state.uploads.all { it.state == "ready" }) {
                val submitted = draft
                model.send(submitted, state.scope) { if (draft == submitted) draft = "" }
            }
        }
    }
    if (showChats) AlertDialog(onDismissRequest = { showChats = false },
        title = { Text("Chats") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                val canStart = state.archivedAt == null && state.threadId != null && state.messages.isNotEmpty() &&
                    !state.replying && !state.sending && !state.chatLoading && !state.archiving
                ActionButton(enabled = canStart, onClick = { showChats = false; confirmNew = true }) { Text("Start a new chat") }
                Text("Past chats", fontWeight = FontWeight.Bold, color = Ink, modifier = Modifier.padding(top = 6.dp))
                when {
                    state.pastChatsLoading && state.pastChats == null -> Text("Loading…", color = Soft)
                    state.pastChatsFailed -> Text("Past chats could not be loaded. Try again in a moment.", color = Danger)
                    state.pastChats.isNullOrEmpty() -> Text("No past chats yet. Starting a new chat keeps this one here, read-only.", color = Soft)
                    else -> LazyColumn(Modifier.heightIn(max = 360.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        items(state.pastChats, key = { it.id }) { chat ->
                            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Card)
                                .clickable { showChats = false; model.openArchived(chat.id) }.padding(12.dp, 10.dp)) {
                                Text(if (chat.title == "Companion") "Chat" else chat.title, color = Ink, fontWeight = FontWeight.SemiBold, maxLines = 2)
                                Text("${chatDate(chat.startedAt)} – ${chatDate(chat.archivedAt)} · ${chat.messages} message${if (chat.messages == 1) "" else "s"}",
                                    color = Soft, fontSize = 13.sp)
                            }
                        }
                    }
                }
            }
        },
        confirmButton = { ActionButton(onClick = { showChats = false }) { Text("Close") } })
    if (confirmNew) AlertDialog(onDismissRequest = { confirmNew = false },
        title = { Text("Start a new chat?") },
        text = { Text("This chat moves to Past chats, where you can still read it. ${state.name} keeps their memories.") },
        confirmButton = { ActionButton(onClick = { confirmNew = false; model.archiveThread(state.scope) }) { Text("Start new chat") } },
        dismissButton = { ActionButton(onClick = { confirmNew = false }) { Text("Cancel") } })
}

private val MOOD_TEXT = mapOf(Mood.Idle to "Here with you", Mood.Listening to "Listening…", Mood.Thinking to "Thinking…",
    Mood.Talking to "Writing to you…", Mood.Happy to "Happy to see you", Mood.Sleepy to "A bit sleepy")

private fun note(state: UiState): String? {
    val name = state.name
    val provider = if (state.runtime?.provider == "codex") "ChatGPT" else "Claude"
    if (state.sendFailed) return "Couldn't send that. Tap send to try again."
    if (state.offline) return "Connection lost. Trying again…"
    val turn = state.turn
    if (turn?.state == "error") {
        val error = turn.error
        return when (error?.code) {
            "USAGE_LIMIT" -> {
                val whenText = error.resetsAt?.let { runCatching {
                    OffsetDateTime.parse(it).atZoneSameInstant(java.time.ZoneId.systemDefault())
                        .format(DateTimeFormatter.ofPattern("EEEE HH:mm"))
                }.getOrNull() } ?: "soon"
                "$name needs a little rest: your $provider plan's limit is reached. Back $whenText."
            }
            "NOT_SIGNED_IN" -> "$name can't think right now: the $provider account on the server needs to be signed in again."
            "NO_RUNTIME", "PROVIDER_MISSING" -> "$name isn't set up yet. Ask the server admin to finish the setup."
            "INTERRUPTED" -> "$name got interrupted. Could you say that again?"
            else -> "$name couldn't answer that time. Try again in a moment."
        }
    }
    val runtime = state.runtime?.state
    if (runtime != null && runtime != "ready") {
        return if (runtime == "signed-out") "$name is asleep: the $provider account on the server needs to be signed in."
        else "$name isn't set up yet. Ask the server admin to finish the setup."
    }
    return null
}

/** The chat's + button: a menu like the iPhone's with photos and videos, a picture taken now, or any file. */
@Composable
internal fun AttachMenu(enabled: Boolean, onLaunch: () -> Unit, onPicked: (List<Uri>) -> Unit, onProblem: (String) -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val files = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris -> if (uris.isNotEmpty()) onPicked(uris) }
    val photos = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(MAX_FILES)) { uris -> if (uris.isNotEmpty()) onPicked(uris) }
    // Kept across the activity being recreated while the camera app is open.
    var shot by rememberSaveable { mutableStateOf<String?>(null) }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { taken ->
        val uri = shot?.let(Uri::parse); shot = null
        if (taken && uri != null) onPicked(listOf(uri)) else uri?.let { CameraShots.discard(context, it) }
    }
    var open by remember { mutableStateOf(false) }
    Box {
        RoundButton("Attach files", "+", enabled = enabled) { open = true }
        DropdownMenu(open, { open = false }) {
            DropdownMenuItem(text = { Text("Photos & videos") }, onClick = {
                open = false; onLaunch(); photos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo))
            })
            DropdownMenuItem(text = { Text("Take photo") }, onClick = {
                open = false; onLaunch()
                val uri = CameraShots.create(context); shot = uri.toString()
                try { camera.launch(uri) } catch (_: android.content.ActivityNotFoundException) {
                    shot = null; CameraShots.discard(context, uri); onProblem("No camera app is available.")
                }
            })
            DropdownMenuItem(text = { Text("Files") }, onClick = { open = false; onLaunch(); files.launch(arrayOf("*/*")) })
        }
    }
}

@Composable
internal fun TypingBubble() {
    val pulse = rememberInfiniteTransition(label = "typing")
    val alpha by pulse.animateFloat(0.35f, 1f, infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "dots")
    Row(Modifier.fillMaxWidth()) {
        Text("•••", Modifier.clip(RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp, bottomStart = 6.dp, bottomEnd = 20.dp))
            .background(LocalTones.current.bubble).border(1.dp, LocalTones.current.bubbleLine, RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp, bottomStart = 6.dp, bottomEnd = 20.dp))
            .padding(horizontal = 16.dp, vertical = 8.dp).semantics { contentDescription = "Typing" },
            color = Soft.copy(alpha = alpha), fontSize = 20.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
internal fun Bubble(model: CompanionModel, message: Message, scope: Long) {
    if (message.role == "peer") { PeerCard(message); return }
    if (message.role == "app") { AppNote(message); return }
    if (message.role != "user" && message.role != "assistant") return
    val mine = message.role == "user"
    // A companion reply shows as several short bubbles, one per paragraph (splitBubbles); files go in the last one.
    val texts = if (mine) listOf(message.text) else splitBubbles(message.text).ifEmpty { listOf("") }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            texts.forEachIndexed { index, text ->
                val last = index == texts.lastIndex
                val bubbleShape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp,
                    bottomStart = if (mine || !last) 20.dp else 6.dp, bottomEnd = if (mine) 6.dp else 20.dp)
                Column(
                    Modifier.widthIn(max = 320.dp)
                        .clip(bubbleShape)
                        .background(if (mine) Mine else LocalTones.current.bubble)
                        .border(1.dp, if (mine) Color.Transparent else LocalTones.current.bubbleLine, bubbleShape)
                        .padding(horizontal = 16.dp, vertical = 10.dp)) {
                    if (text.isNotEmpty()) MarkdownText(text, color = Ink,
                        link = if (LocalTones.current.dark) Color(0xFFEE8F64) else Color(0xFFB4532A),
                        codeBackground = if (LocalTones.current.dark) Color.Black.copy(alpha = 0.28f) else Ink.copy(alpha = 0.08f),
                        fontSize = 17.sp, lineHeight = 23.sp)
                    if (last) message.attachments.forEach { file ->
                        if (text.isNotEmpty() || file != message.attachments.first()) Spacer(Modifier.height(8.dp))
                        AttachmentView(model, file, scope)
                    }
                }
            }
        }
    }
}

// ---- Memories ----

// ---- Me: memories first, then the companion's look and connections, then app settings ----

@Composable
private fun MeScreen(model: CompanionModel, state: UiState, memoryExport: MemoryExportControl, done: () -> Unit) {
    var section by rememberSaveable { mutableStateOf(MeSection.Memories) }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, top = 12.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for (item in MeSection.entries) {
                val selected = item == section
                Text(item.label, Modifier.clip(RoundedCornerShape(50)).background(if (selected) Card else Color.Transparent)
                    .border(1.dp, if (selected) Color.Transparent else Line, RoundedCornerShape(50))
                    .clickable(role = Role.Tab) { section = item }.padding(horizontal = 16.dp, vertical = 8.dp),
                    color = if (selected) Ink else Soft, fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium, fontSize = 15.sp)
            }
        }
        Box(Modifier.weight(1f)) {
            when (section) {
                MeSection.Memories -> MemoryPanel(model, state, memoryExport)
                MeSection.Profile -> OwnerProfilePanel(model, state)
                MeSection.Companion -> LookScreen(model, state, first = false, done = done)
                MeSection.Watches -> WatchesScreen(model, state)
                MeSection.Connectors -> ConnectorsScreen(model, state)
                MeSection.Settings -> SettingsScreen(model, state)
            }
        }
    }
}

private val CONNECTOR_STATES = mapOf("connected" to "Connected", "pending" to "Waiting for pairing", "error" to "Needs attention",
    "not_connected" to "Not connected", "paused" to "Switched off", "unavailable" to "Not available", "expiring" to "Expires soon")

/** Me › Connectors (#43): every link with its state; the Board is switched off and on here, Discord keeps its own setup below. */
@Composable
private fun ConnectorsScreen(model: CompanionModel, state: UiState) {
    LaunchedEffect(state.scope) { model.loadConnectors() }
    var disconnecting by remember(state.scope) { mutableStateOf<Connector?>(null) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp)) {
        Text("Connectors", fontSize = 26.sp, fontWeight = FontWeight.ExtraBold, color = Ink)
        Text("What ${state.name} is linked to. Switching one off never deletes anything on the other side.", color = Soft, fontSize = 15.sp)
        state.connectorsError?.let { Text(it, color = Danger, modifier = Modifier.padding(top = 6.dp)) }
        for (item in state.connectors ?: emptyList()) {
            Column(Modifier.fillMaxWidth().padding(top = 12.dp).clip(RoundedCornerShape(18.dp)).background(Card).padding(14.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(item.name, Modifier.weight(1f), fontSize = 17.sp, fontWeight = FontWeight.Bold, color = Ink)
                    Box(Modifier.size(9.dp).clip(CircleShape).background(when (item.state) {
                        "connected" -> Color(0xFF3FB950); "pending", "expiring" -> Color(0xFFD29922); "error" -> Danger; else -> Soft }))
                    Text("  " + (CONNECTOR_STATES[item.state] ?: item.state), fontSize = 13.sp, fontWeight = FontWeight.Bold,
                        color = if (item.state == "connected") Ink else Soft)
                }
                Text(item.purpose, color = Ink, fontSize = 15.sp, modifier = Modifier.padding(top = 4.dp))
                item.detail?.let { Text(it, color = Soft, fontSize = 13.sp, modifier = Modifier.padding(top = 2.dp)) }
                if (item.id == "github") GitHubControls(model, state, item) { disconnecting = item }
                else if (item.id == "x") XControls(model, state, item)
                else if (item.id != "discord" && item.actions.isNotEmpty()) {
                    val connect = "connect" in item.actions
                    ActionButton(enabled = !state.connectorsBusy, onClick = { if (connect) model.setConnector(item.id, true) else disconnecting = item },
                        modifier = Modifier.padding(top = 8.dp)) { Text(if (connect) "Connect" else "Disconnect") }
                }
            }
        }
        Spacer(Modifier.height(28.dp))
        DiscordSection(model, state, state.name)
        Spacer(Modifier.height(24.dp))
    }
    disconnecting?.let { item ->
        AlertDialog(onDismissRequest = { disconnecting = null },
            title = { Text("Disconnect ${item.name}?") },
            text = { Text("${state.name} stops using it until you connect it again. Nothing is deleted there.") },
            confirmButton = { ActionButton(onClick = { disconnecting = null; if (item.id == "github") model.github(null) else model.setConnector(item.id, false) }) { Text("Disconnect", color = Danger) } },
            dismissButton = { ActionButton(onClick = { disconnecting = null }) { Text("Keep it") } })
    }
}

/** GitHub (#45): the owner pastes their own fine-grained token; it is stored encrypted on the server and never shown again. */
@Composable
private fun GitHubControls(model: CompanionModel, state: UiState, item: Connector, disconnect: () -> Unit) {
    val uri = LocalUriHandler.current
    var replacing by remember(state.scope) { mutableStateOf(false) }
    var token by remember(state.scope) { mutableStateOf("") }
    if (item.state == "not_connected" || replacing) {
        Spacer(Modifier.height(6.dp))
        Text("1. Create a fine-grained token on GitHub (pick an expiry and the repositories to share).", color = Soft, fontSize = 14.sp)
        ActionButton({ uri.openUri("https://github.com/settings/personal-access-tokens/new") }) { Text("Open GitHub token settings", color = Color(0xFFD9764A)) }
        Text("2. Permissions: Administration (read and write) to create repos; Contents, Metadata and Pull requests (read). Add Checks (read) for CI results.", color = Soft, fontSize = 14.sp)
        Text("3. Paste it here. It is stored encrypted, only for you, and never shown again.", color = Soft, fontSize = 14.sp)
        OutlinedTextField(token, { token = it.trim() }, Modifier.fillMaxWidth().padding(top = 8.dp), label = { Text("github_pat_…") }, singleLine = true,
            visualTransformation = PasswordVisualTransformation(), shape = RoundedCornerShape(18.dp),
            keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Password),
            colors = OutlinedTextFieldDefaults.colors(focusedContainerColor = Card, unfocusedContainerColor = Card))
        Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ActionButton(enabled = !state.connectorsBusy && token.isNotBlank(), onClick = {
                model.github(token) { replacing = false }; token = ""
            }) { Text(if (state.connectorsBusy) "Checking…" else "Connect") }
            if (replacing) ActionButton(onClick = { replacing = false; token = "" }) { Text("Cancel") }
        }
    } else Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        ActionButton(enabled = !state.connectorsBusy, onClick = { replacing = true }) { Text("Paste a new token") }
        ActionButton(enabled = !state.connectorsBusy, onClick = disconnect) { Text("Disconnect") }
    }
}

/** X / Twitter (#46): reading works through FxTwitter; an optional X API bearer token is a backup, stored encrypted and never shown again. */
@Composable
private fun XControls(model: CompanionModel, state: UiState, item: Connector) {
    val uri = LocalUriHandler.current
    var adding by remember(state.scope) { mutableStateOf(false) }
    var removing by remember(state.scope) { mutableStateOf(false) }
    var token by remember(state.scope) { mutableStateOf("") }
    if (adding) {
        Spacer(Modifier.height(6.dp))
        Text("1. In the X developer console, open your app (pay-per-use credits) and copy its Bearer Token.", color = Soft, fontSize = 14.sp)
        ActionButton({ uri.openUri("https://developer.x.com/en/portal/dashboard") }) { Text("Open the X developer console", color = Color(0xFFD9764A)) }
        Text("2. Paste it here. It is stored encrypted, only for you, never shown again, and used only when FxTwitter cannot read a post.", color = Soft, fontSize = 14.sp)
        OutlinedTextField(token, { token = it.trim() }, Modifier.fillMaxWidth().padding(top = 8.dp), label = { Text("Bearer token") }, singleLine = true,
            visualTransformation = PasswordVisualTransformation(), shape = RoundedCornerShape(18.dp),
            keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Password),
            colors = OutlinedTextFieldDefaults.colors(focusedContainerColor = Card, unfocusedContainerColor = Card))
        Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ActionButton(enabled = !state.connectorsBusy && token.isNotBlank(), onClick = { model.xKey(token) { adding = false }; token = "" }) {
                Text(if (state.connectorsBusy) "Checking…" else "Save key") }
            ActionButton(onClick = { adding = false; token = "" }) { Text("Cancel") }
        }
    } else Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        ActionButton(enabled = !state.connectorsBusy, onClick = { adding = true }) { Text(if ("add" in item.actions) "Add an X API key (optional)" else "Paste a new key") }
        if ("remove" in item.actions) ActionButton(enabled = !state.connectorsBusy, onClick = { removing = true }) { Text("Remove key") }
    }
    if (removing) AlertDialog(onDismissRequest = { removing = false }, title = { Text("Remove your X API key?") },
        text = { Text("${state.name} keeps reading posts through FxTwitter.") },
        confirmButton = { ActionButton(onClick = { removing = false; model.xKey(null) }) { Text("Remove", color = Danger) } },
        dismissButton = { ActionButton(onClick = { removing = false }) { Text("Keep it") } })
}

@Composable
private fun SettingsScreen(model: CompanionModel, state: UiState) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp)) {
        Text("Settings", fontSize = 26.sp, fontWeight = FontWeight.ExtraBold, color = Ink)
        if (Push.configured) {
            Spacer(Modifier.height(16.dp))
            NotificationsSection(model, state.name)
        }
        Spacer(Modifier.height(28.dp))
        ScheduleSettingsSection(model, state)
        Spacer(Modifier.height(28.dp))
        ThemePicker(model)
        Spacer(Modifier.height(24.dp))
    }
}

// ---- Look ----

@Composable
private fun LookScreen(model: CompanionModel, state: UiState, first: Boolean, done: () -> Unit = {}) {
    val profile = state.profile
    var name by rememberSaveable { mutableStateOf(profile?.name ?: "") }
    var character by rememberSaveable { mutableStateOf(profile?.character ?: "pip") }
    var color by rememberSaveable { mutableStateOf(profile?.color ?: "peach") }
    var outfit by rememberSaveable { mutableStateOf(profile?.outfit ?: "auto") }
    var saved by remember { mutableStateOf(false) }
    val shownOutfit = if (outfit == "auto") state.wearing else outfit
    val shownName = name.ifBlank { CHARACTERS.first { it.id == character }.label }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(if (first) "Meet your companion" else "${profile?.name ?: shownName}’s look", fontSize = 26.sp, fontWeight = FontWeight.ExtraBold, color = Ink)
        if (first) Text("Pick how it looks and give it a name. You can change this any time.", color = Soft, fontSize = 15.sp, textAlign = TextAlign.Center)
        CompanionCharacter(character, color, Mood.Happy, Modifier.size(200.dp).padding(8.dp), label = shownName, outfit = shownOutfit)
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for (option in CHARACTERS) {
                val selected = option.id == character
                Column(Modifier.clip(RoundedCornerShape(20.dp)).background(if (selected) Card else Color.Transparent)
                    .border(2.dp, if (selected) COLORS.getValue(color).shade else Color.Transparent, RoundedCornerShape(20.dp))
                    .clickable(role = Role.RadioButton) { character = option.id; saved = false }.padding(8.dp),
                    horizontalAlignment = Alignment.CenterHorizontally) {
                    CompanionCharacter(option.id, color, Mood.Idle, Modifier.size(58.dp), label = "${option.label}, ${option.hint}", still = true, outfit = shownOutfit)
                    Text(option.label, fontSize = 14.sp, color = Ink, fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal)
                }
            }
        }
        Spacer(Modifier.height(16.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            for ((id, palette) in COLORS) {
                val selected = id == color
                Box(Modifier.size(40.dp).clip(CircleShape).background(palette.body)
                    .border(if (selected) 3.dp else 0.dp, if (selected) Ink else Color.Transparent, CircleShape)
                    .clickable(role = Role.RadioButton) { color = id; saved = false }
                    .semantics { contentDescription = id })
            }
        }
        if (hasOutfits(character)) {
            Spacer(Modifier.height(20.dp))
            Text("Outfit", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = Ink, modifier = Modifier.fillMaxWidth())
            Text("Automatic changes with the time of day, the seasons and special days.", color = Soft, fontSize = 14.sp, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(8.dp))
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for ((id, label) in listOf("auto" to "Automatic") + OUTFITS) {
                    val selected = id == outfit
                    Column(Modifier.width(84.dp).clip(RoundedCornerShape(16.dp)).background(if (selected) Card else Color.Transparent)
                        .border(2.dp, if (selected) COLORS.getValue(color).shade else Color.Transparent, RoundedCornerShape(16.dp))
                        .clickable(role = Role.RadioButton) { outfit = id; saved = false }.padding(6.dp),
                        horizontalAlignment = Alignment.CenterHorizontally) {
                        CompanionCharacter(character, color, Mood.Idle, Modifier.size(64.dp), label = label, still = true,
                            outfit = if (id == "auto") state.wearing else id)
                        Text(label, fontSize = 12.sp, color = Ink, textAlign = TextAlign.Center, maxLines = 2,
                            fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal)
                    }
                }
            }
        }
        Spacer(Modifier.height(20.dp))
        OutlinedTextField(name, { if (it.length <= 40) { name = it; saved = false } }, Modifier.fillMaxWidth(),
            label = { Text("Name") }, placeholder = { Text(CHARACTERS.first { it.id == character }.label) }, singleLine = true,
            shape = RoundedCornerShape(18.dp), keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words),
            colors = OutlinedTextFieldDefaults.colors(focusedContainerColor = Card, unfocusedContainerColor = Card))
        Spacer(Modifier.height(20.dp))
        Pill(if (state.saving) "Saving…" else if (first) "Say hello" else if (saved) "Saved" else "Save", enabled = !state.saving) {
            model.saveProfile(shownName, character, color, outfit) { saved = true; if (!first) done() }
        }
        AnimatedVisibility(state.offline) { Text("Connection lost. Trying again…", color = Soft, modifier = Modifier.padding(top = 10.dp)) }
        if (!first) {
            Spacer(Modifier.height(32.dp))
            WeatherPanel(model, state)
            Spacer(Modifier.height(32.dp))
            PersonalityPanel(model, state)
            Spacer(Modifier.height(32.dp))
            ContactPanel(model, state)
        }
    }
}

// Notifications (docs/PUSH.md): on/off and message preview, plus a way back when Android blocks them.
@Composable
private fun NotificationsSection(model: CompanionModel, name: String) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var enabled by remember { mutableStateOf(Push.enabled(context)) }
    var preview by remember { mutableStateOf(Push.preview(context)) }
    var permitted by remember { mutableStateOf(Push.permitted(context)) }
    LifecycleResumeEffect(Unit) { permitted = Push.permitted(context); onPauseOrDispose { } }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        model.notificationsAsked(); permitted = granted
    }
    Text("Notifications", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = Ink)
    Spacer(Modifier.height(6.dp))
    SettingSwitch("Tell me when $name writes", enabled) {
        enabled = it; model.setNotifications(it)
        if (it && !permitted) ask.launch(android.Manifest.permission.POST_NOTIFICATIONS)
    }
    SettingSwitch("Show the message in the notification", preview, active = enabled) { preview = it; Push.setPreview(context, it) }
    if (enabled && !permitted) {
        Spacer(Modifier.height(6.dp))
        Text("Android is blocking notifications from Companion.", color = Danger, fontSize = 15.sp)
        Spacer(Modifier.height(8.dp))
        ActionButton({
            if (!Push.asked(context)) ask.launch(android.Manifest.permission.POST_NOTIFICATIONS)
            else context.startActivity(android.content.Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, context.packageName))
        }) { Text("Allow notifications", color = Ink, fontWeight = FontWeight.Bold) }
    }
}

@Composable
private fun SettingSwitch(label: String, checked: Boolean, active: Boolean = true, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(enabled = active, role = Role.Switch) { onChange(!checked) }.padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f), color = if (active) Ink else Soft, fontSize = 16.sp)
        Switch(checked = checked, onCheckedChange = onChange, enabled = active,
            colors = SwitchDefaults.colors(checkedTrackColor = Color(0xFFEE8F64), checkedThumbColor = Color.White))
    }
}

// Discord (docs/DISCORD.md): the owner links their own bot, then pairs by sending it a code in a DM.
@Composable
private fun DiscordSection(model: CompanionModel, state: UiState, name: String) {
    val discord = state.discord
    val uri = LocalUriHandler.current
    val clipboard = LocalClipboardManager.current
    var token by rememberSaveable { mutableStateOf("") }
    var confirmOff by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { model.loadDiscord() }
    // While waiting for the pairing message, check again every few seconds.
    LaunchedEffect(discord?.linked, discord?.user, discord?.pairing?.code) {
        while (discord?.linked == true && discord.user == null && discord.problem == null) { delay(4000); model.loadDiscord() }
    }
    Column(Modifier.fillMaxWidth()) {
        Text("Discord", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = Ink)
        Spacer(Modifier.height(8.dp))
        when {
            discord == null -> Text("Loading…", color = Soft)
            !discord.linked -> {
                Text("Talk to $name in Discord direct messages. Reminders arrive there too.", color = Soft, fontSize = 15.sp)
                Spacer(Modifier.height(8.dp))
                Text("1. Open the Discord Developer Portal and create a New Application.", color = Soft, fontSize = 15.sp)
                ActionButton({ uri.openUri("https://discord.com/developers/applications") }) { Text("Open the Developer Portal", color = Color(0xFFD9764A)) }
                Text("2. In Bot, press Reset Token and copy the token.", color = Soft, fontSize = 15.sp)
                Text("3. Paste it here. It stays on the server and is never shown again.", color = Soft, fontSize = 15.sp)
                Spacer(Modifier.height(10.dp))
                OutlinedTextField(token, { token = it.trim() }, Modifier.fillMaxWidth(), label = { Text("Bot token") }, singleLine = true,
                    visualTransformation = PasswordVisualTransformation(), shape = RoundedCornerShape(18.dp),
                    keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Password),
                    colors = OutlinedTextFieldDefaults.colors(focusedContainerColor = Card, unfocusedContainerColor = Card))
                Spacer(Modifier.height(10.dp))
                Pill(if (state.discordBusy) "Connecting…" else "Connect", enabled = !state.discordBusy && token.isNotBlank()) {
                    model.linkDiscord(token); token = ""
                }
            }
            else -> {
                val bot = discord.bot
                val online = when (discord.state) { "online" -> "Online"; "error" -> "Not connected"; else -> "Connecting…" }
                val dot = when (discord.state) { "online" -> Color(0xFF3FB950); "error" -> Danger; else -> Soft }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Bot ${bot?.name ?: ""} · ", color = Ink, fontSize = 15.sp)
                    Box(Modifier.size(9.dp).clip(CircleShape).background(dot))
                    Text(" $online", color = Ink, fontSize = 15.sp, fontWeight = FontWeight.Bold)
                }
                Spacer(Modifier.height(6.dp))
                when {
                    discord.problem != null -> Text(if (discord.problem == "DISALLOWED_INTENTS") "Discord refused the connection settings for this bot."
                        else "Discord no longer accepts this bot’s token. Disconnect, then connect again with a new token.", color = Danger, fontSize = 15.sp)
                    discord.user != null -> Text("Linked to ${discord.user.name}. Send $name a direct message in Discord to chat; reminders arrive there too.",
                        color = Soft, fontSize = 15.sp)
                    discord.pairing != null -> {
                        Text("1. Add the bot to a server you’re in (your own server is fine).", color = Soft, fontSize = 15.sp)
                        if (bot != null) ActionButton({ uri.openUri(bot.inviteUrl) }) { Text("Add the bot to a server", color = Color(0xFFD9764A)) }
                        Text("2. Send the bot this code in a direct message:", color = Soft, fontSize = 15.sp)
                        Spacer(Modifier.height(8.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(discord.pairing.code, Modifier.clip(RoundedCornerShape(12.dp)).background(Card).border(1.dp, Line, RoundedCornerShape(12.dp))
                                .padding(horizontal = 14.dp, vertical = 8.dp), color = Ink, fontSize = 22.sp, fontWeight = FontWeight.Bold,
                                fontFamily = FontFamily.Monospace, letterSpacing = 2.sp)
                            ActionButton({ clipboard.setText(AnnotatedString(discord.pairing.code)) }) { Text("Copy", color = Color(0xFFD9764A)) }
                        }
                        Spacer(Modifier.height(6.dp))
                        Text("Waiting for your message… The code works for an hour.", color = Soft, fontSize = 14.sp)
                    }
                }
                Spacer(Modifier.height(10.dp))
                ActionButton({ confirmOff = true }, enabled = !state.discordBusy) { Text("Disconnect", color = Ink, fontWeight = FontWeight.Bold) }
            }
        }
        state.discordError?.let { Text(it, color = Danger, fontSize = 15.sp, modifier = Modifier.padding(top = 8.dp)) }
    }
    if (confirmOff) {
        AlertDialog(onDismissRequest = { confirmOff = false },
            title = { Text("Disconnect Discord?") },
            text = { Text("$name will stop answering in Discord. You can link a bot again any time.") },
            confirmButton = { ActionButton({ confirmOff = false; model.unlinkDiscord() }) { Text("Disconnect") } },
            dismissButton = { ActionButton({ confirmOff = false }) { Text("Cancel") } })
    }
}

@Composable
private fun ThemePicker(model: CompanionModel) {
    val theme by model.theme.collectAsStateWithLifecycle()
    Text("App theme", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = Ink)
    Spacer(Modifier.height(10.dp))
    Row(Modifier.clip(RoundedCornerShape(50)).background(Card).border(1.dp, Line, RoundedCornerShape(50)).padding(4.dp)) {
        for (choice in ThemeChoice.entries) {
            val selected = choice == theme
            Text(choice.label, Modifier.clip(RoundedCornerShape(50)).background(if (selected) Color(0xFFEE8F64) else Color.Transparent)
                .clickable(role = Role.RadioButton) { model.setTheme(choice) }.padding(horizontal = 20.dp, vertical = 10.dp)
                .semantics { contentDescription = "${choice.label} theme" + if (selected) ", selected" else "" },
                color = if (selected) Color.White else Ink, fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium, fontSize = 15.sp)
        }
    }
}

// ---- Bits ----

@Composable
private fun Pill(text: String, enabled: Boolean, onClick: () -> Unit) {
    Button(onClick, enabled = enabled, shape = RoundedCornerShape(50),
        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFEE8F64), contentColor = Color.White),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 36.dp, vertical = 14.dp)) {
        Text(text, fontSize = 18.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
internal fun RoundButton(label: String, glyph: String, enabled: Boolean = true, secondary: Boolean = false, onClick: () -> Unit) {
    // secondary: the attach "+" (soft background, ink glyph), like the web composer.
    val fill = when { secondary -> Blush; enabled -> Color(0xFFEE8F64); else -> Line }
    Box(Modifier.size(52.dp).clip(CircleShape).background(fill)
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick).semantics { contentDescription = label },
        contentAlignment = Alignment.Center) {
        Text(glyph, color = if (secondary) Ink.copy(alpha = if (enabled) 1f else 0.4f) else Color.White,
            fontSize = if (secondary) 28.sp else 22.sp, fontWeight = if (secondary) FontWeight.Normal else FontWeight.Bold)
    }
}

private fun chatDate(millis: Long): String =
    java.text.DateFormat.getDateInstance(java.text.DateFormat.MEDIUM).format(java.util.Date(millis))
