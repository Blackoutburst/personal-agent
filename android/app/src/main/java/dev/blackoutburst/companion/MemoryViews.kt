package dev.blackoutburst.companion

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

data class MemoryExportControl(val busy: Boolean, val message: String?, val launch: () -> Unit, val cancel: () -> Unit)

/** Kept at app scope so an old picker result is cleaned even after navigating away or signing out. */
@Composable
fun rememberMemoryExport(model: CompanionModel, scope: Long): MemoryExportControl {
    val coroutine = rememberCoroutineScope()
    val currentScope by rememberUpdatedState(scope)
    var pickerScope by remember { mutableLongStateOf(scope) }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var cancellation by remember { mutableStateOf<TransferCancellation?>(null) }
    DisposableEffect(scope) { onDispose { cancellation?.cancel() } }
    LaunchedEffect(scope) { cancellation?.cancel(); message = null; busy = false }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        val selectedScope = pickerScope
        if (uri == null) { if (selectedScope == currentScope) busy = false }
        else {
            val transfer = TransferCancellation(); cancellation = transfer
            if (selectedScope == currentScope) { busy = true; message = "Exporting saved notes…" }
            coroutine.launch {
                try {
                    model.exportMemory(uri, selectedScope, transfer)
                    if (selectedScope == currentScope) message = "Saved memory export."
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (error: Exception) {
                    if (selectedScope == currentScope) message = memoryProblem(error as? ApiException ?: ApiException("FILE_UNAVAILABLE"))
                } finally {
                    if (selectedScope == currentScope) busy = false
                    if (cancellation === transfer) cancellation = null
                }
            }
        }
    }
    return MemoryExportControl(busy, message,
        launch = { if (!busy) { pickerScope = scope; busy = true; message = null; launcher.launch("companion-memory.json") } },
        cancel = { cancellation?.cancel() })
}

private data class ForgetNote(val file: MemoryFile, val item: MemoryItem, val scope: Long)
private fun modifiedLabel(file: MemoryFile, timezone: String?): String = runCatching {
    val zone = runCatching { ZoneId.of(timezone ?: "") }.getOrDefault(ZoneId.systemDefault())
    val date = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM).format(Instant.parse(file.modifiedAtISO).atZone(zone))
    "${file.file} · file updated $date"
}.getOrDefault(file.file)

