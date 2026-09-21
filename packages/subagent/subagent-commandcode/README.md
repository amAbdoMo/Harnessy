---
description: "Harnessy's Command Code delegation plugin for operators and maintainers configuring lanes, run limits, and workspace overrides, and for models choosing a lane to delegate through."
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-commandcode

English | [中文](README.zh.md)

## Summary

This plugin connects Harnessy to the user's installed Command Code CLI. It owns the lane settings, run bounds, `commandcode` Remote namespace, and `ctx.subagents` backend used by roster roles. Profiles that delegate through lanes directly receive the token-stable `list_commandcode_lanes` and `commandcode_delegate` tools by default; a profile that exposes only the unified roster can disable those tools while retaining the backend and diagnostics. Each stored lane fixes its model, reasoning effort, and access level, so a delegated task cannot choose or widen them. Loading starts no Command Code process.

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

Mount the Host row in a Profile. In this repository the `custom-harness` product patch layer owns that row, so Harnessy gets the feature and every other profile stays without a Command Code route.

```yaml
- id: commandcode-delegation
  name: '@deepseek-ai/dsh-subagent-commandcode'
```

### Requirements

The user supplies the CLI. This package never vendors, installs, or redistributes Command Code, and it never reads, copies, or stores its credentials. The user installs the CLI, signs in, and picks lanes in Settings.

| Platform | Executable this build invokes |
|---|---|
| Windows | `cmdc` |
| Other | `cmd` |

On Windows the npm shim is read for the JavaScript entry it launches and that entry runs under the current Node executable, because the shared subprocess seam spawns argv directly and never through a shell.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `disposeGraceMs` | `3000` | Grace between the shared managed-range owner's termination tiers |
| `toolsEnabled` | `true` | Whether to register the pre-roster lane discovery and delegation tools; the backend, settings, health, and Remote surfaces remain available when false |

Everything a user tunes at runtime lives in the `commandcode-delegation` settings section rather than in composition configuration, so an edit applies to the next delegation from an existing Session.

| Field | Default | Meaning |
|---|---|---|
| `maxConcurrentRuns` | `2` | Command Code runs allowed in flight, foreground and background together (1–16) |
| `timeoutMs` | `3600000` | Wall-clock bound for one run (at most `MAX_TIMER_DELAY_MS`) |
| `maxTurns` | `60` | Turn cap passed to the CLI's `--max-turns` (1–1000) |
| `lanes` | `code`, `review`, `tests`, `docs`, `research`, `architecture` | Stored lane directory |
| `projects` | `{}` | Per-workspace lane overrides keyed by canonical workspace path |

Each stored lane carries an `id`, a display `name`, a one-line `purpose`, optional `instructions`, an exact `model`, an `effort` of `default`, `low`, `medium`, or `high`, an `access` of `read-only` or `full-access`, and an `enabled` flag. Every built-in lane starts on `deepseek/deepseek-v4.1-flash`; `code`, `tests`, and `docs` default to `full-access`, while `review`, `research`, and `architecture` default to `read-only`.

### Access levels

Full access runs the CLI with `--yolo`, which lets it edit files and run commands in the workspace without asking. Read-only omits `--yolo` and passes `--permission-mode plan`, which keeps the CLI's native read-only behavior. Only the stored lane selects between them; the model supplies a lane id and nothing else.

### Subagent backend

The plugin registers one provider on `ctx.subagents` under the fixed name `commandcode`, so a roster role whose `execution.backend` is `commandcode` runs through this CLI. The name is fixed because stored roles name it: the roster projects every pre-roster lane onto that backend, so a renamed provider would leave those roles without one.

The backend reads the role's route from `agentOptions`: the model id reaches `--model` unchanged and the reasoning effort reaches `--effort`, so the catalog it accepts is the CLI's own rather than `ctx.llm`'s. A role naming no route passes no `--model` and the CLI applies its own configured default; an effort the CLI does not accept refuses the start. Access maps onto the same two permission modes the lanes use, and a role demanding a level the CLI cannot express — `workspace-write` — is refused at start rather than rounded to another one. The role's instructions prefix the brief, and the turn cap and wall-clock bound come from the settings section above.

The backend advertises `agentOptions`, `persona`, and `accessPolicy` and nothing else: a CLI child owns its tools, its delegation depth, and its structured output, so a role asking for a tool filter or a depth cap on this backend is refused at start.

### Workspace overrides

