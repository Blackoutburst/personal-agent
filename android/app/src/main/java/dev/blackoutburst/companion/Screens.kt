package dev.blackoutburst.companion

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.material3.AlertDialog
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
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.LaunchedEffect
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

private val LocalTones = staticCompositionLocalOf { LightTones }
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

private enum class Tab(val label: String) { Chat("Chat"), Memories("Memories"), Look("Look") }

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
    Column(Modifier.fillMaxSize()) {
        Box(Modifier.weight(1f)) {
            when (tab) {
                Tab.Chat -> ChatScreen(model, state)
                Tab.Memories -> MemoriesScreen(model, state, memoryExport)
                Tab.Look -> LookScreen(model, state, first = false) { tab = Tab.Chat }
            }
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
            for (item in Tab.entries) {
                val selected = item == tab
                Text(item.label, Modifier.clip(RoundedCornerShape(50)).background(if (selected) Card else Color.Transparent)
                    .clickable(role = Role.Tab) { tab = item }.padding(horizontal = 22.dp, vertical = 10.dp),
                    color = if (selected) Ink else Soft, fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium, fontSize = 16.sp)
            }
        }
    }
}

// ---- Chat ----

@Composable
private fun ChatScreen(model: CompanionModel, state: UiState) {
    var draft by rememberSaveable(state.scope) { mutableStateOf("") }
    var confirmDelete by remember(state.scope) { mutableStateOf(false) }
    var pickerScope by remember { mutableLongStateOf(state.scope) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris -> model.attachFiles(uris, pickerScope) }
    var tick by remember { mutableLongStateOf(0L) }
    LaunchedEffect(Unit) { while (true) { delay(1000); tick = System.currentTimeMillis() } }
    val mood = remember(state, draft.isNotBlank(), tick) { model.mood(draft.isNotBlank()) }
    val list = rememberLazyListState()
    val shown = state.messages.filter { it.text.isNotEmpty() || it.attachments.isNotEmpty() }
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
            TextButton(enabled = state.threadId != null && !state.deleting && !state.chatLoading, onClick = { confirmDelete = true }) { Text("Delete") }
        }
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = list, verticalArrangement = Arrangement.spacedBy(8.dp),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp)) {
            if (shown.isEmpty()) item {
                Text("Say hello to ${state.name}!", Modifier.fillMaxWidth().padding(top = 40.dp), color = Soft, textAlign = TextAlign.Center, fontSize = 17.sp)
            }
            items(shown, key = { it.id }) { Bubble(model, it, state.scope) }
        }
        note(state)?.let {
            Text(it, Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp), color = Soft, fontSize = 14.sp, textAlign = TextAlign.Center)
        }
        state.fileError?.let { Text(it, Modifier.fillMaxWidth().padding(horizontal = 16.dp), color = Danger, fontSize = 14.sp) }
        if (state.uploads.isNotEmpty()) Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
            state.uploads.forEach { upload ->
                Column(Modifier.width(260.dp).heightIn(max = 220.dp).verticalScroll(rememberScrollState())) {
                    UploadCard(model, upload, state.scope, state.sending || state.sendFailed)
                }
            }
        }
        if (state.deleteFailed) TextButton(onClick = { model.deleteThread(state.scope) }) { Text("Retry deletion") }
        if (state.deleting) Text("Deleting conversation and files…", Modifier.padding(horizontal = 16.dp), color = Soft)
        Row(Modifier.fillMaxWidth().padding(12.dp, 6.dp), verticalAlignment = Alignment.Bottom) {
            TextButton(enabled = !state.chatLoading && !state.sending && !state.sendFailed && !state.replying && !state.deleting && !state.deleteFailed && state.uploads.size < MAX_FILES,
                onClick = { pickerScope = state.scope; picker.launch(arrayOf("*/*")) }) { Text("Attach") }
            OutlinedTextField(draft, { if (it.length <= 8000) draft = it }, Modifier.weight(1f),
                placeholder = { Text("Write a message…") }, shape = RoundedCornerShape(24.dp), maxLines = 5,
                enabled = !state.chatLoading && !state.sending && !state.sendFailed && !state.deleting && !state.deleteFailed,
                textStyle = TextStyle(fontSize = 17.sp, color = Ink),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Default),
                colors = OutlinedTextFieldDefaults.colors(focusedContainerColor = Card, unfocusedContainerColor = Card,
                    focusedBorderColor = Line, unfocusedBorderColor = Line))
            Spacer(Modifier.size(8.dp))
            if (state.replying) RoundButton("Stop", "■") { model.stop(state.scope) }
            else RoundButton(if (state.sendFailed) "Retry send" else "Send", if (state.sendFailed) "↻" else "↑",
                enabled = (draft.isNotBlank() || state.uploads.isNotEmpty() || state.sendFailed) && !state.chatLoading && !state.sending && !state.deleting && !state.deleteFailed && state.uploads.all { it.state == "ready" }) {
                val submitted = draft
                model.send(submitted, state.scope) { if (draft == submitted) draft = "" }
            }
        }
    }
    if (confirmDelete) AlertDialog(onDismissRequest = { confirmDelete = false },
        title = { Text("Delete conversation?") },
        text = { Text("This removes this conversation and its stored files. Your companion's memories and any history retained by the AI provider are not erased.") },
        confirmButton = { TextButton(onClick = { confirmDelete = false; model.deleteThread(state.scope) }) { Text("Delete conversation", color = Danger) } },
        dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Keep conversation") } })
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

@Composable
private fun Bubble(model: CompanionModel, message: Message, scope: Long) {
    if (message.role == "peer") { PeerCard(message); return }
    val mine = message.role == "user"
    val bubbleShape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp, bottomStart = if (mine) 20.dp else 6.dp, bottomEnd = if (mine) 6.dp else 20.dp)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start) {
        Column(
            Modifier.widthIn(max = 320.dp)
                .clip(bubbleShape)
                .background(if (mine) Mine else LocalTones.current.bubble)
                .border(1.dp, if (mine) Color.Transparent else LocalTones.current.bubbleLine, bubbleShape)
                .padding(horizontal = 16.dp, vertical = 10.dp)) {
            if (message.text.isNotEmpty()) Text(message.text, color = Ink, fontSize = 17.sp, lineHeight = 23.sp)
            message.attachments.forEach { file -> AttachmentView(model, file, scope) }
        }
    }
}

