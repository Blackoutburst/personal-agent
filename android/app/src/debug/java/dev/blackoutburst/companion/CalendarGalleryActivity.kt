package dev.blackoutburst.companion

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.io.File
import java.time.LocalDate
import kotlinx.serialization.json.Json

/** Debug only: the month grid with a pushed sample view (no account, no network).
 *  adb push view.json /data/local/tmp/calendar.json; adb shell am start -n dev.blackoutburst.companion/.CalendarGalleryActivity [--ez light true] */
class CalendarGalleryActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val tones = if (intent.getBooleanExtra("light", false)) LightTones else DarkTones
        val view = Json { ignoreUnknownKeys = true }.decodeFromString<CalendarView>(File("/data/local/tmp/calendar.json").readText())
        setContent {
            val scheme = if (tones.dark) darkColorScheme(primary = tones.ink, background = tones.top, surface = tones.card, onSurface = tones.ink, onSurfaceVariant = tones.soft)
            else lightColorScheme(primary = tones.ink, background = tones.top, surface = tones.card, onSurface = tones.ink, onSurfaceVariant = tones.soft)
            var day by remember { mutableStateOf(view.today) }
            CompositionLocalProvider(LocalTones provides tones) { MaterialTheme(colorScheme = scheme) {
                Column(Modifier.fillMaxSize().background(tones.bottom).statusBarsPadding().verticalScroll(rememberScrollState()).padding(horizontal = 10.dp)) {
                    Text("November 2026", Modifier.padding(6.dp, 16.dp), fontSize = 24.sp, fontWeight = FontWeight.ExtraBold, color = tones.ink)
                    MonthGrid(view, view.today.take(7), day, onDay = { day = it.toString() }, onItem = {}, onSwipe = {})
                    DayPanel(view, LocalDate.parse(day), false, {}) {}
                }
            } }
        }
    }
}
