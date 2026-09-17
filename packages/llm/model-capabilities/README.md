---
description: "Public model capability discovery for maintainers wiring provider-aware reasoning-effort metadata into model discovery from a public catalog."
kind: "package-reference"
---

# @deepseek-ai/dsh-model-capabilities

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-model-capabilities` resolves what public model databases state about a configured route, and how far that statement may be trusted. Mount the `model-capabilities` plugin and it keeps a catalog per public database — a successful fetch, else the durable cache, else the shipped bundled snapshot — and registers one capability source on `LlmRuntime`, so an undeclared model is answered from its own provider-aware public claim while model-id-only claims stay suggestions nobody applies. Refresh runs in the background under configuration, so model discovery works whether or not the public endpoints are reachable.

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

Use this package when a deployment wants reasoning-effort controls offered for models no adapter or local integration describes.

### Mount the plugin

```yaml
- name: '@deepseek-ai/dsh-llm'
- name: '@deepseek-ai/dsh-model-capabilities'
  config:
    publicMetadata:
      enabled: true
      refresh: auto
      cacheTtl: 7d
```

Mount it after `@deepseek-ai/dsh-llm`; that service is required. The settings seam is optional: with `@deepseek-ai/dsh-settings` mounted, a user's `settings.yaml` overrides the row, and without it the row is the whole configuration.

A composition that also mounts `@deepseek-ai/dsh-subagent-commandcode` must declare that row as an injected service, because the position of the two rows in a patch file does not order them:

```yaml
- id: model-capabilities
  name: '@deepseek-ai/dsh-model-capabilities/plugin'
  inject: [commandCodeController]
```

The Loader mounts sibling rows in parallel, so a file position orders nothing; the LLM seam asks capability sources in registration order and the first answer wins, and only a declared dependency makes Command Code's own source register first. That is what keeps its declarations ahead of any public claim.

### Inspect and sync from the command line

Mounting `@deepseek-ai/dsh-model-capabilities/cli` (which injects the store above) adds three flags to the app's own command line:

```sh
dsh --profile custom-harness --models-sync=check
dsh --profile custom-harness --models-sync=write
dsh --profile custom-harness --models-explain=openai-codex/gpt-5.6-sol
dsh --profile custom-harness --models-sync=check --models-refresh
```

`check` reports every configured model and the action a sync would take, and modifies nothing. `write` persists the rows a provider-aware match resolved and leaves every other row byte-identical. `explain` prints one route-qualified model's whole chain — each public tier, the provider entry that answered it, and the final levels or the suggestions that were refused.

The model argument is `<route>/<model>`, never a bare id: the same model may resolve differently, or not at all, through another gateway, and a bare id is exactly the ambiguity this layer refuses to guess through. Both flags repeat and run in argv order, so one invocation can write a sync and then check what it left behind.

### Configure it

The plugin owns the `model-capabilities` settings namespace, so the same values are configurable from a settings document as `model-capabilities.publicMetadata`:

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Whether the public metadata layer runs at all. `false` applies no public catalog — bundled, cached, or live — so every public claim is off and no request is made. |
| `refresh` | `auto` | `auto` fetches what is missing or expired; `manual` never fetches on its own; `never` refuses network access outright. |
| `cacheTtl` | `7d` | How long a fetched catalog stays fresh. A positive integer with one unit: `ms`, `s`, `m`, `h`, or `d`. |

`manual` and `never` serve exactly the same catalogs — cache when there is one, bundled otherwise — and differ only in whether an explicit command may fetch: `manual` permits the `--models-refresh` request, `never` refuses it. A `cacheTtl` this grammar cannot read is refused where it is written rather than becoming a refresh that silently never runs.

### What each setting does

- **`enabled: false`** — the layer answers no catalog, so discovery leaves every undeclared model undeclared and the public network is never contacted. Adapter-native and local integration answers are untouched, and a `--models-sync` invocation reports the layer disabled instead of bypassing the policy.
- **`refresh: auto`** — a valid cache is served as-is; a missing or expired one is refreshed in the background. Startup never waits for that fetch.
- **`refresh: manual`** — a cached catalog is served however old it is; nothing is fetched automatically, and `--models-refresh` is the one path that fetches.
- **`refresh: never`** — same serving, and no request is ever made; a `--models-refresh` invocation is refused with a failure rather than silently reporting stale data.

### What `write` will not do

A sync persists only what a provider-aware match resolved, on a row that declares nothing. It never overwrites an explicit declaration, never chooses among disagreeing model-id-only claims, never writes an unresolved model, and never invents a level. The write is one validated merge through the settings seam, so unrelated configuration and unrelated rows survive it; when nothing is writable the seam is not called at all.

### Build the capability source yourself

A composition with its own catalog source skips the plugin and registers directly. `origin` states where each catalog came from — `fixture`, `bundled`, `live`, or `cache` — and travels into the provenance of every answer.

```ts
import { createPublicCapabilitySource } from '@deepseek-ai/dsh-model-capabilities'
import type { PublicCatalog } from '@deepseek-ai/dsh-model-capabilities'

