package dev.blackoutburst.companion

import java.net.URI

// A small, safe subset of markdown for chat bubbles (#36): paragraphs, dash or star bullets, numbered items,
// bold (double stars), italic (single star or underscore), inline code, [text](url) links and bare http(s) URLs.
// Anything else stays plain text. Only http and https links are ever made clickable.
sealed interface MdBlock {
    data class Paragraph(val spans: List<MdSpan>) : MdBlock
    data class Bullet(val spans: List<MdSpan>, val level: Int) : MdBlock
    data class Numbered(val number: String, val spans: List<MdSpan>, val level: Int) : MdBlock
}

data class MdSpan(val text: String, val bold: Boolean = false, val italic: Boolean = false,
    val code: Boolean = false, val url: String? = null)

private val BULLET = Regex("""^(\s*)[-*•]\s+(.*)$""")
private val NUMBERED = Regex("""^(\s*)(\d{1,3})[.)]\s+(.*)$""")
private val BARE_URL = Regex("""https?://[^\s<>()\[\]]+""")
private const val TRAILING = ".,;:!?'\""

fun parseMarkdown(text: String): List<MdBlock> {
    val blocks = mutableListOf<MdBlock>()
    val paragraph = mutableListOf<String>()
    fun flush() {
        if (paragraph.isNotEmpty()) { blocks += MdBlock.Paragraph(inline(paragraph.joinToString("\n"))); paragraph.clear() }
    }
    for (line in text.replace("\r\n", "\n").split('\n')) {
        val bullet = BULLET.matchEntire(line)
        val numbered = NUMBERED.matchEntire(line)
        when {
            bullet != null -> { flush(); blocks += MdBlock.Bullet(inline(bullet.groupValues[2]), level(bullet.groupValues[1])) }
            numbered != null -> { flush(); blocks += MdBlock.Numbered(numbered.groupValues[2] + ".", inline(numbered.groupValues[3]), level(numbered.groupValues[1])) }
            line.isBlank() -> flush()
            else -> paragraph += line
        }
    }
    flush()
    return blocks
}

private fun level(indent: String) = (indent.replace("\t", "  ").length / 2).coerceAtMost(3)

/** Inline spans. Unclosed markers stay as literal text, so odd input never disappears. */
fun inline(text: String): List<MdSpan> {
    val out = mutableListOf<MdSpan>()
    val plain = StringBuilder()
    var bold = false; var italic = false
    fun emit(value: String, code: Boolean = false, url: String? = null) {
        if (value.isEmpty()) return
        out += MdSpan(value, bold, italic, code, url)
    }
    fun flushPlain() { emitPlainWithUrls(plain.toString(), bold, italic, out); plain.clear() }
    var i = 0
    while (i < text.length) {
        val c = text[i]
        if (c == '`') {
            val end = text.indexOf('`', i + 1)
            if (end > i + 1) { flushPlain(); emit(text.substring(i + 1, end), code = true); i = end + 1; continue }
        }
        if (c == '[') {
            val close = text.indexOf("](", i + 1)
            val end = if (close > i) text.indexOf(')', close + 2) else -1
            if (close > i + 1 && end > close + 2) {
                val url = safeUrl(text.substring(close + 2, end).trim())
                if (url != null) { flushPlain(); emit(text.substring(i + 1, close), url = url); i = end + 1; continue }
            }
        }
        if (text.startsWith("**", i) && (bold || text.indexOf("**", i + 2) > i + 2)) { flushPlain(); bold = !bold; i += 2; continue }
        if ((c == '*' || c == '_') && !text.startsWith("**", i)) {
            val wordEdge = c == '*' || ((i == 0 || !text[i - 1].isLetterOrDigit()) || italic)
            if (wordEdge && (italic || (i + 1 < text.length && !text[i + 1].isWhitespace() && text.indexOf(c, i + 1) > i + 1))) {
                flushPlain(); italic = !italic; i += 1; continue
            }
        }
        plain.append(c); i++
    }
    flushPlain()
    return out
}

private fun emitPlainWithUrls(value: String, bold: Boolean, italic: Boolean, out: MutableList<MdSpan>) {
    var start = 0
    for (match in BARE_URL.findAll(value)) {
        var raw = match.value
        while (raw.isNotEmpty() && raw.last() in TRAILING) raw = raw.dropLast(1)
        val url = safeUrl(raw) ?: continue
        if (match.range.first > start) out += MdSpan(value.substring(start, match.range.first), bold, italic)
        out += MdSpan(shortUrl(url), bold, italic, url = url)
        start = match.range.first + raw.length
    }
    if (start < value.length) out += MdSpan(value.substring(start), bold, italic)
}

fun safeUrl(value: String): String? = runCatching {
    val uri = URI(value)
    if (uri.scheme?.lowercase() in setOf("http", "https") && !uri.host.isNullOrBlank()) value else null
}.getOrNull()

/** A readable label for a long URL: the host, plus the path when it is short. Board tickets get their own label. */
fun shortUrl(url: String): String {
    val uri = runCatching { URI(url) }.getOrNull() ?: return url
    val host = uri.host?.removePrefix("www.") ?: return url
    if (host == "board.blackoutburst.com" && uri.rawQuery?.contains("ticket=") == true) return "Board ticket ↗"
    val path = uri.rawPath.orEmpty().trimEnd('/')
    val full = host + path + (if (uri.rawQuery != null) "?…" else "")
    return if (full.length <= 40) full else "$host/…"
}
