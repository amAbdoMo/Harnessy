# Agent Note: Empty-chat brand polish

Status: implemented

English | [中文](2026-09-12-empty-chat-brand-polish.zh.md)

## Problem

The empty-chat heading still displayed a **Preview** badge even though Harnessy is now the product identity. Its 34px brand seat also selected the transparent large-format mark and enlarged it inside a clipped gradient container, which made the symbol look cropped and inconsistent with the sidebar.

## Decision

The empty-chat heading contains only the Harnessy mark and **Into the Unknown** title. The Preview label and its locale entries and presentation styles are removed.

Harnessy uses its complete app icon in compact surfaces up to 40px, covering both the 24px sidebar seat and 34px empty-chat seat. Larger brand surfaces continue to use the transparent mark asset.

## Alternatives considered

- **Keep the badge but rename it** — rejected because a permanent product screen should not carry a temporary release-state label.
- **Continue using the transparent mark and change its zoom** — rejected because the small seat is better served by the already-tuned app icon and would otherwise duplicate icon composition in CSS.
- **Use the app icon at every size** — rejected because large presentation surfaces still benefit from the transparent mark.

## Consequences

The first screen has one quieter, permanent product identity. The empty-chat logo now matches the crisp, self-contained sidebar icon without changing large-format branding behavior. Component coverage verifies the removed badge and the asset selected at sidebar, hero, and large sizes.
