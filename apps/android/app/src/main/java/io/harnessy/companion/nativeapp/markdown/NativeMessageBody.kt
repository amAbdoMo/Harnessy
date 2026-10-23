package io.harnessy.companion.nativeapp.markdown

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

/**
 * Selectable, native Material 3 Markdown for already-approved text (at most 8192 UTF-8 bytes).
 * Pending/unsupported/budget-limited content displays the unchanged literal, with no active links
 * or remote images. Quoted passages render as indented text behind a theme-colored rail, and
 * thematic breaks as a divider. Parsing/projection runs on Default and is cancelled on revision,
 * lifecycle stop, or disposal. No message content enters saved state, and no previous revisions
 * are cached.
 *
 * @param text Bounded history/progress text supplied by the parent; no raw tool data is fetched.
 * @param modifier Applied once to the body container.
 */
@Composable
fun NativeMessageBody(text: String, modifier: Modifier = Modifier) {
    val owner = LocalLifecycleOwner.current
    val lifecycleState by owner.lifecycle.currentStateAsState()
    val active = lifecycleState.isAtLeast(Lifecycle.State.STARTED)
    key(text, owner, active) {
        val result by produceState<NativeMarkdownResult?>(null, text, owner, active) {
            if (active) {
                value = withContext(Dispatchers.Default) {
                    val parsingContext = coroutineContext
                    parseNativeMarkdown(text, checkCancelled = { parsingContext.ensureActive() })
                }
            }
        }
        SelectionContainer(modifier) {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                when (val body = result) {
                    null -> Text(text, style = MaterialTheme.typography.bodyLarge)
                    is NativeMarkdownResult.Literal -> Text(body.text, style = MaterialTheme.typography.bodyLarge)
                    is NativeMarkdownResult.Formatted -> MarkdownBlocks(body.blocks)
                }
            }
        }
    }
}

@Composable
private fun MarkdownBlocks(blocks: List<NativeMarkdownBlock>) {
    blocks.forEach { block ->
        when (block) {
            is NativeMarkdownBlock.Prose -> MarkdownProse(block)
            is NativeMarkdownBlock.CodeBlock -> MarkdownCode(block)
            is NativeMarkdownBlock.LiteralBlock -> Text(block.text, style = MaterialTheme.typography.bodyLarge)
            is NativeMarkdownBlock.ListBlock -> {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    block.items.forEachIndexed { index, item ->
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            val marker = nativeMarkdownListMarker(block.orderedStart, index)
                            Text(marker, style = MaterialTheme.typography.bodyLarge)
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                MarkdownBlocks(item)
                            }
                        }
                    }
                }
            }
            is NativeMarkdownBlock.Quote -> MarkdownQuote(block)
            NativeMarkdownBlock.Divider -> HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        }
    }
}

/** Quoted content keeps its own typography, indented behind a theme-colored rail. */
@Composable
private fun MarkdownQuote(block: NativeMarkdownBlock.Quote) {
    Row(Modifier.height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.width(3.dp).fillMaxHeight().background(MaterialTheme.colorScheme.primary))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            MarkdownBlocks(block.blocks)
        }
    }
}

@Composable
private fun MarkdownProse(block: NativeMarkdownBlock.Prose) {
    val codeBackground = MaterialTheme.colorScheme.surfaceContainerHigh
    val annotated = buildAnnotatedString {
        block.runs.forEach { run ->
            withStyle(SpanStyle(
                fontWeight = if (run.strong) FontWeight.Bold else null,
                fontStyle = if (run.emphasis) FontStyle.Italic else null,
                fontFamily = if (run.code) FontFamily.Monospace else null,
                background = if (run.code) codeBackground else Color.Unspecified,
            )) { append(run.text) }
        }
    }
    val typography = MaterialTheme.typography
    val style = when (block.headingLevel) {
        1 -> typography.titleLarge
        2 -> typography.titleLarge.copy(fontSize = 18.sp, lineHeight = 24.sp)
        3 -> typography.titleMedium
        4 -> typography.bodyLarge.copy(fontWeight = FontWeight.Medium)
        5 -> typography.bodyMedium.copy(fontWeight = FontWeight.Medium)
        6 -> typography.labelLarge
        else -> typography.bodyLarge
    }
    Text(annotated, style = style,
        modifier = if (block.headingLevel != null) Modifier.semantics { heading() } else Modifier)
}

@Composable
private fun MarkdownCode(block: NativeMarkdownBlock.CodeBlock) {
    Surface(Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = MaterialTheme.shapes.small) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            block.info?.let { info ->
                Text(info, style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(block.text, modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                style = MaterialTheme.typography.bodyMedium, fontFamily = FontFamily.Monospace, softWrap = false)
        }
    }
}
