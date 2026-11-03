package dev.blackoutburst.companion

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

private fun personalityDate(value: String, timezone: String?): String = runCatching {
    val zone = runCatching { ZoneId.of(timezone ?: "") }.getOrDefault(ZoneId.systemDefault())
    DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM).format(Instant.parse(value).atZone(zone))
}.getOrDefault(value)
private fun personalitySource(source: String) = when (source) {
    "settled_turn" -> "Observed after a turn"
    "owner_edit" -> "Owner edit"
    "owner_restore" -> "Owner restore"
    else -> "Observed before an owner change"
}

/** Private SOUL controls belong to Look; chat suggestions remain ordinary conversation. */
@Composable
fun PersonalityPanel(model: CompanionModel, state: UiState) {
    var open by remember(state.scope) { mutableStateOf(false) }
    var restoring by remember(state.scope) { mutableStateOf<PersonalityRestore?>(null) }
    val ink = MaterialTheme.colorScheme.onSurface
    val soft = MaterialTheme.colorScheme.onSurfaceVariant
    val danger = MaterialTheme.colorScheme.error
    val locked = state.personalityBusy || state.personalityLoading
    LaunchedEffect(state.scope, open) { if (open) model.loadPersonality() }
    Column(Modifier.fillMaxWidth()) {
        Text("Personality", fontSize = 20.sp, fontWeight = FontWeight.Bold, color = ink)
        Text("${state.name} keeps growing its own SOUL.md and tells you when it changes. Suggestions stay in your chat.", color = soft)
        TextButton(onClick = { open = !open }) { Text(if (open) "Close personality" else "Open personality") }
        if (open) {
            Row {
                TextButton(enabled = !locked, onClick = { model.loadPersonality() }) { Text("Reload") }
                TextButton(enabled = !locked && state.personality != null, onClick = { model.editPersonality(state.scope) }) {
                    Text(if (state.personalityDraft == null) "Edit SOUL.md" else "Draft is open")
                }
            }
            if (state.personalityBusy) Text("Saving personality change…", color = soft)
            else if (state.personalityLoading) Text("Opening SOUL.md…", color = soft)
            state.personalityError?.let { Text(it, color = danger) }
            state.personalityNotice?.let { Text(it, color = soft) }
            if (state.personalityErrorCode == "PERSONALITY_BUSY" && state.replying)
                TextButton(onClick = { model.stop(state.scope) }) { Text("Stop current reply") }
            state.personality?.let { current ->
                Text("SOUL.md · file updated ${personalityDate(current.modifiedAtISO, state.profile?.timezone)}", color = soft, fontSize = 12.sp)
                SelectionContainer { Text(current.content.ifEmpty { "(Empty file)" }, color = ink) }
                Spacer(Modifier.height(16.dp))
                Text("Observed history", fontWeight = FontWeight.Bold, color = ink)
                Text("Up to 20 versions the app saw. Changes between observations may be missing. These dates describe files and observations, not individual traits.", color = soft, fontSize = 13.sp)
                if (current.history.isEmpty()) Text("No observed versions yet.", color = soft)
                for (version in current.history) {
                    TextButton(enabled = !locked && !state.personalityVersionLoading,
                        onClick = { model.selectPersonalityVersion(version.revision, state.scope) }) {
                        Column(Modifier.fillMaxWidth()) {
                            Text("${personalitySource(version.source)} · ${personalityDate(version.observedAtISO, state.profile?.timezone)}")
                            Text("File updated ${personalityDate(version.modifiedAtISO, state.profile?.timezone)} · ${version.revision.take(12)}",
                                fontSize = 12.sp)
                        }
                    }
                }
                if (state.personalityVersionLoading) Text("Opening observed version…", color = soft)
                state.personalityVersion?.let { version ->
                    Spacer(Modifier.height(8.dp))
                    Text("Selected version ${version.revision.take(12)}", fontWeight = FontWeight.Bold, color = ink)
                    Text("${personalitySource(version.source)} · observed ${personalityDate(version.observedAtISO, state.profile?.timezone)}", color = soft, fontSize = 12.sp)
                    Text("File updated ${personalityDate(version.modifiedAtISO, state.profile?.timezone)}", color = soft, fontSize = 12.sp)
                    SelectionContainer { Text(version.content.ifEmpty { "(Empty file)" }, color = ink) }
                    Text("Line comparison: current → selected", Modifier.padding(top = 10.dp), fontWeight = FontWeight.Bold, color = ink)
                    val diff = remember(current.revision, version.revision) { personalityLineDiff(current.content, version.content) }
                    if (diff.removed.isEmpty() && diff.added.isEmpty()) Text("Identical content.", color = soft)
                    else {
                        Text("${diff.unchangedBefore} unchanged lines before; ${diff.unchangedAfter} after.", color = soft, fontSize = 12.sp)
                        SelectionContainer {
                            Column {
                                if (diff.removed.isNotEmpty()) Text(diff.removed.joinToString("\n") { "− $it" }, color = danger, fontFamily = FontFamily.Monospace)
                                if (diff.added.isNotEmpty()) Text(diff.added.joinToString("\n") { "+ $it" }, color = ink, fontFamily = FontFamily.Monospace)
                            }
                        }
                    }
                    TextButton(enabled = !locked && version.revision != current.revision,
                        onClick = { restoring = PersonalityRestore(version.revision, current.revision, state.scope) }) { Text("Restore this version") }
                }
            }
        }
    }
    restoring?.let { confirmation ->
        AlertDialog(onDismissRequest = { if (!state.personalityBusy) restoring = null },
            title = { Text("Restore this personality version?") },
            text = { Text("Replace SOUL.md ${confirmation.expectedRevision.take(12)} with the observed version ${confirmation.targetRevision.take(12)}. Any open draft will be discarded after success. Your name, look, memories and past chats stay.") },
            confirmButton = { TextButton(enabled = !state.personalityBusy, onClick = {
                restoring = null; model.restorePersonality(confirmation)
            }) { Text("Restore this version") } },
            dismissButton = { TextButton(enabled = !state.personalityBusy, onClick = { restoring = null }) { Text("Keep current") } })
    }
    state.personalityDraft?.let { PersonalityEditor(model, state, it) }
}

