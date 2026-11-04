package dev.blackoutburst.companion

import android.app.TimePickerDialog
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private val whenFormat = DateTimeFormatter.ofPattern("EEE d MMM, HH:mm")

/** An ISO time from the server shown in the owner's timezone. */
internal fun scheduleTime(iso: String?, timezone: String?): String = iso?.let {
    runCatching { Instant.parse(it).atZone(timezone?.let(ZoneId::of) ?: ZoneId.systemDefault()).format(whenFormat) }.getOrNull()
} ?: "Not scheduled"

internal fun watchResult(watch: Watch): String? = when (watch.lastResult) {
    "found" -> if (watch.topic) "Something new" else "Found"
    "not_yet" -> if (watch.topic) "Nothing new" else "Not yet"
    "stale" -> "Couldn’t check"
    else -> null
}

internal fun watchState(watch: Watch, timezone: String?): String = when {
    watch.deliveryPending && watch.lastResult == "found" -> "Found · waiting for delivery after quiet hours"
    watch.deliveryPending -> "Check unavailable · notice waiting for delivery after quiet hours"
    watch.state == "active" -> "Active · next check ${scheduleTime(watch.nextCheckAt, timezone)}"
    watch.state == "paused" -> "Paused"
    watch.state == "complete" -> "Complete"
    else -> "Cancelled"
}

@Composable
private fun Sources(urls: List<String>) {
    val link = if (LocalTones.current.dark) Color(0xFFEE8F64) else Color(0xFFB4532A)
    for (url in urls) Text(buildAnnotatedString {
        withLink(LinkAnnotation.Url(url, TextLinkStyles(SpanStyle(color = link, textDecoration = TextDecoration.Underline)))) { append(url) }
    }, fontSize = 13.sp, maxLines = 2)
}

@Composable
private fun WatchCard(content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(vertical = 5.dp).clip(RoundedCornerShape(18.dp))
        .background(MaterialTheme.colorScheme.surface).padding(14.dp)) { content() }
}

