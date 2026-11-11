package dev.blackoutburst.companion

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

// The Ops tab (#75, docs/OPS.md): a read-only view of C-chan's agents, from POST api/studio { action: "ops" }. Every
// field is optional so a server that adds fields (or lacks some) still parses; all text is shown as plain text.
private val opsJson = Json { ignoreUnknownKeys = true; explicitNulls = false; isLenient = false }

@Serializable data class OpsAgent(
    val runId: String = "", val name: String = "", val role: String = "", val model: String = "", val state: String = "",
    val live: Boolean = false, val ticketNumber: Int? = null, val ticketTitle: String = "", val turns: Int = 0,
    val maxTurns: Int? = null, val heartbeatAgeSeconds: Int? = null, val error: String? = null,
)
@Serializable data class OpsTicket(val id: String = "", val number: Int? = null, val title: String = "")
@Serializable data class OpsDecision(val at: Long = 0, val kind: String = "", val text: String = "")
@Serializable data class OpsTotals(val runs: Int = 0, val turns: Int = 0, val seconds: Long = 0)
@Serializable data class OpsWindow(val total: OpsTotals = OpsTotals(), val models: Map<String, OpsTotals> = emptyMap())
@Serializable data class OpsUsage(val windows: Map<String, OpsWindow> = emptyMap(), val limitHits: Int = 0)
@Serializable data class OpsSnapshot(
    val at: Long = 0, val agents: List<OpsAgent> = emptyList(), val pipeline: Map<String, List<OpsTicket>>? = null,
    val decisions: List<OpsDecision> = emptyList(), val usage: OpsUsage = OpsUsage(),
)
@Serializable data class OpsMessage(val id: String = "", val at: Long? = null, val author: String = "", val text: String = "")
@Serializable data class OpsHistory(val ticketNumber: Int? = null, val title: String = "", val messages: List<OpsMessage> = emptyList())

/** The pipeline columns in display order. */
val OPS_COLUMNS = listOf("todo" to "To do", "in_progress" to "In progress", "review" to "Review", "blocked" to "Blocked", "done" to "Done")

internal fun parseOps(value: JsonElement): OpsSnapshot = try {
    val result = opsJson.decodeFromJsonElement(OpsSnapshot.serializer(), value)
    if (result.agents.size > 100 || result.decisions.size > 200 || (result.pipeline?.values?.sumOf { it.size } ?: 0) > 5000) throw ApiException("INVALID_RESPONSE")
    result
} catch (error: ApiException) { throw error } catch (_: Exception) { throw ApiException("INVALID_RESPONSE") }

internal fun parseOpsHistory(value: JsonElement): OpsHistory = try {
    val result = opsJson.decodeFromJsonElement(OpsHistory.serializer(), value)
    if (result.messages.size > 200) throw ApiException("INVALID_RESPONSE")
    result
} catch (error: ApiException) { throw error } catch (_: Exception) { throw ApiException("INVALID_RESPONSE") }

/** "45 s", "12 min", "1.5 h". */
fun opsDuration(seconds: Long): String = when {
    seconds < 90 -> "$seconds s"
    seconds < 5400 -> "${(seconds + 30) / 60} min"
    else -> "${Math.round(seconds / 360.0) / 10.0} h"
}
