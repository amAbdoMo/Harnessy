---
kind: upgrade-guide
description: "The optional experimental worktree provider and tool packages are unavailable and must be removed from custom compositions."
---

# Remove the optional worktree creator from compositions

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-experimental-worktree` and `@deepseek-ai/dsh-experimental-tool-worktree` are excluded from this Harnessy delivery. Custom compositions enabling these optional packages cannot load them. Their destructive Git operations remain vulnerable to destination or administration-directory substitution after inspection. Existing checkout directories and Git metadata are not changed by this removal.

## Migration

1. Remove entries naming either package from custom `cordis.yml` files and overlays, and remove patch overrides targeting those entries. No replacement creator is supplied.
2. Keep existing checkouts and their Git metadata; no stored-data migration or deletion is required. An existing checkout may be selected as a new Session's directory under the normal workspace and sandbox rules.
3. Verify that the composition no longer reports either package as missing and that ordinary directory-based tools remain available.
