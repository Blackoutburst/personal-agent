package dev.blackoutburst.companion

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.LocalDate
import java.time.YearMonth
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale
import kotlin.math.abs

/** Reminder choices in minutes before the event; null is no reminder. */
internal val REMINDER_CHOICES: List<Pair<Int?, String>> = listOf(null to "None", 0 to "At start", 10 to "10 min", 30 to "30 min",
    60 to "1 hour", 120 to "2 hours", 1440 to "1 day", 2880 to "2 days", 10080 to "1 week")
/** Repeat choices (#47), as the server names them. */
internal val REPEAT_CHOICES = listOf("none" to "Once", "daily" to "Every day", "weekly" to "Every week", "monthly" to "Every month", "yearly" to "Every year")

private val dayFormat = DateTimeFormatter.ofPattern("EEEE d MMMM", Locale.ENGLISH)
private val shortDay = DateTimeFormatter.ofPattern("EEE d MMM", Locale.ENGLISH)
private val monthFormat = DateTimeFormatter.ofPattern("MMMM yyyy", Locale.ENGLISH)
private val WEEKDAYS = listOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
private const val ROWS = 3

// The app's peach accent and the holiday tone, in light and dark.
private val Accent = Color(0xFFFFB38A)
private val AccentDeep = Color(0xFFEE8F64)
private val OnAccent = Color(0xFF3A2E39)

/** The month grid: from the Monday on or before the 1st to the Sunday on or after the last day. */
internal fun monthGrid(month: YearMonth): Pair<LocalDate, Int> {
    val first = month.atDay(1)
    val last = month.atEndOfMonth()
    val from = first.minusDays((first.dayOfWeek.value - 1).toLong())
    val to = last.plusDays((7 - last.dayOfWeek.value).toLong())
    return from to (ChronoUnit.DAYS.between(from, to).toInt() + 1)
}

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

private fun lastDay(item: CalOccurrence) = LocalDate.parse((item.end ?: item.start).take(10))
private fun multiDay(item: CalOccurrence) = !item.holiday && lastDay(item).isAfter(LocalDate.parse(item.date))

internal data class Bar(val item: CalOccurrence, val from: Int, val to: Int, val lane: Int, val before: Boolean, val after: Boolean)
internal data class Cell(val day: LocalDate, val chips: List<CalOccurrence>, val more: Int)
internal data class WeekLayout(val bars: List<Bar>, val lanes: Int, val cells: List<Cell>)

/** One week row (the same layout as the web, public/calendar-ui.mjs): multi-day events as bars in lanes clipped to the
 *  week, single-day items per day, and "+N" for what does not fit in [visible] lines. */
internal fun weekLayout(days: List<LocalDate>, occurrences: List<CalOccurrence>, visible: Int = ROWS): WeekLayout {
    val first = days.first()
    val last = days.last()
    val spans = occurrences.filter { multiDay(it) && !LocalDate.parse(it.date).isAfter(last) && !lastDay(it).isBefore(first) }
        .map { item -> Triple(item, maxOf(0, ChronoUnit.DAYS.between(first, LocalDate.parse(item.date)).toInt()), minOf(6, ChronoUnit.DAYS.between(first, lastDay(item)).toInt())) }
        .sortedWith(compareBy<Triple<CalOccurrence, Int, Int>> { it.second }.thenByDescending { it.third - it.second }.thenBy { it.first.title })
    val ends = mutableListOf<Int>()
    val bars = spans.map { (item, from, to) ->
        var lane = ends.indexOfFirst { it < from }
        if (lane < 0) { lane = ends.size; ends.add(-1) }
        ends[lane] = to
        Bar(item, from, to, lane, LocalDate.parse(item.date).isBefore(first), lastDay(item).isAfter(last))
    }
    val shown = minOf(ends.size, visible)
    val cells = days.mapIndexed { index, day ->
        val singles = occurrences.filter { !multiDay(it) && it.date == day.toString() }
        val hidden = bars.count { it.lane >= shown && it.from <= index && it.to >= index }
        val room = maxOf(0, visible - shown)
        val chips = if (singles.size + hidden <= room) singles else singles.take(maxOf(0, room - 1))
        Cell(day, chips, singles.size - chips.size + hidden)
    }
    return WeekLayout(bars.filter { it.lane < shown }, shown, cells)
}

