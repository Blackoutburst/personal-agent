package dev.blackoutburst.companion

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

/** Reminder choices in minutes before the event; null is no reminder. */
internal val REMINDER_CHOICES: List<Pair<Int?, String>> = listOf(null to "None", 0 to "At start", 10 to "10 min", 30 to "30 min",
    60 to "1 hour", 120 to "2 hours", 1440 to "1 day", 2880 to "2 days", 10080 to "1 week")

/** The first day shown: Monday of this week for the week view, today for the agenda. */
internal fun calendarStart(today: LocalDate, mode: String): LocalDate =
    if (mode == "week") today.minusDays((today.dayOfWeek.value - 1).toLong()) else today

private val dayFormat = DateTimeFormatter.ofPattern("EEEE d MMMM", Locale.ENGLISH)
private val shortDay = DateTimeFormatter.ofPattern("EEE d MMM", Locale.ENGLISH)
private val rangeDay = DateTimeFormatter.ofPattern("d MMM", Locale.ENGLISH)

internal fun reminderText(minutes: Int?, allDay: Boolean): String? = when {
    minutes == null -> null
    minutes == 0 -> if (allDay) "Reminder at 09:00" else "Reminder when it starts"
    minutes % 1440 == 0 -> "Reminder ${minutes / 1440} day${if (minutes == 1440) "" else "s"} before"
    minutes % 60 == 0 -> "Reminder ${minutes / 60} hour${if (minutes == 60) "" else "s"} before"
    else -> "Reminder $minutes min before"
}

/** "14:00–15:30", "All day", "Holiday", or a time span across days. */
internal fun occurrenceTime(item: CalOccurrence): String = when {
    item.holiday -> "Holiday"
    item.allDay -> "All day"
    item.end == null -> item.start.drop(11)
    item.end.take(10) == item.start.take(10) -> "${item.start.drop(11)}–${item.end.drop(11)}"
    else -> "${item.start.drop(11)} → ${LocalDate.parse(item.end.take(10)).format(shortDay)} ${item.end.drop(11)}"
}

/** Which days each occurrence shows on inside the view: all-day events on every day they cover. */
internal fun calendarDays(view: CalendarView, mode: String): List<Pair<LocalDate, List<CalOccurrence>>> {
    val from = LocalDate.parse(view.from)
    val until = from.plusDays(view.days.toLong())
    val byDay = linkedMapOf<LocalDate, MutableList<CalOccurrence>>()
    for (item in view.occurrences) {
        val last = LocalDate.parse((item.end ?: item.start).take(10))
        var day = maxOf(LocalDate.parse(item.date), from)
        while (!day.isAfter(last) && day.isBefore(until)) {
            byDay.getOrPut(day) { mutableListOf() }.add(item)
            if (!item.allDay) break
            day = day.plusDays(1)
        }
    }
    val days = if (mode == "week") (0 until 7).map { from.plusDays(it.toLong()) } else byDay.keys.sorted()
    return days.map { it to (byDay[it] ?: emptyList()) }
}

