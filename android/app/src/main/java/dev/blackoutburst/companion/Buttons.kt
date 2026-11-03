package dev.blackoutburst.companion

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/** Every secondary action in the app: a real bordered pill button, never bare clickable text (matches the web). */
@Composable
fun ActionButton(onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, content: @Composable RowScope.() -> Unit) {
    val colors = MaterialTheme.colorScheme
    OutlinedButton(onClick, modifier, enabled = enabled, shape = RoundedCornerShape(50),
        border = BorderStroke(1.dp, colors.outlineVariant),
        colors = ButtonDefaults.outlinedButtonColors(containerColor = colors.surface, contentColor = colors.onSurface),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp), content = content)
}