/** The Calendar tab: a month grid, the selected day's events and a + button (watches and reminders are in Me › Watches). */
@Composable
fun CalendarScreen(model: CompanionModel, state: UiState) {
    LaunchedEffect(state.scope) { model.loadCalendar(null) }
    val tones = LocalTones.current
    val view = state.calendar
    val busy = state.calendarBusy
    var editing by remember(state.scope) { mutableStateOf<CalEvent?>(null) }
    var creating by remember(state.scope) { mutableStateOf<String?>(null) }
    val open = { item: CalOccurrence -> if (!item.holiday && !busy) view?.events?.firstOrNull { it.id == item.eventId }?.let { editing = it } }
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 10.dp)) {
            Row(Modifier.fillMaxWidth().padding(start = 6.dp, top = 16.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(state.calendarMonth?.let { YearMonth.parse(it).format(monthFormat) } ?: "Calendar", Modifier.weight(1f),
                    fontSize = 24.sp, fontWeight = FontWeight.ExtraBold, color = tones.ink)
                RoundButton("‹", "Previous month", enabled = !busy && view != null) { model.calendarShift(-1) }
                RoundButton("›", "Next month", enabled = !busy && view != null) { model.calendarShift(1) }
                ActionButton(enabled = !busy && view != null, onClick = { model.calendarToday() }, modifier = Modifier.padding(start = 4.dp)) {
                    Text("Today", fontWeight = FontWeight.Bold) }
            }
            state.calendarNotice?.let { Text(it, color = tones.soft, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 6.dp)) }
            state.calendarError?.let { Text(it, color = tones.danger, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 6.dp)) }
            if (view == null || state.calendarMonth == null) {
                Text(if (state.calendarError != null) "" else "Loading…", color = tones.soft, modifier = Modifier.padding(6.dp))
                if (state.calendarError != null) ActionButton(onClick = { model.loadCalendar(null) }) { Text("Try again") }
            } else {
                MonthGrid(view, state.calendarMonth, state.calendarDay, onDay = { model.selectDay(it.toString()) }, onItem = open,
                    onSwipe = { if (!busy) model.calendarShift(it) })
                state.calendarDay?.let { DayPanel(view, LocalDate.parse(it), busy, open) { creating = it.toString() } }
                Row(Modifier.fillMaxWidth().padding(top = 10.dp, start = 6.dp, end = 6.dp).clickable(enabled = !busy, role = Role.Switch) { model.setHolidays(!view.holidaysFr) },
                    verticalAlignment = Alignment.CenterVertically) {
                    Text("Show French public holidays", Modifier.weight(1f), color = tones.ink, fontSize = 15.sp)
                    Switch(checked = view.holidaysFr, onCheckedChange = { model.setHolidays(it) }, enabled = !busy,
                        colors = SwitchDefaults.colors(checkedTrackColor = AccentDeep, checkedThumbColor = Color.White))
                }
            }
            Spacer(Modifier.height(96.dp))
        }
        if (view != null) Box(Modifier.align(Alignment.BottomEnd).padding(20.dp).size(58.dp)
            .shadow(10.dp, RoundedCornerShape(20.dp), ambientColor = AccentDeep, spotColor = AccentDeep)
            .clip(RoundedCornerShape(20.dp)).background(Accent)
            .clickable(enabled = !busy, role = Role.Button) { creating = state.calendarDay ?: view.today }
            .semantics { contentDescription = "Add an event" }, contentAlignment = Alignment.Center) {
            Text("+", color = OnAccent, fontSize = 32.sp, fontWeight = FontWeight.Normal)
        }
    }
    if (creating != null || editing != null) EventEditor(model, state, editing, creating ?: view?.today) { creating = null; editing = null }
}

