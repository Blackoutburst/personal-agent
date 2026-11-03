package dev.blackoutburst.companion

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp

private class MdStyle(val color: Color, val link: Color, val codeBackground: Color, val fontSize: TextUnit, val lineHeight: TextUnit)

/** Renders parseMarkdown blocks. Links open in the browser through Compose's own LinkAnnotation handling. */
@Composable
fun MarkdownText(text: String, color: Color, link: Color, codeBackground: Color, fontSize: TextUnit, lineHeight: TextUnit) {
    val blocks = remember(text) { parseMarkdown(text) }
    MdBlocks(blocks, MdStyle(color, link, codeBackground, fontSize, lineHeight))
}

private fun annotated(spans: List<MdSpan>, style: MdStyle): AnnotatedString = buildAnnotatedString {
    val linkStyles = TextLinkStyles(SpanStyle(color = style.link, fontWeight = FontWeight.Medium, textDecoration = TextDecoration.Underline))
    for (span in spans) {
        val spanStyle = SpanStyle(fontWeight = if (span.bold) FontWeight.Bold else null,
            fontStyle = if (span.italic) FontStyle.Italic else null,
            fontFamily = if (span.code) FontFamily.Monospace else null,
            background = if (span.code) style.codeBackground else Color.Unspecified,
            textDecoration = if (span.strike) TextDecoration.LineThrough else null)
        if (span.url != null) withLink(LinkAnnotation.Url(span.url, linkStyles)) { withStyle(spanStyle) { append(span.text) } }
        else withStyle(spanStyle) { append(span.text) }
    }
}

@Composable
private fun MdBlocks(blocks: List<MdBlock>, style: MdStyle) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        for (block in blocks) when (block) {
            is MdBlock.Paragraph -> Text(annotated(block.spans, style), color = style.color, fontSize = style.fontSize, lineHeight = style.lineHeight)
            is MdBlock.Heading -> {
                val scale = when (block.level) { 1 -> 1.3f; 2 -> 1.18f; else -> 1.06f }
                Text(annotated(block.spans, style), Modifier.padding(top = 4.dp), color = style.color, fontWeight = FontWeight.Bold,
                    fontSize = style.fontSize * scale, lineHeight = style.lineHeight * scale)
            }
            is MdBlock.Bullet -> ListItem("•", block.level, annotated(block.spans, style), style)
            is MdBlock.Numbered -> ListItem(block.number, block.level, annotated(block.spans, style), style)
            is MdBlock.Quote -> Row(Modifier.height(IntrinsicSize.Min)) {
                Box(Modifier.width(3.dp).fillMaxHeight().clip(RoundedCornerShape(2.dp)).background(style.link.copy(alpha = 0.7f)))
                Box(Modifier.padding(start = 10.dp)) {
                    MdBlocks(block.blocks, MdStyle(style.color.copy(alpha = 0.8f), style.link, style.codeBackground, style.fontSize, style.lineHeight))
                }
            }
            is MdBlock.Code -> Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(style.codeBackground)
                .horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 10.dp)) {
                Text(block.text, color = style.color, fontFamily = FontFamily.Monospace, softWrap = false,
                    fontSize = style.fontSize * 0.82f, lineHeight = style.lineHeight * 0.82f)
            }
            is MdBlock.Table -> MdTable(block, style)
            MdBlock.Rule -> Box(Modifier.fillMaxWidth().padding(vertical = 6.dp).height(1.dp).background(style.color.copy(alpha = 0.25f)))
        }
    }
}

@Composable
private fun MdTable(table: MdBlock.Table, style: MdStyle) {
    val small = style.fontSize * 0.88f
    val line = style.color.copy(alpha = 0.2f)
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(style.codeBackground.copy(alpha = style.codeBackground.alpha * 0.6f))) {
        (listOf(table.header) + table.rows).forEachIndexed { index, row ->
            if (index > 0) Box(Modifier.fillMaxWidth().height(1.dp).background(line))
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (cell in row) Text(annotated(cell, style), Modifier.weight(1f), color = style.color, fontSize = small,
                    lineHeight = style.lineHeight * 0.88f, fontWeight = if (index == 0) FontWeight.Bold else null)
            }
        }
    }
}

@Composable
private fun ListItem(marker: String, level: Int, content: AnnotatedString, style: MdStyle) {
    Row(Modifier.padding(start = (level * 16).dp)) {
        Text(marker, Modifier.width(if (marker == "•") 16.dp else 26.dp), color = style.color, fontSize = style.fontSize, lineHeight = style.lineHeight)
        Text(content, color = style.color, fontSize = style.fontSize, lineHeight = style.lineHeight)
    }
}
