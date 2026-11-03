package dev.blackoutburst.companion

import java.time.LocalDate
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CalendarTest {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    @Test fun monthGridCoversWholeMondayWeeks() {
        assertEquals(LocalDate.parse("2026-10-26") to 42, monthGrid(java.time.YearMonth.parse("2026-11")))
        assertEquals(LocalDate.parse("2027-02-01") to 28, monthGrid(java.time.YearMonth.parse("2027-02")))
    }

    @Test fun labelsTimesAndReminders() {
        val timed = CalOccurrence(eventId = "e", title = "Dentist", date = "2026-11-04", allDay = false, start = "2026-11-04T14:00", end = "2026-11-04T14:45")
        assertEquals("14:00–14:45", occurrenceTime(timed))
        assertEquals("22:00", occurrenceTime(timed.copy(start = "2026-11-04T22:00", end = null)))
        assertEquals("All day", occurrenceTime(timed.copy(allDay = true, start = "2026-11-04", end = null)))
        assertEquals("Holiday", occurrenceTime(timed.copy(holiday = true)))
        assertEquals("Reminder 1 hour before", reminderText(60, false))
        assertEquals("Reminder 2 days before", reminderText(2880, true))
        assertEquals("Reminder at 09:00", reminderText(0, true))
        assertNull(reminderText(null, false))
    }

    @Test fun decodesTheServerViewAndLaysOutAWeek() {
        val view = json.decodeFromString<CalendarView>("""{"timezone":"Europe/Paris","today":"2026-11-03","from":"2026-11-02","days":7,"holidaysFr":true,
            "occurrences":[{"eventId":"a","title":"Trip","date":"2026-11-07","allDay":true,"start":"2026-11-07","end":"2026-11-09","location":null,"repeat":"none","yearly":false,"reminderMinutes":null},
            {"eventId":"b","title":"Dinner","date":"2026-11-03","allDay":false,"start":"2026-11-03T20:00","end":null,"location":"Home","repeat":"weekly","yearly":false,"reminderMinutes":30},
            {"eventId":"c","title":"A","date":"2026-11-05","allDay":true,"start":"2026-11-05"},{"eventId":"d","title":"B","date":"2026-11-05","allDay":true,"start":"2026-11-05"},
            {"eventId":"e","title":"C","date":"2026-11-05","allDay":true,"start":"2026-11-05"},{"eventId":"f","title":"D","date":"2026-11-05","allDay":true,"start":"2026-11-05"},
            {"holiday":true,"title":"Armistice 1918","date":"2026-11-11","allDay":true,"start":"2026-11-11","end":null}],
            "events":[{"id":"b","version":2,"title":"Dinner","allDay":false,"start":"2026-11-03T20:00","end":null,"location":"Home","notes":null,"repeat":"weekly","yearly":false,"reminderMinutes":30}],"total":2}""")
        assertEquals("weekly", view.events.single().repeat)
        assertEquals("yearly", json.decodeFromString<CalEvent>("""{"id":"x","version":1,"title":"Léa","allDay":true,"start":"1990-11-04","yearly":true}""").repeat)
        val week = (0 until 7).map { LocalDate.parse("2026-11-02").plusDays(it.toLong()) }
        val layout = weekLayout(week, view.occurrences)
        assertEquals(listOf(Triple("Trip", 5, 6)), layout.bars.map { Triple(it.item.title, it.from, it.to) })
        assertEquals(true, layout.bars.single().after)
        assertEquals(1, layout.lanes)
        assertEquals(listOf("Dinner"), layout.cells[1].chips.map { it.title })
        assertEquals(listOf("A") to 3, layout.cells[3].chips.map { it.title } to layout.cells[3].more)
    }
}