@Composable
fun CalendarSection(model: CompanionModel, state: UiState) {
    LaunchedEffect(state.scope) { model.loadCalendar(null) }
    val ink = MaterialTheme.colorScheme.onSurface
    val soft = MaterialTheme.colorScheme.onSurfaceVariant
    val view = state.calendar
    val busy = state.calendarBusy
    var editing by remember(state.scope) { mutableStateOf<CalEvent?>(null) }
    var creating by remember(state.scope) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp).clip(RoundedCornerShape(18.dp))
        .background(MaterialTheme.colorScheme.surface).padding(14.dp)) {
        Text("Calendar", fontSize = 20.sp, fontWeight = FontWeight.Bold, color = ink)
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            if (state.calendarMode == "week") {
                ActionButton(enabled = !busy && view != null, onClick = { model.calendarWeek(-1) }) { Text("‹") }
                Text(view?.let {
                    val from = LocalDate.parse(it.from)
                    "${from.format(rangeDay)} – ${from.plusDays(6).format(rangeDay)}"
                } ?: "", Modifier.weight(1f), color = ink, fontWeight = FontWeight.SemiBold, fontSize = 15.sp,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                ActionButton(enabled = !busy && view != null, onClick = { model.calendarWeek(1) }) { Text("›") }
            } else Text("Next 60 days", Modifier.weight(1f), color = ink, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
            ActionButton(enabled = !busy && view != null, onClick = { model.calendarToday() }) { Text("Today") }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            for ((mode, label) in listOf("week" to "Week", "agenda" to "Agenda")) {
                val selected = state.calendarMode == mode
                Text(label, Modifier.clip(RoundedCornerShape(50))
                    .background(if (selected) MaterialTheme.colorScheme.primaryContainer else Color.Transparent)
                    .clickable(enabled = !busy && !selected, role = Role.RadioButton) { model.calendarMode(mode) }
                    .padding(horizontal = 12.dp, vertical = 6.dp),
                    color = if (selected) ink else soft, fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal, fontSize = 14.sp)
            }
            Spacer(Modifier.weight(1f))
            ActionButton(enabled = !busy && view != null, onClick = { creating = true }) { Text("Add event") }
        }
        state.calendarNotice?.let { Text(it, color = soft, fontSize = 13.sp) }
        state.calendarError?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }
        if (view == null) {
            Text(if (state.calendarError != null) "" else "Loading…", color = soft)
            if (state.calendarError != null) ActionButton(onClick = { model.loadCalendar(null) }) { Text("Try again") }
            return@Column
        }
        val days = calendarDays(view, state.calendarMode)
        if (days.isEmpty()) Text("Nothing in the next 60 days. Add an event, or ask ${state.name} in chat.", color = soft,
            fontSize = 14.sp, modifier = Modifier.padding(vertical = 8.dp))
        for ((day, items) in days) {
            val today = day.toString() == view.today
            Row(Modifier.padding(top = 10.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(day.format(dayFormat), color = if (today) ink else soft, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                if (today) Text("Today", Modifier.padding(start = 8.dp).clip(RoundedCornerShape(50))
                    .background(MaterialTheme.colorScheme.primaryContainer).padding(horizontal = 8.dp, vertical = 1.dp),
                    color = ink, fontSize = 11.sp, fontWeight = FontWeight.Bold)
            }
            if (items.isEmpty()) Text("Nothing planned", color = soft.copy(alpha = .7f), fontSize = 13.sp)
            for (item in items) OccurrenceRow(item, enabled = !busy) {
                view.events.firstOrNull { it.id == item.eventId }?.let { editing = it }
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = 10.dp).clickable(enabled = !busy, role = Role.Switch) { model.setHolidays(!view.holidaysFr) },
            verticalAlignment = Alignment.CenterVertically) {
            Text("Show French public holidays", Modifier.weight(1f), color = ink, fontSize = 15.sp)
            Switch(checked = view.holidaysFr, onCheckedChange = { model.setHolidays(it) }, enabled = !busy,
                colors = SwitchDefaults.colors(checkedTrackColor = Color(0xFFEE8F64), checkedThumbColor = Color.White))
        }
    }
    if (creating || editing != null) EventEditor(model, state, editing, view?.today) { creating = false; editing = null }
}

@Composable
private fun OccurrenceRow(item: CalOccurrence, enabled: Boolean, onEdit: () -> Unit) {
    val ink = MaterialTheme.colorScheme.onSurface
    val soft = MaterialTheme.colorScheme.onSurfaceVariant
    val shape = RoundedCornerShape(12.dp)
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp).clip(shape)
        .background(if (item.holiday) Color.Transparent else MaterialTheme.colorScheme.background)
        .clickable(enabled = enabled && !item.holiday, role = Role.Button) { onEdit() }
        .padding(horizontal = 10.dp, vertical = 8.dp)) {
        Text(occurrenceTime(item), Modifier.width(78.dp), color = soft, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        Column(Modifier.weight(1f)) {
            Text(item.title, color = ink, fontSize = 15.sp, fontWeight = FontWeight.Bold)
            val span = if (item.allDay && item.end != null && item.end != item.start)
                "${LocalDate.parse(item.start).format(shortDay)} – ${LocalDate.parse(item.end).format(shortDay)}" else null
            val extras = listOfNotNull(span, item.location, if (item.yearly) "Every year" else null, reminderText(item.reminderMinutes, item.allDay))
            if (extras.isNotEmpty()) Text(extras.joinToString(" · "), color = soft, fontSize = 12.sp)
        }
    }
}

