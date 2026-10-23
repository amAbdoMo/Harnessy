package io.harnessy.companion.nativeapp.markdown

import java.util.concurrent.CancellationException
import org.commonmark.node.HtmlBlock
import org.commonmark.parser.Parser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class NativeMarkdownFormatterTest {
    @Test
    fun htmlBlocksAndInlineTagsRemainLiteralText() {
        val html = "<script>\nwindow.location='https://invalid.example';\n</script>\n"
        val parserLiteral = (Parser.builder().build().parse(html).firstChild as HtmlBlock).literal
        val block = formatted(html).blocks.single() as NativeMarkdownBlock.LiteralBlock
        assertEquals(parserLiteral, block.text)
        assertTrue(block.text.contains("<script>"))
        assertTrue(block.text.contains("window.location='https://invalid.example';"))
        assertTrue(block.text.contains("</script>"))

        val inline = "before <img src=\"https://invalid.example/pixel\" onerror=\"alert(1)\"> after"
        assertEquals(inline, proseText(formatted(inline)))
    }

    @Test
    fun linksAndImagesProjectToTextEvenForExecutableOrLocalDestinations() {
        val source = "[label](javascript:payload) ![alt <b>tag</b>](https://invalid.example/pixel.png \"caption\") " +
            "[local](file:///private/path) [pair](harnessy://pair)"
        val body = formatted(source)
        assertEquals(
            "label (javascript:payload) alt <b>tag</b> (https://invalid.example/pixel.png \"caption\") " +
                "local (file:///private/path) pair (harnessy://pair)",
            proseText(body),
        )
        // The projection contains text runs only, with no navigation or image-loading objects.
        val prose = body.blocks.single() as NativeMarkdownBlock.Prose
        assertTrue(prose.runs.none { it.code || it.emphasis || it.strong })
    }

    @Test
    fun fencedAndIndentedCodeKeepLiteralWhitespaceAndMarkup() {
        val fencedText = "val html = \"<script>x()</script>\"\n\tprintln(\"keep  \" )\n\n"
        val indentedText = "<img src='https://invalid.example'>\n  keep  \n"
        val source = "~~~kotlin source-metadata\n${fencedText}~~~\n\n" +
            "    <img src='https://invalid.example'>\n      keep  \n"
        val blocks = formatted(source).blocks
        assertEquals(2, blocks.size)
        assertEquals(NativeMarkdownBlock.CodeBlock(fencedText, "kotlin source-metadata"), blocks[0])
        assertEquals(NativeMarkdownBlock.CodeBlock(indentedText), blocks[1])
    }

    @Test
    fun typographyProjectionKeepsNestedEmphasisAndCodeIndependentOfHeadingStyle() {
        val block = formatted("# *italic* **bold `code`**").blocks.single() as NativeMarkdownBlock.Prose
        assertEquals(1, block.headingLevel)
        assertEquals("italic bold code", block.runs.joinToString("") { it.text })
        assertEquals(NativeMarkdownRun("italic", emphasis = true), block.runs.first())
        assertEquals(NativeMarkdownRun("code", strong = true, code = true), block.runs.last())
    }

    @Test
    fun numberedListsPreserveSourceStartAndNestedBulletContent() {
        val block = formatted("7. first\n   - nested\n8. second\n").blocks.single() as NativeMarkdownBlock.ListBlock
        assertEquals(7, block.orderedStart)
        assertEquals(2, block.items.size)
        assertEquals("first", (block.items[0][0] as NativeMarkdownBlock.Prose).runs.single().text)
        val nested = block.items[0][1] as NativeMarkdownBlock.ListBlock
        assertEquals(null, nested.orderedStart)
        assertEquals("nested", (nested.items.single().single() as NativeMarkdownBlock.Prose).runs.single().text)
        assertEquals("second", (block.items[1].single() as NativeMarkdownBlock.Prose).runs.single().text)
    }

    @Test
    fun mixedMessageKeepsTypographyCodeQuoteAndRuleInOneProjection() {
        // Reported symptom: one quoted or ruled passage turned the whole assistant message literal.
        val source = "**Bold** intro\n\n- first item\n- second item\n\n```kotlin\nval answer = 42\n```\n\n" +
            "> quoted **line**\n\n---\n\ntail paragraph\n"
        val blocks = formatted(source).blocks
        assertEquals(6, blocks.size)
        assertEquals(
            listOf(NativeMarkdownRun("Bold", strong = true), NativeMarkdownRun(" intro")),
            (blocks[0] as NativeMarkdownBlock.Prose).runs,
        )
        val list = blocks[1] as NativeMarkdownBlock.ListBlock
        assertEquals(null, list.orderedStart)
        assertEquals(2, list.items.size)
        assertEquals("first item", (list.items[0].single() as NativeMarkdownBlock.Prose).runs.single().text)
        assertEquals(NativeMarkdownBlock.CodeBlock("val answer = 42\n", "kotlin"), blocks[2])
        assertEquals(
            listOf(NativeMarkdownBlock.Prose(listOf(
                NativeMarkdownRun("quoted "),
                NativeMarkdownRun("line", strong = true),
            ))),
            (blocks[3] as NativeMarkdownBlock.Quote).blocks,
        )
        assertEquals(NativeMarkdownBlock.Divider, blocks[4])
        assertEquals("tail paragraph", (blocks[5] as NativeMarkdownBlock.Prose).runs.single().text)
    }

    @Test
    fun nestedQuotesAndQuotedListsKeepTheirInnerMarkdown() {
        val source = "> outer **bold**\n>\n> > deep **quote**\n>\n> - quoted item\n"
        val quote = formatted(source).blocks.single() as NativeMarkdownBlock.Quote
        assertEquals(3, quote.blocks.size)
        assertEquals(
            listOf(NativeMarkdownRun("outer "), NativeMarkdownRun("bold", strong = true)),
            (quote.blocks[0] as NativeMarkdownBlock.Prose).runs,
        )
        val inner = quote.blocks[1] as NativeMarkdownBlock.Quote
        assertEquals(
            listOf(NativeMarkdownRun("deep "), NativeMarkdownRun("quote", strong = true)),
            (inner.blocks.single() as NativeMarkdownBlock.Prose).runs,
        )
        val quotedList = quote.blocks[2] as NativeMarkdownBlock.ListBlock
        assertEquals(
            "quoted item",
            (quotedList.items.single().single() as NativeMarkdownBlock.Prose).runs.single().text,
        )
    }

    @Test
    fun quotedAndRuledMessagesFallBackToTheWholeOriginalWhenTheOutputBudgetIsExceeded() {
        val source = "> quoted **text**\n\n---\n"
        assertEquals(
            NativeMarkdownResult.Literal(source, NativeMarkdownFallback.BUDGET_EXCEEDED),
            parseNativeMarkdown(source, NativeMarkdownLimits(maxOutputNodes = 4)),
        )
        val blocks = formatted(source).blocks
        assertEquals(2, blocks.size)
        assertTrue(blocks[0] is NativeMarkdownBlock.Quote)
        assertEquals(NativeMarkdownBlock.Divider, blocks[1])
    }

    @Test
    fun deeplyNestedQuotesRespectTheAstDepthBudget() {
        val source = "> ".repeat(40) + "text\n"
        assertEquals(
            NativeMarkdownResult.Literal(source, NativeMarkdownFallback.BUDGET_EXCEEDED),
            parseNativeMarkdown(source),
        )
    }

    @Test
    fun referenceDefinitionsKeepSurroundingFormattingAndDoNotHideUnusedDestinations() {
        val body = formatted("**before** [source][reference]\n\n[reference]: <https://invalid.example> \"title\"\n\n" +
            "[unused]: javascript:payload\n\nafter\n")
        val first = body.blocks.first() as NativeMarkdownBlock.Prose
        assertEquals(NativeMarkdownRun("before", strong = true), first.runs.first())
        assertTrue(first.runs.joinToString("") { it.text }.contains("source (https://invalid.example \"title\")"))
        assertEquals(listOf("[reference]: https://invalid.example \"title\"", "[unused]: javascript:payload"),
            body.blocks.filterIsInstance<NativeMarkdownBlock.LiteralBlock>().map { it.text })
        assertEquals("after", (body.blocks.last() as NativeMarkdownBlock.Prose).runs.single().text)
    }

    @Test
    fun hostileDepthAndNodeCountsReturnTheOriginalBoundedLiteral() {
        val hostileSources = listOf(
            (0 until 40).joinToString("") { depth -> "  ".repeat(depth) + "- item\n" },
            "*x* ".repeat(400),
        )
        hostileSources.forEach { source ->
            assertTrue(source.toByteArray(Charsets.UTF_8).size <= 8192)
            assertEquals(
                NativeMarkdownResult.Literal(source, NativeMarkdownFallback.BUDGET_EXCEEDED),
                parseNativeMarkdown(source),
            )
        }
    }

    @Test
    fun completeOutputBudgetsDiscardPartialProjectionButPreserveInput() {
        val atCeilings = parseNativeMarkdown("abcd", NativeMarkdownLimits(
            maxAstDepth = 2, maxAstNodes = 3, maxOutputNodes = 2, maxOutputChars = 4,
        ))
        assertEquals(
            NativeMarkdownResult.Formatted(listOf(NativeMarkdownBlock.Prose(listOf(NativeMarkdownRun("abcd"))))),
            atCeilings,
        )
        val source = "before **middle** [label](javascript:payload \"title\") after"
        val limits = listOf(
            NativeMarkdownLimits(maxOutputNodes = 3),
            NativeMarkdownLimits(maxOutputChars = 10),
        )
        limits.forEach { ceiling ->
            assertEquals(
                NativeMarkdownResult.Literal(source, NativeMarkdownFallback.BUDGET_EXCEEDED),
                parseNativeMarkdown(source, ceiling),
            )
        }
        val metadata = "```long-language-info\nx\n```\n"
        assertEquals(
            NativeMarkdownResult.Literal(metadata, NativeMarkdownFallback.BUDGET_EXCEEDED),
            parseNativeMarkdown(metadata, NativeMarkdownLimits(maxOutputChars = 4)),
        )
    }

    @Test
    fun cancellationIsNotReplacedWithLiteralSuccess() {
        val cancellation = CancellationException("cancelled")
        try {
            parseNativeMarkdown("bounded content", checkCancelled = { throw cancellation })
            fail("Cancellation must propagate")
        } catch (observed: CancellationException) {
            assertSame(cancellation, observed)
        }
    }

    @Test
    fun unapprovedUtf8SizeIsRejectedInsteadOfTruncated() {
        val source = "界".repeat(2731)
        try {
            parseNativeMarkdown(source)
            fail("Oversized input must not enter the renderer")
        } catch (expected: IllegalArgumentException) {
            assertTrue(source.length < 8192)
            assertTrue(source.toByteArray(Charsets.UTF_8).size > 8192)
        }
    }

    private fun formatted(source: String): NativeMarkdownResult.Formatted {
        val projection = parseNativeMarkdown(source)
        assertTrue("Expected formatted output, received $projection", projection is NativeMarkdownResult.Formatted)
        return projection as NativeMarkdownResult.Formatted
    }

    private fun proseText(body: NativeMarkdownResult.Formatted): String =
        (body.blocks.single() as NativeMarkdownBlock.Prose).runs.joinToString("") { it.text }
}
