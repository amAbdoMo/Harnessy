---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-27-nested-operation-targets

English | [中文](2026-10-27-nested-operation-targets.zh.md)

## Summary

Adds optional replayable presentation metadata to nested PTC tool outcomes.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-27-nested-operation-targets
baseline: false
changes:
  - root: "event:tool/ptc-dispatch"
    previous: "2026-09-16-session-format-v4"
    after: "d66e11dddf5dfa3c71547e2cbd7b0608824cd8d6243fc16f532017ff28e8fba5"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The optional meta field carries JSON-safe operation targets independently of program values and model content. Existing logs without the field remain valid. Both SDKs preserve event data and notifications. This is an additive same-version change; no structural Session format or original workspace authority changes.

<a id="verification"></a>
## Verification

The classifier reports one optional-property-added change without a version bump. The focused nested presentation projector regression and both SDK client projection checks passed. POSIX recorded-session and SDK writer verification remains pending at this acknowledgement.

<a id="dev-note"></a>
## Dev Note

None.
