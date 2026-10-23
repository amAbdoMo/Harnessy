package io.harnessy.companion.nativeapp

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.harnessy.companion.R
import io.harnessy.companion.presentation.DisplayModels.Role
import io.harnessy.companion.presentation.DisplayModels.TextRow

internal data class ActivityDisclosure(val expanded: Boolean, val toggle: () -> Unit)

@Composable
internal fun NativeToolActivity(group: TranscriptEntry.Activity, disclosure: ActivityDisclosure, bodyHeight: Dp) {
    Column(Modifier.fillMaxWidth().testTag(group.key)) {
        ActivityHeader(group, disclosure)
        if (disclosure.expanded) {
            SelectionContainer {
                Column(Modifier.fillMaxWidth().heightIn(max = bodyHeight)
                    .verticalScroll(rememberScrollState()).testTag("activity_body:${group.rows.first().id}"),
                    verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    group.rows.forEach { NativeActivityEvent(it) }
                    Text(stringResource(R.string.native_activity_limits),
                        modifier = Modifier.padding(start = 26.dp, top = 4.dp, bottom = 8.dp),
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable
private fun ActivityHeader(group: TranscriptEntry.Activity, disclosure: ActivityDisclosure) {
    val state = stringResource(if (disclosure.expanded) R.string.native_expanded else R.string.native_collapsed)
    val angle by animateFloatAsState(if (disclosure.expanded) 180f else 0f,
        tween(100, easing = CubicBezierEasing(0.25f, 0.1f, 0.25f, 1f)), label = "activity disclosure")
    NativePressableRow(true, disclosure.toggle,
        modifier = Modifier.testTag("activity_toggle:${group.rows.first().id}").semantics { stateDescription = state },
        contentPadding = PaddingValues(vertical = 4.dp), spacing = 8.dp) {
        val glyphs = group.rows.map { toolGlyph(it.text) }.distinct()
        Icon(painterResource(if (glyphs.size == 1) glyphs.single() else R.drawable.native_tool_generic), null, Modifier.size(18.dp),
            tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(stringResource(R.string.native_activity), style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(pluralStringResource(R.plurals.native_activity_tools, group.rows.size, group.rows.size), style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        Box(Modifier.size(24.dp).testTag("activity_chevron:${group.rows.first().id}"), contentAlignment = Alignment.Center) {
            Icon(Icons.Default.KeyboardArrowDown, null, Modifier.size(18.dp).rotate(angle),
                tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
internal fun NativeActivityEvent(row: TextRow) {
    val author = stringResource(roleText(row.role))
    Row(Modifier.fillMaxWidth().testTag("message_${row.id}").padding(vertical = 4.dp)
        .semantics { stateDescription = author },
        verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (row.role == Role.TOOL) {
            Icon(painterResource(toolGlyph(row.text)), null, Modifier.size(18.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            Icon(Icons.Default.Info, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text(row.text, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall,
            fontFamily = if (row.role == Role.TOOL) FontFamily.Monospace else FontFamily.Default,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
