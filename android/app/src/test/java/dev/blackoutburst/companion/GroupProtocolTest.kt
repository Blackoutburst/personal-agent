package dev.blackoutburst.companion

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.*
import org.junit.Test

class GroupProtocolTest {
    private val group = "6f1c2a8e-3b4d-4e5f-8a6b-7c8d9e0f1a2b"
    private val message = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d"
    private val other = "1b2c3d4e-5f6a-4b7c-9d8e-9f0a1b2c3d4e"
    private val file = "2c3d4e5f-6a7b-4c8d-ae9f-0a1b2c3d4e5f"
    private val members = """[
        {"id":"owner:blackout","kind":"owner","label":"blackout","name":"Blackout","photoVersion":null,"you":true},
        {"id":"companion:blackout","kind":"companion","label":"blackout","name":"Claude-chan","look":{"character":"claude","color":"peach","outfit":"base"},"owner":"owner:blackout","yours":true},
        {"id":"owner:screamer","kind":"owner","label":"screamer","name":"Screamer","photoVersion":"${"a".repeat(64)}"},
        {"id":"companion:screamer","kind":"companion","label":"screamer","name":"Astra","look":{"character":"astra","color":"mint","outfit":"winter"},"owner":"owner:screamer"}]"""
    private fun summary(extra: String = "") = """{"id":"$group","name":"Weekend plans","members":$members,"unread":3,"notify":"all","lastSeq":7,
        "updatedAt":1762257600000,"preview":"See you there","previewName":"Astra","previewAuthorId":"companion:screamer"$extra}"""
    private fun msg(id: String = message, seq: Int = 7, extra: String = "") = """{"id":"$id","seq":$seq,"groupId":"$group",
        "author":{"kind":"companion","ownerLabel":"screamer"},"authorId":"companion:screamer","name":"Astra","text":"Hi **@Blackout**",
        "mentions":["owner:blackout"],"createdAt":1762257600000$extra}"""
    private fun json(text: String) = Json.parseToJsonElement(text)
    private fun refused(block: () -> Unit) {
        try { block(); fail("accepted a malformed reply") } catch (error: ApiException) { assertEquals("INVALID_RESPONSE", error.code) }
    }

    @Test fun parsesTheListWithBadgeOwnersAndPreviews() {
        val list = parseGroupList(json("""{"version":1,"groups":[${summary()}],"unread":3,"owners":[
            {"id":"owner:blackout","label":"blackout","name":"Blackout","companionName":"Claude-chan","you":true},
            {"id":"owner:screamer","label":"screamer","name":"Screamer","companionName":"Astra"}],"seatbelt":12}"""))
        assertEquals(3, list.unread)
        assertEquals("Weekend plans", list.groups[0].name)
        assertEquals("owner:blackout", groupSelf(list.groups[0].members))
        assertEquals("Astra: See you there", groupPreview(list.groups[0]))
        assertEquals(GroupLook("astra", "mint", "winter"), list.groups[0].members[3].look)
        assertTrue(list.owners.single { it.label == "screamer" }.let { !it.you && it.companionName == "Astra" })
        val mine = list.groups[0].copy(previewAuthorId = "owner:blackout", previewName = "Blackout")
        assertEquals("You: See you there", groupPreview(mine))
    }

    @Test fun toleratesMissingOptionalFieldsAndUnknownOnes() {
        val list = parseGroupList(json("""{"groups":[{"id":"$group","name":"G","future":{"x":1}}],"later":true}"""))
        assertEquals(0, list.unread); assertEquals("all", list.groups[0].notify); assertTrue(list.groups[0].members.isEmpty())
        assertNull(groupPreview(list.groups[0])); assertTrue(list.owners.isEmpty())
        val snapshot = parseGroupSnapshot(json("""{"group":{"id":"$group","name":"G"},"messages":[{"id":"$message","seq":1,"author":{"kind":"system"},"authorId":null,"name":"App","text":"Blackout started the group."}],"cursor":"1"}"""), group)
        assertTrue(snapshot.messages[0].system); assertFalse(snapshot.paused); assertTrue(snapshot.typing.isEmpty())
    }

