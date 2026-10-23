---
kind: upgrade-guide
description: "Opening a closed PC conversation from Android requires matching PC support and separately approved session activation; delivery fences become chat-scoped."
---

# Open existing chats from Android

English | [中文](<guide.zh.md>)

## Change

Android can explicitly open an eligible existing cold ordinary chat on the running PC without opening a desktop tab. Merely listing sessions or viewing history never activates an Agent. A cold activation uses normal PC Agent setup and resume, then flushes only the target Session; initialization may migrate or repair history or run SessionStart plugins, even if it fails. An already-live Agent is reused. Opening sends no text or new task, changes no global model default, and cannot activate archived or subagent chats or rearm a goal.

Session activation uses the separate PC grant `sessionActivationV1`, which defaults to denied. Pairing, chat-management, model-selection and tool-detail grants do not enable it. Phone renaming and text submission require an already-open chat and never activate a cold Agent. Opening one chat does not stop another Agent; model changes still require the target chat to be idle. Drafts remain RAM-only and scoped to their original PC and chat; unresolved delivery fences use the same PC/chat scope.

Android reads valid v1/v2 delivery-fence documents without rewriting them. The next legitimate write emits v3, with fences keyed by PC and chat; older Android builds cannot safely read v3. Do not clear delivery records or downgrade the app to remove an uncertainty warning. PC identity-record compatibility is described in the [model and tool consent guide](<../companion-model-and-tool-consent/guide.md>).

## Migration

1. Update the PC through the normal in-app Update workflow before installing the matching Android build. Keep the PC awake and Harnessy running; no desktop chat tab is required.
2. In desktop **Settings → General → Android phone companion → Phone settings → Paired phones**, compare the complete phone fingerprint and explicitly choose **Enable opening chats**. Keep model selection and tool details as separate decisions.
3. On Android, select a closed conversation to view its history, then choose **Open chat**. After the PC confirms activation and fresh status, its composer becomes available. Select a model only while that chat is idle and the independent model permission is enabled.
4. Open another eligible conversation on Android and switch between them. Opening or selecting one must not stop another Agent, move its draft, or change its model. Archived and subagent conversations cannot be activated through this operation.
5. If opening or another mutation has an unknown result, inspect that chat's current PC status and explicitly review its delivery warning. Do not automatically resend. Verify that pairing, prior fences, other chat drafts and global model defaults remain intact.
