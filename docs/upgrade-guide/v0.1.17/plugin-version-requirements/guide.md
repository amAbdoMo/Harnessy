---
kind: upgrade-guide
description: "Plugin engines.dsh takes precedence over DSH peers, and structured incompatibility records expose requirements instead of peers."
---

# Plugin version requirements

English | [中文](guide.zh.md)

## Change

A plugin's own `engines.dsh` range decides compatibility with the running DSH version. When absent, the existing DSH peer dependency checks apply. Exact plugin/runtime exemptions retain their current scope. Structured compatibility results and plugin-manager incompatibility records expose unmet ranges as `requirements` instead of `peers`; the keys identify `engines.dsh` or the DSH peer package.

## Migration

1. Plugin authors can declare their runtime range in `package.json` under `engines.dsh`. Use a valid semantic-version range; workspace ranges are not supported there.
2. Consumers of `PluginCompatibility` and `IncompatiblePlugin` must read `requirements` in place of `peers` and display its keys without assuming they are package names.
3. Check a plugin with a supported `engines.dsh` range and another with an unsupported range. The supported one is admitted even if its DSH peer ranges differ; the unsupported one is refused unless an exact-version exemption exists. A plugin without `engines.dsh` retains peer-based admission.
