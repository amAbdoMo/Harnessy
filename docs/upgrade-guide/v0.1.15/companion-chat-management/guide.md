---
kind: upgrade-guide
description: "Companion chat management requires matching PC and phone APIs, explicit per-phone permission, and v2 persisted records."
---

# Companion chat management permission and compatibility

English | [中文](guide.zh.md)

## Change

Paired Android phones retain existing session reading and text submission access; pairing alone does not authorize chat management. Desktop Main’s native **Paired phones → Enable chat management** requires separate fingerprint confirmation; **Cancel** is the default. This grants no model, account, tool-approval, or credential control.

Only four actions are supported: Create an empty real Workspace chat, Rename, Archive, and Pin/unpin. Permanent Delete is deferred; there is no Delete button, and Archive preserves history. Archive refuses busy chats without a convenience Stop. New chats use the PC default preset, accept no arbitrary provider settings, and send no text or model/tool calls until the user sends a message.

New phone APIs require the matching PC first: a permission-gated Workspace catalog includes registered empty Workspaces without exposing paths, and four narrow commands perform the actions above. Ordinary navigation still lists only groups with returned Sessions. Additive `SessionCreateRequest.newSessionId` requires a strictly new identity and excludes legacy `sessionId`; legacy adoption is unchanged. See [creation semantics](../../../../packages/api/session-controller/README.md#use-this-package).

The PC grant field `sessionManagementV1?: true` denies management when absent. Valid v1 identity records load without a startup rewrite. The next legitimate grant write stores v2, preserving identity keys, existing grants, and generations except for the requested grant change. Older Hosts refuse v2.

Android `OperationStore` v2 reads v1 without mutation and preserves fences, repairs and pairing keys on legitimate writes. Fences commit before possible writes; unknown outcomes never replay. `managed` applied follows PC owner commit and Create/Rename flush; partial or flush failure is unknown, not rollback, inbox admission or a durable replay receipt. See [completion semantics](../../../../packages/host/companion-host/INTEGRATION.md#actual-relay-and-endpoint-wire).

## Migration

1. Update the PC through **Check for Updates** in Harnessy before updating the phone. Source edits alone do not update the running app. Follow the [Android verification requirements](../../../../apps/android/README.md#limits-and-verification).
2. In native **Paired phones**, choose the intended phone’s **Enable chat management**, compare its complete fingerprint, and confirm. Do not reset identity or re-pair.
3. Install matching Android in place. Preserve app data, pairing keys, uncertainty fences, and repair markers; never uninstall or clear storage.
4. Verify real Workspaces, including registered empty folders. Use **New chat**; confirm an empty PC chat and each action’s status/result, including Archive history preservation and busy refusal without Stop.
5. For unknown outcomes or lost replies, inspect the PC target before explicitly reviewing uncertainty or trying a fresh intent. Never automatically Retry or resend.

For rollback, an older Host cannot read v2 after a grant write. Install a matching newer Host without deleting keys. Do not hand-edit records, reset identity, or expect automatic downgrade.
