---
description: "Bounded read-only Workspace Brief command for users and maintainers inspecting the selected Git workspace without sending its contents to a model."
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-brief

English | [中文](README.zh.md)

## Summary

This package lets a user create a compact Markdown brief of the workspace attached to the current session. The brief includes the registered workspace name, canonical repository root, branch, bounded top-level inventory, and recognized manifest metadata; `/workspace-brief --git` also includes up to 20 status rows. Every observation is read-only, size-limited, and restricted to the selected registered workspace. The result uses the ordinary command log, so it survives session reload without entering model history.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Harnessy profile mounts this command with its browser action. Type the command directly when you want explicit control over Git-status inclusion.

| Input | Result |
|---|---|
| `/workspace-brief` | Create the brief without working-tree status rows. |
| `/workspace-brief --git` | Add a bounded working-tree status block. |
| Any other suffix | Return `Usage: /workspace-brief [--git]` without reading the workspace. |

The command rejects sessions without a selected registered workspace and workspaces that are missing or not Git repositories. Filesystem denial, Git sandbox denial, Git execution failure, and the five-second timeout remain distinct errors. An unreadable, oversized, symbolic-link, or invalid `package.json` does not discard valid repository facts; the result labels that manifest section as partial.

### Minimal composition

Mount the command after its injected command, filesystem, sandbox-policy, shell, and workspace-registry services. The Harnessy bundle supplies this ordering.

```yaml
- id: workspace-brief
  name: '@deepseek-ai/dsh-workspace-brief'
```

The package accepts no configuration fields. It never accepts an arbitrary path, writes a file, opens a network connection, or invokes a model.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`WorkspaceBriefRunner` resolves the session cwd through `ctx.workspaceRegistry`, lists the root through `ctx.fs`, rejects a linked `package.json`, and runs one constant Git command through `ctx.shell` with the resolved read-only sandbox policy. Input, manifest bytes, Git output, inventory rows, status rows, field length, total Markdown length, and elapsed time each have an independent bound. The command registry owns `command/run` and `command/done`; plugin disposal owns command unregistration.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Strict grammar, bounded observations, failure classification, Markdown assembly, and command registration |
| [`tests/workspace-brief.spec.ts`](tests/workspace-brief.spec.ts) | Success, failure, cancellation, replay, idempotency, and lifecycle coverage |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workspace registry](../workspace/README.md) — owns the selected workspace identity and directory status.
- [Commands package](../../interaction/commands/README.md) — owns dispatch and the durable log-only lifecycle.
- [Filesystem package](../../fs/fs/README.md) — owns bounded path observations and typed failures.
- [Shell package](../../shell/shell/README.md) — owns subprocess timeout, output capture, and sandbox reporting.
- [Workspace Brief decision](../../../.agents/notes/implemented/feature/2026-09-08-custom-harness-workspace-brief.md) — records the product boundary and trade-offs.

-----

<a id="model-experience"></a>
## Model Experience

None, as the human command records only `command/run` and `command/done`, which are log-only events excluded from model history; the brief text is never appended as a user, assistant, tool, or context message.

#### KV Cache effect

None; creating or replaying a brief does not change any model-request prefix or history tail.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These constraints keep the operation predictable and read-only.

- **Git workspaces only** — a registered non-Git directory receives a specific error rather than a generic filesystem summary.
- **Top-level package metadata only** — the command recognizes a fixed manifest-name set and parses only a regular top-level `package.json`.
- **Explicit refresh** — the persisted card is a point-in-time result; reconnect and reload never rerun repository inspection automatically.
- **Bounded status, not a diff** — `--git` reports at most 20 short-status rows and never reads file diffs or contents beyond the bounded manifest fields.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The runner owns no mutable state; the command registry persists each result and the plugin fiber withdraws the sole registration on disposal.
