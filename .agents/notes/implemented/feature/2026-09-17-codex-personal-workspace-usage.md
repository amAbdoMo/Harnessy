# Agent Note: Codex Personal and Workspace usage remain separate memberships of one person

Status: implemented

English | [中文](2026-09-17-codex-personal-workspace-usage.zh.md)

## Problem

The account manager treated the ChatGPT account id as a unique person id. That value identifies a workspace and is shared by its members, so signing in two users from one workspace overwrote one saved account with the other. The inverse case also had no useful presentation: one user signed into Personal and Workspace appeared as unrelated rows, with no way to compare the two quota contexts in place.

The full account manager also painted every usage bar with the brand color even though the compact sidebar meter already distinguished normal, warning, and danger consumption.

## Decision

Each Codex OAuth membership now receives an opaque id derived from both the ChatGPT user id and the workspace account id. A separate opaque owner id derives from the user id alone. Email, JWT subject, and refresh-token fallbacks keep the same two-level identity when older tokens omit the preferred claims. Writable vault reads migrate legacy workspace-only ids while retaining the active membership, custom name, and usage snapshot.

The Host returns both ids plus a `personal` or `workspace` usage scope. Provider badges count owner ids, while the browser groups memberships with the same owner id into one card. The card shows a Personal/Workspace segmented control only when both scopes exist. Changing it selects the quota snapshot, rename/remove target, and membership that Switch activates; a Personal-only or Workspace-only account has no redundant control.

Both full and compact meters use one classifier: normal below 80%, warning from 80%, and danger from 95%. The UI continues to use semantic theme tokens for the three colors.

The full account card presents the short `5h` reset as a minute-based countdown and updates it while the card is open and when the window regains focus or visibility. The `7d` reset remains an absolute local date and time without the redundant year. The compact sidebar refreshes account usage on startup, once per visible minute, and when the window regains focus or visibility; its meter jumps directly to the latest value so returning from another application does not replay stale progress animation.

Codex automatic switching is an opt-in provider preference evaluated only after every saved membership receives a fresh usage result. Either standard `5h` or `7d` window at 100% makes the active membership exhausted; a replacement must expose at least one standard window and have every exposed standard window below 100%. Selection prefers another seat with the same ChatGPT workspace id, then the same owner's paired Personal or Workspace membership, then another Personal membership when the active membership is Personal. It never crosses between unrelated Workspace memberships and leaves the active credential unchanged when no eligible replacement has capacity.

When automatic switching is enabled, the account controller repeats that refresh and selection in the `agent/request` waterfall after request routing is known and before `prepareCall()` resolves the canonical credential. A committed promotion emits one secret-free `accounts/auto-switched` event. The browser shows that event as a transient toast and stores at most 50 switch records in a local notification history opened from the Workspaces toolbar; opening marks the history read, and Clear history deletes it.

## Alternatives considered

**Key saved accounts by workspace id.** This preserved the existing vault layout but could not represent two users in one Business or Enterprise workspace.

**Merge Personal and Workspace credentials into one stored record.** This made the card model direct but required a new credential schema and changed activation, refresh, rename, and removal semantics at once. Keeping each OAuth membership as one stored account preserves the canonical credential path and lets the client group only the presentation.

**Always show a scope switch.** A stable layout was tempting, but a disabled or one-item switch communicates a choice that does not exist. The control is conditional on both scope kinds.

**Rotate through every saved Codex membership.** A provider-wide round robin would maximize the chance of finding capacity, but it could send Business work through an unrelated organization's workspace. Workspace identity and the owner pairing constrain automatic selection instead.

## Consequences

Two workspace members can be saved and switched independently even when their tokens carry the same ChatGPT account id. One person can save Personal and Workspace memberships, compare their independent `5h` and `7d` windows on one card, and choose which membership becomes active.

Reset information stays readable without second-level churn: the short window reports whole remaining minutes, while the weekly window keeps a compact calendar reference. Backgrounded windows catch up immediately when revisited, and the compact sidebar always reflects the newest received snapshot without a width transition.

The public account view gains `ownerId` and optional `usageScope`. Every public account has an owner id; non-Codex providers use the stored account id because their entries do not expose a separate usage membership. Existing writable Codex vaults migrate on their next account-manager read without exposing source identity claims to the browser.

Automatic switching occurs before the next Codex request binds its credential, so a known-exhausted active membership is not sent into that request. It does not redirect a request already in flight. Failed or missing usage snapshots are not evidence of capacity, so they neither trigger nor receive automatic switching; a usage-service failure is logged and does not block an otherwise valid model request.

The forwarded switch event contains display names, usage scopes, the exhausted standard window, an id, and a timestamp; it never contains email addresses, account ids, or OAuth material. Notification history is local browser state rather than Session data and is intentionally cleared only by its explicit action or browser storage removal.

## Related

- [Harnessy browser identity and account manager](../../../../packages/client/ui-brand-custom-harness/README.md)
- [Locale-owned client UI copy](../architecture/2026-08-23-locale-owned-client-ui-copy.md)
