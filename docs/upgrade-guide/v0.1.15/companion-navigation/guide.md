---
kind: upgrade-guide
description: "Android navigation requests require a PC that accepts the listSessions navigation view; older PCs reject the request and close the channel."
---

# Update the PC before the navigation-enabled Android companion

English | [中文](guide.zh.md)

## Change

The Android companion now requests `listSessions` with `view: 'navigation'` for ordinary conversation lists. A matching PC returns read-only Workspace membership, PC pin order and human-prompt recency. PCs without this extension accept only the legacy request fields: they reject the new request and close the encrypted channel. A successfully paired phone is not evidence that this listing API is supported.

An updated PC preserves exactly `sessionId`, `title`, and `status` for legacy requests that omit `view`, so existing phones can keep using those requests. Heartbeats also omit the view. Navigation itself adds no PC mutation authority and does not change pairing keys or delivery-uncertainty fences. Ordinary lists omit empty Workspace groups; the separately granted catalog and actions follow the [chat-management upgrade guide](../companion-chat-management/guide.md).

## Migration

1. Update the PC to a build supporting `listSessions` with `view: 'navigation'` before using the navigation-enabled phone app. Keep the existing phone version until the matching PC is running; a source edit or new APK alone does not update the PC.
2. Use the existing pairing after both sides are updated. Do not clear pairing keys, reset application data or discard delivery warnings to work around a rejected listing. Do not loosen exact-field parsing or add a permissive fallback.
3. Confirm that the phone loads existing conversations without a listing-triggered channel close. Check Workspace groups and projected PC pins against the PC; unassigned rows remain headerless. Missing metadata must not produce invented organization. Build success alone does not establish physical-device or encrypted-interoperability acceptance.
