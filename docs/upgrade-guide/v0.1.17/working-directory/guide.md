---
kind: upgrade-guide
description: "Filesystem results use canonical operation paths, and nested PTC calls also evaluate tool presentation metadata."
---

# Update directory-sensitive tool integrations

English | [中文](guide.zh.md)

## Change

Filesystem tool results identify the canonical path used by the operation. Shell results record their startup directory. These recorded targets keep historical links stable after a Session changes directory; the original project and permission roots remain unchanged.

Tool `output.presentationMeta` also runs for successful nested PTC calls. A projection failure rejects that nested call with `ToolOutputError`. Its metadata is optional recorded presentation data; the canonical program value and model content keep their existing roles. Older records without metadata remain readable.

Subagent startup captures the requested directory before asynchronous preparation. Existing processes keep their startup directories, and Harnessy's configured provider overrides remain supported.

## Migration

1. For integrations reading filesystem or shell results, use the recorded canonical path or `cwd` instead of resolving old arguments against the Session's later directory. Keep a safe fallback for older records without that evidence.
2. Keep custom `output.presentationMeta` projections pure and JSON-safe. Exercise both native and nested PTC calls and confirm the metadata identifies the actual operation target without changing its result.
3. Use the [working-directory service](../../../../packages/session/working-directory/README.md) for the effective directory; use `Session.header.cwd` for original project identity. Confirm a new child starts in its selected directory while an existing terminal retains its startup directory.

The additive persisted metadata is acknowledged in the [persistence records](../../../persistence-changes/README.md). No user-data rewrite is required.