/** Me › Watches: release and topic watches, then reminders (docs/SCHEDULER.md). */
@Composable
fun WatchesScreen(model: CompanionModel, state: UiState) {
    LaunchedEffect(state.scope) { model.loadSchedules() }
    val ink = MaterialTheme.colorScheme.onSurface
    val soft = MaterialTheme.colorScheme.onSurfaceVariant
    val danger = MaterialTheme.colorScheme.error
    val schedules = state.schedules
    val timezone = schedules?.timezone
    var editing by remember(state.scope) { mutableStateOf<Watch?>(null) }
    var cancelling by remember(state.scope) { mutableStateOf<Watch?>(null) }
    var expanded by remember(state.scope) { mutableStateOf(setOf<String>()) }
    val locked = state.schedulesBusy || state.watchRetry != null
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        item {
            Text("Watches & reminders", Modifier.padding(top = 20.dp), fontSize = 26.sp, fontWeight = FontWeight.ExtraBold, color = ink)
            Text("Ask ${state.name} in chat to watch for a release, follow a topic or remind you of something.", color = soft, fontSize = 15.sp)
            Row {
                ActionButton(enabled = !state.schedulesBusy && !state.schedulesLoading, onClick = { model.loadSchedules() }) {
                    Text(if (state.schedulesLoading) "Loading…" else "Reload")
                }
            }
            state.schedulesNotice?.let { Text(it, color = soft) }
            state.schedulesError?.let { Text(it, color = danger) }
            state.watchRetry?.let {
                Row {
                    ActionButton(enabled = !state.schedulesBusy, onClick = { model.retryWatchChange() }) { Text("Retry the same change") }
                    ActionButton(enabled = !state.schedulesBusy, onClick = { model.dropWatchChange() }) { Text("Stop and reload") }
                }
            }
        }
        item {
            Spacer(Modifier.height(10.dp))
            Text("Watches", fontSize = 20.sp, fontWeight = FontWeight.Bold, color = ink)
            Text("Release watches check every six hours until the release is out. Topic watches send a short digest with sources whenever there is something new. " +
                "Checks use web tools and may be mistaken or unavailable.", color = soft, fontSize = 13.sp)
            if (schedules != null && schedules.releaseWatches.isEmpty()) Text("No watches yet.", color = soft, modifier = Modifier.padding(vertical = 8.dp))
        }
        items(schedules?.releaseWatches ?: emptyList(), key = { "watch-" + it.id }) { watch ->
            WatchCard {
                Text(if (watch.topic) "TOPIC · EVERY ${watch.intervalHours} H" else "RELEASE", color = soft, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                Text(watch.condition, color = ink, fontSize = 17.sp, fontWeight = FontWeight.Bold)
                Text(watchState(watch, timezone), color = soft, fontSize = 13.sp)
                Text(watch.lastCheckAt?.let { "Last checked ${scheduleTime(it, timezone)}" + (watchResult(watch)?.let { result -> " · $result" } ?: "") } ?: "Not checked yet",
                    color = soft, fontSize = 13.sp)
                if (watch.evidence != null || watch.urls.isNotEmpty()) {
                    Column(Modifier.fillMaxWidth().padding(top = 8.dp).clip(RoundedCornerShape(12.dp))
                        .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)).padding(10.dp)) {
                        watch.evidence?.let { Text(it, color = ink, fontSize = 14.sp) }
                        Sources(watch.urls)
                    }
                }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    val open = watch.id in expanded
                    if (watch.topic || watch.consecutiveStale > 0) ActionButton(onClick = { expanded = if (open) expanded - watch.id else expanded + watch.id }) {
                        Text(if (open) "Hide history" else "History")
                    }
                    if (watch.state == "active" || watch.state == "paused") {
                        ActionButton(enabled = !locked, onClick = { editing = watch }) { Text("Edit") }
                        ActionButton(enabled = !locked, onClick = { model.changeWatch(watch, if (watch.state == "paused") "resume" else "pause") }) {
                            Text(if (watch.state == "paused") "Resume" else "Pause")
                        }
                        ActionButton(enabled = !locked, onClick = { cancelling = watch }) { Text("Cancel", color = danger) }
                    }
                }
                if (watch.id in expanded) {
                    if (watch.consecutiveStale > 0) Text("Consecutive checks unavailable: ${watch.consecutiveStale}", color = soft, fontSize = 13.sp)
                    if (watch.topic) {
                        Text(if (watch.digests.isEmpty()) "No digests yet." else "Recent digests", color = ink, fontWeight = FontWeight.Bold, fontSize = 14.sp,
                            modifier = Modifier.padding(top = 6.dp))
                        for (digest in watch.digests) Column(Modifier.padding(top = 6.dp)) {
                            Text(scheduleTime(digest.at, timezone), color = soft, fontSize = 12.sp)
                            Text(digest.evidence, color = ink, fontSize = 14.sp)
                            Sources(digest.urls)
                        }
                    }
                }
            }
        }
        item {
            Spacer(Modifier.height(16.dp))
            Text("Reminders", fontSize = 20.sp, fontWeight = FontWeight.Bold, color = ink)
            Text("Reminders wait until quiet hours end. Quiet hours and routines are in Me › Settings.", color = soft, fontSize = 13.sp)
        }
        val reminders = schedules?.items?.filter { it.canCancel || it.state in listOf("missed", "interrupted", "error") } ?: emptyList()
        if (schedules != null && reminders.isEmpty()) item { Text("No reminders. Ask ${state.name} to remind you of something.", color = soft, modifier = Modifier.padding(vertical = 8.dp)) }
        items(reminders, key = { "reminder-" + it.id }) { reminder ->
            WatchCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(reminder.text, color = ink, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                        Text(scheduleTime(reminder.dueAt, timezone) + if (reminder.canCancel) "" else " · Not delivered", color = soft, fontSize = 13.sp)
                    }
                    if (reminder.canCancel) ActionButton(enabled = !state.schedulesBusy, onClick = { model.cancelReminder(reminder) }) { Text("Cancel") }
                }
            }
        }
        item { Spacer(Modifier.height(24.dp)) }
    }
    editing?.let { watch -> WatchEditor(watch, onDismiss = { editing = null }) { condition, hours ->
        editing = null; model.changeWatch(watch, "edit", condition, hours)
    } }
    cancelling?.let { watch ->
        AlertDialog(onDismissRequest = { cancelling = null },
            title = { Text("Cancel this watch?") },
            text = { Text("“${watch.condition}” stops for good. A message already delivered cannot be undone.") },
            confirmButton = { ActionButton(onClick = { cancelling = null; model.changeWatch(watch, "cancel") }) { Text("Cancel watch", color = danger) } },
            dismissButton = { ActionButton(onClick = { cancelling = null }) { Text("Keep it") } })
    }
}

