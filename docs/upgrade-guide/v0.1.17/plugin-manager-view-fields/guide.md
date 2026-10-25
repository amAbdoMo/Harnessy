---
kind: upgrade-guide
description: "Plugin package inspection takes explicit fields, and bundle inventory includes registry update eligibility."
---

# Plugin inspection fields and update eligibility

English | [中文](guide.zh.md)

## Change

`viewProfilePackage(dir, spec, options)` from `@deepseek-ai/dsh-plugin-manager/operations` requires `PackageViewOptions.fields`, the fields passed to `pnpm view`. `BundleInfo.updatable` is a required boolean reporting whether the manager can check and update a registry dependency. The agent tool omits this UI-only field from its existing bundle-list result.

## Migration

1. Pass `fields: ['name', 'version', 'description', 'dsh']` to retain ordinary package inspection. Compatibility preflight reads `engines` and `peerDependencies`; version listings request their own registry fields.
2. Update inventory producers and test doubles to supply `updatable`. Let the Host manager determine eligibility for actual profile dependencies.
3. Run the type checker, then verify inventory, inspection, and version checks through the changed consumer. An omitted `fields` value in JavaScript can change the package-manager output and must be corrected.
