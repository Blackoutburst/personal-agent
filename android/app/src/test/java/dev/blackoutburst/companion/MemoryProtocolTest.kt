package dev.blackoutburst.companion

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.*
import org.junit.Test

class MemoryProtocolTest {
    private fun hash(text: String) = MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).joinToString("") { "%02x".format(it) }
    private fun file(name: String = "USER.md", content: String = "# Notes\nProse stays.\n- same\n- same\nTrailing prose.\n"): MemoryFile {
        val items = content.split('\n').mapIndexedNotNull { line, value ->
            if (value.startsWith("- ")) MemoryItem((line + 1).toString(16).padStart(16, '0'), value.removePrefix("- ").removeSuffix("\r"), line) else null
        }
        return MemoryFile(name, content, hash(content), "2026-11-03T01:00:00.000Z", !writableMemory(name), listOf(MemorySection("Notes", items)))
    }
    private fun snapshot(files: List<MemoryFile> = listOf(file())) = Memories(files, hash(files.joinToString { it.file + it.revision }))
    private fun raw(value: Memories) = Json.parseToJsonElement(Json.encodeToString(value))
    private fun denied(block: () -> Unit) {
        try { block(); fail("Expected invalid response") } catch (error: ApiException) { assertEquals("INVALID_RESPONSE", error.code) }
    }

    @Test fun fullProseBomCrLfDiaryAndDuplicateOccurrencesSurviveTheProtocol() {
        val user = file(content = "\ufeff# Notes\r\nProse before bullets.\r\n- same\r\n- same\r\nUnbulleted ending.\r\n")
        val diary = file("memory/2026-11-02.md", "A complete diary paragraph, without bullets.\n")
        val expected = snapshot(listOf(user, diary))
        val result = parseMemories(raw(expected))
        assertEquals(expected, result)
        assertEquals(user.content, result.files.first().content)
        assertTrue(result.files.first().content.startsWith('\ufeff'))
        val duplicates = result.files.first().sections.single().items
        assertEquals(listOf("same", "same"), duplicates.map { it.text })
        assertEquals(listOf(2, 3), duplicates.map { it.line })
        assertNotEquals(duplicates[0].id, duplicates[1].id)
        assertFalse(result.files.first().readOnly); assertTrue(result.files.last().readOnly)
        assertEquals("2026-11-03T01:00:00.000Z", result.files.first().modifiedAtISO)
    }

    @Test fun canonicalBackendFixtureKeepsTheRealFileRevisionAndOccurrenceIds() {
        val wire = """{"files":[{"file":"USER.md","content":"## Likes\n- Tea\n- Tea\n","revision":"86d3cfe0207305e3544600a26cc76864fad1f958f43d094afe62a5b8a0a01925","modifiedAtISO":"2026-11-03T00:00:00.000Z","readOnly":false,"sections":[{"title":"Likes","items":[{"id":"ad4bbffd5323f1e4","text":"Tea","line":1},{"id":"d9b1dc4818ed0ff9","text":"Tea","line":2}]}]},{"file":"MEMORY.md","content":"","revision":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","modifiedAtISO":"2026-11-03T00:00:00.000Z","readOnly":false,"sections":[]}],"revision":"6f68140f8ffbdaa898c986bed04dd9b5b8572166520087b90a1e72c5a31456d1"}"""
        val snapshot = parseMemories(Json.parseToJsonElement(wire))
        assertEquals(listOf("ad4bbffd5323f1e4", "d9b1dc4818ed0ff9"), snapshot.files.first().sections.single().items.map { it.id })
        assertEquals("86d3cfe0207305e3544600a26cc76864fad1f958f43d094afe62a5b8a0a01925", snapshot.files.first().revision)
        assertEquals(2, snapshot.files.size)
    }

    @Test fun pathsRevisionsDatesReadOnlyFlagsAndOccurrenceLocatorsFailClosed() {
        val good = file(); val note = good.sections.single().items.first()
        val bad = listOf(good.copy(file = "../USER.md"), good.copy(file = "SOUL.md"), good.copy(file = "memory/2026-02-30.md"),
            good.copy(readOnly = true), good.copy(revision = "not-a-revision"), good.copy(revision = "0".repeat(64)),
            good.copy(modifiedAtISO = "unknown"), good.copy(content = "bad\u0000text"),
            good.copy(sections = listOf(MemorySection("Notes", listOf(note.copy(id = "wrong"))))),
            good.copy(sections = listOf(MemorySection("Notes", listOf(note.copy(line = 999))))),
            good.copy(sections = listOf(MemorySection("Notes", listOf(note, note.copy(line = 3))))),
            good.copy(sections = listOf(MemorySection("Notes", listOf(note, note.copy(id = "f".repeat(16)))))),
            good.copy(sections = listOf(MemorySection("Notes", listOf(note.copy(text = "two\nlines"))))))
        bad.forEach { denied { parseMemories(raw(snapshot(listOf(it)))) } }
        denied { parseMemories(raw(snapshot(listOf(good, good)))) }
        denied { parseMemories(raw(snapshot().copy(revision = "bad"))) }
        val unknown = Json.parseToJsonElement(Json.encodeToString(snapshot()).dropLast(1) + ",\"owner\":\"private-canary\"}")
        denied { parseMemories(unknown) }
    }

    @Test fun noteBoundsRefuseRatherThanTruncateAndCorrectionIsASingleBoundedLine() {
        val large = file(content = "x".repeat(MEMORY_FILE_BYTES))
        assertEquals(MEMORY_FILE_BYTES, parseMemories(raw(snapshot(listOf(large)))).files.single().content.length)
        denied { parseMemories(raw(snapshot(listOf(file(content = "x".repeat(MEMORY_FILE_BYTES + 1)))))) }
        denied { parseMemories(raw(snapshot((1..9).map { file("memory/2026-11-${it.toString().padStart(2, '0')}.md", large.content) }))) }
        val empty = file(content = "")
        denied { parseMemories(raw(snapshot(List(1025) { empty.copy(file = "memory/${2000 + it}-01-01.md") }))) }
        assertTrue(validCorrection("  Exact correction 🙂  "))
        assertTrue(validCorrection("x".repeat(4000)))
        for (text in listOf("", "  ", "a\nb", "a\rb", "a\tb", "\u0000", "\ud800", "x".repeat(4001))) assertFalse(validCorrection(text))
    }

    @Test fun actualApiUsesFileAndGlobalCasWithoutOwnerSelectorsOrSilentRetries() = runBlocking {
        val calls = mutableListOf<Connection>(); val saved = snapshot(); val item = saved.files.single().sections.single().items.first()
        val api = api(calls) { body ->
            val result = when (body["action"]?.jsonPrimitive?.content) {
                "memory" -> saved
                "editMemory" -> saved.copy(changed = true)
                "forget" -> saved.copy(removed = true)
                "forgetAll" -> saved.copy(cleared = true)
                else -> throw AssertionError("Unexpected operation")
            }
            200 to Json.encodeToString(result)
        }
        assertEquals(saved, api.memories())
        api.editMemory("USER.md", item.id, " exact correction ", saved.files.single().revision)
        api.forget("USER.md", item.id, saved.files.single().revision)
        api.forgetAllMemory(saved.revision)
        assertEquals(setOf("action", "file", "id", "text", "expectedRevision"), calls[1].body().keys)
        assertEquals(" exact correction ", calls[1].body().getValue("text").jsonPrimitive.content)
        assertEquals(setOf("action", "file", "id", "expectedRevision"), calls[2].body().keys)
        assertEquals(saved.files.single().revision, calls[2].body().getValue("expectedRevision").jsonPrimitive.content)
        assertEquals(setOf("action", "expectedRevision", "confirm"), calls[3].body().keys)
        assertEquals("true", calls[3].body().getValue("confirm").toString())
        assertEquals(saved.revision, calls[3].body().getValue("expectedRevision").jsonPrimitive.content)
        calls.forEach { assertEquals("app_session=alice-private-token", it.getRequestProperty("Cookie")); assertEquals(BuildConfig.SITE, it.getRequestProperty("Origin")); assertFalse(it.instanceFollowRedirects) }
        val before = calls.size
        for (name in listOf("SOUL.md", "../USER.md", "memory/2026-11-01.md")) {
            try { api.forget(name, item.id, saved.revision); fail("Read-only/path refusal") }
            catch (error: ApiException) { assertEquals("INVALID_REQUEST", error.code) }
        }
        try { api.editMemory("USER.md", item.id, "two\nlines", saved.revision); fail("Single line") }
        catch (error: ApiException) { assertEquals("INVALID_REQUEST", error.code) }
        assertEquals(before, calls.size)
    }

    @Test fun conflictAndBusyAreTypedAndKeepAnExplicitRetryAtTheOriginalRevision() = runBlocking {
        val calls = mutableListOf<Connection>(); var code = "MEMORY_CONFLICT"; val revision = hash("original")
        val api = api(calls) { 409 to """{"error":{"code":"$code","message":"private-response-canary"}}""" }
        repeat(2) {
            try { api.editMemory("USER.md", "a".repeat(16), "draft stays", revision); fail("Conflict") }
            catch (error: ApiException) { assertEquals("MEMORY_CONFLICT", error.code); assertEquals(409, error.status); assertFalse(error.toString().contains("canary")) }
        }
        assertArrayEquals(calls[0].sent.toByteArray(), calls[1].sent.toByteArray())
        assertEquals(revision, calls.last().body().getValue("expectedRevision").jsonPrimitive.content)
        code = "MEMORY_BUSY"
        try { api.forget("USER.md", "a".repeat(16), revision); fail("Busy") }
        catch (error: ApiException) { assertEquals("MEMORY_BUSY", error.code); assertTrue(memoryProblem(error).contains("Finish or stop")); assertFalse(memoryProblem(error).contains("latest version")) }
        assertEquals(3, calls.size) // Only the three explicit calls, no automatic retry.
    }

    @Test fun exportIsAFreshOwnerOnlyJsonSnapshotWithNoPublicOrCredentialUrl() = runBlocking {
        val calls = mutableListOf<Connection>(); var content = "First saved notes.\n"
        val api = api(calls) { body ->
            assertEquals(setOf("action"), body.keys); assertEquals("exportMemory", body.getValue("action").jsonPrimitive.content)
            200 to "{\"export\":" + Json.encodeToString(MemoryExport("companion-memory-v1", "2026-11-03T01:00:00.000Z",
                listOf(file(content = content), file("MEMORY.md", "Our shared milestone.\n"), file("memory/2026-11-02.md", "Diary prose.\n")))) + "}"
        }
        val first = api.exportMemory(); content = "Corrected saved notes.\n"; val second = api.exportMemory()
        assertEquals("First saved notes.\n", first.files.first().content)
        assertEquals(content, second.files.first().content)
        assertEquals(listOf("USER.md", "MEMORY.md", "memory/2026-11-02.md"), second.files.map { it.file })
        assertEquals(2, calls.size)
        assertTrue(memoryExportBytes(second).toString(Charsets.UTF_8).contains("Corrected saved notes."))
        calls.forEach { assertFalse(it.url.toString().contains("private-token")); assertEquals(BuildConfig.SITE + BuildConfig.COMPANION_PATH + "api/companion", it.url.toString()) }
    }

    @Test fun malformedMutationAndExportBodiesNeverBecomeSuccess() = runBlocking {
        for (body in listOf("{}", "{\"files\":[],\"revision\":\"${hash("x")}\"}", "[]")) {
            val api = api(mutableListOf()) { 200 to body }
            try { api.forgetAllMemory(hash("x")); fail("Missing cleared ACK") }
            catch (error: ApiException) { assertEquals("INVALID_RESPONSE", error.code) }
        }
        val badExport = Json.parseToJsonElement("{\"export\":{" + "\"format\":\"other\",\"exportedAt\":\"2026-11-03T01:00:00Z\",\"files\":[]}}")
        denied { parseMemoryExport(badExport) }
    }

    private fun api(calls: MutableList<Connection>, reply: (JsonObject) -> Pair<Int, String>): Api =
        Api(open = { url -> Connection(url, reply).also { calls += it } }) { Session("alice-private-token", "app_session", Long.MAX_VALUE) }
    private class Connection(url: URL, private val reply: (JsonObject) -> Pair<Int, String>) : HttpURLConnection(url) {
        val sent = ByteArrayOutputStream(); private var result: Pair<Int, String>? = null
        fun body() = Json.parseToJsonElement(sent.toString("UTF-8")).jsonObject
        override fun connect() {}
        override fun disconnect() {}
        override fun usingProxy() = false
        override fun getOutputStream() = sent
        override fun getResponseCode(): Int { if (result == null) result = reply(body()); return result!!.first }
        override fun getInputStream() = ByteArrayInputStream(result!!.second.toByteArray())
        override fun getErrorStream() = ByteArrayInputStream(result!!.second.toByteArray())
    }
}
