package dev.blackoutburst.companion

import android.graphics.ImageDecoder
import android.graphics.drawable.AnimatedImageDrawable
import android.graphics.drawable.Drawable
import android.media.MediaPlayer
import android.widget.ImageView
import android.widget.MediaController
import android.widget.VideoView
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.max
import kotlin.math.roundToInt

/** Network is owned by the authenticated API. Native decoders/players only see verified private files. */
@Composable
fun AttachmentView(model: CompanionModel, file: Attachment, scope: Long) {
    if (file.voice != null) { VoiceMessageView(model, file, scope); return }
    val tones = LocalTones.current
    val image = file.mime in IMAGE_TYPES
    val playable = file.mime in VIDEO_TYPES || file.mime in AUDIO_TYPES
    var requested by remember(scope, file.id) { mutableStateOf(image) }
    var attempt by remember(scope, file.id) { mutableIntStateOf(0) }
    var local by remember(scope, file.id) { mutableStateOf<File?>(null) }
    var drawable by remember(scope, file.id) { mutableStateOf<Drawable?>(null) }
    var progress by remember(scope, file.id) { mutableLongStateOf(0) }
    var error by remember(scope, file.id) { mutableStateOf<String?>(null) }
    var loading by remember(scope, file.id) { mutableStateOf(false) }
    var fullScreen by remember(scope, file.id) { mutableStateOf(false) }
    val save = rememberAttachmentSave(model, file, scope)
    val cancellation = remember(scope, file.id, attempt) { TransferCancellation() }
    DisposableEffect(cancellation) { onDispose { cancellation.cancel() } }
    LaunchedEffect(scope, file.id, requested, attempt) {
        if (!requested) return@LaunchedEffect
        loading = true; error = null
        try {
            val downloaded = model.mediaFile(file, scope, cancellation) { progress = it }
            if (image) drawable = withContext(Dispatchers.IO) { decodeImage(downloaded, 1024) }
            local = downloaded
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) { error = fileProblem((failure as? ApiException)?.code ?: "PREVIEW_UNAVAILABLE") }
        finally { loading = false }
    }
    DisposableEffect(drawable) { onDispose { (drawable as? AnimatedImageDrawable)?.stop() } }
    val shape = RoundedCornerShape(14.dp)
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        val shown = drawable
        if (image && shown != null) {
            // Images fill the bubble width at their own shape: tap opens full size, long-press saves.
            val ratio = (shown.intrinsicWidth.toFloat() / shown.intrinsicHeight.coerceAtLeast(1)).takeIf { it.isFinite() && it > 0f } ?: 1.33f
            AndroidView(
                factory = { context -> ImageView(context).apply {
                    scaleType = ImageView.ScaleType.CENTER_CROP; contentDescription = "${file.name}. Tap to open, long-press to save"
                    setOnClickListener { fullScreen = true }
                    setOnLongClickListener { save.launch(); true }
                } },
                modifier = Modifier.fillMaxWidth().aspectRatio(ratio.coerceIn(0.6f, 1.8f)).clip(shape),
                update = { view -> if (view.drawable !== shown) view.setImageDrawable(shown); (shown as? AnimatedImageDrawable)?.start() })
        } else if (image && error == null) {
            Box(Modifier.fillMaxWidth().aspectRatio(1.33f).clip(shape).background(tones.ink.copy(alpha = 0.06f)), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(progress = { if (file.size == 0L) 0f else (progress.toFloat() / file.size).coerceIn(0f, 1f) },
                    modifier = Modifier.size(28.dp), color = tones.soft, strokeWidth = 3.dp)
            }
        }
        if (local != null && file.mime in VIDEO_TYPES) VideoAttachment(local!!, file.name)
        else if (local != null && file.mime in AUDIO_TYPES) AudioAttachment(local!!)
        else if (playable && !requested) ActionButton(onClick = { requested = true }) {
            Text("Load ${if (file.mime in VIDEO_TYPES) "video" else "audio"} (${fileSize(file.size)})")
        }
        if (playable && loading) LinearProgressIndicator(progress = { if (file.size == 0L) 0f else (progress.toFloat() / file.size).coerceIn(0f, 1f) },
            modifier = Modifier.fillMaxWidth())
        error?.let { problem ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(problem, Modifier.weight(1f), color = tones.danger, fontSize = 13.sp)
                SmallIcon("↻", "Retry preview of ${file.name}") { attempt++ }
            }
        }
        // Non-images (and media, to keep the original) get one compact file row with a download icon.
        if (!image || error != null) FileRow(file.name, fileSize(file.size), fileGlyph(file.mime), save)
        file.caption?.takeIf { it.isNotBlank() }?.let { Text(it, color = tones.ink, fontSize = 15.sp) }
        save.status()?.let { Text(it, color = tones.soft, fontSize = 12.sp) }
    }
    if (fullScreen && local != null) FullImage(local!!, file.name, save) { fullScreen = false }
}

