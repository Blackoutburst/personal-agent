package dev.blackoutburst.companion

import java.net.URI

// A safe subset of markdown for chat bubbles (#36). Blocks: paragraphs, # headings, dash or star bullets, numbered items,
// > quotes, fenced code, pipe tables and --- rules. Inline: bold (double stars), italic (single star or underscore),
// strikethrough (double tilde), inline code, [text](url) links and bare http(s) URLs.
// Anything else stays plain text. Only http and https links are ever made clickable.
sealed interface MdBlock {
    data class Paragraph(val spans: List<MdSpan>) : MdBlock
    data class Heading(val level: Int, val spans: List<MdSpan>) : MdBlock
    data class Bullet(val spans: List<MdSpan>, val level: Int) : MdBlock
    data class Numbered(val number: String, val spans: List<MdSpan>, val level: Int) : MdBlock
    data class Quote(val blocks: List<MdBlock>) : MdBlock
    data class Code(val text: String) : MdBlock
    data class Table(val header: List<List<MdSpan>>, val rows: List<List<List<MdSpan>>>) : MdBlock
    data object Rule : MdBlock
}

data class MdSpan(val text: String, val bold: Boolean = false, val italic: Boolean = false,
    val code: Boolean = false, val url: String? = null, val strike: Boolean = false)

private val BULLET = Regex("""^(\s*)[-*+•]\s+(.*)$""")
private val NUMBERED = Regex("""^(\s*)(\d{1,3})[.)]\s+(.*)$""")
private val HEADING = Regex("""^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$""")
private val RULE = Regex("""^\s{0,3}([-*_])(?:\s*\1){2,}\s*$""")
private val QUOTE = Regex("""^\s{0,3}>\s?(.*)$""")
private val FENCE = Regex("""^\s{0,3}(`{3,}|~{3,})\s*([^`\s]*)\s*$""")
private val TABLE_SEPARATOR = Regex("""^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$""")
private val BARE_URL = Regex("""https?://[^\s<>()\[\]]+""")
private const val TRAILING = ".,;:!?'\""
private const val MAX_DEPTH = 4

fun parseMarkdown(text: String): List<MdBlock> = blocks(text.replace("\r\n", "\n").split('\n'), 0)

private fun blocks(lines: List<String>, depth: Int): List<MdBlock> {
    val out = mutableListOf<MdBlock>()
    val paragraph = mutableListOf<String>()
    fun flush() {
        if (paragraph.isNotEmpty()) { out += MdBlock.Paragraph(inline(paragraph.joinToString("\n"))); paragraph.clear() }
    }
    var i = 0
    while (i < lines.size) {
        val line = lines[i]
        val fence = FENCE.matchEntire(line)
        if (fence != null) {
            // Everything up to the matching fence (or the end of the message) is shown verbatim.
            flush()
            val marker = fence.groupValues[1]
            val body = mutableListOf<String>()
            i++
            while (i < lines.size && !lines[i].trim().let { it.length >= marker.length && it.all { c -> c == marker[0] } }) body += lines[i++]
            out += MdBlock.Code(body.joinToString("\n").trimEnd('\n'))
            i++
            continue
        }
        if (depth < MAX_DEPTH && QUOTE.matches(line)) {
            flush()
            val quoted = mutableListOf<String>()
            while (i < lines.size) { val match = QUOTE.matchEntire(lines[i]) ?: break; quoted += match.groupValues[1]; i++ }
            out += MdBlock.Quote(blocks(quoted, depth + 1))
            continue
        }
        if ('|' in line && i + 1 < lines.size && '-' in lines[i + 1] && TABLE_SEPARATOR.matches(lines[i + 1]) &&
            ('|' in lines[i + 1] || line.trim().startsWith('|'))) {
            flush()
            val header = cells(line)
            val rows = mutableListOf<List<List<MdSpan>>>()
            i += 2
            while (i < lines.size && '|' in lines[i] && lines[i].isNotBlank()) {
                val row = cells(lines[i++])
                rows += List(header.size) { row.getOrElse(it) { emptyList() } }
            }
            out += MdBlock.Table(header, rows)
            continue
        }
        val heading = HEADING.matchEntire(line)
        val bullet = BULLET.matchEntire(line)
        val numbered = NUMBERED.matchEntire(line)
        when {
            RULE.matches(line) -> { flush(); out += MdBlock.Rule }
            heading != null -> { flush(); out += MdBlock.Heading(heading.groupValues[1].length, inline(heading.groupValues[2])) }
            bullet != null -> { flush(); out += MdBlock.Bullet(inline(bullet.groupValues[2]), level(bullet.groupValues[1])) }
            numbered != null -> { flush(); out += MdBlock.Numbered(numbered.groupValues[2] + ".", inline(numbered.groupValues[3]), level(numbered.groupValues[1])) }
            line.isBlank() -> flush()
            else -> paragraph += line
        }
        i++
    }
    flush()
    return out
}

