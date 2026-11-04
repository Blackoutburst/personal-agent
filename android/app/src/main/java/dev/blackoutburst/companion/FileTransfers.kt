package dev.blackoutburst.companion

import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/** Only the fixed companion mount is reachable. Media engines receive local files, never credentials. */
internal class FileTransfers(private val session: () -> Session?,
    private val open: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection }) {
    private val json = Json { explicitNulls = false }
    private val base = BuildConfig.SITE + BuildConfig.COMPANION_PATH.trimEnd('/')

    suspend fun upload(threadId: String, key: String, name: String, source: File,
        cancel: TransferCancellation, voice: Boolean = false, progress: (Long) -> Unit): Attachment {
        if (!fileId(threadId) || !requestKey(key) || !fileName(name) || !source.isFile || source.length() > MAX_FILE_BYTES)
            throw ApiException("INVALID_REQUEST")
        val owner = owner()
        return withContext(Dispatchers.IO) {
            val connection = connection("/api/files", owner, cancel)
            try {
                connection.requestMethod = "POST"
                connection.doOutput = true
                connection.setFixedLengthStreamingMode(source.length())
                connection.setRequestProperty("Content-Type", "application/octet-stream")
                connection.setRequestProperty("X-Thread-Id", threadId)
                connection.setRequestProperty("X-Request-Id", key)
                connection.setRequestProperty("X-File-Name", URLEncoder.encode(name, "UTF-8").replace("+", "%20"))
                if (voice) connection.setRequestProperty("X-File-Voice", "1")
                val digest = MessageDigest.getInstance("SHA-256")
                source.inputStream().use { input -> connection.outputStream.use { output ->
                    val buffer = ByteArray(64 * 1024); var sent = 0L
                    while (true) { cancel.check(); val count = input.read(buffer); if (count < 0) break
                        digest.update(buffer, 0, count); output.write(buffer, 0, count); sent += count; progress(sent) }
                } }
                cancel.check()
                val response = response(connection)
                if (response.keys != setOf("file")) throw ApiException("INVALID_RESPONSE")
                val result = try { checkedAttachment(json.decodeFromJsonElement(Attachment.serializer(), response.getValue("file"))) }
                    catch (_: Exception) { throw ApiException("INVALID_RESPONSE") }
                val hash = digest.digest().joinToString("") { "%02x".format(it) }
                if (result.direction != "user" || result.size != source.length() || result.sha256 != hash || (result.voice != null) != voice) throw ApiException("INVALID_RESPONSE")
                result
            } catch (error: ApiException) { throw error }
            catch (_: Exception) { cancel.check(); throw ApiException("NETWORK") }
            finally { connection.disconnect(); cancel.release() }
        }
    }

    suspend fun download(file: Attachment, destination: File, cancel: TransferCancellation,
        progress: (Long) -> Unit = {}): File {
        checkedAttachment(file)
        val owner = owner()
        return withContext(Dispatchers.IO) {
            val connection = connection(file.url, owner, cancel)
            var success = false
            try {
                connection.requestMethod = "GET"
                val status = connection.responseCode
                if (status != 200) { response(connection); throw ApiException("INVALID_RESPONSE") }
                val length = connection.getHeaderField("Content-Length")
                if (length != null && length.toLongOrNull() != file.size) throw ApiException("INVALID_RESPONSE")
                val digest = MessageDigest.getInstance("SHA-256"); var received = 0L
                connection.inputStream.use { input -> destination.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) { cancel.check(); val count = input.read(buffer); if (count < 0) break
                        received += count
                        if (received > file.size || received > MAX_FILE_BYTES) throw ApiException("INVALID_RESPONSE")
                        digest.update(buffer, 0, count); output.write(buffer, 0, count); progress(received)
                    }
                } }
                cancel.check()
                val hash = digest.digest().joinToString("") { "%02x".format(it) }
                if (received != file.size || hash != file.sha256) throw ApiException("INVALID_RESPONSE")
                success = true; destination
            } catch (error: ApiException) { throw error }
            catch (_: Exception) { cancel.check(); throw ApiException("NETWORK") }
            finally { connection.disconnect(); cancel.release(); if (!success) destination.delete() }
        }
    }

    /** Group chat (#53): the same raw upload, to /api/groups/files with the group's id. The reply carries no hash. */
    suspend fun groupUpload(groupId: String, key: String, name: String, source: File, cancel: TransferCancellation,
        progress: (Long) -> Unit): GroupFile {
        if (source.isFile && source.length() > GROUP_FILE_BYTES) throw ApiException("FILE_TOO_LARGE")
        if (!fileId(groupId) || !requestKey(key) || !fileName(name) || !source.isFile || source.length() < 1) throw ApiException("INVALID_REQUEST")
        val owner = owner()
        return withContext(Dispatchers.IO) {
            val connection = connection("/api/groups/files", owner, cancel)
            try {
                connection.requestMethod = "POST"
                connection.doOutput = true
                connection.setFixedLengthStreamingMode(source.length())
                connection.setRequestProperty("Content-Type", "application/octet-stream")
                connection.setRequestProperty("X-Group-Id", groupId)
                connection.setRequestProperty("X-Request-Id", key)
                connection.setRequestProperty("X-File-Name", URLEncoder.encode(name, "UTF-8").replace("+", "%20"))
                source.inputStream().use { input -> connection.outputStream.use { output ->
                    val buffer = ByteArray(64 * 1024); var sent = 0L
                    while (true) { cancel.check(); val count = input.read(buffer); if (count < 0) break
                        output.write(buffer, 0, count); sent += count; progress(sent) }
                } }
                cancel.check()
                val result = parseGroupUpload(response(connection))
                if (result.size != source.length()) throw ApiException("INVALID_RESPONSE")
                result
            } catch (error: ApiException) { throw error }
            catch (_: Exception) { cancel.check(); throw ApiException("NETWORK") }
            finally { connection.disconnect(); cancel.release() }
        }
    }

    /** A group file for display or saving: GET /api/groups/files/<id>, its length checked against the message. */
    suspend fun groupDownload(file: GroupFile, destination: File, cancel: TransferCancellation): File {
        checkGroupFile(file)
        val owner = owner()
        return withContext(Dispatchers.IO) {
            val connection = connection("/api/groups/files/${file.id}", owner, cancel)
            var success = false
            try {
                connection.requestMethod = "GET"
                val status = connection.responseCode
                if (status != 200) { response(connection); throw ApiException("INVALID_RESPONSE") }
                val length = connection.getHeaderField("Content-Length")
                if (length != null && length.toLongOrNull() != file.size) throw ApiException("INVALID_RESPONSE")
                var received = 0L
                connection.inputStream.use { input -> destination.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) { cancel.check(); val count = input.read(buffer); if (count < 0) break
                        received += count
                        if (received > file.size || received > GROUP_FILE_BYTES) throw ApiException("INVALID_RESPONSE")
                        output.write(buffer, 0, count)
                    }
                } }
                cancel.check()
                if (received != file.size) throw ApiException("INVALID_RESPONSE")
                success = true; destination
            } catch (error: ApiException) { throw error }
            catch (_: Exception) { cancel.check(); throw ApiException("NETWORK") }
            finally { connection.disconnect(); cancel.release(); if (!success) destination.delete() }
        }
    }

    private fun owner(): Session = session()?.takeUnless { it.expired } ?: throw ApiException("AUTHENTICATION_REQUIRED", 401)
    private fun connection(path: String, owner: Session, cancel: TransferCancellation): HttpURLConnection {
        cancel.check()
        return open(URL(base + path)).also {
            cancel.bind(it); it.connectTimeout = 15_000; it.readTimeout = 60_000
            it.instanceFollowRedirects = false
            it.setRequestProperty("Cookie", "${owner.cookie}=${owner.token}")
            it.setRequestProperty("Origin", BuildConfig.SITE)
            it.setRequestProperty("Accept", "application/json")
            it.setRequestProperty("Cache-Control", "no-store")
        }
    }
    private fun response(connection: HttpURLConnection): JsonObject {
        val status = connection.responseCode
        val source = if (status in 200..299) connection.inputStream else connection.errorStream
        val bytes = source?.use { it.readNBytes(1024 * 1024 + 1) } ?: ByteArray(0)
        if (bytes.size > 1024 * 1024) throw ApiException("INVALID_RESPONSE", status)
        val value = runCatching {
            val text = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes)).toString()
            json.parseToJsonElement(text).jsonObject
        }.getOrNull()
        if (status !in 200..299) {
            val code = value?.get("error")?.let { runCatching { it.jsonObject["code"].toString().trim('"') }.getOrNull() }
            throw ApiException(code?.takeIf { Regex("[A-Z][A-Z0-9_]{0,60}").matches(it) } ?: "HTTP_$status", status)
        }
        return value ?: throw ApiException("INVALID_RESPONSE", status)
    }
}