@Composable
fun MemoryPanel(model: CompanionModel, state: UiState, exporter: MemoryExportControl) {
    LaunchedEffect(state.scope) { model.loadMemories() }
    var forgetting by remember(state.scope) { mutableStateOf<ForgetNote?>(null) }
    var forgetAll by remember(state.scope) { mutableStateOf<String?>(null) }
    val locked = state.memoryBusy || state.memoryLoading
    val ink = MaterialTheme.colorScheme.onSurface
    val soft = MaterialTheme.colorScheme.onSurfaceVariant
    val danger = MaterialTheme.colorScheme.error
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        item {
            Text("What ${state.name} remembers", Modifier.padding(top = 20.dp), fontSize = 26.sp, fontWeight = FontWeight.ExtraBold, color = ink)
            Text("${state.name} keeps notes as you talk. You can correct or remove a note here.", color = soft, fontSize = 15.sp)
            Row {
                TextButton(enabled = !locked, onClick = { model.loadMemories() }) { Text("Reload notes") }
                TextButton(enabled = !locked && !exporter.busy, onClick = exporter.launch) { Text("Export saved notes") }
            }
            if (exporter.busy) TextButton(onClick = exporter.cancel) { Text("Cancel export") }
            exporter.message?.let { Text(it, color = soft) }
            state.memoryNotice?.let { Text(it, color = soft) }
            state.memoryError?.let { Text(it, color = danger) }
            if (state.memoryErrorCode == "MEMORY_BUSY" && state.replying) TextButton(onClick = { model.stop(state.scope) }) { Text("Stop current reply") }
            if (state.memoryBusy) Text("Saving memory change…", color = soft)
            else if (state.memoryLoading) Text("Opening the notebook…", color = soft)
            else if (state.memories == null && state.memoriesFailed) Text("Couldn't open the notes. Reload to try again.", color = soft)
            else if (state.memories?.all { it.content.isBlank() } == true) Text("No notes yet.", color = soft)
            Spacer(Modifier.height(8.dp))
        }
        for (file in state.memories.orEmpty()) {
            item(key = "header:${file.file}") {
                Text(memoryFileTitle(file.file), Modifier.padding(top = 12.dp), color = ink, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                Text(modifiedLabel(file, state.profile?.timezone), color = soft, fontSize = 12.sp)
                if (file.readOnly) Text("Read-only diary", color = soft, fontSize = 12.sp)
            }
            val lines = file.content.split('\n')
            val controls = file.sections.flatMap { it.items }.associateBy { it.line }
            itemsIndexed(lines, key = { line, _ -> "${file.file}:${file.revision}:$line" }) { line, content ->
                val note = controls[line]
                Column(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                    if (content.isEmpty()) Spacer(Modifier.height(8.dp))
                    else Text(content.removeSuffix("\r"), color = ink, fontSize = 16.sp,
                        fontWeight = if (content.startsWith('#')) FontWeight.Bold else FontWeight.Normal)
                    if (!file.readOnly && note != null) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                        TextButton(enabled = !locked, onClick = { model.editMemory(file, note, state.scope) }) { Text("Edit / correct") }
                        TextButton(enabled = !locked, onClick = { forgetting = ForgetNote(file, note, state.scope) }) { Text("Forget note", color = danger) }
                    }
                }
            }
        }
        item {
            Spacer(Modifier.height(20.dp))
            TextButton(enabled = !locked && state.memoryRevision != null, onClick = { forgetAll = state.memoryRevision }) {
                Text("Forget everything the companion remembers", color = danger)
            }
            TextButton(onClick = { model.signOut() }) { Text("Sign out${state.username?.let { " ($it)" } ?: ""}", color = soft) }
            Spacer(Modifier.height(20.dp))
        }
    }
    forgetting?.let { target -> AlertDialog(onDismissRequest = { forgetting = null },
        title = { Text("Forget this note?") }, text = { Text("${target.item.text}\n\nThis removes the note from this memory file. Past chats and the diary stay.") },
        confirmButton = { TextButton(enabled = !locked, onClick = {
            forgetting = null; model.forget(target.file, target.item, target.scope)
        }) { Text("Forget note", color = danger) } },
        dismissButton = { TextButton(onClick = { forgetting = null }) { Text("Keep note") } }) }
    forgetAll?.let { revision -> AlertDialog(onDismissRequest = { forgetAll = null },
        title = { Text("Forget everything the companion remembers?") },
        text = { Text("This clears About you, Our memories and the diary. The companion's personality and past conversations stay. Deleting a conversation is a separate action.") },
        confirmButton = { TextButton(enabled = !locked, onClick = { forgetAll = null; model.forgetAllMemory(revision, state.scope) }) {
            Text("Forget everything", color = danger)
        } }, dismissButton = { TextButton(onClick = { forgetAll = null }) { Text("Keep memories") } }) }
    state.memoryDraft?.let { draft -> MemoryEditor(model, state, draft) }
}

@Composable
private fun MemoryEditor(model: CompanionModel, state: UiState, draft: MemoryDraft) {
    val clipboard = LocalClipboardManager.current
    val valid = validCorrection(draft.text)
    AlertDialog(onDismissRequest = { model.closeMemoryDraft(state.scope) },
        title = { Text("Correct this note") },
        text = { Column {
            Text(memoryFileTitle(draft.file), color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedTextField(value = draft.text, onValueChange = { model.updateMemoryDraft(it, state.scope) },
                singleLine = true, enabled = !state.memoryBusy, modifier = Modifier.fillMaxWidth(), label = { Text("Note") })
            Text("${draft.text.length} / 4000 characters", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp)
            if (!valid) Text("Use one nonempty line, up to 4000 characters, without tabs or line breaks.", color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
            state.memoryError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            if (draft.conflicted) Text("Your draft is kept here. Copy it before closing, then review the latest notes and edit again.")
            TextButton(onClick = { clipboard.setText(AnnotatedString(draft.text)) }) { Text("Copy draft") }
            if (state.memoryErrorCode == "MEMORY_BUSY" && state.replying) TextButton(onClick = { model.stop(state.scope) }) { Text("Stop current reply") }
        } },
        confirmButton = { TextButton(enabled = valid && !draft.conflicted && !state.memoryBusy,
            onClick = { model.saveMemoryDraft(state.scope) }) { Text(if (state.memoryBusy) "Saving…" else "Save correction") } },
        dismissButton = { TextButton(enabled = !state.memoryBusy, onClick = { model.closeMemoryDraft(state.scope) }) { Text("Discard draft") } })
}
