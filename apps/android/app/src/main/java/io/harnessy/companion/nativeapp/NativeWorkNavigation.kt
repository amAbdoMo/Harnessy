package io.harnessy.companion.nativeapp

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.harnessy.companion.R

internal enum class WorkDestination(val label: Int, val icon: ImageVector, val tag: String) {
    WORK(R.string.native_work, Icons.Default.Home, "work_tab"),
    BROWSER(R.string.native_browser_share_title, Icons.Default.PlayArrow, "live_browser_tab"),
    SETTINGS(R.string.native_settings, Icons.Default.Settings, "settings_tab"),
}

/** The bar exposes only the paired client's primary destinations. */
@Composable
internal fun NativeWorkNavigation(
    selected: WorkDestination,
    browserAvailable: Boolean,
    navigate: (WorkDestination) -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    NavigationBar(Modifier.testTag("work_bottom_navigation"), containerColor = colors.surface, tonalElevation = 0.dp) {
        WorkDestination.entries.forEach { destination ->
            NavigationBarItem(
                selected = destination == selected,
                onClick = { if (destination != selected) navigate(destination) },
                enabled = destination != WorkDestination.BROWSER || browserAvailable,
                modifier = Modifier.testTag(destination.tag),
                icon = { Icon(destination.icon, contentDescription = null) },
                label = { Text(stringResource(destination.label), maxLines = 2, overflow = TextOverflow.Ellipsis) },
                colors = NavigationBarItemDefaults.colors(indicatorColor = colors.primaryContainer,
                    selectedIconColor = colors.primary, selectedTextColor = colors.onSurface),
            )
        }
    }
}
