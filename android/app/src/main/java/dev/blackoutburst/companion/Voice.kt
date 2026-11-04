package dev.blackoutburst.companion

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.os.SystemClock
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

/** The longest voice message (the server accepts up to 10 minutes; the apps stop at 5, like the web app). */
const val VOICE_MAX_MS = 5 * 60_000L

fun voiceClock(ms: Long): String { val s = (ms.coerceAtLeast(0) + 500) / 1000; return "${s / 60}:${(s % 60).toString().padStart(2, '0')}" }

/** One recording at a time: AAC in MP4 (what the server turns into a transcript and every client can play). */
class VoiceRecorder(private val context: Context) {
    private var recorder: MediaRecorder? = null
    var file: File? = null; private set
    var startedAt = 0L; private set
    val active get() = recorder != null

    fun start(target: File): Boolean {
        if (recorder != null) return false
        val created = MediaRecorder(context)
        return try {
            created.setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
            created.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            created.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            created.setAudioChannels(1); created.setAudioSamplingRate(44_100); created.setAudioEncodingBitRate(64_000)
            created.setOutputFile(target)
            created.prepare(); created.start()
            recorder = created; file = target; startedAt = SystemClock.elapsedRealtime(); true
        } catch (_: Exception) { created.release(); target.delete(); false }
    }

    /** Ends the recording. keep: the finished file and its length, or null (cancelled, too short or failed). */
    fun stop(keep: Boolean): Pair<File, Long>? {
        val active = recorder ?: return null
        val target = file; val length = SystemClock.elapsedRealtime() - startedAt
        recorder = null; file = null
        val finished = try { active.stop(); true } catch (_: Exception) { false } finally { active.release() }
        if (!keep || !finished || target == null || length < 500 || !target.isFile || target.length() == 0L) { target?.delete(); return null }
        return target to length
    }
}

/** The mic where Send is while the message box is empty (like Discord): tap to record, the bar then sends or cancels. */
@Composable
fun MicButton(enabled: Boolean, onRecord: () -> Unit, onProblem: (String) -> Unit) {
    val context = LocalContext.current
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) onRecord() else onProblem("Allow the microphone for Companion to record a voice message.")
    }
    RoundButton("Record a voice message", "🎤", enabled = enabled) {
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) onRecord()
        else permission.launch(Manifest.permission.RECORD_AUDIO)
    }
}

/** Replaces the composer while recording: cancel, a pulsing dot with the time, send. */
@Composable
fun RecordingBar(startedAt: Long, onCancel: () -> Unit, onSend: () -> Unit, modifier: Modifier = Modifier) {
    val tones = LocalTones.current
    var now by remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }
    LaunchedEffect(startedAt) { while (true) { now = SystemClock.elapsedRealtime(); delay(250) } }
    val pulse by rememberInfiniteTransition(label = "recording").animateFloat(1f, 0.25f,
        infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "dot")
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        RoundButton("Cancel voice message", "✕", secondary = true, onClick = onCancel)
        Row(Modifier.weight(1f).padding(horizontal = 8.dp).height(52.dp).clip(RoundedCornerShape(26.dp)).background(tones.card)
            .padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(12.dp).alpha(pulse).clip(CircleShape).background(Color(0xFFE5484D)))
            Spacer(Modifier.size(10.dp))
            Text(voiceClock(now - startedAt), color = tones.ink, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.size(10.dp))
            Text("Recording…", color = tones.soft, fontSize = 15.sp)
        }
        RoundButton("Send voice message", "↑", onClick = onSend)
    }
}

/** A voice message in the chat: play/pause, a progress bar you can tap to seek, the length, and the transcript on demand.
 *  The recording is fetched through the authenticated API and played from the app's private cache. */
