package dev.blackoutburst.companion

import android.content.Context
import android.net.Uri
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** The app's own blackoutburst.com session (30 days), obtained through the PKCE app sign-in. */
@Serializable
data class Session(val token: String, val cookie: String, val expiresAt: Long, val username: String? = null) {
    val expired get() = expiresAt <= System.currentTimeMillis()
}

object Pkce {
    private val random = SecureRandom()

    fun randomToken(bytes: Int = 32): String {
        val data = ByteArray(bytes).also(random::nextBytes)
        return base64Url(data)
    }

    fun challenge(verifier: String): String =
        base64Url(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))

    fun base64Url(data: ByteArray): String =
        Base64.encodeToString(data, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
}

/** A sign-in started in the browser: the verifier and state stay on the device. */
@Serializable
data class PendingSignIn(val verifier: String, val state: String, val startedAt: Long)

object SignIn {
    const val APP = "companion"
    private const val TTL_MS = 10 * 60_000L

    fun start(): Pair<PendingSignIn, Uri> {
        val pending = PendingSignIn(Pkce.randomToken(), Pkce.randomToken(24), System.currentTimeMillis())
        val uri = Uri.parse("${BuildConfig.SITE}/account/").buildUpon()
            .appendQueryParameter("app", APP)
            .appendQueryParameter("challenge", Pkce.challenge(pending.verifier))
            .appendQueryParameter("state", pending.state)
            .build()
        return pending to uri
    }

    /** The code from blackoutburst-companion://auth?code=…&state=…, when it matches this sign-in. */
    fun codeFrom(uri: Uri, pending: PendingSignIn?): String? {
        if (pending == null || uri.scheme != "blackoutburst-companion" || uri.host != "auth") return null
        if (System.currentTimeMillis() - pending.startedAt > TTL_MS) return null
        val state = uri.getQueryParameter("state") ?: return null
        if (!MessageDigest.isEqual(state.toByteArray(), pending.state.toByteArray())) return null
        return uri.getQueryParameter("code")?.takeIf { Regex("^[A-Za-z0-9_-]{43}$").matches(it) }
    }
}

/**
 * Keeps the session and a pending sign-in in private preferences, encrypted with an
 * Android Keystore key that never leaves the device. Excluded from backups.
 */
class SessionStore(context: Context) {
    private val prefs = context.getSharedPreferences("session", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }

    var session: Session?
        get() = read("session")?.let { runCatching { json.decodeFromString<Session>(it) }.getOrNull() }
        set(value) = write("session", value?.let { json.encodeToString(Session.serializer(), it) })

    var pending: PendingSignIn?
        get() = read("pending")?.let { runCatching { json.decodeFromString<PendingSignIn>(it) }.getOrNull() }
        set(value) = write("pending", value?.let { json.encodeToString(PendingSignIn.serializer(), it) })

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    private fun write(name: String, value: String?) {
        if (value == null) { prefs.edit().remove(name).apply(); return }
        val cipher = Cipher.getInstance(TRANSFORM).apply { init(Cipher.ENCRYPT_MODE, key()) }
        val sealed = cipher.iv + cipher.doFinal(value.toByteArray())
        prefs.edit().putString(name, Base64.encodeToString(sealed, Base64.NO_WRAP)).apply()
    }

    private fun read(name: String): String? = runCatching {
        val sealed = Base64.decode(prefs.getString(name, null) ?: return null, Base64.NO_WRAP)
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed, 0, 12))
        String(cipher.doFinal(sealed, 12, sealed.size - 12))
    }.getOrNull()

    private companion object {
        const val ALIAS = "companion-session"
        const val TRANSFORM = "AES/GCM/NoPadding"
    }
}
