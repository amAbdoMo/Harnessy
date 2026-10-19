---
description: "Let an agent read or change its Session working directory without moving existing processes or changing permissions."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-working-directory

English | [中文](README.zh.md)

## Summary

Let an agent inspect its current directory or select an existing directory for subsequent operations. Relative paths use the Session's current directory. Changes persist and reach subsequent model context; running processes and permission roots remain unchanged.

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

Mount this plugin alongside the tool registry and [working-directory service](../working-directory/README.md); that service requires filesystem, Session projection and system-prompt services.

```yaml
- name: '@deepseek-ai/dsh-tool-working-directory'
```

The plugin has no configuration fields. Call `working_directory` with no `cd` to validate and read the current directory, or pass `cd` to change it. Both return `{ cwd }`, rendered to the model as the absolute directory. Empty paths and targets that are not existing directories fail. If a previously selected directory disappears, a read recovers to the original project when available; if that is also unavailable, select a valid absolute directory explicitly.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The tool delegates validation, serialization, cancellation and durable changes to the directory service. It requires a calling Agent Session and uses that Agent's identity and cancellation signal. See [the implementation](src/index.ts) for the tool schema and result renderer.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Working-directory service](../working-directory/README.md) — persistence, fallback and immutable project authority.
- [Tool registry](../../core/tools/README.md) — scoped execution and tool output.
- [Session reference](../../../docs/subsystems/session.md) — required events and replay.

-----

<a id="model-experience"></a>
## Model Experience

### Read or change directory

#### What the model sees

The `working_directory` tool description is `Read the current working directory, or change it with cd. Relative paths use the current directory. Existing shells and running processes keep their own directories.` The tool result contains the absolute directory as text. The service supplies required current-directory context and queues a logged transition notice on actual changes or recovery.

#### Token effect

The tool schema and each result add tokens. Unchanged reads add no transition notice; changes add the service's short notice.

#### KV Cache effect

Tool results append to history. A changed directory also changes the service's current-directory context; that service owns the resulting reusable-prefix effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Directory selection does not change process state or access policy.

- Existing shells, terminals and running processes keep their startup directories.
- A directory change does not grant access outside the existing sandbox permissions.
- Calls without an Agent Session fail.

<a id="dev-note"></a>
### Dev Note

None.
