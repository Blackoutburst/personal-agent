package dev.blackoutburst.companion

import java.util.Base64
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class OwnerProfileProtocolTest {
    private val id = "11111111-1111-4111-8111-111111111111"
    private fun raw(extra: String = "") = """{"profile":{"id":"$id","displayName":"Alice","revision":0,"photoVersion":null},"photo":null$extra}"""
    private fun refused(text: String) {
        try { parseOwnerProfile(Json.parseToJsonElement(text)); fail("Expected a rejected profile") }
        catch (error: ApiException) { assertEquals("INVALID_RESPONSE", error.code) }
    }
    @Test fun profileIsStrictAndCannotCarryAuthorityOrPrivateContext() {
        assertEquals("Alice", parseOwnerProfile(Json.parseToJsonElement(raw())).profile.displayName)
        refused(raw(",\"ownerId\":\"foreign\"")); refused(raw(",\"memory\":\"PRIVATE\""))
        refused(raw().replace("\"revision\":0", "\"revision\":-1"))
        refused(raw().replace("Alice", "<script>"))
        refused(raw().replace(id, "foreign"))
    }
    @Test fun photoMustBeBoundedCanonicalRasterData() {
        val png = Base64.getEncoder().encodeToString(byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10))
        assertEquals(8, ownerPhotoBytes(OwnerPhoto("image/png", png)).size)
        for (photo in listOf(OwnerPhoto("image/svg+xml", png), OwnerPhoto("image/jpeg", png), OwnerPhoto("image/png", png + "\n"),
            OwnerPhoto("image/png", Base64.getEncoder().encodeToString(ByteArray(OWNER_PHOTO_LIMIT + 1))))) {
            try { ownerPhotoBytes(photo); fail("Expected refusal") } catch (error: ApiException) { assertEquals("INVALID_RESPONSE", error.code) }
        }
    }
    @Test fun missingPhotoCannotClaimAPhotoVersion() {
        refused(raw().replace("\"photoVersion\":null", "\"photoVersion\":\"" + "a".repeat(64) + "\""))
    }
}
