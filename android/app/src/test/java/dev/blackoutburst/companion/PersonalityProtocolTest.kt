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

class PersonalityProtocolTest {
    private val date = "2026-11-03T02:41:00.000Z"
    private fun hash(content: String) = MessageDigest.getInstance("SHA-256").digest(content.toByteArray())
        .joinToString("") { "%02x".format(it) }
    private fun snapshot(content: String = "\ufeff# Soul\r\nPrivate prose.\r\n- Warm\r\n") =
        Personality("SOUL.md", content, hash(content), date, emptyList(), 20)
    private fun version(content: String = "# Earlier soul\n- Curious\n", source: String = "settled_turn") =
        PersonalityVersion(hash(content), content, date, date, source)
    private fun raw(value: Personality) = Json.parseToJsonElement(Json.encodeToString(value))
    private fun rawVersion(value: PersonalityVersion) = Json.parseToJsonElement("{\"version\":" + Json.encodeToString(value) + "}")
    private fun refused(code: String = "INVALID_RESPONSE", block: () -> Unit) {
        try { block(); fail("Expected refusal") } catch (error: ApiException) { assertEquals(code, error.code) }
    }

    @Test fun fullSoulPreservesBomCrLfProseEmptyFilesAndTruthfulObservedMetadata() {
        val current = snapshot(); assertEquals(current, parsePersonality(raw(current)))
        assertTrue(parsePersonality(raw(current)).content.startsWith('\ufeff'))
        assertEquals("", parsePersonality(raw(snapshot(""))).content)
        val old = version()
        val observed = current.copy(history = listOf(PersonalityHistory(old.revision, old.observedAtISO, old.modifiedAtISO, old.source)))
        val parsed = parsePersonality(raw(observed))
        assertEquals(date, parsed.modifiedAtISO); assertEquals(date, parsed.history.single().observedAtISO)
        assertFalse(parsed.history.any { it.revision == current.revision }) // Reads do not invent observations.
        assertEquals(old, parsePersonalityVersion(rawVersion(old), old.revision))
        for (source in listOf("settled_turn", "owner_edit", "owner_restore", "before_owner_change"))
            assertEquals(source, parsePersonalityVersion(rawVersion(old.copy(source = source)), old.revision).source)
    }

    @Test fun strictWireRejectsForeignFilesCorruptBytesExtraFieldsAndUnboundedHistory() {
        val good = snapshot(); val old = version(); val entry = PersonalityHistory(old.revision, date, date, "owner_edit")
        for (bad in listOf(good.copy(file = "USER.md"), good.copy(file = "../SOUL.md"), good.copy(revision = "0".repeat(64)),
            good.copy(modifiedAtISO = "not-a-date"), good.copy(content = "bad\u0000text"), good.copy(historyLimit = 21),
            good.copy(history = listOf(entry, entry)), good.copy(history = listOf(entry.copy(source = "provider-private-path"))),
            good.copy(history = listOf(entry.copy(observedAtISO = "unknown"))),
            good.copy(history = (1..21).map { entry.copy(revision = hash("version-$it")) }))) refused { parsePersonality(raw(bad)) }
        refused { parsePersonality(Json.parseToJsonElement(Json.encodeToString(good).dropLast(1) + ",\"owner\":\"other\"}")) }
        refused { parsePersonalityVersion(rawVersion(old), good.revision) }
        refused { parsePersonalityVersion(rawVersion(old.copy(content = "Changed bytes")), old.revision) }
        assertEquals(PERSONALITY_BYTES, parsePersonality(raw(snapshot("x".repeat(PERSONALITY_BYTES)))).content.length)
        refused { parsePersonality(raw(snapshot("x".repeat(PERSONALITY_BYTES + 1)))) }
        assertFalse(validPersonalityContent("\ud800")); assertFalse(validPersonalityContent("bad\u0007text"))
        assertTrue(validPersonalityContent("\ufeff\t\r\n"))
    }

    @Test fun simpleLineDiffRetainsEveryChangedLineWithoutQuadraticComparisonOrTruncation() {
        val current = "# Soul\r\n- Warm\r\nSame ending\r\n"
        val target = "# Soul\r\n- Playful\r\n- Curious\r\nSame ending\r\n"
        val diff = personalityLineDiff(current, target)
        assertEquals(1, diff.unchangedBefore); assertEquals(2, diff.unchangedAfter)
        assertEquals(listOf("- Warm\r"), diff.removed)
        assertEquals(listOf("- Playful\r", "- Curious\r"), diff.added)
        val identical = personalityLineDiff(current, current)
        assertTrue(identical.added.isEmpty()); assertTrue(identical.removed.isEmpty())
        val large = "a\n".repeat(PERSONALITY_BYTES / 2)
        val complete = personalityLineDiff(large, "b\n" + large)
        assertEquals(listOf("b"), complete.added); assertTrue(complete.removed.isEmpty())
        assertEquals(large.split('\n').size, complete.unchangedAfter)
    }

