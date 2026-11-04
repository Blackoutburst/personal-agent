package dev.blackoutburst.companion

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** The Board tab's list (#55): one row per Board ticket or thread, newest first, with unread counts. */
@Composable
internal fun BoardScreen(model: CompanionModel, state: UiState) {
    val tones = LocalTones.current
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 8.dp)) {
        Text("Board", fontSize = 26.sp, fontWeight = FontWeight.ExtraBold, color = tones.ink)
        Text("Board messages from ${state.name}, one conversation per ticket. Answer inside one and ${state.name} knows which ticket it is about.",
            color = tones.soft, fontSize = 14.sp)
        Row(Modifier.padding(vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for ((archived, label) in listOf(false to "Open", true to "Archived")) {
                val selected = state.boardShowArchived == archived
                Text(label, Modifier.clip(RoundedCornerShape(50)).background(if (selected) tones.card else Color.Transparent)
                    .clickable(role = Role.Tab, enabled = !state.boardBusy) { model.loadBoard(archived) }.padding(horizontal = 16.dp, vertical = 8.dp),
                    color = if (selected) tones.ink else tones.soft, fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium)
            }
        }
        state.boardError?.let { Text(it, color = tones.danger, fontSize = 14.sp) }
        val topics = state.boardTopics
        when {
            topics == null -> Text(if (state.boardLoading) "Loading…" else "", color = tones.soft)
            topics.isEmpty() -> Text(if (state.boardShowArchived) "Nothing archived yet. Mark a topic done to keep it here."
                else "No Board messages. When ${state.name} has something about a ticket, it shows up here, one conversation per ticket.",
                color = tones.soft, modifier = Modifier.padding(top = 12.dp))
            else -> LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(topics, key = { it.threadId }) { topic -> BoardRow(model, state, topic) }
            }
        }
    }
}

@Composable
private fun BoardRow(model: CompanionModel, state: UiState, topic: BoardTopic) {
    val tones = LocalTones.current
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(tones.card)
        .clickable { model.openBoardTopic(topic.threadId) }.padding(14.dp, 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(topic.label, Modifier.weight(1f), color = tones.ink, fontWeight = if (topic.unread > 0) FontWeight.ExtraBold else FontWeight.SemiBold,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(boardWhen(topic.updatedAt), color = tones.soft, fontSize = 12.sp)
            }
            boardPreview(topic)?.let { Text(it, color = tones.soft, fontSize = 14.sp, maxLines = 2, overflow = TextOverflow.Ellipsis) }
        }
        if (topic.unread > 0) {
            Spacer(Modifier.size(8.dp))
            UnreadDot(topic.unread)
        }
        Spacer(Modifier.size(8.dp))
        ActionButton(enabled = !state.boardBusy, onClick = { model.archiveBoardTopic(topic.threadId, !topic.archived) }) {
            Text(if (topic.archived) "Reopen" else "Done")
        }
    }
}

@Composable
internal fun UnreadDot(count: Int) {
    Box(Modifier.clip(RoundedCornerShape(50)).background(Color(0xFFEE8F64)).padding(horizontal = 7.dp, vertical = 2.dp)
        .semantics { contentDescription = "$count unread" }) {
        Text(if (count > 99) "99+" else count.toString(), color = Color(0xFF3A2E39), fontSize = 12.sp, fontWeight = FontWeight.Bold)
    }
}

/** In a Board sub-conversation: its topic, the way back to the list, and Done / Reopen. */
@Composable
internal fun BoardTopicBar(model: CompanionModel, state: UiState, threadId: String) {
    val tones = LocalTones.current
    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp).clip(RoundedCornerShape(16.dp)).background(tones.card).padding(8.dp, 4.dp),
        verticalAlignment = Alignment.CenterVertically) {
        ActionButton(onClick = { model.leaveBoardTopic() }) { Text("‹ Board") }
        Spacer(Modifier.size(8.dp))
        Text(state.boardLabel ?: "Board", Modifier.weight(1f), color = tones.ink, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Spacer(Modifier.size(8.dp))
        val done = !state.boardArchivedTopic
        ActionButton(enabled = !state.boardBusy, onClick = { model.archiveBoardTopic(threadId, done) { if (done) model.leaveBoardTopic() } }) {
            Text(if (done) "Done" else "Reopen")
        }
    }
}

private fun boardWhen(millis: Long): String {
    if (millis <= 0) return ""
    val zone = ZoneId.systemDefault()
    val time = Instant.ofEpochMilli(millis).atZone(zone)
    return if (time.toLocalDate() == LocalDate.now(zone)) DateTimeFormatter.ofPattern("HH:mm").format(time)
    else DateTimeFormatter.ofPattern("d MMM").format(time)
}