// ---- Memories ----

@Composable
private fun MemoriesScreen(model: CompanionModel, state: UiState, memoryExport: MemoryExportControl) = MemoryPanel(model, state, memoryExport)

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
            PersonalityPanel(model, state)
            Spacer(Modifier.height(32.dp))
            ContactPanel(model, state)
            Spacer(Modifier.height(32.dp))
            ThemePicker(model)
            Spacer(Modifier.height(32.dp))
            DiscordSection(model, state, profile?.name ?: shownName)
        }
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
                TextButton({ uri.openUri("https://discord.com/developers/applications") }) { Text("Open the Developer Portal", color = Color(0xFFD9764A)) }
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
                        if (bot != null) TextButton({ uri.openUri(bot.inviteUrl) }) { Text("Add the bot to a server", color = Color(0xFFD9764A)) }
                        Text("2. Send the bot this code in a direct message:", color = Soft, fontSize = 15.sp)
                        Spacer(Modifier.height(8.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(discord.pairing.code, Modifier.clip(RoundedCornerShape(12.dp)).background(Card).border(1.dp, Line, RoundedCornerShape(12.dp))
                                .padding(horizontal = 14.dp, vertical = 8.dp), color = Ink, fontSize = 22.sp, fontWeight = FontWeight.Bold,
                                fontFamily = FontFamily.Monospace, letterSpacing = 2.sp)
                            TextButton({ clipboard.setText(AnnotatedString(discord.pairing.code)) }) { Text("Copy", color = Color(0xFFD9764A)) }
                        }
                        Spacer(Modifier.height(6.dp))
                        Text("Waiting for your message… The code works for an hour.", color = Soft, fontSize = 14.sp)
                    }
                }
                Spacer(Modifier.height(10.dp))
                TextButton({ confirmOff = true }, enabled = !state.discordBusy) { Text("Disconnect", color = Ink, fontWeight = FontWeight.Bold) }
            }
        }
        state.discordError?.let { Text(it, color = Danger, fontSize = 15.sp, modifier = Modifier.padding(top = 8.dp)) }
    }
    if (confirmOff) {
        AlertDialog(onDismissRequest = { confirmOff = false },
            title = { Text("Disconnect Discord?") },
            text = { Text("$name will stop answering in Discord. You can link a bot again any time.") },
            confirmButton = { TextButton({ confirmOff = false; model.unlinkDiscord() }) { Text("Disconnect") } },
            dismissButton = { TextButton({ confirmOff = false }) { Text("Cancel") } })
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
private fun RoundButton(label: String, glyph: String, enabled: Boolean = true, onClick: () -> Unit) {
    Box(Modifier.size(52.dp).clip(CircleShape).background(if (enabled) Color(0xFFEE8F64) else Line)
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick).semantics { contentDescription = label },
        contentAlignment = Alignment.Center) {
        Text(glyph, color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Bold)
    }
}