`projects` is keyed by a canonical workspace path. An override entry is a field patch on a global lane: every field it omits inherits, every field it names replaces. A Session without a workspace uses the global lanes unchanged. Deleting a lane also deletes every override that patched it, so a later lane reusing the id cannot inherit a stale patch.

### Background runs

A call that does not set `run_in_background: false` registers its job synchronously and returns the job id before anything is probed or admitted. The job owns the CLI preflight, the concurrency slot, the process, and the teardown from there, so a caller is never held while an earlier run finishes or while a probe is in flight.

Killing a job that is still probing or waiting for a slot settles it as killed, starts no Command Code process, and returns the slot it held — or takes none at all if it had not been admitted yet. Killing a live run terminates its process tree before the job settles. A delegation that never reached a run settles as a failed job whose detail is the same fixed product-owned diagnostic a failed run uses — never a host path, command, or raw product error.

`job_output` returns what the same call would have returned in the foreground. While the run is live it reports only the current coarse activity — thinking, reading, editing, running a command, finalizing — and nothing else. After settlement it reports the run's bounded final answer, or the product-owned diagnostic together with any partial answer the CLI already produced when the run failed. A killed job reports no answer, because a cancelled delegation has none.

### Health and the model catalog

Installation, version, and sign-in state are read when the Subagents page asks and again immediately before each delegated run; loading the plugin, and loading the tools, starts nothing. A concurrent probe is joined rather than repeated. A lane always accepts a manually typed exact model id, and the Subagents page reads the CLI's advisory `--list-models` catalog to offer its routes, because catalog membership is advisory and native execution is authoritative.

### Per-model reasoning efforts

Command Code's `--list-models` listing carries an id and a description, and its `--effort` flag accepts a fixed vocabulary; neither says which level a given model takes. The per-model answer is the catalog the CLI ships and validates its own `model:effort` shorthand against — `bundled/command-code-knowledge/reference/models.md` beside the installed entry point, whose `Efforts` column lists the level set for each id it serves and a dash for the models that decide their own reasoning depth. The plugin reads that catalog and publishes it through `ctx.llm.registerModelCapabilitySource` as the per-model capabilities a discovery fetch may adopt, so `deepseek/deepseek-v4-pro` is offered `high` and `max` alone while `Qwen/Qwen3.8-Flash` is offered `low`, `medium`, and `xhigh`. The catalog is resolved from the installed entry point lazily on the first lookup, so mounting the plugin touches no files. The source answers only for routes that name Command Code or point at a `commandcode.ai` endpoint, because the catalog is keyed by model id and Command Code serves bare ids for other vendors' models; an absent, moved, or reformatted catalog yields no answers at all, which leaves every model undeclared rather than offering a level set nobody stated.

### Failure and recovery

There is no fallback. When the CLI is missing, not signed in, or reports a lane's model, access, or account state as unusable, the delegation fails with a bounded product-owned diagnostic naming the cause and the process outcome, and nothing else is tried. A cancelled run settles as `aborted`; a run that outlives its lane timeout is terminated and settles as a failure that names the time limit.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

- **Lanes are policy, not parameters.** The model names a lane; the lane decides the model, the effort, and the access level. A call cannot widen any of them, and the two tool schemas expose no field that could.
- **Read through at call time.** Bounds and lanes are read from the live settings namespace on every delegation, so a saved edit reaches the next run without restarting anything.
- **One owner per concern.** The shared subprocess service owns the process tree, the generic job registry owns scheduling and completion notices, and this package owns only Command Code's own lifecycle decisions.
- **Bounded and sanitized at the source.** The parent Session only ever sees text that already passed the 12 KiB UTF-8 bound, and only fixed failure facts; the raw stderr tail stays on the Host.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service entry: settings registration, Remote namespace, probe memoization |
| [`src/tools.ts`](src/tools.ts) | The two model-facing tools and the foreground adaptation |
| [`src/backend.ts`](src/backend.ts) | The `commandcode` provider on `ctx.subagents`: route, access, and lifecycle adaptation |
| [`src/job.ts`](src/job.ts) | The background adaptation: one job whose task owns preflight, admission, spawn, and teardown |
| [`src/settings.ts`](src/settings.ts) | Namespace name, schema, and lane resolution for one workspace |
| [`src/lanes.ts`](src/lanes.ts) | Built-in lanes, workspace keys, and brief composition |
| [`src/cli.ts`](src/cli.ts) | Executable resolution, health probe, and catalog parsing |
| [`src/argv.ts`](src/argv.ts) | The CLI invocation, with the brief on stdin |
| [`src/protocol.ts`](src/protocol.ts) | Incremental NDJSON reading, activity, and exit codes |
| [`src/run.ts`](src/run.ts) | One-shot lifecycle, timeout, cancellation, teardown |
| [`src/limiter.ts`](src/limiter.ts) | The shared concurrency gate |
| [`src/bound.ts`](src/bound.ts) | The parent-visible byte bound |

