package io.harnessy.companion.nativeapp.markdown

import org.commonmark.node.BlockQuote
import org.commonmark.node.BulletList
import org.commonmark.node.Code
import org.commonmark.node.Document
import org.commonmark.node.Emphasis
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.HardLineBreak
import org.commonmark.node.Heading
import org.commonmark.node.HtmlBlock
import org.commonmark.node.HtmlInline
import org.commonmark.node.Image
import org.commonmark.node.IndentedCodeBlock
import org.commonmark.node.Link
import org.commonmark.node.LinkReferenceDefinition
import org.commonmark.node.ListItem
import org.commonmark.node.Node
import org.commonmark.node.OrderedList
import org.commonmark.node.Paragraph
import org.commonmark.node.SoftLineBreak
import org.commonmark.node.StrongEmphasis
import org.commonmark.node.Text
import org.commonmark.node.ThematicBreak
import org.commonmark.parser.Parser

/** Safety ceilings may be lowered, but not raised beyond this bounded presentation's defaults. */
data class NativeMarkdownLimits(
    val maxAstDepth: Int = 32,
    val maxAstNodes: Int = 1024,
    val maxOutputNodes: Int = 1024,
    val maxOutputChars: Int = 16384,
) {
    init {
        require(maxAstDepth in 1..32)
        require(maxAstNodes in 1..1024)
        require(maxOutputNodes in 1..1024)
        require(maxOutputChars in 1..16384)
    }
}

/** A complete projection, or the unchanged input; partial projections are never published. */
sealed interface NativeMarkdownResult {
    data class Formatted(val blocks: List<NativeMarkdownBlock>) : NativeMarkdownResult
    data class Literal(val text: String, val reason: NativeMarkdownFallback) : NativeMarkdownResult
}

enum class NativeMarkdownFallback { UNSUPPORTED_CONTENT, BUDGET_EXCEEDED }

/** Only text and typography reach the UI. There are no URI actions, HTML, or image resources. */
sealed interface NativeMarkdownBlock {
    data class Prose(val runs: List<NativeMarkdownRun>, val headingLevel: Int? = null) : NativeMarkdownBlock
    data class CodeBlock(val text: String, val info: String? = null) : NativeMarkdownBlock
    data class LiteralBlock(val text: String) : NativeMarkdownBlock
    data class ListBlock(
        val orderedStart: Int?,
        val items: List<List<NativeMarkdownBlock>>,
    ) : NativeMarkdownBlock

    /** Quoted content keeps its own blocks, so nested quotes keep their inner Markdown. */
    data class Quote(val blocks: List<NativeMarkdownBlock>) : NativeMarkdownBlock

    /** A thematic break carries no content of its own. */
    data object Divider : NativeMarkdownBlock
}

data class NativeMarkdownRun(
    val text: String,
    val emphasis: Boolean = false,
    val strong: Boolean = false,
    val code: Boolean = false,
)

internal fun nativeMarkdownListMarker(orderedStart: Int?, itemIndex: Int): String =
    orderedStart?.let { "${it.toLong() + itemIndex}." } ?: "•"

/**
 * Projects CommonMark's real AST without HTML conversion or external operations.
 *
 * @param text Already-approved history text, at most 8192 UTF-8 bytes. Oversized input is a caller error.
 * @param limits Complete-AST and complete-output ceilings. Saturation preserves the original literal.
 * @param checkCancelled Optional cooperative cancellation check; its exceptions propagate unchanged.
 * @return Immutable-by-ownership text projection. Unsupported AST nodes preserve the entire source.
 *
 * Call off the UI thread. CommonMark's synchronous parse is bounded by the input, but cannot be
 * interrupted internally; cancellation is checked before/after it and throughout projection.
 * HTML literals are displayed verbatim. Links and images become label/alt plus destination and
 * optional title text, never actions. Code retains the parser's literal, including final newlines;
 * inline-code whitespace follows CommonMark. Code typography is supported, not syntax highlighting.
 * Block quotes preserve inner typography; thematic breaks render as dividers. Reference definitions
 * remain visible as inert text, including definitions that no link references.
 */
fun parseNativeMarkdown(
    text: String,
    limits: NativeMarkdownLimits = NativeMarkdownLimits(),
    checkCancelled: () -> Unit = {},
): NativeMarkdownResult {
    checkCancelled()
    require(text.length <= 8192 && text.toByteArray(Charsets.UTF_8).size <= 8192) {
        "Native Markdown requires already-bounded history text"
    }
    val root = Parser.builder().build().parse(text)
    checkCancelled()
    val rejection = inspectAst(root, limits, checkCancelled)
    if (rejection != null) return NativeMarkdownResult.Literal(text, rejection)
    return try {
        val blocks = Projection(limits, checkCancelled).blocks(root)
        checkCancelled()
        NativeMarkdownResult.Formatted(blocks)
    } catch (exceeded: ProjectionBudgetExceeded) {
        checkCancelled()
        NativeMarkdownResult.Literal(text, NativeMarkdownFallback.BUDGET_EXCEEDED)
    }
}