@Composable
private fun EventEditor(model: CompanionModel, state: UiState, event: CalEvent?, today: String?, close: () -> Unit) {
    val context = LocalContext.current
    val soft = MaterialTheme.colorScheme.onSurfaceVariant
    val requestId = remember(event?.id) { java.util.UUID.randomUUID().toString() }
    val startDate = event?.start?.take(10) ?: today ?: LocalDate.now().toString()
    var title by remember { mutableStateOf(event?.title ?: "") }
    var allDay by remember { mutableStateOf(event?.allDay ?: false) }
    var date by remember { mutableStateOf(startDate) }
    var time by remember { mutableStateOf(if (event != null && !event.allDay) event.start.drop(11) else "09:00") }
    var endDate by remember { mutableStateOf(event?.end?.take(10)) }
    var endTime by remember { mutableStateOf(if (event?.end != null && !event.allDay) event.end.drop(11) else null) }
    var location by remember { mutableStateOf(event?.location ?: "") }
    var notes by remember { mutableStateOf(event?.notes ?: "") }
    var yearly by remember { mutableStateOf(event?.yearly ?: false) }
    var reminder by remember { mutableStateOf(event?.reminderMinutes) }
    var confirmDelete by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    val busy = state.calendarBusy
    fun pickDate(current: String?, onPick: (String) -> Unit) {
        val base = current?.let(LocalDate::parse) ?: LocalDate.parse(date)
        DatePickerDialog(context, { _, y, m, d -> onPick(LocalDate.of(y, m + 1, d).toString()) }, base.year, base.monthValue - 1, base.dayOfMonth).show()
    }
    fun pickTime(current: String?, onPick: (String) -> Unit) {
        val (h, m) = (current ?: time).split(":").map { it.toIntOrNull() ?: 0 }
        TimePickerDialog(context, { _, hour, minute -> onPick("%02d:%02d".format(hour, minute)) }, h, m, true).show()
    }
    fun draft(): EventDraft? {
        val start = if (allDay) date else "${date}T$time"
        val end = when {
            allDay -> endDate?.takeIf { it != date }
            endDate != null || endTime != null -> "${endDate ?: date}T${endTime ?: time}"
            else -> null
        }
        if (title.isBlank()) { problem = "Give the event a title."; return null }
        if (end != null && end < start) { problem = "The end is before the start."; return null }
        return EventDraft(title.trim(), allDay, start, end, location.trim().ifEmpty { null }, notes.trim().ifEmpty { null }, yearly, reminder)
    }
    if (confirmDelete && event != null) {
        AlertDialog(onDismissRequest = { confirmDelete = false },
            title = { Text("Delete this event?") },
            text = { Text(if (event.yearly) "“${event.title}” will be removed for every year." else "“${event.title}” will be removed.") },
            confirmButton = { TextButton(enabled = !busy, onClick = { confirmDelete = false; model.deleteEvent(event, close) }) {
                Text("Delete", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Keep") } })
        return
    }
    AlertDialog(onDismissRequest = { if (!busy) close() },
        title = { Text(if (event == null) "New event" else "Edit event") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                OutlinedTextField(title, { title = it.take(200) }, label = { Text("Title") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                EditorSwitch("All day", allDay) { allDay = it }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    ActionButton(onClick = { pickDate(date) { date = it } }) { Text(LocalDate.parse(date).format(shortDay)) }
                    if (!allDay) ActionButton(onClick = { pickTime(time) { time = it } }) { Text(time) }
                }
                Text("Ends (optional)", color = soft, fontSize = 13.sp)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    ActionButton(onClick = { pickDate(endDate) { endDate = it } }) { Text(endDate?.let { LocalDate.parse(it).format(shortDay) } ?: "Same day") }
                    if (!allDay) ActionButton(onClick = { pickTime(endTime) { endTime = it } }) { Text(endTime ?: "End time") }
                    if (endDate != null || endTime != null) ActionButton(onClick = { endDate = null; endTime = null }) { Text("No end") }
                }
                OutlinedTextField(location, { location = it.take(200) }, label = { Text("Location") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(notes, { notes = it.take(1000) }, label = { Text("Notes") }, minLines = 2, modifier = Modifier.fillMaxWidth())
                EditorSwitch("Every year", yearly) { yearly = it }
                Text("Reminder", color = soft, fontSize = 13.sp)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    val choices = REMINDER_CHOICES.let { list -> if (list.any { it.first == reminder }) list else list + (reminder to (reminderText(reminder, allDay) ?: "")) }
                    for ((value, label) in choices) {
                        val selected = value == reminder
                        Text(label, Modifier.padding(vertical = 2.dp).clip(RoundedCornerShape(50))
                            .background(if (selected) MaterialTheme.colorScheme.primaryContainer else Color.Transparent)
                            .clickable(role = Role.RadioButton) { reminder = value }.padding(horizontal = 10.dp, vertical = 6.dp),
                            color = if (selected) MaterialTheme.colorScheme.onSurface else soft,
                            fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal, fontSize = 13.sp)
                    }
                }
                if (allDay && reminder != null) Text("All-day reminders count back from 09:00 that day.", color = soft, fontSize = 12.sp)
                (problem ?: state.calendarError)?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }
                Spacer(Modifier.height(2.dp))
            }
        },
        confirmButton = { TextButton(enabled = !busy, onClick = {
            problem = null
            draft()?.let { model.saveEvent(event, requestId, it, close) }
        }) { Text(if (busy) "Saving…" else "Save") } },
        dismissButton = {
            Row {
                if (event != null) TextButton(enabled = !busy, onClick = { confirmDelete = true }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
                TextButton(enabled = !busy, onClick = close) { Text("Cancel") }
            }
        })
}

@Composable
private fun EditorSwitch(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(role = Role.Switch) { onChange(!checked) }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f), color = MaterialTheme.colorScheme.onSurface, fontSize = 15.sp)
        Switch(checked = checked, onCheckedChange = onChange, colors = SwitchDefaults.colors(checkedTrackColor = Color(0xFFEE8F64), checkedThumbColor = Color.White))
    }
}
