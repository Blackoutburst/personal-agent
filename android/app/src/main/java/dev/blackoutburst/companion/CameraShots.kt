package dev.blackoutburst.companion

import android.content.Context
import android.net.Uri
import androidx.core.content.FileProvider
import java.io.File
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter

/**
 * Photos taken from the chat's + menu. The camera app writes each one into cache/camera through the app's
 * FileProvider; it is then attached like any picked file. Shots older than a day are cleaned up.
 */
object CameraShots {
    private const val DAY_MS = 24 * 60 * 60 * 1000L

    fun create(context: Context): Uri {
        val dir = File(context.cacheDir, "camera").apply { mkdirs() }
        val now = System.currentTimeMillis()
        dir.listFiles()?.filter { now - it.lastModified() > DAY_MS }?.forEach { it.delete() }
        val name = "Photo_" + LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd_HHmmss")) + ".jpg"
        return FileProvider.getUriForFile(context, context.packageName + ".camera", File(dir, name))
    }

    fun discard(context: Context, uri: Uri) {
        runCatching { context.contentResolver.delete(uri, null, null) }
    }
}
