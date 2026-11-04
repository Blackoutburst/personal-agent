package dev.blackoutburst.companion

import android.graphics.BitmapFactory
import android.graphics.drawable.AnimatedImageDrawable
import android.graphics.drawable.Drawable
import android.widget.ImageView
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Base64
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// Group chat (#53): the Group tab's list of groups, and one group conversation with its owners and companions.

@Composable
internal fun GroupsTab(model: CompanionModel) {
    val groups = model.groups
    val state by groups.state.collectAsStateWithLifecycle()
    if (state.openId != null) GroupConversation(groups, state) else GroupList(groups, state)
}

@Composable
private fun GroupList(groups: GroupChat, state: GroupState) {
    val tones = LocalTones.current
    var creating by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { groups.loadList() }
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Groups", Modifier.weight(1f), fontSize = 26.sp, fontWeight = FontWeight.ExtraBold, color = tones.ink)
            ActionButton(enabled = state.canCreate && !state.busy, onClick = { groups.beginCreate(); creating = true }) { Text("New group") }
        }
        Text("Talk with other owners and their companions together. Everyone's companion joins the group.", color = tones.soft, fontSize = 14.sp)
        Spacer(Modifier.size(8.dp))
        state.notice?.let { Text(it, color = tones.soft, fontSize = 14.sp) }
        state.listError?.let { Text(it, color = tones.danger, fontSize = 14.sp) }
        val list = state.groups
        when {
            list == null -> Text(if (state.listLoading) "Loading…" else "", color = tones.soft)
            list.isEmpty() -> Text(if (state.canCreate) "No groups yet. Start one with another owner: you, them and both companions talk in one place."
                else "No groups yet. Group chat needs another owner on this server.", color = tones.soft, modifier = Modifier.padding(top = 12.dp))
            else -> LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(list, key = { it.id }) { group -> GroupRow(groups, group, state.photos) }
            }
        }
    }
    if (creating) CreateGroupDialog(groups, state) { creating = false }
}

@Composable
private fun GroupRow(groups: GroupChat, group: GroupSummary, photos: Map<String, OwnerPhoto>) {
    val tones = LocalTones.current
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(tones.card)
        .clickable { groups.open(group.id) }.padding(12.dp, 10.dp), verticalAlignment = Alignment.CenterVertically) {
        // The other people's companions (or owners) as a small stack of faces.
        val faces = group.members.filter { !it.you && !it.yours }.sortedBy { if (it.kind == "companion") 0 else 1 }.take(2)
        Box(Modifier.size(44.dp)) {
            faces.forEachIndexed { index, member ->
                Box(Modifier.align(if (index == 0) Alignment.TopStart else Alignment.BottomEnd)) {
                    GroupAvatar(member, member.name, photos, if (faces.size == 1) 44.dp else 30.dp)
                }
            }
        }
        Spacer(Modifier.size(10.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(group.name, Modifier.weight(1f), color = tones.ink, fontWeight = if (group.unread > 0) FontWeight.ExtraBold else FontWeight.SemiBold,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(groupWhen(group.updatedAt), color = tones.soft, fontSize = 12.sp)
            }
            groupPreview(group)?.let { Text(it, color = tones.soft, fontSize = 14.sp, maxLines = 2, overflow = TextOverflow.Ellipsis) }
        }
        if (group.unread > 0) { Spacer(Modifier.size(8.dp)); UnreadDot(group.unread) }
    }
}

