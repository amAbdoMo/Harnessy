package io.harnessy.companion.nativeapp

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.harnessy.companion.R

/** Uses Harnessy branding; search and close operate only on the current native sidebar. */
@Composable
internal fun NativeSidebarHeader(foreground: Boolean, search: () -> Unit, close: (() -> Unit)?) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val shortWindow = maxHeight < 240.dp
        val showWordmark = maxWidth >= 280.dp && !shortWindow
        val brand = stringResource(R.string.native_brand_name)
        Column(Modifier.fillMaxWidth()) {
            Row(Modifier.fillMaxWidth().heightIn(min = if (shortWindow) 48.dp else 56.dp).padding(start = 16.dp, end = 8.dp),
                verticalAlignment = Alignment.CenterVertically) {
                Image(painterResource(R.drawable.harnessy_brand), if (showWordmark) null else brand, Modifier.size(28.dp))
                if (showWordmark) {
                    Spacer(Modifier.width(10.dp))
                    Text(brand, style = MaterialTheme.typography.titleLarge.copy(
                        fontSize = 21.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
                        modifier = Modifier.weight(1f).testTag("sidebar_wordmark"), maxLines = 1, overflow = TextOverflow.Ellipsis)
                } else Spacer(Modifier.weight(1f))
                Spacer(Modifier.width(12.dp))
                NativeFloatingIconButton(Icons.Default.Search, stringResource(R.string.native_search_conversations),
                    search, testTag = "sidebar_search", enabled = foreground)
                if (close != null) {
                    Spacer(Modifier.width(4.dp))
                    NativeFloatingIconButton(Icons.Default.Close, stringResource(R.string.native_close_navigation),
                        close, testTag = "close_sessions", enabled = foreground)
                }
            }
            HorizontalDivider(Modifier.padding(horizontal = 12.dp), color = MaterialTheme.colorScheme.outlineVariant)
        }
    }
}
