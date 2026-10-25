# Agent Note: Durable rich-text quotes in the Web composer

Status: implemented

English | [中文](2026-08-26-web-rich-text-quotes.zh.md)

## Problem

Selected excerpts need atomic editing and reload-safe drafts without depending on the continued availability of source messages. Persisting derived text nodes or source indexes adds competing owners for authoritative message text.

## Decision

The existing composer owns atomic QuoteNode editing and semantic DraftSnapshot spans beside references. Clipboard text uses canonical Markdown; editor detection treats each quote as one character. Runtime identities, callbacks, and locale labels remain outside browser storage. Failed submissions restore the same semantic document.

Messages contain ordinary Markdown text. The message-quotes plugin recognizes explicit blockquote lines through the Conversation-owned pure JSON text matcher. It renders decoded excerpts literally without applying nested reference decoration. Session-reference and skill processing still applies to submitted text. Harnessy's ordinary text presentation retains its existing file and skill navigation through the factory's optional renderer; that callback is presentation state, never a matching fact or stored node.

Chat owns visible selection extraction, local action placement, clipping, composer occlusion, and dismissal. The plugin owns gesture admission and the quote action. Finalized durable Assistant text, expanded reasoning, and user bubbles can supply excerpts; streaming, interrupted, and unidentified Assistant output cannot. Insertion rechecks live Session and composer editability. A failed insertion preserves the selection. Context-menu cancellation remains synchronous with the original event.

## Alternatives considered

**Persist editor JSON or derived UserText nodes.** Editor identities and display rules evolve independently of authoritative text. The existing semantic draft representation owns restoration.

**Retain source navigation or quote-only message indexes.** Navigation requires durable coordinates, availability checks, and failure handling. Quote indexes duplicate explicit Markdown and make typed and inserted blockquotes behave differently. Only the selected text survives submission.

**Replace Harnessy's reference presentation.** The existing navigation owner already handles file paths and skill previews. Keeping that owner avoids competing renderers and preserves custom behavior.

## Verification

Composer tests cover atomic removal, undo, storage restoration, Markdown submission, and failed-send recovery. Matcher and rendering tests cover literal nested references, source ranges, and existing navigation. Chat tests distinguish durable messages from streaming and interrupted content; inline Slot tests cover missing entries and failures.

## Consequences

Unsent excerpts remain in browser-local draft storage. Recognition covers explicit quote lines, not lazy Markdown continuation or fenced-code parsing. Source navigation requires a separate durable-coordinate design. Derived JSON nodes and presentation callbacks never replace Session content.
