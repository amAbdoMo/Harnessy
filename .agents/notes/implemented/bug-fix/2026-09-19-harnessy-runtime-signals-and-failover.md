# Agent Note: Keep Harnessy runtime signals actionable

Status: implemented

English | [中文](2026-09-19-harnessy-runtime-signals-and-failover.zh.md)

## Problem

Harnessy exposed several operational controls without reliably preserving their intent at the moment they mattered. A Session could bypass configured subagent roles through older delegation tools, split repetitive work into one child per item, and turn every child completion into a desktop notification. Root completion notices were inferred from the absence of a running flag, so they could repeat vague “no longer running” messages instead of reporting the recorded terminal result. Long runs also became difficult to scan because every Tool call occupied a full transcript row, applied file changes had no Turn-level summary, and elapsed time remained minute-only after an hour. The MCP header could retain a stale activity projection even though calls were present in the durable Session. Codex account switching waited for a displayed window to reach 100%, so a request could exhaust the remaining allowance and stop before the next proactive check. Usage fills also replayed from zero on ordinary refreshes, which made stable quota values look inconsistent.

## Decision

The `custom-harness` profile exposes the roster's `list_subagents` and `delegate` tools as its only child-creation path. Generic in-process delegation tools are disabled in that profile, and the Command Code backend remains mounted with its pre-roster lane tools disabled. Roster tool guidance requires directory discovery before the first delegation, the closest configured role, coherent batches rather than one child per image, file, or record, and parent-owned integration and validation. Adaptive concurrency lets the parent choose the smallest useful independent batch while the shared run gate retains a hard ceiling of 16; a manual setting can impose a stricter cap.

Child Session completion remains visible in the subagent activity surface but does not create notification-center or desktop completion messages. The header reports working and done totals, completed direct children start collapsed, and each row reports the effective model and reasoning effort. Child requests that require a human decision remain eligible for notification. The bell exposes unread state as one count-free dot, while its accessible name retains the exact count. Root notifications wait for the `turnOutline` projection's terminal classification and distinguish completed, stopped, and failed work. A pending approval, question, or plan review suppresses the terminal event for the same run. Successful completion requests a native notification only while Harnessy is in the background; stopped, failed, and action-needed events remain immediately visible.

Compact Chat groups consecutive live reasoning and Tool rows between Assistant progress messages while retaining the mounted row renderers behind the disclosure; a failed call forces the group open. Successful Tool results contribute Turn file totals only from validated applied-diff metadata, and selecting a file opens the recorded hunks in the right sidebar. Shell output without diff metadata never becomes an inferred edit. Elapsed time uses seconds, then minutes and seconds, then hours with remaining minutes and seconds.

The Session-header MCP action derives call activity from the latest projection on every render instead of caching against the stable outer chat object. It stays labeled when idle, shows the running-call count, and uses warm semantic success and error colors. Server connection health continues to come from the MCP manager; per-Session calls continue to come from durable tool events.

Codex automatic switching treats 95% usage in either standard window as the proactive threshold and selects only a refreshed replacement whose standard windows remain below that threshold. A provider-confirmed quota error performs another usage refresh and retries the open turn only when the refresh commits a different active credential. Usage bars render the latest measured percentage directly instead of restarting a fill animation after refresh.

Workspace role overrides remain supported because they are the narrowest way to make one project stricter than the global roster. Their editor is collapsed by default and reports whether the workspace inherits the global roles or carries custom fields.

## Alternatives considered

**Use a fixed concurrency default.** A universal number cannot distinguish independent research from shared-file or mutable MCP work. Adaptive mode leaves batch sizing with the parent, a manual cap supports stricter projects, and 16 remains a safety ceiling rather than a quality target.

**Keep every delegation surface and rely on prompt wording.** A model can choose any registered tool, so prose cannot guarantee configured roles. Removing the competing creation tools from the Harnessy composition makes the role policy representable at the tool boundary while leaving the Command Code backend and other profiles intact.

**Notify for every child completion.** Completion notices are useful inside the subagent panel but become duplicate desktop noise when the parent already owns the task. Human-action requests remain notifications because silence there can stall work.

**Treat every successful command as a file change.** Command text and exit status cannot prove which files changed or what content was applied. Restricting the summary to recorded diff metadata produces smaller but trustworthy totals and keeps the sidebar preview reproducible from Session data.

**Switch only at 100%.** Usage reporting and request consumption are not atomic. A 95% proactive threshold provides headroom, while the quota-error recovery path covers a request that still reaches the provider limit between checks.

**Remove workspace overrides.** Removing them simplifies the page but forces users to duplicate global roles merely to tighten one project's model, access, or instructions. Collapsing the editor preserves the useful scope without making it part of routine setup.

## Consequences

Harnessy consistently uses configured roles for new children, and batching guidance reduces token waste and conflicting writes without preventing deliberate parallel work. Adaptive mode keeps final judgment with the parent under the 16-run ceiling, while manual mode can lower that ceiling. The compact activity surface separates live work from completed history without hiding it, and reliable Turn totals make code progress inspectable without reading every Tool row. Notification history stays focused on recorded root outcomes and actionable requests, while successful foreground completion avoids redundant native noise. MCP calls already present in a Session become visible without changing the transport. Codex can switch before exhaustion and recover the open turn after a confirmed quota failure when another eligible saved account exists. The trade-off is that file totals intentionally omit mutations not accompanied by valid diff metadata, Harnessy no longer exposes the generic and pre-roster delegation tools available in broader framework profiles, and switching at 95% may leave a small amount of unused capacity on the previous account.