declare const modelsDev: unknown
declare const openRouter: unknown

// Most authoritative first; the layer never merges two sources into one answer.
const catalogs: readonly PublicCatalog[] = [
  { source: 'openrouter', origin: 'live', fetchedAt: new Date().toISOString(), entries: openRouter },
  { source: 'models.dev', origin: 'live', fetchedAt: new Date().toISOString(), entries: modelsDev },
  ...loadBundledPublicCatalogs(),
]

const dispose = ctx.llm.registerModelCapabilitySource(
  'public-metadata',
  createPublicCapabilitySource(catalogs),
)
```

`loadBundledPublicCatalogs()` reads the shipped snapshot once, validates it, and returns the two catalogs in precedence order, each marked `origin: 'bundled'`.

### Regenerate the bundled snapshot

```sh
pnpm run gen-model-capability-snapshot          # rewrite the artifact
pnpm run verify-model-capability-snapshot       # fail if it is stale (in doc-sync)
```

The generator reads the curated captures in `tests/fixtures/upstream/`, which `.artifacts/make-snapshot-fixtures.mjs` derives from a full public capture. Both commands are offline. `--check` reuses the committed timestamp, so the gate fails on content and never on the wall clock; `--models-dev`, `--openrouter`, `--out`, and `--generated-at` override its inputs.

### Resolve without registering

`resolvePublicCapability(catalogs, modelId, request)` returns the same answer the source answers with, plus the provenance and the suggestions the source deliberately withholds. Diagnostics use it to explain a chain: a `resolved` result names the matched provider entry and how it matched, and an `unresolved` one carries the model-id-only claims it found instead.

### What the answer may be

| `kind` | Meaning | May be declared |
|---|---|---|
| `resolved` | A provider-aware match: the route's own endpoint or id named a provider entry that publishes this model. | Yes |
| `unresolved` | No provider-aware match. `suggestions` holds every model-id-only claim, one per provider entry, each labelled `model-id-only` or `model-id-ambiguous`. | No |

A route is OpenRouter's own when its configured endpoint is on an `openrouter.ai` host or its route id names OpenRouter; only then does OpenRouter's catalog answer, so an unrelated gateway exposing the same model id never inherits OpenRouter's levels.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design philosophy

Matching is by route identity, never by model id. A model id does not identify the gateway, and the gateway decides which reasoning controls exist: `gpt-5.6-sol` publishes `none,low,medium,high,xhigh,max` through one models.dev provider entry and `low,medium,high,xhigh` through another. An id-only claim therefore never becomes a capability; it is reported with its competitors so a human can decide.

### Source map

| File | Role |
|---|---|
| [`src/types.ts`](src/types.ts) | The catalog, match, provenance, and resolution vocabulary |
| [`src/routes.ts`](src/routes.ts) | Endpoint and provider-id normalization, including the OpenRouter route test |
| [`src/efforts.ts`](src/efforts.ts) | Published effort tokens into the harness level vocabulary |
| [`src/resolve.ts`](src/resolve.ts) | `resolvePublicCapability`, the two database readers, and `createPublicCapabilitySource` |
| [`src/snapshot.ts`](src/snapshot.ts) | Curation, the bundled document schema, and its validation |
| [`src/snapshot/public-model-capabilities.ts`](src/snapshot/public-model-capabilities.ts) | The generated artifact itself |
| [`src/bundled.ts`](src/bundled.ts) | `loadBundledPublicCatalogs()` and `bundledSnapshotMetadata` |
| [`src/fetch.ts`](src/fetch.ts) | The two public GETs, their size cap, and their response validation |
| [`src/cache.ts`](src/cache.ts) | The durable cache file and its atomic replacement |
| [`src/store.ts`](src/store.ts) | Catalog selection, the TTL decision, and one refresh pass |
| [`src/config.ts`](src/config.ts) | The `model-capabilities` section schema and its duration grammar |
| [`src/plugin.ts`](src/plugin.ts) | The composition row: registration, background refresh, and disposal |
| [`src/inspect.ts`](src/inspect.ts) | What one route-qualified model resolves to, and what a sync would do with it |
| [`src/cli.ts`](src/cli.ts) | The `--models-sync` and `--models-explain` commands |

### Catalog selection

One catalog per database, never a union: the newest successful fetch, else the last known-good cache whatever its age, else the bundled snapshot. The tiers are ordered rather than merged because combining two generations of one database would offer a level neither generation stated.

Age is not validity. A cache entry past its TTL is *eligible for refresh*, not discarded: it keeps answering until a fetch actually replaces it, which is what makes a failed refresh invisible to the composer. Only a structurally invalid entry — a wrong database, an unreadable fetch time, an empty catalog — is dropped, and only the entries this build cannot read are dropped, never the whole file.

The TTL is evaluated per database, because the two can succeed and fail independently, and the boundary belongs to staleness: an entry exactly `cacheTtl` old is eligible, one a millisecond younger is not. The clock is injected, so every boundary case is tested without waiting.

### Refresh and failure

One refresh pass asks only the databases that are missing or expired, settles both fetches independently, and commits the successes in a single atomic write. A failure keeps that database's previous catalog and is reported per database; a malformed response is refused whole, so a proxy error page can never replace a known-good cache with an empty one. A cache write failure costs durability only — the catalogs are already live in memory, so discovery keeps serving.

A refresh is background work with an owner: the plugin holds its abort controller, bounds it with a deadline, and aborts it on disposal. Startup awaits nothing on the network, so an unreachable endpoint delays no discovery — the first answer comes from the cache or the snapshot either way.

### Reading the databases

`models.dev` publishes `reasoning_options`, an array of control descriptors, of which the `type: 'effort'` entry carries `values`. OpenRouter publishes `reasoning.supported_efforts` and `reasoning.default_effort` per model. Both readers validate the members they read and skip anything else, so a malformed provider or model entry states nothing instead of failing the lookup. A fetched response goes through the snapshot generator's own curation, so a live catalog and the bundled artifact are the same reduction of the same published form.

### Inspecting and syncing

A command reads the routes out of the settings seam and asks `inspect.ts` one question per configured model, so the CLI owns no matching of its own: the answer is the store's own selection put through the same `resolvePublicCapability` the runtime seam uses. `explain` renders the reported chain rather than reconstructing one.

One decision per row is what the command acts on: a resolved provider-aware match on a row that declares nothing is `write`, a row that already declares a level set or refuses reasoning is `declared`, id-only claims are `suggestion`, and everything else is `unresolved`. `check` prints the decision; `write` acts on the `write` rows alone.

The write is one `llm-pi-ai` merge through the settings seam. The seam replaces arrays wholesale, so a touched route contributes its complete models list with only the matching rows changed — every other field of every row is restated as it stands, which is what keeps the write from dropping configuration it did not mean to touch. When nothing is writable the seam is not called at all, so a `write` against a fully declared deployment leaves the document byte-identical.

### What the Models page reads

Mounting the plugin also mounts `ModelCapabilitiesInspector`, which serves the `modelCapabilities/inspect` Remote. It answers one projection per configured model — `enabled`, the provider-aware match that applies, and the id-only claims that do not — built from the same configured-route join and the same resolver the runtime seam and the command line use. The Client renders it through `@deepseek-ai/dsh-api-remotes`, so no browser package imports this one and no second matcher exists anywhere.

The projection omits the row's own declaration on purpose: a surface edits that in a draft, so the Host's copy would only be stale between an edit and its commit. It also omits the route's settings fields and the sync decision, which a surface has no use for. `enabled` is carried because a disabled layer and a database with no record of a model both resolve nothing, and a surface has to tell those apart to say which one happened.

The store is read, never loaded: a surface reports what the runtime is answering with right now, and the cache read belongs to the layer that owns startup.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-llm service](../llm/README.md) — `registerModelCapabilitySource`, `LlmDiscoveredModel`, and the single normalization every claim passes through.
- [public model capability discovery](../../../.agents/notes/proposed/feature/2026-09-16-public-model-capability-discovery.md) — the precedence, snapshot, cache, and command-line decisions this package implements.
- [dsh-settings](../../settings/settings/README.md) — the seam behind `model-capabilities.publicMetadata` and behind the `llm-pi-ai` document a sync writes.
- [dsh-cmdline](../../boot/cmdline/README.md) — how an app plugin owns its own flag family and its `--help`.
- [Models page](../../client/ui-settings-models/README.md) — where this layer's provenance is displayed.
- [Command Code model catalog](../../subagent/subagent-commandcode/src/models.ts) — the local integration that stays ahead of any public claim.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the capability source a composition registers on `LlmRuntime`.

#### KV Cache effect

Nothing in this package reaches a model request: it answers a question the LLM service asks during model discovery, and the reasoning-effort levels a deployment then declares are ordinary request parameters whose prefix effects the provider's own caching rules own.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define where this slice stops and the next one begins.

- **Reasoning efforts are the only capability** — vision, tools, modalities, structured output, and context limits are not read, though `ModelCapabilityProvenance.capability` and the resolution vocabulary are shaped to carry them. The Models page reports this one capability's provenance, and a later capability extends the same projection.
- **No periodic refresh** — a deployment refreshes on mount, on a settings change, or on demand; a timer is a cadence configuration does not yet express.
- **`none` is read as `off`** — the published token list is normalized with that one alias, and a claim offering only `off` declares nothing, so a model whose entry publishes `none` alone stays undeclared rather than offering a level a selector cannot use.
- **The snapshot and the cache cover only reasoning** — each keeps a provider's endpoint and a model's effort tokens and nothing else, so a later capability needs its own field added to the curation and the cache schema before it can resolve.
- **One fetch per database per refresh pass, with no retry** — a failed database is retried on the next pass, which `refresh: auto` reaches on the next start or settings change and `--models-refresh` reaches on demand, not on a timer.
- **The cache is per Harness home, not per profile** — the path resolves from `resolveDshHome`, so installations that share one `DSH_HOME` share the cache, which is the same ownership every other piece of runtime state uses.
- **A sync writes only what the settings seam owns** — it edits the `llm-pi-ai` document, so a deployment whose routes come from a composition entry rather than a settings document has nowhere for a sync to persist; `check` still reports it.
- **Only the shipped Harnessy profile mounts the layer** — the official profiles do not, because public metadata is product behavior here rather than a default for every deployment.
- **A resolved claim beside a declaration is reported, not applied** — the row's own level set wins, and the sync prints what the catalogs state so a human can judge the declaration it kept. Reconciling the two automatically is not something this layer does.
- No invariant companion is published because every observation this package owns is a pure function of its arguments, so an independent check could only re-run the same matching and compare it with itself.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: notes for maintainers and open questions. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- Normalization here reproduces the level rules `@deepseek-ai/dsh-llm` already applies to every claim a source makes, because the seam's copy is private and a consumer needs the normalized levels before it can build the claim it hands back.
- The level vocabulary is gated by a `Record` key type against the same seven levels `THINKING_LEVELS` declares in `@deepseek-ai/dsh-llm-pi-ai`, so an upstream level change fails compilation here rather than silently narrowing what public metadata may offer.
- The resolution fixtures in `tests/fixtures/` are hand-curated subsets of captured databases plus deliberately malformed entries; the upstream inputs in `tests/fixtures/upstream/` are the real captures reduced to the fields the generator reads, and `.artifacts/` (not committed) holds the raw captures those were derived from.
- The generator reads either capture form: the raw published field names, or the reduced one. That is what lets the gate verify the artifact against a checked-in input while a maintainer regenerates from a fresh capture with the same code path.
- `refresh: manual` and `refresh: never` serve identically; they differ only in whether `--models-refresh` is permitted. A future periodic refresh would be a third policy rather than a change to either.
- Snapshot age is reported once at mount and never fails: a deployment that refreshes replaces the artifact on its first successful fetch, and one that is deliberately offline keeps serving it.
- The route a sync writes is the resolved `llm-pi-ai` section, not the raw user document: the seam exposes no read of the user layer alone, and the resolved section is a superset of it, so restating a touched route's models list cannot drop the user's own fields.
- `tests/shipped-composition.spec.ts` boots the shipped row set through the real Loader, so the registration order the precedence depends on is observed rather than assumed; `packages/bundle/custom-harness/cordis.patch.yml` and the boot fixture are compared for drift.

</details>