/** Edits a watch's condition and, for topic watches, how often it checks. Only what changed is sent. */
@Composable
private fun WatchEditor(watch: Watch, onDismiss: () -> Unit, save: (String?, Int?) -> Unit) {
    var text by remember(watch.id, watch.version) { mutableStateOf(watch.condition) }
    var hours by remember(watch.id, watch.version) { mutableStateOf(watch.intervalHours?.toString() ?: "") }
    val condition = text.trim()
    val hoursValue = hours.trim().toIntOrNull()
    val hoursOk = !watch.topic || (hoursValue != null && hoursValue in 6..168)
    val changedCondition = condition != watch.condition
    val changedHours = watch.topic && hoursValue != watch.intervalHours
    val valid = condition.isNotEmpty() && condition.length <= 1000 && hoursOk && (changedCondition || changedHours)
    AlertDialog(onDismissRequest = onDismiss,
        title = { Text(if (watch.topic) "Edit topic watch" else "Edit release watch") },
        text = {
            Column {
                OutlinedTextField(text, { if (it.length <= 1000) text = it }, Modifier.fillMaxWidth(), label = { Text(if (watch.topic) "Topic" else "Condition") }, minLines = 2)
                if (watch.topic) OutlinedTextField(hours, { if (it.length <= 3) hours = it.filter(Char::isDigit) }, Modifier.fillMaxWidth().padding(top = 8.dp),
                    label = { Text("Check every (hours, 6 to 168)") }, singleLine = true, isError = !hoursOk,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
                if (changedCondition) Text("A new condition starts the watch over: it checks again soon.", fontSize = 13.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
            }
        },
        confirmButton = { ActionButton(enabled = valid, onClick = {
            save(if (!watch.topic || changedCondition) condition else null, if (changedHours) hoursValue else null)
        }) { Text("Save") } },
        dismissButton = { ActionButton(onClick = onDismiss) { Text("Close") } })
}

private val WEEKDAYS = listOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

/** Me › Settings: quiet hours, occasional check-ins, the daily digest and the weekly check-in. Each change saves right away. */
@Composable
fun ScheduleSettingsSection(model: CompanionModel, state: UiState) {
    LaunchedEffect(state.scope) { if (state.schedules == null) model.loadSchedules() }
    val ink = MaterialTheme.colorScheme.onSurface
    val soft = MaterialTheme.colorScheme.onSurfaceVariant
    val settings = state.schedules?.settings
    val busy = state.schedulesBusy
    Text("Quiet hours & routines", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = ink)
    if (settings == null) {
        Text(if (state.schedulesError != null) "Your schedule settings could not be loaded." else "Loading…", color = soft)
        if (state.schedulesError != null) ActionButton(onClick = { model.loadSchedules() }) { Text("Try again") }
        return
    }
    fun save(block: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit) = model.configureSchedules(buildJsonObject(block))
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("Quiet from", color = ink, fontSize = 16.sp, modifier = Modifier.weight(1f))
        TimeButton(settings.quietStart, !busy) { save { put("quietStart", it) } }
        Text("  until  ", color = soft)
        TimeButton(settings.quietEnd, !busy) { save { put("quietEnd", it) } }
    }
    ScheduleSwitch("Occasional check-ins", settings.heartbeatEnabled, !busy) { value -> save { put("heartbeatEnabled", value) } }
    if (settings.boardCapOffered) BoardCapRow(settings.boardCapLimit, busy) { cap ->
        save { if (cap == null) put("boardWakeCap", kotlinx.serialization.json.JsonNull) else put("boardWakeCap", cap) } }
    settings.dailyDigest?.let { daily ->
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) { ScheduleSwitch("Daily digest", daily.enabled, !busy) { value ->
                save { put("dailyDigest", buildJsonObject { put("enabled", value) }) } } }
            TimeButton(daily.localTime, !busy && daily.enabled) { time -> save { put("dailyDigest", buildJsonObject { put("localTime", time) }) } }
        }
    }
    settings.weeklyCheckin?.let { weekly ->
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) { ScheduleSwitch("Weekly check-in", weekly.enabled, !busy) { value ->
                save { put("weeklyCheckin", buildJsonObject { put("enabled", value) }) } } }
            TimeButton(weekly.localTime, !busy && weekly.enabled) { time -> save { put("weeklyCheckin", buildJsonObject { put("localTime", time) }) } }
        }
        if (weekly.enabled) FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            WEEKDAYS.forEachIndexed { index, label ->
                val selected = weekly.weekday == index + 1
                Text(label, Modifier.clip(RoundedCornerShape(50))
                    .background(if (selected) MaterialTheme.colorScheme.primaryContainer else Color.Transparent)
                    .clickable(enabled = !busy && !selected, role = Role.RadioButton) {
                        save { put("weeklyCheckin", buildJsonObject { put("weekday", index + 1) }) }
                    }.padding(horizontal = 10.dp, vertical = 6.dp),
                    color = if (selected) ink else soft, fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal, fontSize = 14.sp)
            }
        }
    }
    Text("Times use your timezone, ${state.schedules?.timezone}. Quiet hours can delay delivery. Check-ins run at most every six hours and stay silent without a useful update.",
        color = soft, fontSize = 13.sp, modifier = Modifier.padding(top = 4.dp))
    state.schedulesError?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }
}

