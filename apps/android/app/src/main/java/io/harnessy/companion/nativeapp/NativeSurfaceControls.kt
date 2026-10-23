package io.harnessy.companion.nativeapp

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** The raised circular control retains a 48 dp touch target in either theme. */
@Composable
internal fun NativeFloatingIconButton(
    icon: ImageVector,
    contentDescription: String,
    onClick: () -> Unit,
    testTag: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    iconSize: Dp = 20.dp,
) {
    Surface(shape = CircleShape, color = MaterialTheme.colorScheme.surface, shadowElevation = 2.dp,
        modifier = modifier.size(48.dp)) {
        IconButton(onClick = onClick, enabled = enabled, modifier = Modifier.fillMaxSize().testTag(testTag)) {
            Icon(icon, contentDescription, Modifier.size(iconSize))
        }
    }
}

/** Flat bands show press, hover and keyboard focus; null selection denotes an ordinary action. */
@Composable
internal fun NativePressableRow(
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    selected: Boolean? = null,
    contentPadding: PaddingValues = PaddingValues(horizontal = 20.dp),
    spacing: Dp = 14.dp,
    content: @Composable RowScope.() -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val focused by interaction.collectIsFocusedAsState()
    val hovered by interaction.collectIsHoveredAsState()
    val band = when {
        enabled && (pressed || focused || hovered) -> MaterialTheme.colorScheme.surfaceContainerHighest
        selected == true -> MaterialTheme.colorScheme.surfaceContainer
        else -> Color.Transparent
    }
    val action = if (selected == null) {
        Modifier.clickable(enabled = enabled, role = Role.Button, onClick = onClick,
            interactionSource = interaction, indication = null)
    } else {
        Modifier.selectable(selected = selected, enabled = enabled, role = Role.Button, onClick = onClick,
            interactionSource = interaction, indication = null)
    }
    Box(modifier.then(action).background(band)) {
        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(contentPadding),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(spacing),
            content = content)
    }
}
