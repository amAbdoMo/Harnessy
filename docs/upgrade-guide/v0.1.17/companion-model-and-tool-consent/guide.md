---
kind: upgrade-guide
description: "Phone model operations require matching PC support, and explicit consent writes a companion identity record that older Hosts cannot read."
---

# Phone model selection and tool-detail consent

English | [中文](guide.zh.md)

## Change

Phone model requests require an updated PC Host. An older PC rejects the new closed protocol operations. Pairing grants neither model selection nor tool details; each permission requires a separate native PC decision for the phone's full fingerprint. Chat-management consent grants neither permission.

The PC reads companion identity records v1–v4 without rewriting them at startup. A legitimate identity or grant write stores v5, adding the optional `sessionActivationV1` grant flag (absent means denied) while preserving keys, generations and other permissions. Older Hosts cannot read v5; do not edit or downgrade that record.

## Migration

1. Update the PC companion support before installing a model-enabled Android build. Keep the existing Harness home and pairing; do not reset or copy identity keys.
2. Open the PC's Android companion settings and **Paired phones**. Compare the complete fingerprint and enable **Model selection** and **Tool details** separately only if wanted. Both are denied by default. Tool details disclose potentially sensitive filenames from historical and live activity; disabling delivery cannot erase text already received.
3. On Android, choose an ordinary chat that is live and idle on the PC, with no queued work. Select a PC-configured model. The choice affects only that chat's next model request, with the selected model's default reasoning effort; global model defaults remain unchanged. A lost acknowledgement after admission means an unknown outcome, not a safe retry.
4. With tool details enabled, inspect supported filesystem activity. Successful results can show workspace-relative file labels, read windows, fixed write/edit outcomes and search counts. External paths, file contents, raw commands, diffs and error diagnostics are excluded. Missing metadata or call correlation yields a fixed status; nested PTC details are unavailable.
5. Keep a PC build that supports v5 after a grant write. To stop either feature, disable its permission in **Paired phones** rather than downgrading the identity record. Verify that pairing and the other permissions remain intact.
