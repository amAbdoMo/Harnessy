---
description: "The unified subagent roster plugin for operators defining named subagent roles and for models choosing which role should run a delegated task."
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-roster

English | [中文](README.zh.md)

## Summary

The roster is one live settings section that owns the subagent roles a deployment offers. Each role fixes its own backend, model policy, sandbox access, invocation policy, and standing instructions, so a delegation call names a role and can neither select nor widen any of them. The plugin registers two token-stable model-facing tools: `list_subagents` reports the roles enabled for the calling session's workspace, and `delegate` starts one of them. Foreground calls and background jobs draw their concurrency slot from one shared run gate.

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

Mount the Host row in a Profile. The plugin registers its tools while loading and starts no child.

```yaml
- id: subagent-roster
  name: '@deepseek-ai/dsh-subagent-roster'
```

The backend a role names must be registered too; the shipped roles use the in-process `spawn` provider.

```yaml
- id: subagent-spawn-in-process
  name: '@deepseek-ai/dsh-subagent-spawn-in-process'
```

### Configuration

Composition configuration carries nothing: every value a user tunes lives in the `subagent-roster` settings section, which the tools read through on each call, so a saved edit applies to the next delegation from a session that is already running.

| Field | Default | Meaning |
|---|---|---|
| `subagents` | `code`, `review`, `tests`, `docs`, `research`, `architecture` | The global role directory |
| `overrides` | `{}` | Per-workspace role patches, keyed by canonical workspace path |
| `automaticRouting.enabled` | `false` | Whether a call may select a model route at all |
| `automaticRouting.allowedModels` | `[]` | Exact `{ provider, model }` routes an explicit selection must resolve to |
| `limits.maxConcurrentRuns` | `2` | Delegations allowed in flight together, foreground and background (1–16) |
| `limits.defaultTimeoutMs` | `3600000` | Wall-clock bound for a role that names none (at most `MAX_TIMER_DELAY_MS`) |

### Roles

A role carries an `id` (an argv-safe token the model names verbatim), a display `name`, an `enabled` flag, a one-line `purpose`, `whenToUse` routing guidance, an `invocation` policy, a `model` policy, an `access` level, optional `tools` scoping, standing `instructions`, an optional `maxDepth`, and an `execution` block naming the `backend`, the `background` schedule, and an optional per-role `timeoutMs`.

The shipped six are ordinary definitions: nothing privileges a built-in id, so a user may edit, disable, duplicate, or delete any of them, and a role they add behaves identically.

### Access

`access` is `inherit` or one of the sandbox modes. A child's delegated mode is the narrower of its parent's effective mode and the role's access, so a role can only tighten access — never widen it — and `inherit` records exactly what a delegation that names no access records today. The parent's effective mode is resolved through the live sandbox policy, so a deployment default can be narrowed for one child even when the parent session carries no override. The plugin passes no access, sandbox, or permission parameter, so escalation is unrepresentable at the tool boundary.

### Invocation policies

| Policy | What the router requires before starting the child |
|---|---|
| `automatic` | Nothing beyond an enabled role |
| `ask-first` | An `allowed-once` answer from the composed approval service; every other outcome, a missing service, and a throwing answerer all refuse the start |
| `manual` | A direct human turn: the caller must be a runtime root and the open turn must hold a human-sourced message |

The parent's policy governs the parent's `delegate` call. The child's own approval policy stays pinned to `never`, so `ask-first` does not weaken a child's protection against widening its own scope.

### Model routing

A role's `model` policy defaults to `fixed`, so the user owns the child's model and only an explicit per-role `automatic` opts that role into agent-chosen routing. A `fixed` role that names a route pins exactly it: the router sends that route as the child's agent options and refuses a call that names any route field. A `fixed` role that names no route contributes none, so the child inherits the calling parent's resolved route and the parent still cannot change it. An `automatic` role accepts optional `provider`, `model`, and `reasoning_effort`, and only from `automaticRouting.allowedModels`; the existing selection path merges the request over the role's own route, rejects an unauthorized route with `child LLM route "<provider>/<model>" is not allowed for this Session`, and resolves the effective route through the live LLM runtime before any child exists. Changing the route without naming an effort drops the configured effort, because the effort belonged to the route it replaced.

### Workspace overrides

