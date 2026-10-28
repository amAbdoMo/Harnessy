---
description: "Review DeepSeek Harness upstream work, preserve Harnessy's product decisions, and integrate only fully reviewed checkpoints with an exact adoption and exclusion ledger."
---

# Cookbook: reviewing upstream for Harnessy

## Summary

Use this handoff to integrate selected upstream improvements without replacing Harnessy's custom behavior. Review every commit included by a checkpoint, including merged side branches, and record adoption, adaptation, or deliberate exclusion. Preserve Harnessy's custom MCP, subagent, account, workspace, notification, and Desktop owners. Ask the owner only when a choice changes visible behavior, stored data, security, operating cost, or release scope.

The [review ledger](scripts/harnessy-upstream-review.json) pins the inventory, decisions, evidence, and integrated checkpoint. An entry without a review is unreviewed; a partial port does not account for its unchecked remainder. Keep moving hashes and per-commit evidence in that ledger, not this procedure. Git ancestry records the integrated checkpoint; GitHub's behind count includes newer commits and is not an arbitrary per-commit review counter.

## Table of Contents

- [Before you start](#before-start)
- [1. Load the smallest useful context](#load-context)
- [2. Find only new upstream work](#find-new-work)
- [3. Protect Harnessy's product decisions](#protect-decisions)
- [4. Classify each relevant change](#classify)
- [Batch integration workflow](#batch-workflow)
- [5. Ask only material questions](#questions)
- [6. Present recommendations](#recommendations)
- [7. Integrate and verify](#integrate)
- [Reusable handoff report](#report)
- [Dev Note](#dev-note)

-----

<a id="before-start"></a>
## Before you start

Confirm the task's scope. A **review** is read-only and ends with recommendations. A **checkpoint integration** fetches upstream, accounts for the chosen checkpoint's complete missing ancestry, integrates selected work, runs focused checks, and publishes only when qualified. Newer unreviewed commits may remain behind; state their count. A full synchronization additionally accounts for the fetched upstream tip. Build an installer only when Desktop packaging changed or the owner requested a release artifact.

Preserve uncommitted user work. Inspect the worktree before fetching or merging, and never discard, overwrite, or hide unrelated changes. Harnessy does not need an automatic rollback copy; Git commits and the remote branch are the recovery points unless the owner explicitly requests another backup.

Use `origin` for the Harnessy fork and `upstream` for the main DeepSeek Harness repository. Verify those names instead of assuming their URLs:

```sh
git remote -v
git status --short
```

<a id="load-context"></a>
## 1. Load the smallest useful context

Read [AGENTS.md](AGENTS.md) first. Read [the architecture](docs/architecture.md) before changing `packages/`, [defensive patterns](docs/defensive-patterns.md) before lifecycle, concurrency, subprocess, or teardown work, and the applicable package README before editing its implementation. Do not read every old Agent Note.

The following files are the fast product map. Read the first three for every synchronization, then open only the area-specific decisions affected by the new upstream diff.

| Area | Current owner and focused decisions |
| --- | --- |
| Product identity and contributor entry | [Root README](README.md), [custom bundle README](packages/bundle/custom-harness/README.md), and [Harnessy client README](packages/client/ui-brand-custom-harness/README.md) |
| MCP management and activity | [MCP manager decision](.agents/notes/implemented/feature/2026-09-13-harnessy-mcp-manager.md) |
| Configured subagents and routing | [Subagents Settings decision](.agents/notes/implemented/feature/2026-09-16-subagents-settings-page.md), [Command Code lanes](.agents/notes/implemented/feature/2026-09-15-commandcode-delegation-lanes.md), and [runtime signals and failover](.agents/notes/implemented/bug-fix/2026-09-19-harnessy-runtime-signals-and-failover.md) |
| Accounts, usage, and switching | [Multi-account manager decision](.agents/notes/implemented/feature/2026-09-12-harnessy-multi-account-manager.md) and [account usage decision](.agents/notes/implemented/feature/2026-09-17-codex-personal-workspace-usage.md) |
| Optional and remote workspaces | [Optional workspace decision](.agents/notes/implemented/feature/2026-09-12-optional-workspace-sessions.md) and [default workspace decision](.agents/notes/implemented/feature/2026-09-20-default-workspace.md) |
| Windows background lifecycle and packaging | [Desktop README](apps/desktop/README.md) and [fork CI decision](.agents/notes/implemented/process/2026-09-09-custom-harness-fork-ci.md) |

Scan upstream filenames and diff statistics before opening implementation files. This identifies the affected rows in the table and avoids loading unrelated packages, documentation, and old decisions.

<a id="find-new-work"></a>
## 2. Find only new upstream work

Fetch both remotes, then calculate the comparison from the current Harnessy `HEAD`:

```sh
git fetch origin
git fetch upstream
git rev-list --left-right --count HEAD...upstream/master
git log --reverse --topo-order --oneline HEAD..upstream/master
git diff --stat HEAD...upstream/master
```

The count is `<Harnessy-only> <upstream-only>`. The second number is the amount Harnessy is behind. Include every missing upstream commit in the ledger, including merges and patch-equivalent commits; equivalence is a review decision, not permission to omit an ancestor. Preserve left-side custom commits. If the second count is zero, verify the ledger and stop the missing-commit audit.

Choose bounded milestones from upstream's first-parent history, then inspect every newly reachable ancestor. Reverse topological order includes older side branches; its first unreviewed entry is not necessarily the next master checkpoint.

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
| Notifications | Notify for root-session completion, failure, approval/access needs, and questions. Avoid child-completion and repeated “no longer running” spam. Keep the white outlined numbered unread-completion taskbar badge, and keep Windows native notifications for actionable events. |
| Workspaces | Support ordinary local projects and remote/live-site work without requiring an existing project folder. Remote sessions use an owner-selected parent such as Desktop and an isolated per-session child folder so temporary artifacts are easy to remove. |
| Desktop lifecycle | On Windows, closing the main window hides Harnessy after acknowledgement, the tray reopens it, active work continues, and explicit Quit performs the real shutdown with interruption checks. |
| Release path | Keep the personal Windows x64 unsigned installer workflow separate from DeepSeek's signed multi-platform release infrastructure and secrets. Do not enable inherited live-service or private-runner workflows by default. |

Prefer upstream extension points and shared services over a lasting fork inside the agent loop. When upstream introduces a capability that overlaps a Harnessy page, adapt the existing page and its data owner; do not create duplicate tabs, settings namespaces, status indicators, or competing defaults.

<a id="classify"></a>
## 4. Classify each relevant change

Assign one decision to every reviewed upstream group. Record every group's changed paths and their dispositions in the ledger; mixed commits may adopt selected behavior while explicitly excluding other hunks. Keep unreviewed commits marked unreviewed, and do not advance a checkpoint across a gap:

- **Adopt** when the upstream change is useful as written and does not conflict with a Harnessy product decision.
- **Adapt** when the behavior is useful but must enter an existing Harnessy owner, copy style, persistence path, security rule, Windows lifecycle, or release workflow.
- **Skip** when it depends on DeepSeek-only infrastructure, duplicates a custom surface, weakens credential or state isolation, changes the personal Windows product in an unwanted way, or adds maintenance cost without a user benefit.

Do not classify from commit titles alone. Inspect the changed source, tests, documentation, and current Harnessy consumer. For each recommendation record the user benefit, affected owner, required adaptation, conflict risk, focused verification, and whether an owner decision is needed.

Use these default priorities: correctness and data compatibility first; security and lifecycle second; model/provider capability third; visible usability fourth; refactors and internal cleanup last. A low-priority refactor can still be adopted when it reduces the custom diff and future merge cost without changing behavior.

<a id="batch-workflow"></a>
## Batch integration workflow

Use a complete upstream feature or dependent PR group as the work unit. Select a final revision containing its fixes, inspect the combined diff against Harnessy, and inventory every constituent commit and merged branch. Read intermediate hunks when the combined diff hides a deletion, reversal, migration, exclusion or merge resolution; do not reimplement each intermediate version. Reuse DSH source and tests directly where compatible, adapting overlaps at Harnessy's existing owners.

Keep one batch table with exact upstream identities, affected paths, adopted/adapted/excluded decisions, supporting local commits, required checks and unresolved failures. Extend existing evidence instead of creating overlapping audit reports. Review independent areas in parallel with file ownership assigned before edits; the coordinating agent owns shared files, integration and final verification.

Choose checks before implementation using [pre-push checks](.agents/skills/dsh-pre-push-checks/SKILL.md). Reuse applicable passing evidence; upstream results support unchanged code but do not establish Harnessy's composition. Run focused behavior and required recorded-output checks for changed behavior, custom-owner checks for overlaps, and package/platform checks when those paths change. Keep the mandatory checkpoint product guard and normal hooks. Run shared checks once after the batch settles; repeat only evidence invalidated by a change or failure.

Before a hosted run, check fixture dependencies, selectors, header ownership and input/output inventories locally. Combine independent diagnostics into the approved job budget and retain every failure. Do not refresh unrelated recordings or turn each failed case into a separate dispatch. When a shared change affects many recordings, select their complete affected set once; preserve committed input generations and require successful qualification before importing outputs.

Record independently completed groups in the ledger even while another group remains pending. A failure blocks its affected group and dependent checkpoint, not unrelated review work. Diagnose whether it concerns product behavior, fixture adaptation or infrastructure; fix its owner without weakening assertions. Advance only a fully reviewed ancestor closure through the [normal integration procedure](#integrate). Report completed features, pending groups, the next checkpoint blocker and Git behind separately. Source delivery does not establish a main-app update.

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

Create an isolated `codex/upstream-*` branch; never merge upstream directly into `master` or operate on the active dirty checkout. Keep the ledger's baseline fixed and extend its pinned inventory without losing existing reviews. The verifier needs the pinned Git objects and their ancestry, so fetch the required history before checking a shallow clone. Inspect constituent diffs and merge resolutions, implement selected fixes, and document exclusions at their affected paths. Do not use a blanket `ours` strategy or attach unchecked ancestry to clear the counter.

Before integrating a candidate, run `pnpm run verify:harnessy-upstream --checkpoint <checkpoint>` with its full commit ID. This read-only check requires exact inventory metadata, complete per-group path coverage, explicit merge evidence, and a reviewed ancestor closure. It also rejects unreviewed ancestry already acquired by `HEAD` and proposals that omit acquired upstream ancestors; it cannot establish that a reviewer's reasoning or evidence is correct. Qualification remains separate: selected runtime changes need focused behavior and recorded-session checks.

Merge the reviewed checkpoint normally and resolve each overlap according to its ledger disposition. Preserve custom owners and frozen historical files. Set `reviewedThrough` to the accepted checkpoint in the integration result, then run the checks below. `verify:harnessy-product` remains mandatory after conflict resolution; it checks identity, isolated state, custom bundle, Desktop launcher, accounts/models, MCP status, and configured-subagent behavior. Follow the normal pre-push procedure; do not bypass hooks or rebuild the active app.

After the integration commit, verify the working tree, ancestry, and fork remote:

```sh
pnpm run verify:harnessy-upstream
pnpm run verify:harnessy-product
git status --short
git rev-list --left-right --count HEAD...upstream/master
git merge-base --is-ancestor <reviewed-checkpoint> HEAD
git rev-parse HEAD
git ls-remote --heads origin staging
```

A completed checkpoint requires a clean intended worktree, a passing ledger check, successful checkpoint ancestry verification, qualified selected changes, and matching local and `origin/staging` revisions when publication is requested. Verify that newly acquired upstream ancestors equal the reviewed checkpoint's declared closure. A full synchronization also requires zero commits behind the fetched upstream tip; a bounded checkpoint must report the remaining behind and unreviewed counts separately. Harnessy-only commits may remain ahead. Never push `master`, tags, releases, or an extra delivery branch without a separate request.

When a release artifact is requested, use the fork's Windows workflow and report the workflow result, artifact name, size, and checksum. Keep that operational evidence in the task handoff or release record, not in this maintained page.

<a id="report"></a>
## Reusable handoff report

Use this template at the end of the next upstream review so a later task can continue without repeating the audit:

```md
## Upstream status

- Pinned upstream tip and integrated reviewed checkpoint: <ledger references>
- Commits behind before / after: <counts>
- Ledger adopted/adapted / reviewed-excluded / unreviewed: <counts>
- Scope: review only | checkpoint integrated | fully synchronized | released

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

- Start from the ledger's remaining unreviewed entries and `git log --reverse --topo-order --oneline HEAD..upstream/master`. Reuse valid recorded evidence; do not infer review from an adopted hunk, commit title, or reduced counter.
```

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This page is the durable handoff. Keep moving revision IDs, workflow run URLs, artifact checksums, and one-time conflict details in the task or release record. Update this page only when a Harnessy product owner, upstream-review policy, or verification path changes.

</details>
