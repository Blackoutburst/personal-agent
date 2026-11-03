package dev.blackoutburst.companion

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** The owner's city (src/weather.mjs): during the day the outfit follows the real weather. */
@Composable
fun WeatherPanel(model: CompanionModel, state: UiState) {
    val ink = MaterialTheme.colorScheme.onSurface
    val soft = MaterialTheme.colorScheme.onSurfaceVariant
    LaunchedEffect(state.scope) { model.loadWeather() }
    var city by remember(state.weather?.place) { mutableStateOf(state.weather?.place ?: "") }
    Column(Modifier.fillMaxWidth()) {
        Text("Weather", fontSize = 20.sp, fontWeight = FontWeight.Bold, color = ink)
        Text("Your city lets the outfit follow the real weather during the day, and your companion knows what it is like outside. " +
            "Only the city and its coordinates are sent to Open-Meteo.", color = soft)
        Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(city, { if (it.length <= 100) city = it }, Modifier.weight(1f), singleLine = true,
                label = { Text("City") }, enabled = !state.weatherBusy,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { model.saveWeather(city) }))
            ActionButton(enabled = !state.weatherBusy, onClick = { model.saveWeather(city) }) { Text(if (state.weatherBusy) "Saving…" else "Save") }
        }
        val weather = state.weather
        Text(when {
            weather?.place == null -> "No city set. The outfit follows the seasons only."
            weather.current != null -> "Now in ${weather.place}: ${weather.current.summary}."
            else -> "Saved: ${weather.place}. The weather will show up shortly."
        }, color = soft, fontSize = 13.sp, modifier = Modifier.padding(top = 4.dp))
        state.weatherError?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }
    }
}
