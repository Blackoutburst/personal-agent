package dev.blackoutburst.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PushTextTest {
    @Test fun markdownBecomesOneReadableLine() {
        val text = notificationText("## Done!\nI filed **#39** for you: [Android push](https://board.blackoutburst.com/?ticket=1)\n\n- one\n- two")
        assertEquals("Done! I filed #39 for you: Android push • one • two", text)
    }

    @Test fun longMessagesAreCut() {
        val text = notificationText("word ".repeat(200), max = 50)
        assertTrue(text.length <= 50)
        assertTrue(text.endsWith("…"))
    }
}
