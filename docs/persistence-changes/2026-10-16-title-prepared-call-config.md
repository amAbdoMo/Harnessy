---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-16-title-prepared-call-config

English | [中文](2026-10-16-title-prepared-call-config.zh.md)

## Summary

Adds the exact prepared generation controls to new auxiliary session-title request records.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-16-title-prepared-call-config
baseline: false
changes:
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "a0b6c6652e4e6b18abc8ac04882bedefad08ec4185ea8af75612ab95bd5353bc"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The config property is optional on read, so existing request records remain valid and are not rewritten or migrated by listing. New title calls write their prepared provider, model and controls before dispatch, including the supported reasoning effort. The existing route, prompt, source sequences and output cap remain available; absence of config in an older record does not imply any particular reasoning effort. The authoritative classifier accepts this optional addition without a Session writer-version bump.

<a id="verification"></a>
## Verification

Source-only Vitest over session-title-llm request policy, both title providers and their real Loader composition: 20 tests passed. The policy regression compares the recorded config with the actual dispatched controls across supported-effort variants. Real user Session files were neither opened nor migrated; runtime/browser qualification remains offline.

<a id="dev-note"></a>
## Dev Note

None.
