package dev.blackoutburst.companion

import org.junit.Assert.assertEquals
import org.junit.Test

class BubblesTest {
    @Test fun blankLinesSplitAndSingleBreaksStay() {
        assertEquals(listOf("idk\nits the norm", "so", "nobody cares ig"), splitBubbles("idk\nits the norm\n\nso\n\n\n nobody cares ig "))
        assertEquals(emptyList<String>(), splitBubbles("  \n\n "))
    }
    @Test fun codeAndListsStayWhole() {
        assertEquals(listOf("try:", "```\na\n\nb\n```", "then reload"), splitBubbles("try:\n\n```\na\n\nb\n```\n\nthen reload"))
        assertEquals(listOf("options:", "1. tea\n\n2. coffee", "up to you"), splitBubbles("options:\n\n1. tea\n\n2. coffee\n\nup to you"))
    }
    @Test fun restStaysInLastBubble() {
        val parts = splitBubbles((0 until 12).joinToString("\n\n") { "m$it" })
        assertEquals(8, parts.size); assertEquals("m7\n\nm8\n\nm9\n\nm10\n\nm11", parts.last())
    }
}
