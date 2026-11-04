package dev.blackoutburst.companion

/**
 * Splits a companion reply into chat bubbles, like several short texts instead of one long one.
 * Same rule as public/bubbles.mjs: a blank line starts a new bubble; a code block, or a list or table
 * that runs on across blank lines, stays together; past [max] bubbles the rest stays in the last one.
 */
private val LISTY = Regex("""^\s*(?:[-*+•]\s|\d{1,3}[.)]\s|\|)""")
private val FENCE = Regex("""^\s*```""")

fun splitBubbles(text: String, max: Int = 8): List<String> {
    val parts = mutableListOf<String>()
    val current = mutableListOf<String>()
    var fenced = false
    fun flush() {
        val chunk = current.joinToString("\n").trim(); current.clear()
        if (chunk.isEmpty()) return
        val previous = parts.lastOrNull()
        if (previous != null && LISTY.containsMatchIn(chunk) && LISTY.containsMatchIn(previous.lines().last())) parts[parts.size - 1] = previous + "\n\n" + chunk
        else parts.add(chunk)
    }
    for (line in text.replace("\r\n", "\n").replace('\r', '\n').split('\n')) {
        if (FENCE.containsMatchIn(line)) fenced = !fenced
        if (!fenced && line.isBlank()) flush() else current.add(line)
    }
    flush()
    if (parts.size > max) {
        val rest = parts.subList(max - 1, parts.size).joinToString("\n\n")
        while (parts.size > max - 1) parts.removeAt(parts.size - 1)
        parts.add(rest)
    }
    return parts
}