/** Pick the other owner(s) (their companions come along) and an optional name. */
@Composable
private fun CreateGroupDialog(groups: GroupChat, state: GroupState, close: () -> Unit) {
    val tones = LocalTones.current
    var picked by remember { mutableStateOf(setOf<String>()) }
    var name by remember { mutableStateOf("") }
    val nameOk = name.isBlank() || groupNameOk(name)
    AlertDialog(onDismissRequest = { if (!state.busy) close() },
        title = { Text("New group") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Who joins? Their companion comes along, and so does yours.", color = tones.soft, fontSize = 14.sp)
                LazyColumn(Modifier.heightIn(max = 280.dp)) {
                    items(state.owners.filter { !it.you }, key = { it.id }) { owner ->
                        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp))
                            .clickable { picked = if (owner.label in picked) picked - owner.label else picked + owner.label }.padding(4.dp),
                            verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(owner.label in picked, { on -> picked = if (on) picked + owner.label else picked - owner.label })
                            Column {
                                Text(owner.name.ifBlank { owner.label }, color = tones.ink, fontWeight = FontWeight.SemiBold)
                                owner.companionName?.takeIf { it.isNotBlank() }?.let { Text("with $it", color = tones.soft, fontSize = 13.sp) }
                            }
                        }
                    }
                }
                OutlinedTextField(name, { if (it.length <= GROUP_NAME_CHARS) name = it }, Modifier.fillMaxWidth(), singleLine = true,
                    label = { Text("Name (optional)") }, isError = !nameOk, enabled = !state.busy,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences))
                state.error?.let { Text(it, color = tones.danger, fontSize = 14.sp) }
            }
        },
        confirmButton = {
            ActionButton(enabled = picked.isNotEmpty() && nameOk && !state.busy, onClick = { groups.create(picked.toList(), name.takeIf { it.isNotBlank() }, close) }) {
                Text(if (state.busy) "Creating…" else "Create")
            }
        },
        dismissButton = { ActionButton(enabled = !state.busy, onClick = close) { Text("Cancel") } })
}

// ---- One group conversation ----

