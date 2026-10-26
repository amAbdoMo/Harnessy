# Agent Note: PR artifact builds and aggregate TypeScript checks

Status: implemented

English | [中文](2026-10-05-pr-artifact-typechecks.zh.md)

## Problem

Compatibility, packaging, and runtime checks need compiled workspace artifacts. Repeating the repository-wide test and script diagnostics in each artifact producer adds work even when an independent full build already owns those checks. Package compilation alone cannot replace aggregate diagnostics because the root programs include additional source files.

## Decision

Ordinary `build`, `build:custom-harness`, and `typecheck` retain the complete Host and Client aggregate checks. The supported fork workflow keeps the normal Harnessy build; inherited multi-platform CI remains subject to the [fork CI opt-in policy](2026-09-09-custom-harness-fork-ci.md).

Explicit `--artifacts-only` builds check and compile every existing reference read from each compiler face, then run the ordinary Typert, bundling, Desktop, and Web stages. References include auxiliary test programs, such as the translator and plugin-record programs; the helper does not maintain a separate package-only list. Host compilation precedes Host bundling and Desktop, followed by Client compilation and bundling. The caller must independently retain blocking full Host and Client checks for aggregate-only tests and scripts.

The Python executable builder accepts `--artifacts-only` after validating its runtime closure and rejects its combination with `--skip-build`. Its default remains a complete build. The inherited PR runtime workflow selects artifact compilation only for CI calls; release and ordinary manual calls retain full compilation. Node 22 compatibility prepares artifacts before its built lazy-search check, while the normal compatibility command retains its full typecheck unless its caller explicitly owns that check elsewhere.

The compatibility source cases share one serial Vitest invocation with fork isolation and a one-worker environment override. Workflow compatibility cases run one at a time, and the two-target Python runtime matrix waits for the keyless SDK job. Compact coverage timings sum distinct environment, preparation, setup, collection, and execution costs; cache keys isolate platform, environment, and runner pool. Timings affect scheduling only: the complete source inventory, merged coverage thresholds, and reporter failures remain required checks.

Release packing defaults to serial family order. Explicit parallel packing uses pinned pnpm's bounded scheduler and exact member filters; tarball validation precedes the publish-order record. Harnessy's client-profile checks and publication-disabled marker remain required in either mode.

## Alternatives considered

**Remove aggregate checks from every build.** Package references do not cover every test or script. Artifact-only compilation therefore requires a separate blocking full-check owner rather than replacing ordinary builds.

**Use unchecked library emission for benchmarks.** The fork does not guarantee an active independent full-check workflow by default. Benchmark preparation retains checked ordinary compilation instead of making its diagnostics depend on optional CI.

**Increase worker or job concurrency.** Serial compatibility scheduling and bounded packing preserve the existing resource limits instead of increasing shared-runner demand.

**Cache compiled outputs across revisions.** File timings are advisory scheduling data; reusing compiled artifacts would add separate correctness and invalidation obligations.

## Consequences

Artifact-only mode omits root aggregate diagnostics by design. Its fixture checks compare full and referenced JavaScript, declaration, map, and build-information outputs, reject package and referenced-test errors in both paths, and retain aggregate-only error rejection in the full compiler. A caller that removes its independent full check loses that diagnostic coverage.

Pinned-pnpm packing fixtures exercise exact filters, lifecycle hooks, bounded overlap, failures, custom profiles, and Harnessy's publication-disabled marker. A pnpm upgrade requires those real-CLI checks before the new version owns parallel packing. No local fixture timing establishes hosted CI latency or native-platform qualification.