private fun fileGlyph(mime: String?) = when {
    mime == null -> "📄"
    mime in IMAGE_TYPES -> "🖼️"
    mime in VIDEO_TYPES -> "🎬"
    mime in AUDIO_TYPES -> "🎵"
    else -> "📄"
}

/** One line: icon, shortened name, size and a small download icon. */
@Composable
private fun FileRow(name: String, size: String, glyph: String, save: AttachmentSave) {
    val tones = LocalTones.current
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(tones.ink.copy(alpha = 0.07f)).padding(start = 10.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Text(glyph, fontSize = 20.sp)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(name, color = tones.ink, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(size, color = tones.soft, fontSize = 12.sp)
        }
        if (save.saving) SmallIcon("✕", "Cancel saving $name") { save.cancel() }
        else SmallIcon("⤓", "Download $name") { save.launch() }
    }
}

/** A small round icon button (glyph only) that fits inside bubbles and chips. */
@Composable
internal fun SmallIcon(glyph: String, label: String, enabled: Boolean = true, onClick: () -> Unit) {
    val tones = LocalTones.current
    Box(Modifier.size(36.dp).clip(CircleShape).clickable(enabled = enabled, role = Role.Button, onClick = onClick)
        .semantics { contentDescription = label }, contentAlignment = Alignment.Center) {
        Text(glyph, color = tones.ink.copy(alpha = if (enabled) 0.85f else 0.35f), fontSize = 18.sp)
    }
}

/** Saving an attachment through the system "create document" picker, shared by rows, long-press and the viewer. */
internal class AttachmentSave(val launch: () -> Unit, val cancel: () -> Unit, private val state: () -> Triple<Boolean, String, String?>) {
    val saving: Boolean get() = state().first
    fun status(): String? { val (saving, progress, result) = state(); return if (saving) "Saving $progress…" else result }
}

@Composable
private fun rememberAttachmentSave(model: CompanionModel, file: Attachment, scope: Long): AttachmentSave {
    val coroutine = rememberCoroutineScope()
    var saving by remember(scope, file.id) { mutableStateOf(false) }
    var progress by remember(scope, file.id) { mutableLongStateOf(0) }
    var result by remember(scope, file.id) { mutableStateOf<String?>(null) }
    var cancellation by remember(scope, file.id) { mutableStateOf<TransferCancellation?>(null) }
    DisposableEffect(scope, file.id) { onDispose { cancellation?.cancel() } }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(file.mime)) { uri ->
        if (uri != null) {
            val transfer = TransferCancellation(); cancellation = transfer; saving = true; result = null
            coroutine.launch {
                try { model.saveAttachment(file, uri, scope, transfer) { progress = it }; result = "Saved ${file.name}." }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (failure: Exception) { result = fileProblem((failure as? ApiException)?.code ?: "FILE_UNAVAILABLE") }
                finally { saving = false }
            }
        }
    }
    return AttachmentSave(launch = { if (!saving) picker.launch(file.name) }, cancel = { cancellation?.cancel() },
        state = { Triple(saving, "${fileSize(progress)} / ${fileSize(file.size)}", result) })
}

