package dev.blackoutburst.companion

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
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

/** Renders parseMarkdown blocks. Links open in the browser through Compose's own LinkAnnotation handling. */
@Composable
fun MarkdownText(text: String, color: Color, link: Color, codeBackground: Color, fontSize: TextUnit, lineHeight: TextUnit) {
    val blocks = remember(text) { parseMarkdown(text) }
    val linkStyles = TextLinkStyles(SpanStyle(color = link, textDecoration = TextDecoration.Underline))
    fun annotated(spans: List<MdSpan>): AnnotatedString = buildAnnotatedString {
        for (span in spans) {
            val style = SpanStyle(fontWeight = if (span.bold) FontWeight.Bold else null,
                fontStyle = if (span.italic) FontStyle.Italic else null,
                fontFamily = if (span.code) FontFamily.Monospace else null,
                background = if (span.code) codeBackground else Color.Unspecified)
            if (span.url != null) withLink(LinkAnnotation.Url(span.url, linkStyles)) { withStyle(style) { append(span.text) } }
            else withStyle(style) { append(span.text) }
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        for (block in blocks) when (block) {
            is MdBlock.Paragraph -> Text(annotated(block.spans), color = color, fontSize = fontSize, lineHeight = lineHeight)
            is MdBlock.Bullet -> ListItem("•", block.level, annotated(block.spans), color, fontSize, lineHeight)
            is MdBlock.Numbered -> ListItem(block.number, block.level, annotated(block.spans), color, fontSize, lineHeight)
        }
    }
}

@Composable
private fun ListItem(marker: String, level: Int, content: AnnotatedString, color: Color, fontSize: TextUnit, lineHeight: TextUnit) {
    Row(Modifier.padding(start = (level * 16).dp)) {
        Text(marker, Modifier.width(if (marker == "•") 16.dp else 26.dp), color = color, fontSize = fontSize, lineHeight = lineHeight)
        Text(content, color = color, fontSize = fontSize, lineHeight = lineHeight)
    }
}