    @Test fun refusesMalformedLists() {
        for (bad in listOf(
            """{"groups":[${summary()},${summary()}]}""",
            """{"groups":[${summary().replace(group, "g1")}]}""",
            """{"groups":[${summary().replace("\"notify\":\"all\"", "\"notify\":\"never\"")}]}""",
            """{"groups":[${summary().replace("\"unread\":3", "\"unread\":-1")}]}""",
            """{"groups":[${summary().replace("owner:screamer\",\"kind\":\"owner\"", "owner:Screamer!\",\"kind\":\"owner\"")}]}""",
            """{"groups":[${summary().replace("\"name\":\"Weekend plans\"", "\"name\":\" \"")}]}""",
            """{"groups":[],"owners":[{"id":"owner:a","label":"b","name":"x"}]}""",
            """{"groups":[],"unread":-2}""")) refused { parseGroupList(json(bad)) }
    }

    @Test fun parsesSnapshotsAndEventsForTheSameGroupOnly() {
        val snapshot = parseGroupSnapshot(json("""{"version":1,"group":${summary()},"messages":[${msg(other, 6)},${msg(extra = ""","replyTo":{"id":"$other","seq":6,"authorId":"owner:blackout","name":"Blackout","preview":"Are we going?"},
            "attachments":[{"id":"$file","name":"map.png","mime":"image/png","size":2048},{"id":"$message","name":"notes.pdf","mime":"application/pdf","size":10}],"feeling":"happy","proactive":true""")}],
            "cursor":"7","hasOlder":false,"typing":["owner:screamer"],"paused":false}"""), group)
        val last = snapshot.messages.last()
        assertEquals("Are we going?", last.replyTo?.preview)
        assertTrue(last.attachments[0].image); assertFalse(last.attachments[1].image)
        assertTrue(last.proactive); assertEquals(listOf("owner:blackout"), last.mentions)
        refused { parseGroupSnapshot(json("""{"group":${summary()},"messages":[],"cursor":"7"}"""), other) }
        refused { parseGroupSnapshot(json("""{"group":${summary()},"messages":[${msg()},${msg(other, 6)}],"cursor":"7"}"""), group) }
        refused { parseGroupSnapshot(json("""{"group":${summary()},"messages":[],"cursor":"-1"}"""), group) }

        val events = parseGroupEvents(json("""{"version":1,"groupId":"$group","name":"Renamed","messages":[${msg()}],"cursor":"7","lastSeq":7,"hasMore":false,
            "members":$members,"typing":["companion:screamer"],"paused":true}"""), group, "6")
        assertEquals("Renamed", events.name); assertTrue(events.paused); assertEquals(4, events.members?.size)
        refused { parseGroupEvents(json("""{"groupId":"$other","messages":[],"cursor":"6"}"""), group, "6") }
        refused { parseGroupEvents(json("""{"groupId":"$group","messages":[${msg()}],"cursor":"5"}"""), group, "6") }
        refused { parseGroupEvents(json("""{"groupId":"$group","messages":[${msg(seq = 6)}],"cursor":"7"}"""), group, "6") }
        refused { parseGroupEvents(json("""{"groupId":"$group","messages":[${msg().replace("\"authorId\":\"companion:screamer\"", "\"authorId\":\"owner:screamer\"")}],"cursor":"7"}"""), group, "6") }
        refused { parseGroupEvents(json("""{"groupId":"$group","messages":[],"cursor":"6","typing":["nobody"]}"""), group, "6") }
    }

