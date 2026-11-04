package dev.blackoutburst.companion

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WatchesTest {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    @Test fun onlyPlainWebLinksAreTappable() {
        assertTrue(safeLink("https://news.example.com/nvda-q3"))
        assertTrue(safeLink("http://example.org/a?b=c"))
        assertFalse(safeLink("javascript:alert(1)"))
        assertFalse(safeLink("intent://scan/#Intent;scheme=zxing;end"))
        assertFalse(safeLink("https://user:pass@example.com/"))
        assertFalse(safeLink("file:///sdcard/secret"))
        assertFalse(safeLink("https://example.com/" + "a".repeat(2100)))
    }

    @Test fun topicWatchesDecodeAndReadNaturally() {
        val raw = """{"timezone":"Europe/Paris","settings":{"heartbeatEnabled":true,"quietStart":"22:00","quietEnd":"08:00",
            "dailyDigest":{"enabled":true,"localTime":"09:00"},"weeklyCheckin":{"enabled":false,"localTime":"10:00","weekday":1}},
            "items":[{"id":"r1","text":"Call the dentist","dueAt":"2026-11-03T15:00:00.000Z","state":"active","canCancel":true}],
            "releaseWatches":[{"id":"1e80ef85-15aa-4afb-99cf-e415fa3e4971","version":3,"kind":"topic_watch","condition":"NVIDIA stock news",
            "state":"active","nextCheckAt":"2026-11-03T20:00:00.000Z","lastCheckAt":"2026-11-03T08:00:00.000Z","lastResult":"found",
            "urls":["https://news.example.com/nvda-q3"],"evidence":"Q3 beat.","consecutiveStale":0,"deliveryPending":false,
            "createdAt":"2026-11-03T01:00:00.000Z","intervalHours":24,"digests":[{"at":"2026-11-03T08:00:00.000Z","evidence":"Q3 beat.","urls":[]}]}]}"""
        val schedules = json.decodeFromString<Schedules>(raw)
        val watch = schedules.releaseWatches.single()
        assertTrue(watch.topic)
        assertEquals(24, watch.intervalHours)
        assertEquals("Something new", watchResult(watch))
        assertEquals("Not yet", watchResult(watch.copy(kind = "release_watch", lastResult = "not_yet")))
        assertEquals("Tue 3 Nov, 21:00", scheduleTime(watch.nextCheckAt, schedules.timezone))
        assertEquals("Active · next check Tue 3 Nov, 21:00", watchState(watch, schedules.timezone))
        assertEquals("Found · waiting for delivery after quiet hours", watchState(watch.copy(deliveryPending = true), schedules.timezone))
        assertEquals(1, schedules.settings.weeklyCheckin?.weekday)
    }

    @Test fun boardWakeCapDistinguishesNumberNoLimitAndOlderServers() {
        val base = "\"heartbeatEnabled\":false,\"quietStart\":\"22:00\",\"quietEnd\":\"08:00\""
        val limited = json.decodeFromString(ScheduleSettings.serializer(), "{$base,\"boardWakeCap\":200}")
        assertTrue(limited.boardCapOffered); assertEquals(200, limited.boardCapLimit)
        val unlimited = json.decodeFromString(ScheduleSettings.serializer(), "{$base,\"boardWakeCap\":null}")
        assertTrue(unlimited.boardCapOffered); assertEquals(null, unlimited.boardCapLimit)
        val older = json.decodeFromString(ScheduleSettings.serializer(), "{$base}")
        assertFalse(older.boardCapOffered)
    }

    @Test fun proactiveSettingsAndFollowupsAreOptionalForOlderServers() {
        val base = "\"heartbeatEnabled\":false,\"quietStart\":\"22:00\",\"quietEnd\":\"08:00\""
        val current = json.decodeFromString<Schedules>("{\"timezone\":\"UTC\",\"settings\":{$base,\"proactive\":{\"enabled\":true,\"perDay\":6}}," +
            "\"followups\":[{\"id\":\"f1\",\"note\":\"Ask about the trip\",\"dueAt\":\"2026-11-14T17:00:00.000Z\",\"state\":\"active\",\"createdAt\":\"2026-11-02T12:00:00.000Z\",\"canCancel\":true}]}")
        assertEquals(Proactive(true, 6), current.settings.proactive)
        assertEquals("Ask about the trip", current.followups.single().note)
        val older = json.decodeFromString<Schedules>("{\"timezone\":\"UTC\",\"settings\":{$base}}")
        assertEquals(null, older.settings.proactive)
        assertTrue(older.followups.isEmpty())
        assertEquals(1440, PROACTIVE_MAX_PER_DAY)
    }
}
