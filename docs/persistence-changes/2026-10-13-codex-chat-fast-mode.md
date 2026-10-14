---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-13-codex-chat-fast-mode

English | [中文](2026-10-13-codex-chat-fast-mode.zh.md)

## Summary

Adds the log-only llm-pi-ai/fast-mode event with the current chat's enabled boolean.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-13-codex-chat-fast-mode
baseline: false
changes:
  - root: "event:llm-pi-ai/fast-mode"
    previous: null
    after: "37ae0f7c37ae4f1a01b65fde2ec9f3047ec2f39b1ebed3982d3d66eda5e80deb"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The event is additive and producers mark it ignorable. Readers without its plugin may skip it without changing model history. Existing chats with no event default to no priority request. Current readers validate the durable enabled value as a boolean and reconstruct the preference from the Session log; forks inherit their recorded prefix. The writer format remains unchanged.

<a id="verification"></a>
## Verification

Focused command and Session tests cover malformed persisted values, fork isolation, flush settlement and rejection, and the ignorable append marker. Codex socket tests cover SSE and WebSocket priority payloads, unchanged reasoning and request content, dispatch-time capture, auxiliary-call exclusion, and JSONL close/reopen followed by live priority dispatch. The keyless TypeScript SDK replay and Python runtime snapshot compare real command outcomes, notifications, and persisted preferences. Localized slash-menu tests cover the command's client presentation.

<a id="dev-note"></a>
## Dev Note

None.