/** Iterative inspection precedes recursive projection, so hostile depth never reaches recursion. */
private fun inspectAst(
    root: Node,
    limits: NativeMarkdownLimits,
    checkCancelled: () -> Unit,
): NativeMarkdownFallback? {
    var node: Node? = root
    var depth = 0
    var count = 0
    while (node != null) {
        checkCancelled()
        count += 1
        if (count > limits.maxAstNodes || depth > limits.maxAstDepth) {
            return NativeMarkdownFallback.BUDGET_EXCEEDED
        }
        when (node) {
            is Document, is Paragraph, is Heading, is BulletList, is OrderedList, is ListItem,
            is FencedCodeBlock, is IndentedCodeBlock, is HtmlBlock, is BlockQuote, is ThematicBreak,
            is Text, is Emphasis, is StrongEmphasis, is Code, is SoftLineBreak, is HardLineBreak,
            is Link, is LinkReferenceDefinition, is Image, is HtmlInline -> Unit
            else -> return NativeMarkdownFallback.UNSUPPORTED_CONTENT
        }
        if (node.firstChild != null) {
            node = node.firstChild
            depth += 1
        } else {
            while (node != null && node !== root && node.next == null) {
                node = node.parent
                depth -= 1
            }
            node = if (node === root) null else node?.next
        }
    }
    return null
}

private class ProjectionBudgetExceeded : RuntimeException()

private class Projection(
    private val limits: NativeMarkdownLimits,
    private val checkCancelled: () -> Unit,
) {
    private var outputNodes = 0
    private var outputChars = 0

    private fun reserveNode() {
        checkCancelled()
        if (outputNodes >= limits.maxOutputNodes) throw ProjectionBudgetExceeded()
        outputNodes += 1
    }

    private fun reserveText(text: String) {
        checkCancelled()
        if (text.length > limits.maxOutputChars - outputChars) throw ProjectionBudgetExceeded()
        outputChars += text.length
    }

    fun blocks(parent: Node): List<NativeMarkdownBlock> {
        val result = mutableListOf<NativeMarkdownBlock>()
        var child = parent.firstChild
        while (child != null) {
            reserveNode()
            result += block(child)
            child = child.next
        }
        return result.toList()
    }

    private fun block(node: Node): NativeMarkdownBlock = when (node) {
        is Paragraph -> NativeMarkdownBlock.Prose(inlines(node))
        is Heading -> NativeMarkdownBlock.Prose(inlines(node), node.level)
        is FencedCodeBlock -> {
            reserveText(node.literal)
            reserveText(node.info)
            NativeMarkdownBlock.CodeBlock(node.literal, node.info.takeIf { it.isNotEmpty() })
        }
        is IndentedCodeBlock -> {
            reserveText(node.literal)
            NativeMarkdownBlock.CodeBlock(node.literal)
        }
        is HtmlBlock -> {
            reserveText(node.literal)
            NativeMarkdownBlock.LiteralBlock(node.literal)
        }
        is LinkReferenceDefinition -> {
            val definition = "[${node.label}]: ${node.destination}" + (node.title?.let { " \"$it\"" } ?: "")
            reserveText(definition)
            NativeMarkdownBlock.LiteralBlock(definition)
        }
        is BlockQuote -> NativeMarkdownBlock.Quote(blocks(node))
        is ThematicBreak -> NativeMarkdownBlock.Divider
        is BulletList -> list(node, null)
        is OrderedList -> list(node, node.markerStartNumber ?: 1)
        else -> error("AST inspection admitted an unsupported block")
    }

    private fun list(node: Node, start: Int?): NativeMarkdownBlock.ListBlock {
        val items = mutableListOf<List<NativeMarkdownBlock>>()
        var item = node.firstChild
        var index = 0
        while (item != null) {
            reserveNode()
            reserveText(nativeMarkdownListMarker(start, index))
            items += blocks(item)
            index += 1
            item = item.next
        }
        return NativeMarkdownBlock.ListBlock(start, items.toList())
    }

    private fun inlines(parent: Node): List<NativeMarkdownRun> {
        val inlineRuns = mutableListOf<NativeMarkdownRun>()
        appendChildren(parent, inlineRuns, InlineStyle())
        return inlineRuns.toList()
    }

    private data class InlineStyle(
        val emphasis: Boolean = false,
        val strong: Boolean = false,
        val code: Boolean = false,
    )

    private fun appendRun(inlineRuns: MutableList<NativeMarkdownRun>, text: String, style: InlineStyle = InlineStyle()) {
        reserveNode()
        reserveText(text)
        inlineRuns += NativeMarkdownRun(text, style.emphasis, style.strong, style.code)
    }

    private fun appendChildren(parent: Node, inlineRuns: MutableList<NativeMarkdownRun>, style: InlineStyle) {
        var child = parent.firstChild
        while (child != null) {
            checkCancelled()
            appendInline(child, inlineRuns, style)
            child = child.next
        }
    }

    private fun appendInline(node: Node, inlineRuns: MutableList<NativeMarkdownRun>, style: InlineStyle) {
        when (node) {
            is Text -> appendRun(inlineRuns, node.literal, style)
            is HtmlInline -> appendRun(inlineRuns, node.literal, style)
            is Code -> appendRun(inlineRuns, node.literal, style.copy(code = true))
            is SoftLineBreak, is HardLineBreak -> appendRun(inlineRuns, "\n", style)
            is Emphasis -> appendChildren(node, inlineRuns, style.copy(emphasis = true))
            is StrongEmphasis -> appendChildren(node, inlineRuns, style.copy(strong = true))
            is Link -> {
                appendChildren(node, inlineRuns, style)
                appendDestination(inlineRuns, node.destination, node.title)
            }
            is Image -> {
                appendChildren(node, inlineRuns, style)
                appendDestination(inlineRuns, node.destination, node.title)
            }
            else -> error("AST inspection admitted an unsupported inline")
        }
    }

    private fun appendDestination(inlineRuns: MutableList<NativeMarkdownRun>, destination: String, title: String?) {
        appendRun(inlineRuns, " (")
        appendRun(inlineRuns, destination)
        if (!title.isNullOrEmpty()) appendRun(inlineRuns, " \"$title\"")
        appendRun(inlineRuns, ")")
    }
}
