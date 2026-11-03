package dev.blackoutburst.companion

import java.time.LocalDate
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CalendarTest {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    @Test fun weekStartsOnMonday() {
        assertEquals(LocalDate.parse("2026-11-02"), calendarStart(LocalDate.parse("2026-11-03"), "week"))
        assertEquals(LocalDate.parse("2026-11-02"), calendarStart(LocalDate.parse("2026-11-08"), "week"))
        assertEquals(LocalDate.parse("2026-11-03"), calendarStart(LocalDate.parse("2026-11-03"), "agenda"))
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

    @Test fun decodesTheServerViewAndSpreadsMultiDayEvents() {
        val view = json.decodeFromString<CalendarView>("""{"timezone":"Europe/Paris","today":"2026-11-03","from":"2026-11-02","days":7,"holidaysFr":true,
            "occurrences":[{"eventId":"a","title":"Trip","date":"2026-11-07","allDay":true,"start":"2026-11-07","end":"2026-11-09","location":null,"yearly":false,"reminderMinutes":null},
            {"eventId":"b","title":"Dinner","date":"2026-11-03","allDay":false,"start":"2026-11-03T20:00","end":null,"location":"Home","yearly":false,"reminderMinutes":30},
            {"holiday":true,"title":"Armistice 1918","date":"2026-11-11","allDay":true,"start":"2026-11-11","end":null}],
            "events":[{"id":"b","version":2,"title":"Dinner","allDay":false,"start":"2026-11-03T20:00","end":null,"location":"Home","notes":null,"yearly":false,"reminderMinutes":30}],"total":2}""")
        val week = calendarDays(view, "week")
        assertEquals(7, week.size)
        assertEquals(listOf("Dinner"), week[1].second.map { it.title })
        assertEquals(listOf("Trip"), week[5].second.map { it.title })
        assertEquals(listOf("Trip"), week[6].second.map { it.title })
        assertEquals(2L, view.events.single().version)
        assertEquals(listOf("2026-11-03", "2026-11-07", "2026-11-08"), calendarDays(view, "agenda").map { it.first.toString() })
    }
}
