---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-24-harnessy-search-thinking

English | [中文](2026-10-24-harnessy-search-thinking.zh.md)

## Summary

Allows the auxiliary DeepSeek search request to record an explicit disabled-thinking option.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-24-harnessy-search-thinking
baseline: false
changes:
  - root: "event:web/deepseek-search-llm-request"
    previous: "2026-09-11-initial"
    after: "0c556c9b9f2a96238a6b9bbb99e748206cbff2ed6203041c9571f04ae5802f52"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The thinking field is optional. Existing request events without it remain valid, and the event envelope and Session writer version are unchanged. New auxiliary requests record the same disabled-thinking value they send to the Messages API.

<a id="verification"></a>
## Verification

Focused web provider, web tool, and Web Search settings suites passed 311 tests across 12 files. The keyless deepseek-fetch scenario passed after generating its own current-profile header sidecars. No live API or installed-app update was exercised.

<a id="dev-note"></a>
## Dev Note

None.
