# Agent Note: Keep the Custom Harness root README English-only

Status: implemented

English | [中文](2026-09-09-custom-harness-english-root-readme.zh.md)

## Problem

Custom Harness uses the repository root README as a concise personal landing page. Maintaining a second root translation duplicates the product instructions even though the owner wants this landing page available only in English. The inherited technical documentation remains bilingual and may still need to refer to root installation and source-run instructions.

## Decision

The root `README.md` is an explicit exclusion in `scripts/translation-pairing.manifest.json`. It has no `README.zh.md`, no root pairing sidecar, and no language switcher. Chinese technical guides that previously linked to the root Chinese file link to the corresponding anchors in the English root README. All other active documentation remains governed by the bilingual pairing policy.

## Alternatives considered

**Keep the Chinese root README.** Rejected at the owner's request.

**Remove every Chinese technical document.** Rejected because the requested change concerns the repository landing page. Deleting inherited technical translations would be a much larger, unrelated change.

## Consequences

The GitHub landing page is English-only. Chinese technical pages may direct readers to English installation and build instructions at the root, while their own paired content remains maintained and validated.
