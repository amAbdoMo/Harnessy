---
description: "Keep each Session's current working directory across replay and validate directory changes before execution."
kind: "package-reference"
---

# @deepseek-ai/dsh-working-directory

English | [中文](README.zh.md)

## Summary

Keep a Session's current directory independent from its original project and other Sessions. Changes persist in the Session log and appear in subsequent model context. Missing directories recover to the original project when it still exists; unavailable original projects fail explicitly. Existing processes and permission roots remain unchanged.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The shared base profile mounts this service. Custom compositions using the directory-aware filesystem or shell tools must mount it alongside a filesystem provider, Session projections and system prompts.

```yaml
- name: '@deepseek-ai/dsh-working-directory'
```

| Field | Default | Meaning |
|---|---|---|
| `defaultDirectory` | Launch directory | Absolute execution-world directory for Sessions without an original project. |

`get(session)` reads the effective directory without filesystem access or mutation. `ensure(agent, signal)` validates it and recovers a missing changed selection to the original project, or the deployment fallback for a headerless Session. `set(agent, path, signal)` validates a new absolute or relative directory before committing the change. Directory checks use the filesystem injected into this service, so the Agent's context does not need its own filesystem injection.

`Session.header.cwd` remains the immutable original project used for settings, workspace association and sandbox authority. Only actual changes or recoveries append mandatory `working-directory/change` events; a fallback read, initial assembly or listing does not append an initial value or migrate a Session merely to record that fallback. Older builds that do not recognize this required event must refuse the log rather than execute in the wrong directory. No header or historical file is rewritten or moved.

`working-directory/before-change` is a synchronous authorization waterfall for proposed directories, including paths not yet created. Policies can be checked during preflight and are rechecked immediately before publication. Every permitting policy delegates to `next()`; rejection preserves the directory and adds no event or notice. The [Auto-review integration](../../experimental/auto-review/README.md#known-limitations-and-deferred-work) restricts moves while its preset is active.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Session projection folds committed directory changes while preserving immutable project metadata. Changes for one Session serialize; separate Sessions remain independent. Cancellation or Agent disposal before commit prevents publication. Service disposal aborts and drains owned operations. A failed notice injection leaves committed state intact and emits a warning.

See [the implementation](src/index.ts) and [behavior tests](tests/working-directory.spec.ts).

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Session projections](../session-projection/README.md) — replayed state and wire observations.
- [Filesystem services](../../fs/fs/README.md) — execution-world path resolution.
- [System prompts](../../core/system-prompt/README.md) — required user context.

<a id="model-experience"></a>
## Model Experience

### Current directory

#### What the model sees

Required user context includes `Current working directory: "<absolute directory>".` even when optional runtime context is disabled. Assembly also refreshes the legacy `{{cwd}}` template variable without replacing custom prompt text. Committed changes and recovery queue a user-role notice; admitted context and notices are logged for model-history reconstruction. The Session header retains the original project directory.

#### Token effect

Each assembly includes the directory sentence. Changes add a short transition notice; unchanged reads add no transition notice.

#### KV Cache effect

A changed directory changes the corresponding context text and appends its transition notice. The reusable prefix ends at the first changed context token.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Directory changes apply to future operations only.

- Running processes retain their existing directories.
- Permission roots do not expand when the current directory changes.
- Recovery fails when both the current directory and original project are unavailable; an explicit valid change can recover the Session.

<a id="dev-note"></a>
### Dev Note

None.