    @Test fun smallRepliesAreCheckedAgainstTheirGroup() {
        assertEquals(GroupRead(group, 2), parseGroupRead(json("""{"version":1,"groupId":"$group","unread":2}"""), group))
        assertEquals("mentions", parseGroupSettings(json("""{"version":1,"groupId":"$group","notify":"mentions"}"""), group).notify)
        assertEquals(0, parseGroupLeft(json("""{"version":1,"left":"$group","unread":0}"""), group).unread)
        assertNull(parseGroupPhoto(json("""{"version":1,"member":"owner:screamer","photo":null}"""), "owner:screamer"))
        assertEquals("map.png", parseGroupUpload(json("""{"file":{"id":"$file","name":"map.png","mime":"image/png","size":5}}""").jsonObject).name)
        refused { parseGroupRead(json("""{"groupId":"$other","unread":0}"""), group) }
        refused { parseGroupSettings(json("""{"groupId":"$group","notify":"loud"}"""), group) }
        refused { parseGroupPhoto(json("""{"member":"owner:blackout","photo":null}"""), "owner:screamer") }
        refused { parseGroupUpload(json("""{"file":{"id":"$file","name":"../x","mime":"image/png","size":5}}""").jsonObject) }
        refused { parseGroupUpload(json("""{"file":{"id":"$file","name":"big.bin","mime":"application/octet-stream","size":${GROUP_FILE_BYTES + 1}}}""").jsonObject) }
    }

    @Test fun typingLineNamesOthersOnly() {
        val list = parseGroupList(json("""{"groups":[${summary()}]}""")).groups[0].members
        assertNull(typingLine(listOf("owner:blackout"), list, "owner:blackout"))
        assertEquals("Astra is typing…", typingLine(listOf("companion:screamer", "owner:blackout"), list, "owner:blackout"))
        assertEquals("Screamer and Astra are typing…", typingLine(listOf("owner:screamer", "companion:screamer"), list, "owner:blackout"))
        assertEquals("3 people are typing…", typingLine(listOf("owner:screamer", "companion:screamer", "companion:blackout"), list, "owner:blackout"))
        assertEquals("Someone is typing…", typingLine(listOf("owner:gone"), list, "owner:blackout"))
    }

    @Test fun mentionAutocompleteFindsAndInsertsMembers() {
        val list = parseGroupList(json("""{"groups":[${summary()}]}""")).groups[0].members
        assertEquals("", mentionQuery("Hi @", 4))
        assertEquals("As", mentionQuery("Hi @As", 6))
        assertNull(mentionQuery("mail me@As", 10))
        assertNull(mentionQuery("Hi @Astra there", 15))
        assertEquals(listOf("Astra"), mentionCandidates("as", list, "owner:blackout").map { it.name })
        assertEquals(listOf("Claude-chan", "Screamer", "Astra"), mentionCandidates("", list, "owner:blackout").map { it.name })
        assertEquals(listOf("Screamer"), mentionCandidates("scr", list, "owner:blackout").map { it.name })
        assertEquals("Hi @Astra " to 10, insertMention("Hi @As", 6, "Astra"))
        assertEquals("@Claude-chan look" to 13, insertMention("@Cl look", 3, "Claude-chan"))
        assertEquals("no mention" to 3, insertMention("no mention", 3, "Astra"))
    }

    @Test fun mergingKeepsSeqOrderWithoutDuplicates() {
        val snapshot = parseGroupSnapshot(json("""{"group":${summary()},"messages":[${msg(other, 6)}],"cursor":"6"}"""), group)
        val events = parseGroupEvents(json("""{"groupId":"$group","messages":[${msg()}],"cursor":"7"}"""), group, "6")
        val merged = mergeGroupMessages(snapshot.messages, events.messages + snapshot.messages)
        assertEquals(listOf(6L, 7L), merged.map { it.seq })
        assertSame(snapshot.messages, mergeGroupMessages(snapshot.messages, emptyList()))
    }

    @Test fun groupPushesCarryIdsAndNoText() {
        val data = mapOf("type" to "group", "group" to "1", "groupId" to group, "messageId" to message, "name" to "Weekend plans")
        assertTrue(groupPush(data))
        assertFalse(groupPush(data + ("groupId" to "nope")))
        assertFalse(groupPush(data - "group"))
        assertFalse(boardPush(data))
        assertEquals("New message", groupNotificationText(data, null))
        assertEquals("You were mentioned", groupNotificationText(data + ("mention" to "1"), null))
        val found = parseGroupEvents(json("""{"groupId":"$group","messages":[${msg()}],"cursor":"7"}"""), group, "6").messages[0]
        assertEquals("Astra: Hi @Blackout", groupNotificationText(data, found))
        assertEquals("Astra: Sent a picture", groupNotificationText(data, found.copy(text = "", attachments = listOf(GroupFile(file, "a.png", "image/png", 3)))))
    }

