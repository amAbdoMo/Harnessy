---
description: "Review only new DeepSeek Harness upstream work, preserve Harnessy's product decisions, and finish with concise recommendations and a verified zero-behind branch."
---

# Cookbook: reviewing upstream for Harnessy

English | [中文](reviewing-upstream-for-harnessy.zh.md)

## Summary

Use this handoff when comparing Harnessy with the main DeepSeek Harness repository. It keeps the review limited to upstream commits that Harnessy does not already contain, routes each change to the current Harnessy owner, and turns the result into **Adopt**, **Adapt**, or **Skip** recommendations. Ask the owner only when a choice changes visible behavior, stored data, security, operating cost, or release scope. A completed synchronization must include the selected improvements, preserve Harnessy's custom MCP, subagent, account, workspace, notification, and Desktop behavior, and leave the upstream-only commit count at zero.

Do not store a moving commit hash or repeat a completed commit-by-commit audit in this page. Git ancestry is the durable checkpoint: after a completed synchronization, the next review starts from only the new right-side commits.

## Table of Contents

- [Before you start](#before-start)
- [1. Load the smallest useful context](#load-context)
- [2. Find only new upstream work](#find-new-work)
- [3. Protect Harnessy's product decisions](#protect-decisions)
- [4. Classify each relevant change](#classify)
- [5. Ask only material questions](#questions)
- [6. Present recommendations](#recommendations)
- [7. Integrate and verify](#integrate)
- [Reusable handoff report](#report)
- [Dev Note](#dev-note)

-----

<a id="before-start"></a>
## Before you start

Confirm the task's scope. A **review** is read-only and ends with recommendations. A **synchronization** fetches upstream, integrates the selected work, runs focused checks, commits, pushes when requested, and verifies that Harnessy is no longer behind. Do not build an installer for a recommendation-only review. Build one only when Desktop packaging changed or the owner requested a release artifact.

Preserve uncommitted user work. Inspect the worktree before fetching or merging, and never discard, overwrite, or hide unrelated changes. Harnessy does not need an automatic rollback copy; Git commits and the remote branch are the recovery points unless the owner explicitly requests another backup.

Use `origin` for the Harnessy fork and `upstream` for the main DeepSeek Harness repository. Verify those names instead of assuming their URLs:

```sh
git remote -v
git status --short
```

<a id="load-context"></a>
## 1. Load the smallest useful context

Read [AGENTS.md](../../AGENTS.md) first. Read [the architecture](../architecture.md) before changing `packages/`, [defensive patterns](../defensive-patterns.md) before lifecycle, concurrency, subprocess, or teardown work, and the applicable package README before editing its implementation. Do not read every old Agent Note.

The following files are the fast product map. Read the first three for every synchronization, then open only the area-specific decisions affected by the new upstream diff.

| Area | Current owner and focused decisions |
| --- | --- |
| Product identity and contributor entry | [Root README](../../README.md), [custom bundle README](../../packages/bundle/custom-harness/README.md), and [Harnessy client README](../../packages/client/ui-brand-custom-harness/README.md) |
| MCP management and activity | [MCP manager decision](../../.agents/notes/implemented/feature/2026-09-13-harnessy-mcp-manager.md) |
| Configured subagents and routing | [Subagents Settings decision](../../.agents/notes/implemented/feature/2026-09-16-subagents-settings-page.md), [Command Code lanes](../../.agents/notes/implemented/feature/2026-09-15-commandcode-delegation-lanes.md), and [runtime signals and failover](../../.agents/notes/implemented/bug-fix/2026-09-19-harnessy-runtime-signals-and-failover.md) |
| Accounts, usage, and switching | [Multi-account manager decision](../../.agents/notes/implemented/feature/2026-09-12-harnessy-multi-account-manager.md) and [account usage decision](../../.agents/notes/implemented/feature/2026-09-17-codex-personal-workspace-usage.md) |
| Optional and remote workspaces | [Optional workspace decision](../../.agents/notes/implemented/feature/2026-09-12-optional-workspace-sessions.md) and [default workspace decision](../../.agents/notes/implemented/feature/2026-09-20-default-workspace.md) |
| Windows background lifecycle and packaging | [Desktop README](../../apps/desktop/README.md) and [fork CI decision](../../.agents/notes/implemented/process/2026-09-09-custom-harness-fork-ci.md) |

Scan upstream filenames and diff statistics before opening implementation files. This identifies the affected rows in the table and avoids loading unrelated packages, documentation, and old decisions.

<a id="find-new-work"></a>
## 2. Find only new upstream work

Fetch both remotes, then calculate the comparison from the current Harnessy `HEAD`:

```sh
git fetch origin
git fetch upstream
git rev-list --left-right --count HEAD...upstream/master
git log --right-only --cherry-pick --no-merges --oneline HEAD...upstream/master
git diff --stat HEAD...upstream/master
```

The count is `<Harnessy-only> <upstream-only>`. The second number is the amount Harnessy is behind. The log lists only upstream commits not already represented in Harnessy; do not review left-side custom commits as missing upstream work. If the second count is zero, stop the commit audit. Report that Harnessy is current and discuss only a separate product-improvement request from the owner.

When the list is large, group it by affected package or user surface before reading individual diffs. Prioritize shared APIs, persistence, lifecycle, security, provider behavior, Desktop packaging, and code touching a current Harnessy owner. Documentation-only and internal maintenance changes still need compatibility classification, but they do not justify reopening unrelated product choices.

<a id="protect-decisions"></a>
## 3. Protect Harnessy's product decisions

Treat the table below as the default integration policy. Upstream can improve the implementation, but it must not silently replace these Harnessy choices.

| Surface | Preserve during upstream integration |
| --- | --- |
| Identity and local state | Harnessy branding, installer identity, and `%LOCALAPPDATA%\CustomHarness` remain independent. Do not import stock application state automatically. Keep shared package and protocol identifiers unchanged where interoperability depends on them. |
| MCP | Keep one visual MCP manager for saved local and HTTPS servers, protected secrets that are never rendered back, connection health, discovered tools, session-header status, and bounded tool-call activity. Fold useful upstream MCP capabilities into this owner instead of adding a second manager or exposing credentials. |
| Subagents | Keep one customizable Subagents page, named roles, model and thinking-effort choices, access limits, automatic routing, workspace overrides, and live edits. Prefer a few independent, task-sized delegations; batch related repetitive work instead of creating one child per file, image, or record. The parent remains responsible for integration and final validation. |
| Command Code | Treat Command Code as a user-owned delegation backend. Readiness comes from its configured runtime; Harnessy must not vendor its CLI, credentials, or a hidden fallback. |
| Accounts and limits | Keep multiple provider accounts, protected credentials, personal/workspace usage, clear limit bars, and explicit automatic switching behavior. A failed switch must remain visible and actionable. |
| Notifications | Notify for root-session completion, failure, approval/access needs, and questions. Avoid child-completion and repeated “no longer running” spam. Use an unread dot rather than a numeric badge, and keep Windows native notifications for actionable events. |
| Workspaces | Support ordinary local projects and remote/live-site work without requiring an existing project folder. Remote sessions use an owner-selected parent such as Desktop and an isolated per-session child folder so temporary artifacts are easy to remove. |
| Desktop lifecycle | On Windows, closing the main window hides Harnessy after acknowledgement, the tray reopens it, active work continues, and explicit Quit performs the real shutdown with interruption checks. |
| Release path | Keep the personal Windows x64 unsigned installer workflow separate from DeepSeek's signed multi-platform release infrastructure and secrets. Do not enable inherited live-service or private-runner workflows by default. |

Prefer upstream extension points and shared services over a lasting fork inside the agent loop. When upstream introduces a capability that overlaps a Harnessy page, adapt the existing page and its data owner; do not create duplicate tabs, settings namespaces, status indicators, or competing defaults.

<a id="classify"></a>
## 4. Classify each relevant change

Assign one decision to every relevant upstream group:

- **Adopt** when the upstream change is useful as written and does not conflict with a Harnessy product decision.
- **Adapt** when the behavior is useful but must enter an existing Harnessy owner, copy style, persistence path, security rule, Windows lifecycle, or release workflow.
- **Skip** when it depends on DeepSeek-only infrastructure, duplicates a custom surface, weakens credential or state isolation, changes the personal Windows product in an unwanted way, or adds maintenance cost without a user benefit.

Do not classify from commit titles alone. Inspect the changed source, tests, documentation, and current Harnessy consumer. For each recommendation record the user benefit, affected owner, required adaptation, conflict risk, focused verification, and whether an owner decision is needed.

Use these default priorities: correctness and data compatibility first; security and lifecycle second; model/provider capability third; visible usability fourth; refactors and internal cleanup last. A low-priority refactor can still be adopted when it reduces the custom diff and future merge cost without changing behavior.

<a id="questions"></a>
## 5. Ask only material questions

Lead with a recommendation and plain-language consequence, then ask one concise question only when the answer changes the result. Suitable questions include whether an upstream default should replace a Harnessy default, whether a capability belongs in an existing page or deserves a new visible surface, whether stored data may migrate, whether a new external service or secret is acceptable, and whether this task should also publish an installer.

Do not ask the owner to choose mechanical conflict resolutions, internal type names, test files, formatting, or other implementation details. Resolve those from the repository rules. When the owner says “use your recommendations,” apply the recommended option and record the assumption. When no material choice exists, proceed and report the result without a questionnaire.

<a id="recommendations"></a>
## 6. Present recommendations

Present the shortest decision-ready list before implementation when choices remain. Put the highest-value items first and separate changes that can be adopted directly from changes that require Harnessy adaptation. State what should remain upstream-only and why; “not suitable” must name the conflict or maintenance cost.

Use a compact table with these columns: **Decision**, **Upstream improvement**, **Harnessy benefit**, **Adaptation or reason to skip**, and **Risk/check**. Do not paste the full upstream log. Link to source owners or commits only when they help the owner make a decision.

<a id="integrate"></a>
## 7. Integrate and verify

For a synchronization, integrate upstream in a way that preserves ancestry, resolve overlaps in the product owners above, and update every affected consumer. Preserve the user's work and do not use destructive reset or checkout commands. Follow the repository's pre-push procedure and run the smallest focused behavior, type, documentation, and packaging checks that cover the changed surfaces; exhaustive platform and live-API coverage belongs to CI unless the task specifically requires it.

After the integration commit, verify the working tree, ancestry, and fork remote:

```sh
git status --short
git rev-list --left-right --count HEAD...upstream/master
git merge-base --is-ancestor upstream/master HEAD
git rev-parse HEAD
git rev-parse origin/master
```

Completion requires a clean intended worktree, a zero second count, a successful ancestry check, and matching local and `origin/master` revisions when pushing is in scope. A nonzero first count is normal because it represents Harnessy-only work. If pushing or installer creation is outside the task, state that explicitly instead of describing the synchronization as fully published.

When a release artifact is requested, use the fork's Windows workflow and report the workflow result, artifact name, size, and checksum. Keep that operational evidence in the task handoff or release record, not in this maintained page.

<a id="report"></a>
## Reusable handoff report

Use this template at the end of the next upstream review so a later task can continue without repeating the audit:

```md
## Upstream status

- Upstream-only commits before work: <count>
- Upstream-only commits after work: <count>
- Scope: review only | synchronized | synchronized and released

## Recommendations

| Decision | Improvement | Benefit to Harnessy | Required adaptation | Risk/check |
| --- | --- | --- | --- | --- |
| Adopt / Adapt / Skip | ... | ... | ... | ... |

## Owner questions and answers

- <Only material choices; write “None” when no choice was required.>

## Integrated work

- <User-visible behavior and its owner, not a raw commit list.>

## Verification

- `<exact command>` — <result>

## Deferred or upstream-only

- <Item and concrete reason.>

## Next review

- Start from `git log --right-only --cherry-pick --no-merges --oneline HEAD...upstream/master`; do not re-audit commits already contained by `HEAD`.
```

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This page is the durable handoff. Keep moving revision IDs, workflow run URLs, artifact checksums, and one-time conflict details in the task or release record. Update this page only when a Harnessy product owner, upstream-review policy, or verification path changes.

</details>
