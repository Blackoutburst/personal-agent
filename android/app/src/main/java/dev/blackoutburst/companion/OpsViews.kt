package dev.blackoutburst.companion

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay

/** The Ops tab (#75): live agents, ticket pipeline, C-chan's decisions, usage and a ticket's Board history. Read-only. */
@Composable
fun OpsScreen(model: CompanionModel, state: UiState) {
    val ink = MaterialTheme.colorScheme.onSurface
    val soft = MaterialTheme.colorScheme.onSurfaceVariant
    // Opening the tab loads it and refreshes it every 10 seconds while it stays open.
    LaunchedEffect(state.scope) { while (true) { model.loadOps(); delay(10_000) } }
    val ops = state.ops
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp)) {
        Text("Ops", fontSize = 24.sp, fontWeight = FontWeight.Bold, color = ink)
        Text("C-chan's agents, read-only. Updates by itself.", color = soft)
        ActionButton(onClick = { model.loadOps() }, modifier = Modifier.padding(top = 8.dp)) { Text("Refresh") }
        state.opsError?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }
        if (ops == null) { if (state.opsError == null) Text("Loading…", color = soft); return@Column }
        Section("Agents")
        if (ops.agents.isEmpty()) Text("No agents yet.", color = soft)
        for (agent in ops.agents) {
            val ticket = agent.ticketNumber?.let { "#$it ${agent.ticketTitle}" } ?: "no ticket"
            val beat = agent.heartbeatAgeSeconds?.let { " · heartbeat ${opsDuration(it.toLong())} ago" } ?: ""
            Text("${agent.name} (${agent.role}) · ${agent.model} · ${agent.state}", color = ink, fontWeight = if (agent.live) FontWeight.Bold else FontWeight.Normal)
            Text("$ticket · ${agent.turns}${agent.maxTurns?.let { "/$it" } ?: ""} turns$beat", color = soft, fontSize = 13.sp, modifier = Modifier.padding(bottom = 6.dp))
        }
        Section("Pipeline")
        val pipeline = ops.pipeline
        if (pipeline == null) Text("The Board is not reachable right now.", color = soft)
        else for ((key, label) in OPS_COLUMNS) {
            val tickets = pipeline[key].orEmpty()
            Text("$label (${tickets.size})", color = ink, fontWeight = FontWeight.Medium, modifier = Modifier.padding(top = 4.dp))
            for (ticket in tickets.take(30)) {
                Text("#${ticket.number ?: "?"} ${ticket.title}", color = soft, fontSize = 14.sp,
                    modifier = Modifier.fillMaxWidth().clickable { model.loadOpsHistory(ticket) }.padding(vertical = 3.dp))
            }
        }
        state.opsHistory?.let { history ->
            Section("Board messages · #${history.ticketNumber ?: "?"} ${history.title}")
            if (history.messages.isEmpty()) Text("No messages on this ticket.", color = soft)
            for (message in history.messages) Text("${message.author.ifBlank { "unknown" }}: ${message.text}", color = ink, fontSize = 14.sp, modifier = Modifier.padding(bottom = 4.dp))
            ActionButton(onClick = { model.closeOpsHistory() }) { Text("Close") }
        }
        Section("C-chan's decisions")
        if (ops.decisions.isEmpty()) Text("No decisions recorded yet.", color = soft)
        for (decision in ops.decisions.take(40)) Text("${decision.kind} · ${decision.text}", color = ink, fontSize = 14.sp, modifier = Modifier.padding(bottom = 3.dp))
        Section("Usage")
        for ((key, label) in listOf("last24h" to "Last 24 hours", "last7d" to "Last 7 days")) {
            val window = ops.usage.windows[key] ?: continue
            Text("$label: ${window.total.runs} runs, ${window.total.turns} turns, ${opsDuration(window.total.seconds)}", color = ink)
            for ((name, row) in window.models) Text("$name: ${row.runs} runs, ${row.turns} turns, ${opsDuration(row.seconds)}", color = soft, fontSize = 13.sp)
        }
        if (ops.usage.limitHits > 0) Text("Plan limit hit ${ops.usage.limitHits} times this week.", color = ink)
        Text("Max plan: turns and run time per model; token counts are not reported.", color = soft, fontSize = 12.sp)
    }
}

@Composable
private fun Section(title: String) {
    Text(title, fontSize = 18.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.padding(top = 16.dp, bottom = 4.dp))
}