private fun cells(line: String): List<List<MdSpan>> {
    var row = line.trim()
    if (row.startsWith('|')) row = row.drop(1)
    if (row.endsWith('|') && !row.endsWith("\\|")) row = row.dropLast(1)
    val parts = mutableListOf<String>()
    val cell = StringBuilder()
    var i = 0
    while (i < row.length) {
        when {
            row[i] == '\\' && i + 1 < row.length && row[i + 1] == '|' -> { cell.append('|'); i += 2; continue }
            row[i] == '|' -> { parts += cell.toString(); cell.clear() }
            else -> cell.append(row[i])
        }
        i++
    }
    parts += cell.toString()
    return parts.map { inline(it.trim()) }
}

private fun level(indent: String) = (indent.replace("\t", "  ").length / 2).coerceAtMost(3)

/** Inline spans. Unclosed markers stay as literal text, so odd input never disappears. */
fun inline(text: String): List<MdSpan> {
    val out = mutableListOf<MdSpan>()
    val plain = StringBuilder()
    var bold = false; var italic = false; var strike = false
    fun emit(value: String, code: Boolean = false, url: String? = null) {
        if (value.isEmpty()) return
        out += MdSpan(value, bold, italic, code, url, strike)
    }
    fun flushPlain() { emitPlainWithUrls(plain.toString(), bold, italic, strike, out); plain.clear() }
    var i = 0
    while (i < text.length) {
        val c = text[i]
        if (c == '`') {
            // A run of N backticks closes at the next run of exactly N, so `` a ` b `` keeps its inner backtick.
            var n = 0
            while (i + n < text.length && text[i + n] == '`') n++
            val end = closingRun(text, i + n, n)
            if (end > i + n) {
                var code = text.substring(i + n, end)
                if (code.length >= 2 && code.startsWith(' ') && code.endsWith(' ') && code.isNotBlank()) code = code.substring(1, code.length - 1)
                flushPlain(); emit(code, code = true); i = end + n; continue
            }
            plain.append(text, i, i + n); i += n; continue
        }
        if (c == '[') {
            val close = text.indexOf("](", i + 1)
            val end = if (close > i) text.indexOf(')', close + 2) else -1
            if (close > i + 1 && end > close + 2) {
                val url = safeUrl(text.substring(close + 2, end).trim())
                if (url != null) {
                    flushPlain()
                    // The label keeps its own emphasis, e.g. [**#35** attachments](url).
                    for (span in inline(text.substring(i + 1, close))) out += span.copy(url = url,
                        bold = span.bold || bold, italic = span.italic || italic, strike = span.strike || strike)
                    i = end + 1; continue
                }
            }
        }
        if (text.startsWith("~~", i) && (strike || text.indexOf("~~", i + 2) > i + 2)) { flushPlain(); strike = !strike; i += 2; continue }
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

private fun closingRun(text: String, from: Int, n: Int): Int {
    var j = from
    while (j < text.length) {
        if (text[j] != '`') { j++; continue }
        var run = 0
        while (j + run < text.length && text[j + run] == '`') run++
        if (run == n) return j
        j += run
    }
    return -1
}

private fun emitPlainWithUrls(value: String, bold: Boolean, italic: Boolean, strike: Boolean, out: MutableList<MdSpan>) {
    var start = 0
    for (match in BARE_URL.findAll(value)) {
        var raw = match.value
        while (raw.isNotEmpty() && raw.last() in TRAILING) raw = raw.dropLast(1)
        val url = safeUrl(raw) ?: continue
        if (match.range.first > start) out += MdSpan(value.substring(start, match.range.first), bold, italic, strike = strike)
        out += MdSpan(shortUrl(url), bold, italic, url = url, strike = strike)
        start = match.range.first + raw.length
    }
    if (start < value.length) out += MdSpan(value.substring(start), bold, italic, strike = strike)
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
