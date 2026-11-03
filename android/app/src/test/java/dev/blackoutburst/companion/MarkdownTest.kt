package dev.blackoutburst.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownTest {
    private fun text(spans: List<MdSpan>) = spans.joinToString("") { it.text }

    @Test fun boldItalicAndCode() {
        val spans = inline("I posted it as **#35**, with *your* `screenshot`")
        assertEquals("I posted it as #35, with your screenshot", text(spans))
        assertTrue(spans.single { it.text == "#35" }.bold)
        assertTrue(spans.single { it.text == "your" }.italic)
        assertTrue(spans.single { it.text == "screenshot" }.code)
    }

    @Test fun unclosedMarkersStayLiteral() {
        assertEquals("2 * 3 = 6 and **open", text(inline("2 * 3 = 6 and **open")))
        assertEquals("snake_case_name stays", text(inline("snake_case_name stays")))
    }

    @Test fun bareUrlsAreShortenedAndClickable() {
        val url = "https://board.blackoutburst.com/?project=f0ad83b792830c7cd190412ee8f48997&ticket=21b96420a756e7d3a8afbe1ee598cf1a"
        val spans = inline("See $url.")
        val link = spans.single { it.url != null }
        assertEquals(url, link.url)
        assertEquals("Board ticket ↗", link.text)
        assertEquals("See Board ticket ↗.", text(spans))
        assertEquals("example.com/a/b", shortUrl("https://www.example.com/a/b/"))
        assertEquals("example.com/…", shortUrl("https://example.com/" + "x".repeat(60)))
    }

    @Test fun markdownLinksUseTheirTextAndOnlyHttp() {
        val spans = inline("[#35 Polish attachments](https://board.blackoutburst.com/?ticket=1) and [bad](javascript:alert(1))")
        assertEquals("https://board.blackoutburst.com/?ticket=1", spans.first().url)
        assertEquals("#35 Polish attachments", spans.first().text)
        assertTrue(spans.none { it.url?.startsWith("javascript") == true })
        assertNull(safeUrl("file:///etc/passwd"))
        assertNull(safeUrl("intent://x"))
    }

    @Test fun blocksSplitParagraphsBulletsAndNumbers() {
        val blocks = parseMarkdown("Three tickets:\n- **#33** the + button\n  - nested\n1. first\n\nShould I assign them?")
        assertTrue(blocks[0] is MdBlock.Paragraph)
        val bullet = blocks[1] as MdBlock.Bullet
        assertEquals("#33 the + button", text(bullet.spans)); assertEquals(0, bullet.level)
        assertEquals(1, (blocks[2] as MdBlock.Bullet).level)
        assertEquals("1.", (blocks[3] as MdBlock.Numbered).number)
        assertEquals("Should I assign them?", text((blocks[4] as MdBlock.Paragraph).spans))
    }
}
