package dev.blackoutburst.companion

import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class OpsProtocolTest {
    private val snapshot = Json.parseToJsonElement("""{"at":1,"agents":[{"runId":"a-1","name":"coder-ops","role":"coder","model":"sonnet","state":"running","live":true,
        "ticketNumber":75,"ticketTitle":"Ops","turns":3,"maxTurns":80,"heartbeatAgeSeconds":20,"future":1}],
        "pipeline":{"todo":[],"in_progress":[{"id":"t1","number":75,"title":"Ops"}],"review":[],"blocked":[],"done":[]},
        "decisions":[{"at":1,"kind":"escalate","text":"escalated #75 to opus"}],
        "usage":{"windows":{"last24h":{"total":{"runs":1,"turns":3,"seconds":120},"models":{"sonnet":{"runs":1,"turns":3,"seconds":120}}}},"limitHits":0}}""")

    @Test fun parsesAgentsPipelineDecisionsAndUsage() {
        val result = parseOps(snapshot)
        assertEquals("coder-ops", result.agents[0].name)
        assertEquals(75, result.pipeline!!["in_progress"]!![0].number)
        assertEquals("escalate", result.decisions[0].kind)
        assertEquals(3, result.usage.windows["last24h"]!!.total.turns)
    }

    @Test fun anUnreachableBoardLeavesThePipelineNull() {
        assertNull(parseOps(Json.parseToJsonElement("""{"at":1,"agents":[],"pipeline":null,"decisions":[],"usage":{}}""")).pipeline)
    }

    @Test fun parsesATicketHistoryAndRefusesAWrongShape() {
        val history = parseOpsHistory(Json.parseToJsonElement("""{"ticketNumber":75,"title":"Ops","messages":[{"id":"m","at":"x","author":"C-chan","text":"accepted"}]}"""))
        assertEquals("accepted", history.messages[0].text)
        try { parseOps(Json.parseToJsonElement("""{"agents":"nope"}""")); fail() } catch (error: ApiException) { assertEquals("INVALID_RESPONSE", error.code) }
    }

    @Test fun formatsDurations() {
        assertEquals("30 s", opsDuration(30)); assertEquals("10 min", opsDuration(600)); assertEquals("2.0 h", opsDuration(7200))
    }
}
