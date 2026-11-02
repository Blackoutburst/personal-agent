package dev.blackoutburst.companion

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.dp
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics

// The same characters as the web app (public/companion-character.mjs), in a 200×200 box.

data class Palette(val body: Color, val shade: Color, val light: Color, val cheek: Color)

data class CharacterInfo(val id: String, val label: String, val hint: String)

val CHARACTERS = listOf(
    CharacterInfo("pip", "Pip", "a round little blob"),
    CharacterInfo("mochi", "Mochi", "a soft cat"),
    CharacterInfo("sprout", "Sprout", "a tiny plant spirit"),
    CharacterInfo("luna", "Luna", "a friendly ghost"),
    CharacterInfo("claude", "Claude", "a cheerful anime girl"),
)

val COLORS = linkedMapOf(
    "peach" to Palette(Color(0xFFFFB38A), Color(0xFFEE8F64), Color(0xFFFFDCC8), Color(0xFFFF7E7E)),
    "mint" to Palette(Color(0xFF8EDCB8), Color(0xFF5CC291), Color(0xFFD2F5E5), Color(0xFFFF8E9A)),
    "sky" to Palette(Color(0xFF93CBF6), Color(0xFF5EAAE6), Color(0xFFD3EAFC), Color(0xFFFF92AE)),
    "lilac" to Palette(Color(0xFFC7ABF4), Color(0xFFA07FE0), Color(0xFFE9DDFC), Color(0xFFFF8FBF)),
    "sun" to Palette(Color(0xFFFFD772), Color(0xFFF1B83A), Color(0xFFFFF0C2), Color(0xFFFF9472)),
    "rose" to Palette(Color(0xFFF8A6C4), Color(0xFFE87BA3), Color(0xFFFDD8E6), Color(0xFFFF6F96)),
)

enum class Mood { Idle, Listening, Thinking, Talking, Happy, Sleepy }

private val INK = Color(0xFF3A2E39)
private val WHITE = Color.White
private val LEAF_STEM = Color(0xFF5AAE62)

private val pathCache = HashMap<String, Path>()
private fun svg(d: String): Path = pathCache.getOrPut(d) { PathParser().parsePathString(d).toPath() }

private class Body(val face: Float, val shadow: Float, val draw: DrawScope.(Palette) -> Unit)

private fun DrawScope.ellipse(cx: Float, cy: Float, rx: Float, ry: Float, color: Color, alpha: Float = 1f, rotation: Float = 0f) {
    rotate(rotation, Offset(cx, cy)) { drawOval(color, Offset(cx - rx, cy - ry), Size(rx * 2, ry * 2), alpha) }
}
private fun DrawScope.fill(d: String, color: Color, alpha: Float = 1f) = drawPath(svg(d), color, alpha)
private fun DrawScope.line(d: String, color: Color, width: Float) =
    drawPath(svg(d), color, style = Stroke(width, cap = StrokeCap.Round, join = StrokeJoin.Round))