`overrides` is keyed by the canonical workspace path that `path.resolve` produces for the session's `cwd` (lower-cased on Windows). An entry is a field patch on a global role: every field it omits inherits, every field it names replaces, and a `removed` list drops a role for that workspace alone. A patch naming half of a route is a patch on the whole route field.

### Background runs

A background delegation registers its job synchronously and returns the job id before admission, so a caller is never held while an earlier run finishes. The job owns the concurrency slot, the run, and the teardown from then on: killing a job that has not been admitted takes no slot, and killing a live run returns the slot it held. The child text is readable through the job's own output once it settles.

### Failure and recovery

Every refusal is loud and names the cause: an unknown id lists the configured ones, a disabled role is rejected by name, a backend nobody registered is reported before the approval channel is consulted, a route outside the authorization is rejected with the shared selection error, and a backend that cannot confine a child refuses a concrete access rather than ignoring it. There is no fallback and no silent degradation.

### Migration

A deployment whose users configured the pre-roster namespaces keeps that configuration. On the first load that finds stored `commandcode-delegation` lanes, the plugin projects them — together with the per-workspace `projects` overrides, the run bounds, and the `subagent-model-selection` authority — into the `subagent-roster` document, validates it, and writes it once.

The write is additive: `commandcode-delegation`, its `projects` overrides, and `subagent-model-selection` stay exactly as they were stored, so the old values remain inspectable and a user can revert by editing the new document. A stored `subagent-roster` section ends the migration, including one whose role list the user emptied, so a roster the user edited is never replaced. A stored legacy value that projects to an invalid document is refused with one warning and leaves the shipped roles in place.

Every migrated role keeps the `commandcode` backend, so a delegation to one of them fails loudly until a provider registers under that name.

### Remote surface

The plugin owns the generated `subagentRoster` Remote namespace, which is what a browser surface reads. Every method returns role policy and run bounds only: no credential, provider token, host path, or process output crosses it.

| Method | What it returns |
|---|---|
| `resolvedRoster(workspace, signal)` | The roles enabled for one workspace — `name`, `purpose`, `whenToUse`, `invocation`, the resolved `model` policy, `access`, and `execution` — each carrying per-field override provenance, plus the canonical workspace key they resolved for. A role this workspace disabled or removed is absent |
| `automaticRouting(signal)` | Whether explicit route selection is accepted at all, and the exact `{ provider, model }` routes an explicit selection must resolve to |
| `storedRoster(signal)` | The stored document a configuration surface edits: every definition, enabled or not, plus the run bounds |

Each read resolves the same live settings section the two model-facing tools read, so a page and the next delegation cannot disagree about a saved edit, and `workspace: null` resolves the global layer alone.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

- **Roles are policy, not parameters.** The model names a role; the role decides the model, the effort, the access level, the invocation policy, and the backend. The tool schemas expose no field that could widen any of them.
- **Read through at call time.** The settings document, and therefore the directory, the routing authority, and the run bounds, is read on every delegation, so a saved edit reaches the next call without a recomposition.
- **One run gate.** Foreground calls and background jobs take their slot from the same limiter, whose cap is read on every admission.
- **The seam owns narrowing.** The child's mode is narrowed inside `@deepseek-ai/dsh-subagent` through the same ladder the escalation check encodes; this package contributes the requested access and nothing about how it is applied.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service entry: settings registration, the run limiter, and the two tools |
| [`src/settings.ts`](src/settings.ts) | Namespace, schema, workspace canonicalization, and per-workspace resolution |
| [`src/types.ts`](src/types.ts) | The stored, resolved, and directory-entry vocabulary |
| [`src/defaults.ts`](src/defaults.ts) | The shipped roles, routing default, and run bounds |
| [`src/directory.ts`](src/directory.ts) | The model-facing directory projection and its rendered text |
| [`src/tools.ts`](src/tools.ts) | `list_subagents`, `delegate`, route resolution, and the invocation policies |
| [`src/authority.ts`](src/authority.ts) | The open-turn authority window and the direct-human check |
| [`src/limiter.ts`](src/limiter.ts) | The shared concurrency gate |
| [`src/migrate.ts`](src/migrate.ts) | The projection from the pre-roster namespaces |
| [`src/migration.ts`](src/migration.ts) | The one-shot load-time migration that reads the legacy namespaces and writes the projected document |

### Run flow

