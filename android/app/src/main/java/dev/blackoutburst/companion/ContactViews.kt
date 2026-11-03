package dev.blackoutburst.companion

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

@Composable
fun ContactPanel(model: CompanionModel, state: UiState) {
    val ink = MaterialTheme.colorScheme.onSurface
    val soft = MaterialTheme.colorScheme.onSurfaceVariant
    val locked = state.contactsBusy || state.contactsLoading || !state.contactsConfirmed
    LaunchedEffect(state.scope) { model.loadContacts() }
    Column(Modifier.fillMaxWidth()) {
        Text("Companion contacts", fontSize = 20.sp, fontWeight = FontWeight.Bold, color = ink)
        Text("Both owners must enable contact. Ask your own companion in chat to send a specific message; it does not reply to peers on its own.", color = soft)
        Text("Turning contact off stops new exchanges. Delivered messages stay in each owner's chat.", color = soft, fontSize = 13.sp)
        TextButton(enabled = !state.contactsBusy, onClick = { model.loadContacts() }) { Text("Reload contacts") }
        if (state.contactsLoading) Text("Loading contacts…", color = soft)
        if (state.contactsBusy) Text("Saving contact setting…", color = soft)
        state.contactsError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        state.contactsNotice?.let { Text(it, color = soft) }
        if (!state.contactsConfirmed && !state.contactsLoading && state.contacts != null)
            Text("Last confirmed settings shown. Reload before changing them.", color = soft, fontSize = 12.sp)
        if (state.contacts?.isEmpty() == true && state.contactsConfirmed) Text("No other companions are available.", color = soft)
        state.contacts.orEmpty().forEach { contact ->
            Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(contact.name.ifBlank { "Companion" }, color = ink, fontWeight = FontWeight.Bold)
                    Text("${contact.ownerLabel.ifBlank { "Owner" }}'s companion", color = soft, fontSize = 13.sp)
                    Text(when {
                        !contact.enabled -> "Off for your companion"
                        !contact.peerEnabled -> "Waiting for the other owner to enable contact"
                        else -> "Both sides enabled at last refresh"
                    }, color = soft, fontSize = 12.sp)
                }
                Switch(checked = contact.enabled, enabled = !locked,
                    onCheckedChange = { model.setContact(contact.id, it, contact.revision, state.scope) },
                    modifier = Modifier.semantics { contentDescription = "Allow contact with ${contact.name.ifBlank { "Companion" }}" })
            }
        }
    }
}

@Composable
fun PeerCard(message: Message) {
    val peer = message.peer ?: return
    val shape = RoundedCornerShape(14.dp)
    val colors = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().background(colors.surfaceVariant, shape).border(1.dp, colors.outlineVariant, shape).padding(14.dp)) {
        Text(peerAttribution(peer), color = colors.onSurfaceVariant, fontWeight = FontWeight.Bold, fontSize = 13.sp)
        // Intentionally plain Text: peer text cannot create links, intents, file controls or app actions.
        Text(message.text, Modifier.padding(top = 6.dp), color = colors.onSurface, fontSize = 16.sp, lineHeight = 22.sp)
        Spacer(Modifier.height(4.dp))
        val sent = runCatching { DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM)
            .format(Instant.parse(peer.sentAtISO).atZone(ZoneId.systemDefault())) }.getOrDefault(peer.sentAtISO)
        Text(sent, color = colors.onSurfaceVariant, fontSize = 11.sp)
    }
}