@Composable
fun VoiceMessageView(model: CompanionModel, file: Attachment, scope: Long) {
    val tones = LocalTones.current
    val voice = file.voice ?: return
    var attempt by remember(scope, file.id) { mutableIntStateOf(0) }
    var wanted by remember(scope, file.id) { mutableStateOf(false) }
    var player by remember(scope, file.id) { mutableStateOf<MediaPlayer?>(null) }
    var playing by remember(scope, file.id) { mutableStateOf(false) }
    var position by remember(scope, file.id) { mutableLongStateOf(0L) }
    var length by remember(scope, file.id) { mutableLongStateOf(voice.durationMs) }
    var problem by remember(scope, file.id) { mutableStateOf<String?>(null) }
    var loading by remember(scope, file.id) { mutableStateOf(false) }
    var showText by remember(scope, file.id) { mutableStateOf(false) }
    var seekTo by remember(scope, file.id) { mutableFloatStateOf(-1f) }
    val cancellation = remember(scope, file.id, attempt) { TransferCancellation() }
    DisposableEffect(cancellation) { onDispose { cancellation.cancel() } }
    DisposableEffect(scope, file.id) { onDispose { player?.release(); player = null } }
    LaunchedEffect(wanted, attempt) {
        if (!wanted || player != null) return@LaunchedEffect
        loading = true; problem = null
        try {
            val local = model.mediaFile(file, scope, cancellation) { }
            val created = MediaPlayer()
            try { created.setDataSource(local.path); created.prepare() } catch (error: Exception) { created.release(); throw error }
            created.setOnCompletionListener { playing = false; position = 0; it.seekTo(0) }
            if (created.duration > 0) length = created.duration.toLong()
            player = created
            if (seekTo >= 0f) { created.seekTo((seekTo * length).toInt()); position = (seekTo * length).toLong(); seekTo = -1f }
            else { created.start(); playing = true }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) { wanted = false; problem = if (failure is ApiException) fileProblem(failure.code) else "This voice message can't be played." }
        finally { loading = false }
    }
    LaunchedEffect(playing) { while (playing) { player?.let { position = it.currentPosition.toLong() }; delay(100) } }
    Column(Modifier.widthIn(min = 220.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            val label = if (playing) "Pause voice message" else "Play voice message"
            Box(Modifier.size(40.dp).clip(CircleShape).background(Color(0xFFEE8F64))
                .clickable(enabled = !loading, role = Role.Button) {
                    val current = player
                    when {
                        current == null -> wanted = true
                        playing -> { current.pause(); playing = false }
                        else -> { current.start(); playing = true }
                    }
                }.semantics { contentDescription = label }, contentAlignment = Alignment.Center) {
                Text(if (loading) "…" else if (playing) "❚❚" else "▶", color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.Bold)
            }
            Spacer(Modifier.size(10.dp))
            val fraction = if (length > 0) (position.toFloat() / length).coerceIn(0f, 1f) else 0f
            Box(Modifier.weight(1f).height(24.dp).pointerInput(length) {
                detectTapGestures { offset ->
                    val ratio = (offset.x / size.width).coerceIn(0f, 1f)
                    val current = player
                    if (current == null) { seekTo = ratio; wanted = true } else { current.seekTo((ratio * length).toInt()); position = (ratio * length).toLong() }
                }
            }.semantics { contentDescription = "Voice message position" }, contentAlignment = Alignment.CenterStart) {
                Box(Modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(2.dp)).background(tones.ink.copy(alpha = 0.15f)))
                Box(Modifier.fillMaxWidth(fraction).height(4.dp).clip(RoundedCornerShape(2.dp)).background(Color(0xFFEE8F64)))
            }
            Spacer(Modifier.size(10.dp))
            Text(voiceClock(if (playing || position > 0) position else length), color = tones.soft, fontSize = 13.sp)
        }
        problem?.let { text ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(text, Modifier.weight(1f), color = tones.danger, fontSize = 13.sp)
                SmallIcon("↻", "Retry voice message") { problem = null; attempt++; wanted = true }
            }
        }
        voice.transcript?.takeIf { it.isNotBlank() }?.let { transcript ->
            Text(if (showText) "Hide transcript" else "Transcript", Modifier.clip(RoundedCornerShape(8.dp))
                .clickable(role = Role.Button) { showText = !showText }.padding(vertical = 2.dp),
                color = tones.soft, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            if (showText) Text(transcript, color = tones.ink, fontSize = 15.sp)
        }
    }
}
