package dev.blackoutburst.companion

import android.app.Application
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

// Android push (docs/PUSH.md). The server sends a data-only FCM message with ids (thread, message, companion name),
// never the text. This app fetches the text itself over the signed-in session and shows the notification, unless the
// app is open (the chat already shows it), notifications are off, or nobody is signed in.
object Push {
    const val CHANNEL = "messages"
    const val EXTRA_THREAD = "dev.blackoutburst.companion.THREAD"
    /** Set for a Board sub-conversation's message (#55): the tap opens it in the Board tab. */
    const val EXTRA_BOARD = "dev.blackoutburst.companion.BOARD"
    private const val PREFS = "push"
    private const val SEEN_MAX = 100

    /** True while any app screen is visible; set by MainActivity. */
    @Volatile var foreground = false

    val configured: Boolean get() = BuildConfig.FIREBASE_APP_ID.isNotEmpty()

    fun init(context: Context) {
        if (!configured) return
        if (FirebaseApp.getApps(context).isEmpty()) FirebaseApp.initializeApp(context, FirebaseOptions.Builder()
            .setApplicationId(BuildConfig.FIREBASE_APP_ID).setApiKey(BuildConfig.FIREBASE_API_KEY)
            .setProjectId(BuildConfig.FIREBASE_PROJECT_ID).setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID).build())
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Messages", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Messages from your companion while the app is closed"
        })
    }

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    fun enabled(context: Context) = prefs(context).getBoolean("enabled", true)
    fun preview(context: Context) = prefs(context).getBoolean("preview", true)
    fun setPreview(context: Context, value: Boolean) = prefs(context).edit().putBoolean("preview", value).apply()
    fun setEnabled(context: Context, value: Boolean) = prefs(context).edit().putBoolean("enabled", value).apply()
    fun asked(context: Context) = prefs(context).getBoolean("asked", false)
    fun markAsked(context: Context) = prefs(context).edit().putBoolean("asked", true).apply()
    fun permitted(context: Context) =
        context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /** Remembers the last notified message ids so a retried push never shows twice. Returns false for a repeat. */
    @Synchronized fun firstTime(context: Context, messageId: String): Boolean {
        val seen = prefs(context).getString("seen", "")!!.split(',').filter { it.isNotEmpty() }
        if (messageId in seen) return false
        prefs(context).edit().putString("seen", (seen + messageId).takeLast(SEEN_MAX).joinToString(",")).apply()
        return true
    }

    private suspend fun token(): String? = if (!configured) null else suspendCancellableCoroutine { continuation ->
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            continuation.resume(if (task.isSuccessful) task.result else null)
        }
    }

    /** Registers this install for the signed-in owner. Quietly does nothing when push is off or unavailable. */
    suspend fun register(context: Context, api: Api) {
        if (!configured || !enabled(context)) return
        FirebaseMessaging.getInstance().isAutoInitEnabled = true
        val token = token() ?: return
        runCatching { api.pushRegister(token) }
    }

    /** Stops pushes to this install for the account `api` is signed in as, then drops the token. */
    suspend fun unregister(api: Api) {
        if (!configured) return
        val token = token() ?: return
        runCatching { api.pushUnregister(token) }
        runCatching { FirebaseMessaging.getInstance().isAutoInitEnabled = false; FirebaseMessaging.getInstance().deleteToken() }
    }

    fun clearShown(context: Context) = context.getSystemService(NotificationManager::class.java).cancelAll()

    fun show(context: Context, threadId: String, messageId: String, title: String, text: String, board: Boolean = false) {
        val open = Intent(context, MainActivity::class.java).putExtra(EXTRA_THREAD, threadId).putExtra(EXTRA_BOARD, board)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val tap = PendingIntent.getActivity(context, messageId.hashCode(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = Notification.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setContentIntent(tap)
            .apply { if (board) setSubText("Board") }
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setColor(0xFFEE8F64.toInt())
            .build()
        context.getSystemService(NotificationManager::class.java).notify(messageId.hashCode(), notification)
    }
}

/** Plain one-paragraph text for a notification: markdown markers and URLs reduced to their readable form. */
fun notificationText(text: String, max: Int = 300): String {
    val plain = parseMarkdown(text).joinToString(" ") { block ->
        when (block) {
            is MdBlock.Paragraph -> block.spans.joinToString("") { it.text }
            is MdBlock.Heading -> block.spans.joinToString("") { it.text }
            is MdBlock.Bullet -> "• " + block.spans.joinToString("") { it.text }
            is MdBlock.Numbered -> block.number + " " + block.spans.joinToString("") { it.text }
            is MdBlock.Quote -> block.blocks.joinToString(" ") { inner -> (inner as? MdBlock.Paragraph)?.spans?.joinToString("") { it.text } ?: "" }
            is MdBlock.Code -> block.text
            is MdBlock.Table -> block.header.joinToString(" · ") { cell -> cell.joinToString("") { it.text } }
            MdBlock.Rule -> ""
        }
    }.replace(Regex("\\s+"), " ").trim()
    return if (plain.length <= max) plain else plain.take(max - 1).trimEnd() + "…"
}

class CompanionApplication : Application() {
    override fun onCreate() { super.onCreate(); Push.init(this) }
}

class PushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        val store = SessionStore(this)
        if (store.session == null || !Push.enabled(this)) return
        runBlocking { runCatching { Api { store.session }.pushRegister(token) } }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        if (data["type"] != "message") return
        val threadId = data["threadId"] ?: return
        val messageId = data["messageId"] ?: return
        if (Push.foreground || !Push.enabled(this) || !Push.permitted(this)) return
        val store = SessionStore(this)
        if (store.session == null) return
        if (!Push.firstTime(this, messageId)) return
        val title = data["name"]?.takeIf { it.isNotBlank() } ?: getString(R.string.app_name)
        val text = if (!Push.preview(this)) "New message" else runBlocking {
            withTimeoutOrNull(8_000) {
                runCatching { Api { store.session }.snapshot(threadId).messages.firstOrNull { it.id == messageId } }.getOrNull()
            }
        }?.let { found ->
            notificationText(found.text).ifBlank { if (found.attachments.isNotEmpty()) "Sent you a file" else "" }
        }?.ifBlank { null } ?: "New message"
        Push.show(this, threadId, messageId, title, text, boardPush(data))
    }
}