### Run flow

A call resolves the current workspace's lanes, requires an enabled lane id, and builds the brief from the lane's instructions plus the task. A foreground call then awaits the CLI preflight and a concurrency slot, spawns the CLI with the lane's flags and the brief on stdin, and reads the NDJSON stream line by line. A background call instead registers a job whose starter performs that same sequence, so registration returns an id and only the job's own task probes, waits, spawns, and tears down. Only a `result` frame whose subtype is `success` and whose `finalText` is non-blank completes a run; every other terminal state, a truncation without a result frame, a non-zero exit with no result frame, and a missing process outcome all become bounded failures once the process itself has been observed to end.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Delegation subsystem](../../../docs/subsystems/subagent.md) — the shared delegation contracts this feature reuses.
- [dsh-subagent](../subagent/README.md) — the seam whose out-of-process vocabulary this package composes with.
- [Harnessy product patch layer](../../bundle/custom-harness/README.md) — the profile that mounts this plugin and its settings section.
- [Subagents settings page](../../client/ui-settings-subagents/README.md) — the Settings surface where the roster this configuration migrates into is edited.
- [Generated configuration catalog](../../../docs/config-catalog.md) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Lane discovery

#### What the model sees

`list_commandcode_lanes` reports the enabled lanes resolved for the current workspace: each lane's `id`, `name`, `purpose`, exact `model`, `effort`, and `access`. It reports no instructions, no paths, no unrelated settings, and no part of the CLI catalog.

#### Token effect

One small result per call, proportional to the number of enabled lanes.

#### KV Cache effect

Append-only: one result after the reusable prefix.

### Delegation

#### What the model sees

`commandcode_delegate` takes a required lane id, a self-contained task, and an optional `run_in_background`. It exposes no model, effort, timeout, turn, executable, credential, or permission field. A background call returns a job id; the generic job runtime delivers the completion notice, and `job_output` then carries exactly what the same call would have returned in the foreground: the bound final answer, or the diagnostic and preserved partial answer of a failed run. A foreground call returns that text directly. A failed run returns a bounded product-owned diagnostic that names the cause and the process outcome, plus any partial answer the CLI already produced. Command Code's reasoning, tool traffic, commands, file contents, raw stderr, native session ids, and full transcript never enter the parent Session.

#### Token effect

Foreground input grows by the retained final answer or failure diagnostic, both bounded to 12 KiB. Background input additionally carries the start acknowledgement, the completion notice, and any `job_output` or `job_kill` result.

#### KV Cache effect

Append-only: results follow the reusable prefix, and a background completion notice may add one turn without rewriting it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The brief travels in argv-adjacent stdin, not argv** — `-p` with no query argument is the CLI's documented piped-input form, so task text never enters the command line; the CLI's own 30-second stdin timeout still bounds how late that write may arrive.
- **No continuation or resume** — every delegation is one fresh one-shot run; the CLI is invoked with `--no-session`, and Harnessy keeps only current-session job history.
- **Catalog parsing is advisory** — `--list-models` is read by shape, not by a pinned schema; a reformatted listing yields no rows and the Settings page asks for an exact model id instead.
- **Windows resolution depends on the npm shim** — a Windows install whose `cmdc.cmd` does not name a JavaScript entry is reported as unusable rather than bypassed.
- **No per-call overrides by design** — a task that needs a different model, effort, or access level needs a different lane; there is no callable escape hatch.
- **A role's access vocabulary is wider than the CLI's** — the CLI expresses read-only and full access only, so a `commandcode` role naming `workspace-write` is refused at start rather than approximated.
- **One CLI implementation** — the plugin talks to the user's installed Command Code only; there is no alternative backend, and no fallback when it is missing.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

- **Flag surface is derived from the installed CLI** — the invocation, exit-code vocabulary, and JSON output shape come from Command Code 1.54.0's own `--help` and bundled headless reference; a future release that changes them needs the same derivation again rather than a guess.
- **Access is a lane field, not a call field** — the reason the two schemas stay token-stable is that widening a call cannot widen a permission.

</details>

**Runtime invariant:** No companion is published. Process-tree ownership belongs to the shared subprocess service, scheduling and completion notices belong to the generic job registry, and the settings document is owned by the settings service.
