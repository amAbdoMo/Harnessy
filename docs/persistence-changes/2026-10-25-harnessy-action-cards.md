---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-25-harnessy-action-cards

English | [中文](2026-10-25-harnessy-action-cards.zh.md)

## Summary

Records optional action-card decisions and attribution for status notices.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-25-harnessy-action-cards
baseline: false
changes:
  - root: "event:action-cards/decision"
    previous: null
    after: "2674d6b95e5c88c081dd62be78a6cdcf4e4f746dca5f773a764e6e1d62672534"
    decision: same-version
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-17-working-directory-transitions"
    after: "8bb390b6c0253c96c5d662283f991fa300b782ec2f8ee273878741d0500757f0"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-17-working-directory-transitions"
    after: "9540b08d13054131e1a46841e053d0562d7606629ebb5e1b4f35ff258e96e6fd"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-17-working-directory-transitions"
    after: "c9688568fc407aa5f53ba7c673bd4d7cfdf5aba12858d609fef69d2e669960ec"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-17-working-directory-transitions"
    after: "5e14827226c65146fd32a67d4efe02b224e0b9f7b190ac197e383ff0b62fd72c"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing events remain valid. The new action-cards/decision event is always written with ignorable:true, so readers without the optional plugin may skip it. The action-cards message source attributes ordinary recorded notice text; older readers retain that content. No committed Session generation is moved or overwritten, and the writer version stays unchanged.

<a id="verification"></a>
## Verification

Vitest replay of the seven recommendation packages passed 183 tests with one host-capability symlink skip. Projection, status-context, cancellation, recovery, live-root admission and real Loader/HMR cases passed. This evidence does not establish a main-app update.

<a id="dev-note"></a>
## Dev Note

None.