internal fun decodeImage(file: File, maximumEdge: Int): Drawable =
    ImageDecoder.decodeDrawable(ImageDecoder.createSource(file)) { decoder, info, _ ->
        val width = info.size.width; val height = info.size.height
        if (width <= 0 || height <= 0 || width.toLong() * height > 100_000_000) throw IOException()
        val scale = max(width, height) / maximumEdge.toDouble()
        if (scale > 1) decoder.setTargetSize(max(1, (width / scale).roundToInt()), max(1, (height / scale).roundToInt()))
    }

@Composable
private fun FullImage(local: File, name: String, save: AttachmentSave, close: () -> Unit) {
    var drawable by remember(local) { mutableStateOf<Drawable?>(null) }
    var failed by remember(local) { mutableStateOf(false) }
    LaunchedEffect(local) {
        try { drawable = withContext(Dispatchers.IO) { decodeImage(local, 4096) } }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { failed = true }
    }
    DisposableEffect(drawable) { onDispose { (drawable as? AnimatedImageDrawable)?.stop() } }
    Dialog(onDismissRequest = close, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(Modifier.fillMaxSize().background(Color.Black).statusBarsPadding().navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(8.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                ActionButton(onClick = close) { Text("Close", color = Color.White) }
                ActionButton(enabled = !save.saving, onClick = { save.launch() }) { Text(if (save.saving) "Saving…" else "Save", color = Color.White) }
            }
            Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
                if (drawable != null) AndroidView(factory = { context -> ImageView(context).apply {
                    scaleType = ImageView.ScaleType.FIT_CENTER; contentDescription = name
                } }, modifier = Modifier.fillMaxSize(), update = { view ->
                    if (view.drawable !== drawable) view.setImageDrawable(drawable)
                    (drawable as? AnimatedImageDrawable)?.start()
                })
                else Text(if (failed) "This image could not be displayed. You can download the original." else "Opening image…", color = Color.White)
            }
        }
    }
}

@Composable
private fun VideoAttachment(local: File, name: String) {
    var failed by remember(local) { mutableStateOf(false) }
    if (failed) Text("This video cannot be played on this device. You can download it instead.")
    else AndroidView(factory = { context -> VideoView(context).apply {
        contentDescription = name
        val controls = MediaController(context); controls.setAnchorView(this); setMediaController(controls)
        setOnErrorListener { _, _, _ -> failed = true; true }
        setOnPreparedListener { controls.show(0) }
        setVideoPath(local.absolutePath)
    } }, modifier = Modifier.fillMaxWidth().height(220.dp), onRelease = { it.stopPlayback() })
}

@Composable
private fun AudioAttachment(local: File) {
    var player by remember(local) { mutableStateOf<MediaPlayer?>(null) }
    var ready by remember(local) { mutableStateOf(false) }
    var playing by remember(local) { mutableStateOf(false) }
    var failed by remember(local) { mutableStateOf(false) }
    var duration by remember(local) { mutableIntStateOf(0) }
    var position by remember(local) { mutableIntStateOf(0) }
    DisposableEffect(local) {
        val audio = MediaPlayer(); player = audio
        try {
            audio.setOnPreparedListener { duration = it.duration.coerceAtLeast(0); ready = true }
            audio.setOnCompletionListener { playing = false; position = duration }
            audio.setOnErrorListener { _, _, _ -> failed = true; playing = false; true }
            audio.setDataSource(local.absolutePath); audio.prepareAsync()
        } catch (_: Exception) { failed = true }
        onDispose { player = null; audio.release() }
    }
    LaunchedEffect(local, ready) {
        while (ready && !failed) { position = runCatching { player?.currentPosition ?: 0 }.getOrDefault(0); delay(400) }
    }
    if (failed) Text("This audio cannot be played on this device. You can download it instead.")
    else {
        Button(enabled = ready, onClick = { player?.let { if (playing) it.pause() else it.start(); playing = !playing } }) {
            Text(if (!ready) "Preparing audio…" else if (playing) "Pause audio" else "Play audio")
        }
        Slider(value = position.toFloat().coerceIn(0f, max(1, duration).toFloat()),
            onValueChange = { position = it.roundToInt(); if (ready) player?.seekTo(position) },
            valueRange = 0f..max(1, duration).toFloat(), enabled = ready && duration > 0)
        Text("${position / 60000}:${(position / 1000 % 60).toString().padStart(2, '0')} / ${duration / 60000}:${(duration / 1000 % 60).toString().padStart(2, '0')}")
    }
}