@Composable
private fun PersonalityEditor(model: CompanionModel, state: UiState, draft: PersonalityDraft) {
    val clipboard = LocalClipboardManager.current
    AlertDialog(onDismissRequest = { model.closePersonalityDraft(state.scope) },
        title = { Text("Edit SOUL.md") },
        text = {
            Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
                Text("Your companion's full personality file. Saving affects its next fresh session, not past chats.")
                OutlinedTextField(draft.content, { model.updatePersonalityDraft(it, state.scope) }, Modifier.fillMaxWidth(),
                    enabled = !state.personalityBusy, minLines = 6, maxLines = 12, label = { Text("SOUL.md") })
                Text("${draft.content.toByteArray(Charsets.UTF_8).size} / $PERSONALITY_BYTES bytes", fontSize = 12.sp)
                if (draft.conflicted) Text("This draft has an older revision. Copy it if needed, discard it, then review the current file before editing again.")
                state.personalityError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                TextButton(onClick = { clipboard.setText(AnnotatedString(draft.content)) }) { Text("Copy draft") }
            }
        },
        confirmButton = { TextButton(enabled = !state.personalityBusy && !state.personalityLoading && !draft.conflicted && validPersonalityContent(draft.content),
            onClick = { model.savePersonalityDraft(state.scope) }) { Text(if (state.personalityBusy) "Saving…" else "Save") } },
        dismissButton = { TextButton(enabled = !state.personalityBusy, onClick = { model.closePersonalityDraft(state.scope) }) { Text("Discard draft") } })
}