    @Test fun actualApiUsesExactRawByteCasAndConfirmedPinnedRestoreOverTheOwnersPrivateRoute() = runBlocking {
        val calls = mutableListOf<Connection>(); val current = snapshot(); val old = version()
        val content = "\ufeff# Owner correction\r\nKeep exact whitespace.  \r\n"
        val api = api(calls) { body ->
            when (body.getValue("action").jsonPrimitive.content) {
                "personality" -> 200 to Json.encodeToString(current)
                "personalityVersion" -> 200 to "{\"version\":" + Json.encodeToString(old) + "}"
                "editPersonality" -> 200 to Json.encodeToString(snapshot(content).copy(changed = true))
                "restorePersonality" -> 200 to Json.encodeToString(snapshot(old.content).copy(changed = true))
                else -> throw AssertionError("Unexpected action")
            }
        }
        assertEquals(current, api.personality()); assertEquals(old, api.personalityVersion(old.revision))
        assertEquals(content, api.editPersonality(content, current.revision).content)
        assertEquals(old.content, api.restorePersonality(old.revision, hash(content)).content)
        assertEquals(setOf("action"), calls[0].body().keys)
        assertEquals(setOf("action", "revision"), calls[1].body().keys)
        assertEquals(setOf("action", "content", "expectedRevision"), calls[2].body().keys)
        assertEquals(content, calls[2].body().getValue("content").jsonPrimitive.content)
        assertEquals(current.revision, calls[2].body().getValue("expectedRevision").jsonPrimitive.content)
        assertEquals(setOf("action", "revision", "expectedRevision", "confirm"), calls[3].body().keys)
        assertEquals(old.revision, calls[3].body().getValue("revision").jsonPrimitive.content)
        assertEquals(hash(content), calls[3].body().getValue("expectedRevision").jsonPrimitive.content)
        assertEquals("true", calls[3].body().getValue("confirm").toString())
        calls.forEach {
            assertEquals(BuildConfig.SITE + BuildConfig.COMPANION_PATH + "api/companion", it.url.toString())
            assertEquals("app_session=alice-test-token", it.getRequestProperty("Cookie"))
            assertEquals(BuildConfig.SITE, it.getRequestProperty("Origin")); assertFalse(it.instanceFollowRedirects)
            assertFalse(it.url.toString().contains("test-token"))
        }
    }

    @Test fun staleOrBusyChangesNeverSilentlyRetryOrSubstituteTheReviewedRevision() = runBlocking {
        val calls = mutableListOf<Connection>(); var code = "PERSONALITY_CONFLICT"
        val api = api(calls) { 409 to """{"error":{"code":"$code","message":"PRIVATE DIAGNOSTIC CANARY"}}""" }
        val expected = hash("reviewed current"); val target = hash("reviewed target")
        repeat(2) {
            try { api.restorePersonality(target, expected); fail("Expected stale restore") }
            catch (error: ApiException) { assertEquals(code, error.code); assertEquals(409, error.status); assertFalse(error.toString().contains("CANARY")) }
        }
        assertArrayEquals(calls[0].sent.toByteArray(), calls[1].sent.toByteArray())
        assertEquals(expected, calls.last().body().getValue("expectedRevision").jsonPrimitive.content)
        code = "PERSONALITY_BUSY"
        try { api.editPersonality("draft stays", expected); fail("Expected busy") }
        catch (error: ApiException) { assertEquals(code, error.code); assertTrue(personalityProblem(error).contains("Finish or stop")) }
        assertEquals(3, calls.size) // Only the owner's explicit calls.
    }

    @Test fun malformedMutationAckAndInvalidLocalSelectorsNeverReportSuccessOrSendBytes() = runBlocking {
        val calls = mutableListOf<Connection>(); val good = snapshot()
        val api = api(calls) { 200 to Json.encodeToString(good) }
        try { api.editPersonality(good.content, good.revision); fail("Missing changed ACK") }
        catch (error: ApiException) { assertEquals("INVALID_RESPONSE", error.code) }
        val count = calls.size
        for (revision in listOf("", "0".repeat(63), "a".repeat(64) + "\n")) {
            try { api.personalityVersion(revision); fail("Bad selector") } catch (error: ApiException) { assertEquals("INVALID_REQUEST", error.code) }
            try { api.restorePersonality(revision, good.revision); fail("Bad target") } catch (error: ApiException) { assertEquals("INVALID_REQUEST", error.code) }
        }
        try { api.editPersonality("bad\u0000text", good.revision); fail("Bad raw bytes") } catch (error: ApiException) { assertEquals("INVALID_REQUEST", error.code) }
        assertEquals(count, calls.size)
    }

    @Test fun eachRequestCapturesItsOwnerBeforeIoAndALaterCallUsesTheNewOwner() = runBlocking {
        var owner = Session("alice-test-token", "app_session", Long.MAX_VALUE)
        val calls = mutableListOf<Connection>(); val good = snapshot()
        val api = Api(open = { url ->
            owner = Session("bob-test-token", "app_session", Long.MAX_VALUE)
            Connection(url) { 200 to Json.encodeToString(good) }.also { calls += it }
        }) { owner }
        api.personality(); api.personality()
        assertEquals("app_session=alice-test-token", calls[0].getRequestProperty("Cookie"))
        assertEquals("app_session=bob-test-token", calls[1].getRequestProperty("Cookie"))
    }

    private fun api(calls: MutableList<Connection>, reply: (JsonObject) -> Pair<Int, String>): Api =
        Api(open = { url -> Connection(url, reply).also { calls += it } }) { Session("alice-test-token", "app_session", Long.MAX_VALUE) }
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