/** A compact chip above the input bar for a file that is being prepared, uploaded or ready to send (#34). */
@Composable
fun UploadCard(model: CompanionModel, upload: PendingUpload, locked: Boolean, modifier: Modifier = Modifier) {
    val tones = LocalTones.current
    val mime = upload.file?.mime ?: mimeFromName(upload.name)
    var thumbnail by remember(upload.key) { mutableStateOf<Drawable?>(null) }
    LaunchedEffect(upload.key, upload.local) {
        val local = upload.local
        if (thumbnail == null && local != null && mime in IMAGE_TYPES) thumbnail = runCatching {
            withContext(Dispatchers.IO) { decodeImage(local, 160) }
        }.getOrNull()
    }
    val status = when (upload.state) {
        "preparing" -> "Preparing…"
        "uploading" -> "Uploading ${if (upload.total == 0L) 0 else (upload.progress * 100 / upload.total)}%"
        "ready" -> "Ready"
        "removing" -> "Removing…"
        else -> upload.error ?: "Upload failed"
    }
    val failed = upload.state == "error" || upload.state == "remove-error"
    Row(modifier.clip(RoundedCornerShape(16.dp)).background(tones.card).border(1.dp, tones.line, RoundedCornerShape(16.dp)).padding(6.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(44.dp).clip(RoundedCornerShape(10.dp)).background(tones.ink.copy(alpha = 0.07f)), contentAlignment = Alignment.Center) {
            val shown = thumbnail
            if (shown != null) AndroidView(factory = { context -> ImageView(context).apply { scaleType = ImageView.ScaleType.CENTER_CROP } },
                modifier = Modifier.fillMaxSize(), update = { view -> if (view.drawable !== shown) view.setImageDrawable(shown) })
            else Text(fileGlyph(mime), fontSize = 20.sp)
        }
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(upload.name, color = tones.ink, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(if (upload.total > 0) "${fileSize(upload.total)} · $status" else status,
                color = if (failed) tones.danger else tones.soft, fontSize = 12.sp, maxLines = if (failed) 3 else 1, overflow = TextOverflow.Ellipsis)
            if (upload.state == "uploading") LinearProgressIndicator(
                progress = { if (upload.total == 0L) 0f else (upload.progress.toFloat() / upload.total).coerceIn(0f, 1f) },
                modifier = Modifier.fillMaxWidth().padding(top = 4.dp).height(3.dp))
        }
        if (upload.state == "error") SmallIcon("↻", "Retry upload of ${upload.name}", enabled = !locked) { model.retryUpload(upload.key) }
        SmallIcon(if (upload.state == "remove-error") "↻" else "✕",
            when (upload.state) { "preparing", "uploading" -> "Cancel upload of ${upload.name}"; "remove-error" -> "Retry removing ${upload.name}"; else -> "Remove ${upload.name}" },
            enabled = !locked && upload.state != "removing") { model.removeUpload(upload.key) }
    }
}

private fun mimeFromName(name: String): String? = when (name.substringAfterLast('.', "").lowercase()) {
    "png" -> "image/png"; "jpg", "jpeg" -> "image/jpeg"; "gif" -> "image/gif"; "webp" -> "image/webp"
    "mp4" -> "video/mp4"; "webm" -> "video/webm"; "mp3" -> "audio/mpeg"; "wav" -> "audio/wav"; "ogg" -> "audio/ogg"
    else -> null
}
