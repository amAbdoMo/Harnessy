---
description: "Host capability probe for repository tests: whether this machine can create a real symbolic link, so symlink tests run wherever the privilege exists instead of being skipped by platform."
kind: "package-library"
---

# @deepseek-ai/dsh-platform-probe

English | [中文](README.zh.md)

## Summary

This library answers one question for a repository test: whether this host can create a real symbolic link. On Windows that needs Developer Mode or SeCreateSymbolicLinkPrivilege, so the answer is a capability rather than a platform, and a Windows host holding the privilege runs every test this probe gates. Call `symlinksUsable()` from a `skipIf` guard. The probe creates one real symlink inside a fresh temporary directory, removes it, and caches the answer for the process; it never throws. Where a test needs only a directory alias, keep the repository's privilege-free junction idiom.

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

### When to use it

Reach for it when a spec must create a real symbolic link and depend on the link's own semantics: a dangling link, a link that escapes a sandbox root, `lstat` symlink identity, or a link whose target text a `readlink`-style assertion reads. A spec that needs only a directory alias takes the repository's `symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')` idiom instead, which needs no privilege on any host.

### Entry point

Guard the spec at collection time, with the reason the guard exists:

```ts
import { symlinksUsable } from '@deepseek-ai/dsh-platform-probe'
import { it } from 'vitest'

// A real symbolic link needs Developer Mode or SeCreateSymbolicLinkPrivilege on Windows.
it.skipIf(!symlinksUsable())('follows a dangling link', async () => { /* ... */ })
```

`symlinksUsable()` returns whether this host created the probe link; `describe.skipIf(!symlinksUsable())` covers a suite whose hooks create the link. The call is the gate: the bare name `symlinksUsable` is a function value, so `!symlinksUsable` would be `false` and silently run every gated spec. Never gate on `process.platform === 'win32'`, which would skip a Windows host that can create links.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

The probe measures a capability rather than a platform. Off Windows it returns `true` without touching the filesystem, because POSIX hosts need no privilege. On Windows it creates one temporary directory through `mkdtempSync`, writes a file inside it, creates a symbolic link to that file with an explicit `file` type, and confirms the result through `lstatSync(link).isSymbolicLink()`.

The explicit type is what makes the answer honest: Windows refuses a real symlink it cannot create rather than substituting a junction, which would satisfy a weaker probe on a host that still cannot run the specs above. Everything runs inside one `try`, so a refused privilege, an unreadable temporary directory, or a result that is not symbolic all return `false`. The `finally` removes the temporary directory on both paths and swallows a cleanup failure, keeping the answer independent of cleanup.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `symlinksUsable`: the once-per-process probe and its module-level cache |
| — | No invariant companion is published because the probe owns no Cordis event stream and no shared data; its contract is a pure host capability read. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Testing policy](../../../docs/testing.md) — the platform accommodations and self-skipping conventions this probe serves.
- [Development](../../../docs/development.md) — running one focused spec from a source checkout.
- [Test-support group map](../README.md) — sibling harnesses and support packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as this probe reads one host capability for tests and registers nothing model-facing.

#### KV Cache effect

None; it never assembles or sends a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These constraints hold for the current probe:

- **One capability.** The probe answers the symbolic-link question only; a further host capability needs its own probe module rather than a widening parameter here.
- **The first call fixes the answer for the process.** A host that gains Developer Mode after the first call keeps reporting the cached result until the process restarts.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