@Composable
private fun RoundButton(label: String, description: String, enabled: Boolean, onClick: () -> Unit) {
    val tones = LocalTones.current
    Box(Modifier.padding(horizontal = 2.dp).size(38.dp).clip(CircleShape).border(1.dp, tones.line, CircleShape).background(tones.card)
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick).semantics { contentDescription = description },
        contentAlignment = Alignment.Center) {
        Text(label, color = tones.ink.copy(alpha = if (enabled) 1f else .4f), fontSize = 20.sp)
    }
}

@Composable
internal fun MonthGrid(view: CalendarView, month: String, selected: String?, onDay: (LocalDate) -> Unit, onItem: (CalOccurrence) -> Unit, onSwipe: (Long) -> Unit) {
    val tones = LocalTones.current
    val from = LocalDate.parse(view.from)
    val days = (0 until view.days).map { from.plusDays(it.toLong()) }
    val weeks = days.chunked(7)
    // Tall tiles: the weeks share the screen below the header.
    val height = maxOf(84, (LocalConfiguration.current.screenHeightDp - 270) / weeks.size.coerceAtLeast(1)).dp
    var drag by remember { mutableStateOf(0f) }
    Column(Modifier.fillMaxWidth().pointerInput(month) {
        detectHorizontalDragGestures(onDragStart = { drag = 0f }, onDragEnd = { if (abs(drag) > 120f) onSwipe(if (drag < 0) 1 else -1); drag = 0f }) { _, amount -> drag += amount }
    }) {
        Row(Modifier.fillMaxWidth().padding(bottom = 4.dp)) {
            for (name in WEEKDAYS) Text(name.uppercase(), Modifier.weight(1f), color = tones.soft, fontSize = 11.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
        }
        for (week in weeks) {
            Week(week, weekLayout(week, view.occurrences), month, view.today, selected, height, onDay, onItem)
            Spacer(Modifier.height(3.dp))
        }
    }
}

@Composable
private fun Week(week: List<LocalDate>, layout: WeekLayout, month: String, today: String, selected: String?, height: androidx.compose.ui.unit.Dp,
                 onDay: (LocalDate) -> Unit, onItem: (CalOccurrence) -> Unit) {
    val tones = LocalTones.current
    Box(Modifier.fillMaxWidth().heightIn(min = height)) {
        Row(Modifier.matchParentSize()) {
            for (day in week) {
                val shape = RoundedCornerShape(12.dp)
                Box(Modifier.weight(1f).fillMaxSize().padding(horizontal = 1.5.dp).alpha(if (day.toString().take(7) == month) 1f else .5f).clip(shape).background(tones.top)
                    .border(1.5.dp, if (day.toString() == selected) AccentDeep else Color.Transparent, shape)
                    .clickable(role = Role.Button) { onDay(day) }
                    .semantics { contentDescription = day.format(dayFormat) + if (day.toString() == today) ", today" else "" })
            }
        }
        Column(Modifier.fillMaxWidth()) {
            Row(Modifier.fillMaxWidth()) {
                for (day in week) Box(Modifier.weight(1f).padding(start = 5.dp, top = 4.dp, bottom = 2.dp)) {
                    val isToday = day.toString() == today
                    Text(day.dayOfMonth.toString(), Modifier.size(24.dp).clip(CircleShape).background(if (isToday) Accent else Color.Transparent)
                        .wrapContentHeight(Alignment.CenterVertically),
                        color = when { isToday -> OnAccent; day.toString().take(7) == month -> tones.ink; else -> tones.soft.copy(alpha = .6f) },
                        fontSize = 12.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
                }
            }
            for (lane in 0 until layout.lanes) {
                Row(Modifier.fillMaxWidth().padding(vertical = 1.dp)) {
                    var index = 0
                    while (index < 7) {
                        val bar = layout.bars.firstOrNull { it.lane == lane && it.from == index }
                        if (bar != null) {
                            Chip(bar.item, Modifier.weight((bar.to - bar.from + 1).toFloat()), month, bar = bar, onItem = onItem)
                            index = bar.to + 1
                        } else { Spacer(Modifier.weight(1f)); index++ }
                    }
                }
            }
            Row(Modifier.fillMaxWidth().padding(bottom = 4.dp)) {
                for (cell in layout.cells) Column(Modifier.weight(1f).alpha(if (cell.day.toString().take(7) == month) 1f else .6f),
                    verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    for (item in cell.chips) Chip(item, Modifier.fillMaxWidth(), month, onItem = onItem)
                    if (cell.more > 0) Text("+${cell.more}", Modifier.clip(RoundedCornerShape(6.dp)).clickable { onDay(cell.day) }.padding(horizontal = 4.dp),
                        color = tones.soft, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}

@Composable
private fun Chip(item: CalOccurrence, modifier: Modifier, month: String, bar: Bar? = null, onItem: (CalOccurrence) -> Unit) {
    val tones = LocalTones.current
    val holiday = if (tones.dark) Color(0xFF4A3D22) to Color(0xFFF5DFA6) else Color(0xFFFFF3D6) to Color(0xFF6B5320)
    val r = 6.dp
    val shape = RoundedCornerShape(topStart = if (bar?.before == true) 0.dp else r, bottomStart = if (bar?.before == true) 0.dp else r,
        topEnd = if (bar?.after == true) 0.dp else r, bottomEnd = if (bar?.after == true) 0.dp else r)
    val timed = !item.allDay && !item.holiday && bar == null
    val background = when {
        item.holiday -> holiday.first
        timed -> Color.Transparent
        bar != null -> Accent.copy(alpha = if (tones.dark) .55f else .75f)
        else -> Accent.copy(alpha = if (tones.dark) .35f else .4f)
    }
    Row(modifier.padding(start = if (bar?.before == true) 1.5.dp else 3.dp, end = if (bar?.after == true) 1.5.dp else 3.dp).height(17.dp).clip(shape).background(background)
        .clickable(enabled = !item.holiday, role = Role.Button) { onItem(item) }.padding(horizontal = 3.dp),
        verticalAlignment = Alignment.CenterVertically) {
        if (timed) Box(Modifier.padding(end = 2.dp).size(5.dp).clip(CircleShape).background(AccentDeep))
        Text(item.title, color = if (item.holiday) holiday.second else tones.ink, fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
            fontWeight = if (timed) FontWeight.Normal else FontWeight.SemiBold, lineHeight = 12.sp)
    }
}

@Composable
internal fun DayPanel(view: CalendarView, day: LocalDate, busy: Boolean, onItem: (CalOccurrence) -> Unit, onAdd: () -> Unit) {
    val tones = LocalTones.current
    val items = view.occurrences.filter { !LocalDate.parse(it.date).isAfter(day) && !lastDay(it).isBefore(day) }
    Column(Modifier.fillMaxWidth().padding(top = 10.dp).clip(RoundedCornerShape(18.dp)).background(tones.top).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(day.format(dayFormat), color = tones.ink, fontSize = 16.sp, fontWeight = FontWeight.Bold)
            if (day.toString() == view.today) Text("Today", Modifier.padding(start = 8.dp).clip(RoundedCornerShape(50)).background(Accent)
                .padding(horizontal = 8.dp, vertical = 1.dp), color = OnAccent, fontSize = 11.sp, fontWeight = FontWeight.Bold)
        }
        if (items.isEmpty()) Text("Nothing planned.", color = tones.soft, fontSize = 14.sp)
        for (item in items) {
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(tones.card)
                .clickable(enabled = !busy && !item.holiday, role = Role.Button) { onItem(item) }.padding(horizontal = 12.dp, vertical = 9.dp)) {
                Column(Modifier.weight(1f)) {
                    Text(item.title, color = tones.ink, fontSize = 15.sp, fontWeight = FontWeight.Bold)
                    val span = if (multiDay(item)) "${LocalDate.parse(item.date).format(shortDay)} – ${lastDay(item).format(shortDay)}" else null
                    val repeat = REPEAT_CHOICES.firstOrNull { it.first == item.repeat && it.first != "none" }?.second
                    Text(listOfNotNull(occurrenceTime(item), span, item.location, repeat, reminderText(item.reminderMinutes, item.allDay)).joinToString(" · "),
                        color = tones.soft, fontSize = 12.sp)
                }
            }
        }
        ActionButton(enabled = !busy, onClick = onAdd) { Text("Add an event on this day") }
    }
}

@Composable
private fun EventEditor(model: CompanionModel, state: UiState, event: CalEvent?, day: String?, close: () -> Unit) {
    val context = LocalContext.current
    val soft = MaterialTheme.colorScheme.onSurfaceVariant
    val requestId = remember(event?.id) { java.util.UUID.randomUUID().toString() }
    val startDate = event?.start?.take(10) ?: day ?: LocalDate.now().toString()
    var title by remember { mutableStateOf(event?.title ?: "") }
    var allDay by remember { mutableStateOf(event?.allDay ?: false) }
    var date by remember { mutableStateOf(startDate) }
    var time by remember { mutableStateOf(if (event != null && !event.allDay) event.start.drop(11) else "09:00") }
    var endDate by remember { mutableStateOf(event?.end?.take(10)) }
    var endTime by remember { mutableStateOf(if (event?.end != null && !event.allDay) event.end.drop(11) else null) }
    var location by remember { mutableStateOf(event?.location ?: "") }
    var notes by remember { mutableStateOf(event?.notes ?: "") }
    var repeat by remember { mutableStateOf(event?.repeat ?: "none") }
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
        return EventDraft(title.trim(), allDay, start, end, location.trim().ifEmpty { null }, notes.trim().ifEmpty { null }, repeat, reminder)
    }
    if (confirmDelete && event != null) {
        AlertDialog(onDismissRequest = { confirmDelete = false },
            title = { Text("Delete this event?") },
            text = { Text(if (event.repeat != "none") "“${event.title}” and all its repeats will be removed." else "“${event.title}” will be removed.") },
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
                Text("Repeat", color = soft, fontSize = 13.sp)
                Choices(REPEAT_CHOICES, repeat) { repeat = it }
                if (repeat == "monthly" && LocalDate.parse(date).dayOfMonth > 28) Text("In shorter months it falls on the last day.", color = soft, fontSize = 12.sp)
                OutlinedTextField(location, { location = it.take(200) }, label = { Text("Location") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(notes, { notes = it.take(1000) }, label = { Text("Notes") }, minLines = 2, modifier = Modifier.fillMaxWidth())
                Text("Reminder", color = soft, fontSize = 13.sp)
                Choices(REMINDER_CHOICES.let { list -> if (list.any { it.first == reminder }) list else list + (reminder to (reminderText(reminder, allDay) ?: "")) }, reminder) { reminder = it }
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
private fun <T> Choices(choices: List<Pair<T, String>>, selected: T, onPick: (T) -> Unit) {
    val soft = MaterialTheme.colorScheme.onSurfaceVariant
    FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        for ((value, label) in choices) {
            val on = value == selected
            Text(label, Modifier.padding(vertical = 2.dp).clip(RoundedCornerShape(50))
                .background(if (on) Accent.copy(alpha = .45f) else Color.Transparent)
                .clickable(role = Role.RadioButton) { onPick(value) }.padding(horizontal = 10.dp, vertical = 6.dp),
                color = if (on) MaterialTheme.colorScheme.onSurface else soft, fontWeight = if (on) FontWeight.Bold else FontWeight.Normal, fontSize = 13.sp)
        }
    }
}

@Composable
private fun EditorSwitch(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(role = Role.Switch) { onChange(!checked) }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f), color = MaterialTheme.colorScheme.onSurface, fontSize = 15.sp)
        Switch(checked = checked, onCheckedChange = onChange, colors = SwitchDefaults.colors(checkedTrackColor = AccentDeep, checkedThumbColor = Color.White))
    }
}