/** #51: how many Board wakes the companion may take in any 24 hours; switching the limit off removes the cap. */
@Composable
private fun BoardCapRow(limit: Int?, busy: Boolean, onSave: (Int?) -> Unit) {
    ScheduleSwitch("Limit Board wakes per day", limit != null, !busy) { on -> onSave(if (on) BOARD_CAP_DEFAULT else null) }
    if (limit != null) {
        var text by remember(limit) { mutableStateOf(limit.toString()) }
        val value = text.toIntOrNull()?.takeIf { it in 1..10000 }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(text, { if (it.length <= 5) text = it.filter(Char::isDigit) }, Modifier.weight(1f),
                label = { Text("Board wakes per day") }, singleLine = true, isError = value == null,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
            ActionButton(onClick = { value?.let(onSave) }, Modifier.padding(start = 8.dp), enabled = !busy && value != null && value != limit) { Text("Save") }
        }
    }
    Text("How often your companion may wake to answer Board mentions in any 24 hours.",
        color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp)
}

@Composable
private fun ScheduleSwitch(label: String, checked: Boolean, enabled: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(enabled = enabled, role = Role.Switch) { onChange(!checked) }.padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f), color = MaterialTheme.colorScheme.onSurface, fontSize = 16.sp)
        Switch(checked = checked, onCheckedChange = onChange, enabled = enabled,
            colors = SwitchDefaults.colors(checkedTrackColor = Color(0xFFEE8F64), checkedThumbColor = Color.White))
    }
}

@Composable
private fun TimeButton(value: String, enabled: Boolean, onPick: (String) -> Unit) {
    val context = LocalContext.current
    ActionButton(enabled = enabled, onClick = {
        val (hour, minute) = value.split(":").map { it.toIntOrNull() ?: 0 }.let { (it.getOrElse(0) { 9 }) to (it.getOrElse(1) { 0 }) }
        TimePickerDialog(context, { _, h, m -> val picked = "%02d:%02d".format(h, m); if (picked != value) onPick(picked) }, hour, minute, true).show()
    }) { Text(value) }
}