@Composable
private fun GroupConversation(groups: GroupChat, state: GroupState) {
    val tones = LocalTones.current
    val groupId = state.openId ?: return
    BackHandler(enabled = !state.sending) { groups.close() }
    var draft by remember(groupId) { mutableStateOf(TextFieldValue("")) }
    var menu by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf(false) }
    var adding by remember { mutableStateOf(false) }
    var leaving by remember { mutableStateOf(false) }
    val members = state.open?.members ?: emptyList()
    val self = state.self
    val list = rememberLazyListState()
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val dismissKeyboard = { focus.clearFocus(); keyboard?.hide() }
    LaunchedEffect(list) { list.interactionSource.interactions.collect { if (it is DragInteraction.Start) dismissKeyboard() } }
    LaunchedEffect(groupId, state.messages.size) { if (state.messages.isNotEmpty()) list.animateScrollToItem(state.messages.size - 1) }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(12.dp, 8.dp), verticalAlignment = Alignment.CenterVertically) {
            ActionButton(enabled = !state.sending, onClick = { groups.close() }) { Text("‹ Groups") }
            Spacer(Modifier.size(10.dp))
            Column(Modifier.weight(1f)) {
                Text(state.open?.name ?: "Group", color = tones.ink, fontSize = 20.sp, fontWeight = FontWeight.ExtraBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (members.isNotEmpty()) Text(members.joinToString(", ") { if (it.id == self) "You" else it.name }, color = tones.soft, fontSize = 13.sp,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Box {
                SmallIcon("⋯", "Group options", enabled = state.open != null && !state.busy) { menu = true }
                DropdownMenu(menu, { menu = false }) {
                    DropdownMenuItem(text = { Text("Rename") }, onClick = { menu = false; renaming = true })
                    if (state.owners.any { owner -> !owner.you && members.none { it.id == owner.id } })
                        DropdownMenuItem(text = { Text("Add people") }, onClick = { menu = false; adding = true })
                    val notify = state.open?.notify ?: "all"
                    DropdownMenuItem(text = { Text((if (notify == "all") "✓ " else "    ") + "Notify: every message") }, onClick = { menu = false; if (notify != "all") groups.setNotify("all") })
                    DropdownMenuItem(text = { Text((if (notify == "mentions") "✓ " else "    ") + "Notify: mentions only") }, onClick = { menu = false; if (notify != "mentions") groups.setNotify("mentions") })
                    DropdownMenuItem(text = { Text("Leave group", color = tones.danger) }, onClick = { menu = false; leaving = true })
                }
            }
        }
        (state.error ?: state.notice)?.let { Text(it, Modifier.fillMaxWidth().padding(horizontal = 16.dp), color = if (state.error != null) tones.danger else tones.soft, fontSize = 14.sp) }
        LazyColumn(Modifier.weight(1f).fillMaxWidth().pointerInput(Unit) { detectTapGestures(onTap = { dismissKeyboard() }) },
            state = list, verticalArrangement = Arrangement.spacedBy(6.dp), contentPadding = PaddingValues(12.dp)) {
            if (state.loading && state.messages.isEmpty()) item { Text("Loading…", Modifier.fillMaxWidth().padding(top = 40.dp), color = tones.soft, textAlign = TextAlign.Center) }
            itemsIndexed(state.messages, key = { _, message -> message.id }) { index, message ->
                val previous = state.messages.getOrNull(index - 1)
                val first = previous == null || previous.authorId != message.authorId || previous.system
                GroupMessageRow(groups, state, message, members, self, first) {
                    groups.reply(message)
                }
            }
        }
        val typing = typingLine(state.typing, members, self)
        val note = when {
            state.offline -> "Connection lost. Trying again…"
            typing != null -> typing
            state.paused -> "The companions are taking a break until someone writes."
            else -> null
        }
        note?.let { Text(it, Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 2.dp), color = tones.soft, fontSize = 13.sp, fontStyle = FontStyle.Italic) }
        state.fileError?.let { Text(it, Modifier.fillMaxWidth().padding(horizontal = 16.dp), color = tones.danger, fontSize = 14.sp) }
        state.replyTo?.let { reply ->
            Row(Modifier.fillMaxWidth().padding(12.dp, 4.dp).clip(RoundedCornerShape(12.dp)).background(tones.card).padding(10.dp, 6.dp),
                verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Replying to ${if (reply.authorId == self) "yourself" else reply.name}", color = tones.soft, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                    Text(replyPreview(reply), color = tones.ink, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                SmallIcon("✕", "Cancel reply", enabled = !state.sending) { groups.reply(null) }
            }
        }
        // @mention autocomplete: the members whose name starts with what follows the @.
        val query = mentionQuery(draft.text, draft.selection.end)
        val candidates = if (query != null) mentionCandidates(query, members, self) else emptyList()
        if (candidates.isNotEmpty()) Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 2.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            candidates.forEach { member ->
                Row(Modifier.clip(RoundedCornerShape(50)).background(tones.card).border(1.dp, tones.line, RoundedCornerShape(50))
                    .clickable { val (text, cursor) = insertMention(draft.text, draft.selection.end, member.name)
                        draft = TextFieldValue(text, TextRange(cursor)); groups.draftChanged(text) }
                    .padding(start = 4.dp, end = 12.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    GroupAvatar(member, member.name, state.photos, 24.dp)
                    Spacer(Modifier.size(6.dp))
                    Text(member.name, color = tones.ink, fontSize = 14.sp)
                }
            }
        }
        if (state.uploads.isNotEmpty()) Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            state.uploads.forEach { upload -> GroupUploadChip(groups, upload, locked = state.sending || state.sendFailed) }
        }
        Row(Modifier.fillMaxWidth().padding(12.dp, 6.dp), verticalAlignment = Alignment.Bottom) {
            val open = !state.loading && !state.sending && !state.sendFailed && state.open != null
            AttachMenu(enabled = open && state.uploads.size < MAX_FILES, onLaunch = {}, onPicked = { groups.attachFiles(it) }, onProblem = groups::attachProblem)
            Spacer(Modifier.size(8.dp))
            OutlinedTextField(draft, { if (it.text.length <= GROUP_TEXT_CHARS) { draft = it; groups.draftChanged(it.text) } }, Modifier.weight(1f),
                placeholder = { Text("Message the group…") }, shape = RoundedCornerShape(24.dp), maxLines = 5, enabled = open,
                textStyle = TextStyle(fontSize = 17.sp, color = tones.ink),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Default),
                colors = OutlinedTextFieldDefaults.colors(focusedContainerColor = tones.card, unfocusedContainerColor = tones.card,
                    focusedBorderColor = tones.line, unfocusedBorderColor = tones.line))
            Spacer(Modifier.size(8.dp))
            val ready = state.uploads.all { it.state == "ready" }
            RoundButton(if (state.sendFailed) "Retry send" else "Send", if (state.sendFailed) "↻" else "↑",
                enabled = (draft.text.isNotBlank() || state.uploads.isNotEmpty() || state.sendFailed) && ready && !state.sending && !state.loading && state.open != null) {
                val submitted = draft.text
                groups.send(submitted) { if (draft.text == submitted) draft = TextFieldValue("") }
            }
        }
    }
    if (renaming) {
        var name by remember { mutableStateOf(state.open?.name ?: "") }
        AlertDialog(onDismissRequest = { if (!state.busy) renaming = false }, title = { Text("Rename group") },
            text = {
                Column {
                    OutlinedTextField(name, { if (it.length <= GROUP_NAME_CHARS) name = it }, Modifier.fillMaxWidth(), singleLine = true,
                        isError = name.isNotBlank() && !groupNameOk(name), enabled = !state.busy)
                    state.error?.let { Text(it, color = tones.danger, fontSize = 14.sp) }
                }
            },
            confirmButton = { ActionButton(enabled = groupNameOk(name) && !state.busy, onClick = { groups.rename(name) { renaming = false } }) { Text("Save") } },
            dismissButton = { ActionButton(enabled = !state.busy, onClick = { renaming = false }) { Text("Cancel") } })
    }
    if (adding) {
        var picked by remember { mutableStateOf(setOf<String>()) }
        AlertDialog(onDismissRequest = { if (!state.busy) adding = false }, title = { Text("Add people") },
            text = {
                Column {
                    state.owners.filter { owner -> !owner.you && members.none { it.id == owner.id } }.forEach { owner ->
                        Row(Modifier.fillMaxWidth().clickable { picked = if (owner.label in picked) picked - owner.label else picked + owner.label },
                            verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(owner.label in picked, { on -> picked = if (on) picked + owner.label else picked - owner.label })
                            Text(owner.name.ifBlank { owner.label } + (owner.companionName?.let { " with $it" } ?: ""), color = tones.ink)
                        }
                    }
                    state.error?.let { Text(it, color = tones.danger, fontSize = 14.sp) }
                }
            },
            confirmButton = { ActionButton(enabled = picked.isNotEmpty() && !state.busy, onClick = { groups.addMembers(picked.toList()) { adding = false } }) { Text("Add") } },
            dismissButton = { ActionButton(enabled = !state.busy, onClick = { adding = false }) { Text("Cancel") } })
    }
    if (leaving) AlertDialog(onDismissRequest = { if (!state.busy) leaving = false }, title = { Text("Leave this group?") },
        text = { Text("You and your companion leave \"${state.open?.name ?: "this group"}\". Someone in it can add you back.") },
        confirmButton = { ActionButton(enabled = !state.busy, onClick = { groups.leave { leaving = false } }) { Text("Leave", color = tones.danger) } },
        dismissButton = { ActionButton(enabled = !state.busy, onClick = { leaving = false }) { Text("Cancel") } })
}