private val BODIES = mapOf(
    "pip" to Body(106f, 52f) { c ->
        line("M100 40 C 98 30 102 22 110 16", c.shade, 4.5f)
        drawCircle(c.shade, 7.5f, Offset(111f, 14f))
        ellipse(78f, 176f, 15f, 7.5f, c.shade); ellipse(122f, 176f, 15f, 7.5f, c.shade)
        ellipse(35f, 128f, 9f, 14f, c.shade, rotation = 18f); ellipse(165f, 128f, 9f, 14f, c.shade, rotation = -18f)
        fill("M100 40 C 148 40 168 80 166 118 C 164 158 136 176 100 176 C 64 176 36 158 34 118 C 32 80 52 40 100 40 Z", c.body)
        ellipse(100f, 146f, 36f, 22f, c.light, .7f)
        ellipse(72f, 66f, 14f, 8f, WHITE, .35f, -25f)
    },
    "mochi" to Body(106f, 54f) { c ->
        line("M150 160 C 186 160 194 124 176 106", c.shade, 13f)
        ellipse(78f, 177f, 15f, 7f, c.shade); ellipse(122f, 177f, 15f, 7f, c.shade)
        val head = "M54 72 L 46 30 L 84 52 Q 100 47 116 52 L 154 30 L 146 72 Q 170 100 164 138 Q 156 178 100 178 Q 44 178 36 138 Q 30 100 54 72 Z"
        fill(head, c.body); line(head, c.body, 6f)
        fill("M58 62 L 54 40 L 76 54 Z", c.cheek, .45f); fill("M142 62 L 146 40 L 124 54 Z", c.cheek, .45f)
        ellipse(100f, 150f, 34f, 20f, c.light, .75f)
        for (d in listOf("M54 116 L 32 110", "M54 123 L 32 127", "M146 116 L 168 110", "M146 123 L 168 127")) line(d, c.shade, 2.5f)
        ellipse(100f, 116f, 4f, 3f, c.cheek)
    },
    "sprout" to Body(120f, 52f) { c ->
        line("M100 56 C 100 46 100 40 101 30", LEAF_STEM, 4.5f)
        fill("M100 38 C 84 22 64 26 60 36 C 74 46 90 46 100 38 Z", Color(0xFF7BC67E))
        fill("M101 33 C 116 12 142 14 147 27 C 133 41 114 41 101 33 Z", Color(0xFF8FD48F))
        ellipse(78f, 178f, 15f, 7f, c.shade); ellipse(122f, 178f, 15f, 7f, c.shade)
        fill("M100 52 C 140 52 168 92 166 128 C 164 162 136 178 100 178 C 64 178 36 162 34 128 C 32 92 60 52 100 52 Z", c.body)
        ellipse(100f, 155f, 34f, 17f, c.light, .7f)
        ellipse(70f, 80f, 12f, 7f, WHITE, .35f, -35f)
    },
    "luna" to Body(102f, 40f) { c ->
        ellipse(33f, 118f, 9f, 15f, c.shade, rotation = 25f); ellipse(167f, 118f, 9f, 15f, c.shade, rotation = -25f)
        fill("M100 38 C 146 38 166 74 166 112 L 166 158 Q 155 176 144 160 Q 133 176 122 160 Q 111 176 100 160 Q 89 176 78 160 Q 67 176 56 160 Q 45 176 34 158 L 34 112 C 34 74 54 38 100 38 Z", c.body)
        ellipse(100f, 138f, 34f, 18f, c.light, .6f)
        fill("M66 52 L 69 60 L 77 63 L 69 66 L 66 74 L 63 66 L 55 63 L 63 60 Z", WHITE, .8f)
    },
)

private fun DrawScope.eyes(y: Float, mood: Mood, blink: Float) {
    for (x in listOf(78f, 122f)) when (mood) {
        Mood.Happy -> line("M${x - 8} ${y + 3} Q $x ${y - 9} ${x + 8} ${y + 3}", INK, 4f)
        Mood.Sleepy -> line("M${x - 8} $y Q $x ${y + 7} ${x + 8} $y", INK, 4f)
        else -> {
            val dy = when (mood) { Mood.Thinking -> -3f; Mood.Listening -> 3f; else -> 0f }
            val dx = if (mood == Mood.Thinking) 3f else 0f
            scale(1f, blink, Offset(x, y)) {
                ellipse(x, y, 8.5f, 10.5f, INK)
                drawCircle(WHITE, 3.2f, Offset(x + 2.8f + dx, y - 3.8f + dy))
                drawCircle(WHITE, 1.4f, Offset(x - 2.5f + dx, y + 3.5f + dy), alpha = .7f)
            }
        }
    }
}

private fun DrawScope.mouth(y: Float, mood: Mood, talk: Float) {
    when (mood) {
        Mood.Happy -> { fill("M88 ${y + 12} Q 100 ${y + 30} 112 ${y + 12} Z", INK); ellipse(100f, y + 21, 5f, 3f, Color(0xFFFF8C9B)) }
        Mood.Talking -> ellipse(100f, y + 18, 7f, 6f * talk, INK)
        Mood.Thinking -> ellipse(106f, y + 18, 4f, 3f, INK)
        Mood.Sleepy -> ellipse(100f, y + 17, 3.5f, 2.5f, INK)
        else -> line("M91 ${y + 14} Q 100 ${y + 22} 109 ${y + 14}", INK, 3.5f)
    }
}

private fun DrawScope.extras(mood: Mood, c: Palette, pulse: Float) {
    if (mood == Mood.Thinking) {
        listOf(Triple(150f, 44f, 5f), Triple(166f, 34f, 6.5f), Triple(184f, 20f, 8f)).forEachIndexed { i, (x, y, r) ->
            val a = ((pulse * 3 - i).coerceIn(0f, 1f)).let { if (it == 0f) .25f else .25f + .75f * it }
            drawCircle(c.shade, r, Offset(x, y), alpha = a)
        }
    }
    if (mood == Mood.Sleepy) {
        val paint = android.graphics.Paint().apply {
            color = android.graphics.Color.argb(255, (c.shade.red * 255).toInt(), (c.shade.green * 255).toInt(), (c.shade.blue * 255).toInt())
            isAntiAlias = true
            typeface = android.graphics.Typeface.create(android.graphics.Typeface.DEFAULT, 800, false)
        }
        drawContext.canvas.nativeCanvas.apply {
            paint.textSize = 18f; drawText("z", 148f, 50f - pulse * 4, paint)
            paint.textSize = 24f; drawText("z", 162f, 34f - pulse * 4, paint)
        }
    }
}

