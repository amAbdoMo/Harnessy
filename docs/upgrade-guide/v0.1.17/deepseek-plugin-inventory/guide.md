---
kind: upgrade-guide
description: "DeepSeek plugin inventory receivers must accept identities without versions and partial metadata."
---

# DeepSeek plugin inventory

English | [中文](guide.zh.md)

## Change

`DeepSeekPluginPackageIdentity.version` is optional. The `dsh_plugin_packages` version-1 field can contain public package identities with only a `name`. Private packages without a usable version are omitted. Unreadable package metadata logs a warning and omits that entry instead of failing the entire model request; readable siblings remain included. Versioned identities retain their existing representation.

## Migration

1. Update consumers of `DeepSeekPluginPackageIdentity` and wire receivers to handle an absent `version`. Keep name-only and versioned identities distinct; do not infer package activation from array order.
2. If package diagnostics are unwanted, set `enabled: false` on the existing `plugin-package-inventory-deepseek` row in the profile patch. See the [inventory package](../../../../packages/llm/plugin-package-inventory-deepseek/README.md).
3. Verify request preparation with a public unversioned plugin, a private unversioned plugin and a readable versioned sibling. Expect only the public name and the versioned sibling; corrupt metadata must not block the request.
