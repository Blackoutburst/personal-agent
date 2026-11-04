package dev.blackoutburst.companion

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import java.io.ByteArrayOutputStream
import java.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private suspend fun prepareOwnerPicture(context: Context, uri: Uri): OwnerPhoto = withContext(Dispatchers.IO) {
    val bytes = context.contentResolver.openInputStream(uri)?.use { it.readNBytes(10 * 1024 * 1024 + 1) }
        ?: throw IllegalArgumentException("That picture could not be read.")
    require(bytes.size <= 10 * 1024 * 1024) { "Choose a picture under 10 MB." }
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    require(bounds.outWidth in 1..32000 && bounds.outHeight in 1..32000) { "Choose a smaller, valid picture." }
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 1024) sample *= 2
    val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
        ?: throw IllegalArgumentException("That picture could not be read.")
    var scaled: Bitmap? = null
    try {
        val factor = minOf(1.0, 512.0 / maxOf(decoded.width, decoded.height))
        scaled = Bitmap.createScaledBitmap(decoded, maxOf(1, (decoded.width * factor).toInt()), maxOf(1, (decoded.height * factor).toInt()), true)
        for (quality in listOf(85, 65)) {
            val output = ByteArrayOutputStream()
            require(scaled.compress(Bitmap.CompressFormat.JPEG, quality, output)) { "That picture could not be prepared." }
            if (output.size() <= OWNER_PHOTO_LIMIT) return@withContext OwnerPhoto("image/jpeg", Base64.getEncoder().encodeToString(output.toByteArray()))
        }
        throw IllegalArgumentException("Choose a smaller picture.")
    } finally { if (scaled !== decoded) scaled?.recycle(); decoded.recycle() }
}

@Composable internal fun OwnerProfilePanel(model: CompanionModel, state: UiState) {
    val context = LocalContext.current
    val jobs = rememberCoroutineScope()
    var displayName by remember(state.scope) { mutableStateOf("") }
    var picture by remember(state.scope) { mutableStateOf<OwnerPhoto?>(null) }
    var changePhoto by remember(state.scope) { mutableStateOf(false) }
    var preparing by remember(state.scope) { mutableStateOf(false) }
    var pictureError by remember(state.scope) { mutableStateOf<String?>(null) }
    LaunchedEffect(state.scope) { model.loadOwnerProfile() }
    LaunchedEffect(state.ownerProfile, state.ownerProfileConfirmed) {
        if (state.ownerProfileConfirmed) {
            displayName = state.ownerProfile?.profile?.displayName.orEmpty()
            picture = state.ownerProfile?.photo; changePhoto = false; pictureError = null
        }
    }
    val busy = preparing || state.ownerProfileLoading || state.ownerProfileBusy
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null && !preparing && !state.ownerProfileBusy) jobs.launch {
            preparing = true; pictureError = null
            try { picture = prepareOwnerPicture(context, uri); changePhoto = true }
            catch (_: Exception) { pictureError = "That picture could not be prepared. Choose a JPEG, PNG or another photo under 10 MB." }
            finally { preparing = false }
        }
    }
    val preview = remember(picture) { runCatching {
        val p = picture ?: return@runCatching null
        val bytes = ownerPhotoBytes(p)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth !in 1..4096 || bounds.outHeight !in 1..4096) return@runCatching null
        var sample = 1; while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 512) sample *= 2
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
    }.getOrNull() }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("Your profile", style = MaterialTheme.typography.headlineMedium)
        Text("Your name and picture for shared conversations. Your companion keeps its own name and look.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (preview != null) Image(preview, "Your profile picture", Modifier.size(96.dp).clip(CircleShape), contentScale = ContentScale.Crop)
        else Box(Modifier.size(96.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceVariant), contentAlignment = Alignment.Center) { Text("You") }
        OutlinedTextField(displayName, { if (it.length <= 80) displayName = it }, Modifier.fillMaxWidth(), label = { Text("Your display name") },
            enabled = !busy && state.ownerProfile != null, singleLine = true)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ActionButton({ picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }, enabled = !busy && state.ownerProfile != null) { Text("Choose picture") }
            if (picture != null) TextButton({ picture = null; changePhoto = true }, enabled = !busy) { Text("Remove") }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ActionButton({ model.saveOwnerProfile(displayName, picture, changePhoto, state.scope) },
                enabled = !busy && state.ownerProfileConfirmed && ownerDisplayName(displayName.trim())) { Text(if (state.ownerProfileBusy) "Saving…" else "Save profile") }
            TextButton({ model.loadOwnerProfile() }, enabled = !busy) { Text("Reload profile") }
        }
        if (preparing) Text("Preparing your picture…")
        if (state.ownerProfileLoading) Text("Loading your profile…")
        state.ownerProfileError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        pictureError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        state.ownerProfileNotice?.let { Text(it) }
    }
}
