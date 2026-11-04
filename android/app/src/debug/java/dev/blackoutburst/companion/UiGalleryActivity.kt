package dev.blackoutburst.companion

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.os.Bundle
import android.provider.OpenableColumns
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import java.io.File

/** adb shell am start -n dev.blackoutburst.companion/.UiGalleryActivity [--ez light true] */
class UiGalleryActivity : ComponentActivity() {
    private val model: CompanionModel by viewModels()
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val tones = if (intent.getBooleanExtra("light", false)) LightTones else DarkTones
        val sample = File(cacheDir, "gallery-sample.png").apply {
            val bitmap = Bitmap.createBitmap(320, 240, Bitmap.Config.ARGB_8888)
            Canvas(bitmap).apply { drawColor(0xFF7FB3D5.toInt()); drawCircle(160f, 120f, 70f, Paint().apply { color = 0xFFEE8F64.toInt() }) }
            outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
        val reply = "I posted it as **#35**, with your screenshot attached: https://board.blackoutburst.com/?project=f0ad83b792830c7cd190412ee8f48997&ticket=21b96420a756e7d3a8afbe1ee598cf1a\n\n" +
            "Three Android UI tickets are open now, all in *Todo*:\n- **#33** the + button (low priority)\n- **#34** the preview before you send a file\n- **#35** files once they're in a message\n\n" +
            "1. Try `adb logcat`\n2. Or see [the Board](https://board.blackoutburst.com/)" +
            "\n\n# Heading 1\n## Heading 2\n### Heading 3\nSome ~~strikethrough~~ text.\n\n> A quote with **bold**\n> and a second line\n\n" +
            "```js\nconst s = `hi ${'$'}{name}`;\nconsole.log(s) // a long line that should scroll sideways\n```\n\n" +
            "| Ticket | State |\n|---|---|\n| #33 | done |\n| #36 | review |\n\n---\nAfter the rule."
        val file = Attachment("a1", "Screenshot_20261103_101413_very_long_file_name.jpg.pdf", "application/pdf", 315_631, "0".repeat(64), "user", "/x")
        setContent {
            val scheme = if (tones.dark) darkColorScheme(primary = tones.ink, background = tones.top, surface = tones.card, onSurface = tones.ink, onSurfaceVariant = tones.soft)
            else lightColorScheme(primary = tones.ink, background = tones.top, surface = tones.card, onSurface = tones.ink, onSurfaceVariant = tones.soft)
            CompositionLocalProvider(LocalTones provides tones) { MaterialTheme(colorScheme = scheme) {
                Column(Modifier.fillMaxSize().background(tones.top).statusBarsPadding().verticalScroll(rememberScrollState()).padding(vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    // The + menu, testable without signing in: what was picked shows next to it.
                    var picked by remember { mutableStateOf("Nothing picked") }
                    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                        AttachMenu(enabled = true, onLaunch = {}, onProblem = { picked = it }, onPicked = { uris ->
                            picked = uris.joinToString("\n") { uri ->
                                contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                                    if (c.moveToFirst()) "${c.getString(0)} · ${c.getLong(1)} B · ${contentResolver.getType(uri)}" else "?"
                                } ?: "?"
                            }
                        })
                        Spacer(Modifier.size(8.dp))
                        Text(picked, color = tones.ink)
                    }
                    Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Bubble(model, Message("m1", "t", "user", "Can you **file** this as a bugfix?", attachments = listOf(file)), 0)
                        Bubble(model, Message("m2", "t", "assistant", reply), 0)
                    }
                    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        UploadCard(model, PendingUpload("k1", "t", "Screenshot_20261103_085039.jpg", local = sample, total = 104_734, state = "ready"), false, Modifier.width(180.dp))
                        UploadCard(model, PendingUpload("k2", "t", "notes.txt", total = 2048, progress = 900, state = "uploading"), false, Modifier.width(180.dp))
                    }
                    UploadCard(model, PendingUpload("k3", "t", "big-video.mp4", total = 99_000_000, state = "error", error = "The file exceeds the size limit."), false,
                        Modifier.padding(horizontal = 12.dp).width(260.dp))
                    Row(Modifier.fillMaxWidth().padding(12.dp, 6.dp), verticalAlignment = Alignment.Bottom) {
                        RoundButton("Attach files", "+") {}
                        Spacer(Modifier.size(8.dp))
                        OutlinedTextField("", {}, Modifier.weight(1f), placeholder = { Text("Write a message…") }, shape = RoundedCornerShape(24.dp))
                        Spacer(Modifier.size(8.dp))
                        RoundButton("Send", "↑") {}
                    }
                }
            } }
        }
    }
}