/** Illustrated characters: one picture per expression (res/drawable-nodpi/<id>_<frame>.webp). */
private val PORTRAITS = mapOf(
    "claude" to mapOf(
        "idle" to R.drawable.claude_idle, "blink" to R.drawable.claude_blink, "talk" to R.drawable.claude_talk,
        "listening" to R.drawable.claude_listening, "thinking" to R.drawable.claude_thinking,
        "happy" to R.drawable.claude_happy, "sleepy" to R.drawable.claude_sleepy,
    ),
)

@Composable
private fun Portrait(frames: Map<String, Int>, mood: Mood, modifier: Modifier, label: String, still: Boolean) {
    val motion = rememberInfiniteTransition(label = "portrait")
    val breath by motion.animateFloat(0f, 1f, infiniteRepeatable(tween(2000), RepeatMode.Reverse), label = "breath")
    // 1 while the overlay picture shows: a short blink every 5 s, or the open mouth every other 250 ms.
    val blink by motion.animateFloat(0f, 0f, infiniteRepeatable(keyframes {
        durationMillis = 5000; 0f at 4690; 1f at 4700; 1f at 4850; 0f at 4860
    }), label = "blink")
    val talk by motion.animateFloat(0f, 1f, infiniteRepeatable(keyframes {
        durationMillis = 500; 0f at 249; 1f at 250; 1f at 499
    }), label = "talk")
    val base = when (mood) {
        Mood.Listening -> "listening"; Mood.Thinking -> "thinking"; Mood.Happy -> "happy"; Mood.Sleepy -> "sleepy"
        else -> "idle"
    }
    val overlay = when {
        still -> null
        mood == Mood.Talking && talk >= .5f -> "talk"
        mood == Mood.Idle && blink >= .5f -> "blink"
        else -> null
    }
    androidx.compose.foundation.layout.Box(modifier.semantics { if (label.isNotEmpty()) contentDescription = label }) {
        val lift = if (still) 0f else breath
        androidx.compose.foundation.Image(
            androidx.compose.ui.res.painterResource(frames.getValue(overlay ?: base)), null,
            Modifier.matchParentSize().graphicsLayer {
                translationY = -lift * 2.dp.toPx()
                scaleX = 1f + lift * .006f; scaleY = scaleX
                transformOrigin = androidx.compose.ui.graphics.TransformOrigin(.5f, 1f)
            },
        )
    }
}

/** The companion, gently alive: it breathes, blinks, talks and thinks. */
@Composable
fun CompanionCharacter(character: String, color: String, mood: Mood, modifier: Modifier = Modifier, label: String = "", still: Boolean = false) {
    PORTRAITS[character]?.let { return Portrait(it, mood, modifier, label, still) }
    val body = BODIES[character] ?: BODIES.getValue("pip")
    val palette = COLORS[color] ?: COLORS.getValue("peach")
    val motion = rememberInfiniteTransition(label = "character")
    val bob by motion.animateFloat(0f, 1f, infiniteRepeatable(tween(if (mood == Mood.Sleepy) 3400 else 2400), RepeatMode.Reverse), label = "bob")
    val blink by motion.animateFloat(1f, 1f, infiniteRepeatable(keyframes {
        durationMillis = 4200; 1f at 3900; 0.1f at 4000; 1f at 4100
    }), label = "blink")
    val talk by motion.animateFloat(0.35f, 1f, infiniteRepeatable(tween(220, easing = LinearEasing), RepeatMode.Reverse), label = "talk")
    val pulse by motion.animateFloat(0f, 1f, infiniteRepeatable(tween(1400, easing = LinearEasing)), label = "pulse")
    val moving = !still
    Canvas(modifier.semantics { if (label.isNotEmpty()) contentDescription = label }) {
        val unit = size.minDimension / 200f
        translate((size.width - 200f * unit) / 2, (size.height - 200f * unit) / 2) {
            scale(unit, unit, Offset.Zero) {
                val lift = if (moving) bob * if (mood == Mood.Happy) 6f else 3f else 0f
                drawOval(Color.Black, Offset(100f - body.shadow + lift, 181f), Size((body.shadow - lift) * 2, 14f), .08f)
                translate(0f, -lift) {
                    body.draw(this, palette)
                    ellipse(62f, body.face + 15, 10f, 6f, palette.cheek, .55f)
                    ellipse(138f, body.face + 15, 10f, 6f, palette.cheek, .55f)
                    eyes(body.face, mood, if (moving) blink else 1f)
                    mouth(body.face, mood, if (moving) talk else 1f)
                }
                extras(mood, palette, if (moving) pulse else 1f)
            }
        }
    }
}