A call resolves the calling session's workspace, requires an enabled role for the id the model named, resolves the backend provider, and enforces the role's invocation policy. It then resolves the child's route — the role's fixed route, the parent's authorized selection, or nothing at all when the child inherits — before any child exists. A foreground call takes a run-gate slot, starts the child with the role's persona, tool scoping, depth cap, and requested access, and returns its final text. A background call registers the job first and lets the job's own task take the slot, start the child, and settle.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — the shared delegation contracts this plugin composes with.
- [dsh-subagent](../subagent/README.md) — the seam whose access narrowing and provider registry this package uses.
- [tool-subagent](../tool-subagent/README.md) — the per-backend delegation surface whose model-selection module this package reuses.
- [dsh-subagent-commandcode](../subagent-commandcode/README.md) — the lane system whose stored documents `src/migrate.ts` projects.
- [Generated configuration catalog](../../../docs/config-catalog.md) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Subagent discovery

#### What the model sees

`list_subagents` takes no arguments and reports one row per role enabled for the calling session's workspace: `id`, `name`, `purpose`, `whenToUse`, `invocation`, the resolved `model` (an exact `provider/model` pair with its `reasoningEffort`, or `inherit`), `access`, and `background`. Disabled roles and roles this workspace removed are absent. It reports no instructions, no settings document, and no other package's data. The rendered result is one line per role, so the routing guidance arrives in the same call that lists the ids `delegate` accepts.

#### Token effect

One result per call, proportional to the number of enabled roles: one rendered line per role, including its `purpose` and `whenToUse`.

#### KV Cache effect

Append-only: the result follows the reusable prefix.

### Delegation

#### What the model sees

`delegate` takes a required `subagent` id, a required self-contained `task`, an optional `run_in_background`, and the optional `provider`, `model`, and `reasoning_effort` fields that only an `automatic` role accepts. It exposes no access, sandbox, permission, credential, timeout, or turn parameter, and a `fixed` role refuses every route field outright. A foreground call returns the child's final text, or fails with the run's outcome detail. A background call returns a job id that `job_output` and `job_kill` address, and the job runtime delivers the completion notice. The child's transcript, tool traffic, and reasoning never enter the parent session.

#### Token effect

A foreground call adds the child's final text, or the detail of a run that did not complete. A background call adds the start acknowledgement, the completion notice, and whatever `job_output` returns.

#### KV Cache effect

Append-only: results follow the reusable prefix, and a completion notice may add one turn without rewriting it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One static schema serves both model modes** — `delegate` declares the route fields for every role, because one registered tool serves the whole directory; a `fixed` role refuses them at execution rather than at the schema. Hiding them would require re-registering the tool whenever the settings document changes.
- **A backend that cannot narrow access refuses a concrete access** — an out-of-process provider advertises `accessPolicy: false`, so a role demanding `read-only` on it fails loudly at start rather than running unconfined; such a role needs an in-process backend.
- **The settings section has no client page in this package** — the document is edited through the settings service; a Subagents page is a separate plugin's concern.
- **Workspace overrides key on one resolved path** — the canonical key is `path.resolve(workspace)`, lower-cased on Windows, so a workspace reached through a different spelling or a symlink is a different key.
- **Enabling automatic routing requires naming a route** — a document that turns selection on with no allowed model is rejected at the settings write rather than at the next delegation.
- **A role id is fixed once created** — the id is both the model-facing name and the override key, so renaming a role means adding one and removing the other.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

- **The narrowing ladder lives in the seam** — `@deepseek-ai/dsh-subagent` resolves the child's mode from the parent's effective mode and the requested access, so this package never re-implements the ordering that `sandbox/src/escalation.ts` encodes.
- **The route path is the shared one** — `requestedAgentOptions`, `assertAllowedModelSelection`, and `preflightChildLlmRoute` are the same functions `tool-subagent` uses, so the authorization and capability rules cannot drift between the two surfaces.
- **The migration separates the projection from its write** — `src/migrate.ts` builds a new document and mutates nothing it was handed; `src/migration.ts` reads both namespaces through the settings service, validates the projected document, and writes it once, leaving both legacy sections untouched.

</details>

**Runtime invariant:** No companion is published. The role directory and its run bounds are owned by the settings service, the child's policy is owned by the delegation seam, and this package holds no state a second observation could contradict.