    @Test fun groupNamesFollowTheServerRules() {
        assertTrue(groupNameOk("Weekend plans")); assertTrue(groupNameOk("  padded  "))
        assertFalse(groupNameOk("")); assertFalse(groupNameOk("   ")); assertFalse(groupNameOk("<b>x</b>"))
        assertFalse(groupNameOk("x".repeat(61))); assertFalse(groupNameOk("tab\there"))
    }

    @Test fun postsSendTheExactPayloadAndUploadsUseGroupHeaders() = runBlocking {
        val owner = Session("synthetic-private-token", "app_session", Long.MAX_VALUE)
        val bodies = mutableListOf<JsonObject>()
        val api = Api(open = { url -> Fake(url) { body ->
            bodies += body
            when (body["action"]?.jsonPrimitive?.content) {
                "post" -> """{"version":1,"message":${msg(extra = ""","replyTo":{"id":"$other","seq":6,"authorId":"owner:screamer","name":"Screamer","preview":"?"}""")},"cursor":"7"}"""
                "list" -> throw Status404()
                else -> throw AssertionError("unexpected")
            }
        } }) { owner }
        val posted = api.groupPost(group, "stable-1", "Hi @Astra", other, listOf(file))
        assertEquals(message, posted.message.id)
        val sent = bodies.single()
        assertEquals(setOf("action", "groupId", "requestId", "text", "replyTo", "attachments"), sent.keys)
        assertEquals(other, sent["replyTo"]?.jsonPrimitive?.content)
        try { api.groups(); fail("older server") } catch (error: ApiException) { assertEquals(404, error.status) }
        try { api.groupPost(group, "stable-2", "   ", null, emptyList()); fail("empty") } catch (error: ApiException) { assertEquals("INVALID_REQUEST", error.code) }
        try { api.groupPost("not-a-group", "stable-2", "hi", null, emptyList()); fail("bad id") } catch (error: ApiException) { assertEquals("INVALID_REQUEST", error.code) }

        val source = java.io.File.createTempFile("group", ".png").apply { writeBytes(ByteArray(5)); deleteOnExit() }
        var upload: Fake? = null
        val uploads = FileTransfers({ owner }) { url -> Fake(url) { """{"file":{"id":"$file","name":"map one.png","mime":"image/png","size":5}}""" }.also { upload = it } }
        val result = uploads.groupUpload(group, "upload-key", "map one.png", source, TransferCancellation()) {}
        assertEquals(file, result.id)
        assertTrue(upload!!.url.toString().endsWith("/api/groups/files"))
        assertEquals(group, upload!!.headers["X-Group-Id"]); assertEquals("upload-key", upload!!.headers["X-Request-Id"])
        assertEquals("map%20one.png", upload!!.headers["X-File-Name"]); assertNull(upload!!.headers["X-Thread-Id"])
        assertEquals(5, upload!!.sent.size())
    }

    private class Status404 : RuntimeException()

    private class Fake(url: URL, private val answer: (JsonObject) -> String) : HttpURLConnection(url) {
        val sent = ByteArrayOutputStream()
        val headers = mutableMapOf<String, String>()
        private var status = 200
        private var reply = ""
        override fun setRequestProperty(key: String, value: String) { headers[key] = value }
        override fun getOutputStream() = sent
        override fun getResponseCode(): Int { respond(); return status }
        override fun getInputStream() = ByteArrayInputStream(reply.toByteArray())
        override fun getErrorStream() = ByteArrayInputStream(reply.toByteArray())
        override fun getHeaderField(name: String?): String? = null
        private var answered = false
        private fun respond() {
            if (answered) return
            answered = true
            val text = sent.toString(Charsets.UTF_8)
            val body = runCatching { Json.parseToJsonElement(text).jsonObject }.getOrDefault(JsonObject(emptyMap()))
            try { reply = answer(body) } catch (_: Status404) { status = 404; reply = """{"error":{"code":"NOT_FOUND","message":"Route not found."}}""" }
        }
        override fun connect() {}
        override fun disconnect() {}
        override fun usingProxy() = false
    }
}