@Composable
private fun GroupMessageRow(groups: GroupChat, state: GroupState, message: GroupMessage, members: List<GroupMember>, self: String?,
    first: Boolean, onReply: () -> Unit) {
    val tones = LocalTones.current
    if (message.system) {
        Text(message.text, Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 4.dp), color = tones.soft, fontSize = 13.sp, textAlign = TextAlign.Center)
        return
    }
    val mine = message.authorId != null && message.authorId == self
    val author = members.firstOrNull { it.id == message.authorId }
    val mentioned = self != null && self in message.mentions
    var menu by remember { mutableStateOf(false) }
    val clipboard = LocalClipboardManager.current
    Row(Modifier.fillMaxWidth().padding(top = if (first) 6.dp else 0.dp), horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.Top) {
        if (!mine) {
            if (first) GroupAvatar(author, message.name, state.photos, 34.dp, fallbackKind = message.author.kind) else Spacer(Modifier.width(34.dp))
            Spacer(Modifier.size(8.dp))
        }
        Column(horizontalAlignment = if (mine) Alignment.End else Alignment.Start) {
            if (first && !mine) Text(message.name + if (message.author.kind == "companion") " · companion" else "", color = tones.soft, fontSize = 12.sp,
                fontWeight = FontWeight.Bold, modifier = Modifier.padding(start = 4.dp, bottom = 2.dp))
            val shape = RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp, bottomStart = if (mine) 18.dp else 6.dp, bottomEnd = if (mine) 6.dp else 18.dp)
            Box {
                Column(Modifier.widthIn(max = 300.dp).clip(shape).background(if (mine) tones.mine else tones.bubble)
                    .border(if (mentioned) 2.dp else 1.dp, if (mentioned) Color(0xFFEE8F64) else if (mine) Color.Transparent else tones.bubbleLine, shape)
                    .combinedClickable(onClick = {}, onLongClick = { menu = true }, onLongClickLabel = "Message options")
                    .padding(horizontal = 14.dp, vertical = 9.dp)) {
                    message.replyTo?.let { reply ->
                        Column(Modifier.padding(bottom = 6.dp).clip(RoundedCornerShape(8.dp)).background(tones.ink.copy(alpha = 0.06f)).padding(8.dp, 4.dp)) {
                            Text(if (reply.authorId != null && reply.authorId == self) "You" else reply.name, color = tones.soft, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                            Text(reply.preview, color = tones.ink.copy(alpha = 0.8f), fontSize = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                    }
                    if (message.text.isNotEmpty()) MarkdownText(message.text, color = tones.ink,
                        link = if (tones.dark) Color(0xFFEE8F64) else Color(0xFFB4532A),
                        codeBackground = if (tones.dark) Color.Black.copy(alpha = 0.28f) else tones.ink.copy(alpha = 0.08f),
                        fontSize = 16.sp, lineHeight = 22.sp)
                    message.attachments.forEachIndexed { index, file ->
                        if (message.text.isNotEmpty() || index > 0) Spacer(Modifier.size(6.dp))
                        GroupFileView(groups, file)
                    }
                }
                DropdownMenu(menu, { menu = false }) {
                    DropdownMenuItem(text = { Text("Reply") }, onClick = { menu = false; onReply() })
                    if (message.text.isNotEmpty()) DropdownMenuItem(text = { Text("Copy text") }, onClick = { menu = false; clipboard.setText(AnnotatedString(message.text)) })
                }
            }
            Text(groupTime(message.createdAt), color = tones.soft, fontSize = 11.sp, modifier = Modifier.padding(horizontal = 6.dp))
        }
    }
}

/** An owner: their picture, or their initial. A companion: their character portrait. */
@Composable
internal fun GroupAvatar(member: GroupMember?, name: String, photos: Map<String, OwnerPhoto>, size: Dp, fallbackKind: String = "owner") {
    val tones = LocalTones.current
    val look = member?.look
    val modifier = Modifier.size(size).clip(CircleShape)
    if (look != null) {
        Box(modifier.background(tones.card).border(1.dp, tones.line, CircleShape), contentAlignment = Alignment.Center) {
            // Illustrated portraits are full figures: zoomed to the face so a small avatar still reads.
            val zoom = if (hasOutfits(look.character)) Modifier.graphicsLayer {
                scaleX = 1.7f; scaleY = 1.7f; transformOrigin = androidx.compose.ui.graphics.TransformOrigin(0.5f, 0.42f)
            } else Modifier
            CompanionCharacter(look.character, look.color, Mood.Idle, Modifier.fillMaxSize().then(zoom), label = name, still = true, outfit = look.outfit)
        }
        return
    }
    val photo = member?.photoVersion?.let { photos[member.id + "|" + it] }
    val bitmap = remember(photo) { photo?.let { runCatching { decodePhoto(it) }.getOrNull() } }
    if (bitmap != null) { Image(bitmap, name, modifier, contentScale = ContentScale.Crop); return }
    val kind = member?.kind ?: fallbackKind
    val hue = ((member?.id ?: name).hashCode() and 0x7fffffff) % 6
    val fill = listOf(0xFFEE8F64, 0xFF7FB3D5, 0xFF9CCC65, 0xFFBA68C8, 0xFFFFB74D, 0xFF4DB6AC)[hue]
    Box(modifier.background(Color(fill)).semantics { contentDescription = name }, contentAlignment = Alignment.Center) {
        Text(if (kind == "companion") "✦" else name.trim().firstOrNull()?.uppercase() ?: "?", color = Color.White,
            fontSize = (size.value * 0.45f).sp, fontWeight = FontWeight.Bold)
    }
}

private fun decodePhoto(photo: OwnerPhoto): ImageBitmap? {
    val bytes = Base64.getDecoder().decode(photo.base64)
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
}

/** Images inline (tap: full size, long-press: save); any other file as a named chip that saves it. */
@Composable
private fun GroupFileView(groups: GroupChat, file: GroupFile) {
    val tones = LocalTones.current
    val coroutine = rememberCoroutineScope()
    var status by remember(file.id) { mutableStateOf<String?>(null) }
    val saver = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(file.mime)) { uri ->
        if (uri != null) coroutine.launch {
            status = "Saving…"
            status = try { groups.saveFile(file, uri, TransferCancellation()); "Saved ${file.name}." }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { fileProblem((failure as? ApiException)?.code ?: "FILE_UNAVAILABLE") }
        }
    }
    val save = { saver.launch(file.name) }
    if (file.image) {
        var attempt by remember(file.id) { mutableIntStateOf(0) }
        var drawable by remember(file.id) { mutableStateOf<Drawable?>(null) }
        var local by remember(file.id) { mutableStateOf<java.io.File?>(null) }
        var error by remember(file.id) { mutableStateOf<String?>(null) }
        var full by remember(file.id) { mutableStateOf(false) }
        val cancellation = remember(file.id, attempt) { TransferCancellation() }
        DisposableEffect(cancellation) { onDispose { cancellation.cancel() } }
        LaunchedEffect(file.id, attempt) {
            error = null
            try {
                val downloaded = groups.mediaFile(file, cancellation)
                drawable = withContext(Dispatchers.IO) { decodeImage(downloaded, 1024) }
                local = downloaded
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { error = fileProblem((failure as? ApiException)?.code ?: "PREVIEW_UNAVAILABLE") }
        }
        DisposableEffect(drawable) { onDispose { (drawable as? AnimatedImageDrawable)?.stop() } }
        val shape = RoundedCornerShape(12.dp)
        val shown = drawable
        when {
            shown != null -> {
                val ratio = (shown.intrinsicWidth.toFloat() / shown.intrinsicHeight.coerceAtLeast(1)).takeIf { it.isFinite() && it > 0f } ?: 1.33f
                AndroidView(factory = { context -> ImageView(context).apply {
                        scaleType = ImageView.ScaleType.CENTER_CROP; contentDescription = "${file.name}. Tap to open, long-press to save"
                        setOnClickListener { full = true }
                        setOnLongClickListener { save(); true }
                    } },
                    modifier = Modifier.width(260.dp).aspectRatio(ratio.coerceIn(0.6f, 1.8f)).clip(shape),
                    update = { view -> if (view.drawable !== shown) view.setImageDrawable(shown); (shown as? AnimatedImageDrawable)?.start() })
            }
            error != null -> Row(verticalAlignment = Alignment.CenterVertically) {
                Text(error!!, Modifier.weight(1f, fill = false), color = tones.danger, fontSize = 13.sp)
                SmallIcon("↻", "Retry preview of ${file.name}") { attempt++ }
            }
            else -> Box(Modifier.width(260.dp).aspectRatio(1.33f).clip(shape).background(tones.ink.copy(alpha = 0.06f)), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(Modifier.size(26.dp), color = tones.soft, strokeWidth = 3.dp)
            }
        }
        if (full && local != null) GroupFullImage(local!!, file.name, save) { full = false }
    } else {
        Row(Modifier.clip(RoundedCornerShape(50)).background(tones.ink.copy(alpha = 0.06f)).clickable(role = Role.Button) { save() }
            .semantics { contentDescription = "${file.name}, ${fileSize(file.size)}. Tap to save" }.padding(12.dp, 6.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Text("📎", fontSize = 15.sp)
            Spacer(Modifier.size(6.dp))
            Text(file.name, Modifier.widthIn(max = 200.dp), color = tones.ink, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.size(6.dp))
            Text(fileSize(file.size), color = tones.soft, fontSize = 12.sp)
        }
    }
    status?.let { Text(it, color = tones.soft, fontSize = 12.sp) }
}

@Composable
private fun GroupFullImage(local: java.io.File, name: String, save: () -> Unit, close: () -> Unit) {
    var drawable by remember(local) { mutableStateOf<Drawable?>(null) }
    LaunchedEffect(local) { drawable = runCatching { withContext(Dispatchers.IO) { decodeImage(local, 4096) } }.getOrNull() }
    Dialog(onDismissRequest = close, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(Modifier.fillMaxSize().background(Color.Black).padding(12.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                ActionButton(onClick = save) { Text("Save") }
                Spacer(Modifier.size(8.dp))
                ActionButton(onClick = close) { Text("Close") }
            }
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                val shown = drawable
                if (shown != null) AndroidView(factory = { context -> ImageView(context).apply { scaleType = ImageView.ScaleType.FIT_CENTER; contentDescription = name } },
                    modifier = Modifier.fillMaxSize(), update = { view -> if (view.drawable !== shown) view.setImageDrawable(shown); (shown as? AnimatedImageDrawable)?.start() })
                else CircularProgressIndicator(color = Color.White)
            }
        }
    }
}

@Composable
private fun GroupUploadChip(groups: GroupChat, upload: GroupUpload, locked: Boolean) {
    val tones = LocalTones.current
    Row(Modifier.widthIn(max = 260.dp).clip(RoundedCornerShape(14.dp)).background(tones.card).border(1.dp, tones.line, RoundedCornerShape(14.dp))
        .padding(start = 12.dp, end = 4.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f, fill = false)) {
            Text(upload.name, color = tones.ink, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(when (upload.state) {
                "ready" -> fileSize(upload.total)
                "uploading" -> "Uploading ${fileSize(upload.progress)} / ${fileSize(upload.total)}"
                "error" -> upload.error ?: "Upload failed"
                else -> "Preparing…"
            }, color = if (upload.state == "error") tones.danger else tones.soft, fontSize = 12.sp, maxLines = 2)
        }
        if (upload.state == "error") SmallIcon("↻", "Retry upload of ${upload.name}", enabled = !locked) { groups.retryUpload(upload.key) }
        SmallIcon("✕", "Remove ${upload.name}", enabled = !locked) { groups.removeUpload(upload.key) }
    }
}

private fun groupWhen(millis: Long): String {
    if (millis <= 0) return ""
    val zone = ZoneId.systemDefault()
    val time = Instant.ofEpochMilli(millis).atZone(zone)
    return if (time.toLocalDate() == LocalDate.now(zone)) DateTimeFormatter.ofPattern("HH:mm").format(time)
    else DateTimeFormatter.ofPattern("d MMM").format(time)
}

private fun groupTime(millis: Long): String = if (millis <= 0) "" else groupWhen(millis).let { day ->
    val time = Instant.ofEpochMilli(millis).atZone(ZoneId.systemDefault())
    if (time.toLocalDate() == LocalDate.now(ZoneId.systemDefault())) day else day + " " + DateTimeFormatter.ofPattern("HH:mm").format(time)
}
