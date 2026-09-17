# Agent Note: Public model capability discovery, reasoning efforts first

Status: proposed

English | [中文](2026-09-16-public-model-capability-discovery.zh.md)

## Problem

Adding a provider to Harnessy still means declaring reasoning-effort levels model by model. The seam for that already exists and works — `LlmRuntime.registerModelCapabilitySource` feeds `LlmDiscoveredModel.reasoningEfforts`, the runtime normalizes it once, and the Models UI, composer, and subagent preflight all read the result — but only one source feeds it, the Command Code integration reading that CLI's local catalog. Every other gateway leaves models undeclared, so the composer offers no effort control even where the endpoint accepts one.

Reliable public metadata exists. Verified against the live endpoints on 2026-09-16: `models.dev/api.json` lists 217 providers with 160 publishing an effort list as `reasoning_options: [{ type: 'effort', values: [...] }]`, and OpenRouter's `/api/v1/models` lists 444 models with 170 publishing `reasoning: { supported_efforts: [...], default_effort }`. Both are keyless and machine-readable.

Matching by model id alone is not safe, and the same probe shows why. A configured route listing `gpt-5.6-sol` resolves to `low, medium, high` through one provider entry while `gpt-5.6-luna` resolves to `none, low, medium, high, xhigh, max` through another; `claude-sonnet-4-6` differs between entries the same way. The model id does not identify the gateway, and the gateway decides which reasoning controls exist.

## Proposal

One resolution layer, consumed by every surface, with a fixed precedence.

**Precedence.** 1. Adapter/provider-native model metadata. 2. Local provider-specific integrations, Command Code included. 3. Live cached public metadata, provider-aware. 4. The bundled public snapshot, same matching. 5. Undeclared. A lower step never overrides a higher one, so an existing declaration and a local integration's answer both win over anything public.

**A new Host package** holds the layer: sources behind one interface, the precedence walk, matching, caching, and the bundled snapshot. `registerModelCapabilitySource` stays the only wiring into the LLM seam, so the runtime remains the single normalizer and no consumer learns about databases.

**Provider-aware matching.** For models.dev the route's configured `baseURL` is normalized to a host — lowercase, default port removed, trailing slash removed, a trailing `/v1` or `/v1/` segment removed, so trivial spelling differences cannot break the comparison — and compared against each provider entry's API host; the model id is then matched inside that provider alone. For OpenRouter the source answers only when the route actually points at OpenRouter, by host or by route id, and never merely because a model id appears in its catalog. Indexes are built once per metadata generation, and every lookup is synchronous against the loaded snapshot so discovery never acquires a network dependency.

**Model-id-only matches are suggestions, never capabilities.** They appear in the sync tool and in diagnostics with their provenance attached, and require explicit acceptance before anything is persisted. They never reach the composer or a subagent on their own.

**Provenance travels with the answer.** The reasoning fields gain a companion describing where they came from: the source name, the match kind (`provider-host`, `provider-id`, `model-id`), the matched provider entry, whether the data is live, cached, bundled, or local, and when it was fetched. The type carries a capability discriminator so later capabilities — tool support, vision, structured output, context limits, modalities, temperature — can use the same shape without changing the mechanism; none of them are implemented here.

**Snapshot and live refresh both.** A bundled snapshot ships in the package with a schema version, a generation date, and the identity of each capture it was built from, so staleness is answerable. Live refresh is optional and cached on disk with a TTL; a refresh failure keeps the previous data and keeps serving it, and the bundled snapshot is the floor. Network failure therefore never removes a control that was already available. A malformed or partial response is discarded whole, and one failing source never affects another.

**Configuration.** One global section with an optional per-profile override, shaped as `modelCapabilities.publicMetadata: { enabled, refresh: auto|manual|never, cacheTtl }`. Network access happens only when it is enabled, so `enabled: false` or `refresh: never` leaves a deployment fully usable and entirely offline, served by the snapshot and local sources. Startup never blocks on a refresh; the first read serves whatever is available and a refresh lands in the background.

**Command line.** The resolution layer is also a command surface: a sync command with a read-only check mode and a write mode, and an explain command that prints the whole chain — each source in order, whether it matched, why it was skipped, the final set, and any ambiguous or rejected id-only match. Write persists provider-aware matches only, never overwrites a declaration the user or a local integration supplied, and edits the settings document through its own API so unrelated formatting does not churn.

**Conflicts.** When both databases carry provider-aware data for a route, the source corresponding to the configured route wins outright; claims are never merged into a union, because a union would offer a level neither source states for that gateway.

## Alternatives considered

**Model-id-only matching as authoritative.** Rejected on the probe above: the same id resolves to different effort sets through different providers, so accepting one gateway's claim for another's model would offer levels the endpoint rejects mid-turn.

**A frozen snapshot only, or live fetching only.** Rejected: a snapshot alone goes stale silently, and live fetching alone makes the feature depend on the network and removes controls when it is unavailable. Both, with the snapshot as the floor, satisfies either condition.

**Merging both databases into one answer.** Rejected: a union silently invents a level set that neither provider states, and provenance becomes unattributable.

**Resolving inside the Models UI or the composer.** Rejected: the sync tool, diagnostics, the picker, the composer, and subagent preflight must agree, which one shared resolution layer gives and parallel implementations cannot.

**Auto-claiming levels for undeclared models at resolution time.** Rejected: an id-only inference would become a request parameter with nothing for the user to review, which is the failure the declaration model exists to prevent.

## Acceptance criteria

Slice 1 is implemented in `packages/llm/model-capabilities`: the resolution layer, the provenance types, the source interface, both databases' provider-aware matching, model-id-only suggestion detection, and fixture-driven tests. It registers through `LlmRuntime.registerModelCapabilitySource` and has no network, cache, configuration, or command surface yet, so the criteria below are met only for the components that exist.

Slice 2 adds the bundled snapshot: `src/snapshot/public-model-capabilities.ts`, generated by `pnpm run gen-model-capability-snapshot` from curated checked-in captures, loaded through `loadBundledPublicCatalogs()` as `origin: 'bundled'`, and verified fresh by `pnpm run verify-model-capability-snapshot` (in `doc-sync`). It carries each catalog in the document form the slice-1 resolver already reads, so no second matcher exists. The artifact states its schema version, generation time, and each capture's input path, content digest, and entry count; `--check` reuses the committed timestamp, so the gate fails on content and never on the wall clock.

Slice 3 adds the live layer: the `model-capabilities` plugin fetches both public databases, keeps a durable cache, and selects one catalog per database — a successful fetch, else the cache however old, else the bundled snapshot. The two databases are fetched independently, each failure keeps that database's previous catalog, and a refresh is background work the plugin owns and aborts on disposal, so startup never waits on the network. Configuration is the `model-capabilities` settings namespace (`publicMetadata: { enabled, refresh, cacheTtl }`), with `enabled: false` applying no public catalog at all and making no request, `manual` and `never` fetching nothing automatically, and `cacheTtl` read as a duration such as `7d`. Provenance gained the fetch time and the `cache` origin.

Slice 4 adds the command surface and the shipped registration. `--models-sync=check` reports every configured model with its current declaration, the resolved levels, the source, the matched provider entry, the match kind, the origin, the fetch time where there is one, whether the answer is authoritative, and the action a sync would take; `--models-sync=write` persists the authoritative provider-aware rows and nothing else; `--models-explain=<route>/<model>` prints one model's whole chain. `--models-refresh` is the explicit, user-triggered fetch that `manual` permits and `never` refuses. The operations read the runtime's own store and resolver, so no second matcher exists, and the write goes through the settings seam as one validated `llm-pi-ai` merge that restates only the routes it touched. The layer mounts in the shipped Harnessy product patch layer after Command Code, with a declared service dependency rather than a file position, because the Loader mounts sibling rows in parallel and only that dependency makes Command Code's own source register first.

The layer answers with provider-aware matches for models.dev routes and OpenRouter routes, leaves an ambiguous or unique id-only match as a suggestion that is never applied automatically, and preserves adapter-native and Command Code answers over any public claim. The bundled snapshot serves when the network is off, a stale cache keeps serving when a refresh fails, and a malformed response changes nothing. All of these hold, and the command line reports which one produced each answer.

Existing declared models behave exactly as they do today, Command Code keeps its current answers, and no configuration migration is required. Sync in check mode modifies nothing; in write mode it adds provider-aware matches, never overwrites a declaration, and leaves the rest of the settings document as it found it. Both modes are implemented and validated against the live configuration: the check is byte-for-byte read-only, and a write against a deployment whose remaining rows are suggestions or unresolved leaves the document byte-identical.

Diagnostics answer, for any provider and model, which source supplied the capability, whether the match was provider-aware, which provider entry matched, whether the data was live, cached, bundled, or local, and when it was fetched. The source, match kind, matched provider entry, model identity, authority, origin (`fixture`/`bundled`/`live`/`cache`), and the fetch time are all answered by `--models-sync`, `--models-explain`, and the Models page.

Slice 5 adds the Models-page display and completes the feature. The plugin now also serves `modelCapabilities/inspect`, a Remote that answers one projection per configured model — whether the layer is enabled, the provider-aware match that applies, and the id-only claims that do not — built from the same configured-route join and the same resolver the runtime seam and the command line use. `@deepseek-ai/dsh-api-remotes` mounts it, so the Client reads one declaration and imports no Host package. Each model row renders where its levels came from: Configured for a row the user declared, otherwise Public metadata with the database, the matched provider entry, and whether the answer was live, cached, or bundled, dated through the shared relative-time buckets. A bundled catalog shows no fetch time; a fixture origin is withheld; a disabled layer says so rather than showing an absence of claims.

An id-only match is never displayed as a capability, and disagreeing claims are reported as disagreement with each claim listed underneath and no winner chosen. A model no database states keeps the plain undeclared row. A public claim that a declaration outranks is reported beside the declaration as not applied, and the page never reconciles the two. Applied versus suggested is carried in words rather than colour alone, and every string is locale-owned copy.

The feature is complete. The provenance the Models page shows is the same chain the runtime, `--models-sync`, and `--models-explain` use; the shipped Harnessy composition registers the capability source after Command Code; and the four end-to-end states — a local declaration, a provider-aware public match, an id-only suggestion, and an unresolved model — are observed in that composition rather than assumed.

**Deliberately future work, not gaps.** A periodic refresh timer, capability types beyond reasoning effort, the `models sync` / `models explain` subcommand spelling, and automatic reconciliation of a public claim against an explicit declaration are extensions this note records rather than unfinished parts of it. None of them is required by the criteria above.

**Deviations recorded while implementing slice 2.** The snapshot is a generated TypeScript data module, not JSON. JSON was the first choice, but this repository publishes an exact `files` list per package and compiles each package's built declarations under a NodeNext consumer check, and neither can carry a tracked JSON file: `tsc` leaves the import in the emitted module rather than inlining it, so the published tree would have to expose the data through a path the constraints gate does not model. A generated module is the same data with none of that friction, and the package bundles it into its entry like any other source.

The snapshot also records each capture's repository input path and content digest rather than a source URL, because a capture is a fetched file and only its bytes prove which one it was; the URL belongs with the live fetch that produces the next capture. Generation is offline from checked-in curated captures rather than fetching upstream, so the gate is deterministic and no test or gate reaches the network. The "stale" test is content against the captures and this generator, not age; an age-based refresh policy belongs to slice 3's configuration, and is now only an advisory mount-time log line that never fails.

**Deviations recorded while implementing slice 3.** The settings namespace is `model-capabilities`, not `modelCapabilities.publicMetadata`: the settings seam accepts a lowercase hyphenated identifier as a top-level document key, and a dotted namespace is not one. The section shape is unchanged — a `publicMetadata` object with `enabled`, `refresh`, and `cacheTtl` — so the recorded configuration is what a deployment writes under that key.

`cacheTtl` is a string with a small grammar (`500ms`, `30s`, `15m`, `12h`, `7d`), not the `…Ms` number the rest of the repository configures durations with: a refresh cadence is stated in days, and a raw millisecond count there is a hazard. Nothing else in the repository parses a duration, so there was no existing representation to reuse; the grammar is bounded to a positive integer and one unit so every accepted value has exactly one reading.

The bundled snapshot remains available when the network is disabled, which is what the note's proposal records: `enabled: false` applies no public catalog at all — bundled, cached, or live — while `refresh: never` and `refresh: manual` keep serving the cache and the snapshot without fetching. The two switches answer different questions: `enabled` is whether this layer answers at all, `refresh` is whether it may use the network.

`manual` and `never` are behaviorally identical in this slice. They stay distinct because the future sync command must be permitted to fetch under `manual` and forbidden under `never`; conflating them would make that a breaking change.

One refresh pass runs per mount and per settings change, with no timer and no retry. A failed database is retried on the next pass, so a deployment that runs for weeks without restarting or reconfiguring refreshes once. A periodic timer is a deployment-varying cadence, which belongs with configuration rather than a hardcoded interval.

**Deviations recorded while implementing slice 4.** The commands are flags on the app's own command line (`--models-sync`, `--models-explain`, `--models-refresh`) rather than a subcommand tree, because that is the surface this repository's apps already own: the launcher parses only its own flags and hands the rest to the booted tree, where an app plugin declares its flag family and its `--help`. Both operations live in the package and are independent of argv, so the `models sync` / `models explain` spelling the note sketches can be added later without touching the resolution or the sync logic.

`check` is not network-active. `--models-refresh` is a separate flag, so an invocation that only reports can never fetch, and the refresh policy is read before anything runs: `manual` permits the explicit request, `never` refuses it with a failure rather than silently reporting stale data, and `enabled: false` reports the layer disabled rather than bypassing the policy.

The shipped row's precedence against Command Code is a declared service dependency (`inject: [commandCodeController]`), not a position in the patch file. The Loader mounts sibling rows in parallel, so file position orders nothing — the first attempt at this slice placed the row after Command Code and the public source still registered first, which an end-to-end test against the real composition now observes rather than assumes.

A resolved claim beside a row that already declares a level set is reported, not applied, and the report prints the catalog's own statement so a human can judge the declaration that was kept. Reconciling the two is a user decision, not a sync decision.

Only the shipped Harnessy product patch layer mounts the layer. The official profiles mount no Command Code and no public metadata, so adding it there would grant a product behavior to deployments that never asked for it.

**Deviations recorded while implementing slice 5.** The provenance crosses the Client boundary as a new `modelCapabilities` Remote namespace rather than as a field on the existing `llm/discoverModels` reply. The Models page needs the state of every *configured* model — including the id-only claims and the disabled layer — and discovery is a one-shot probe of a draft endpoint that a source answers with a capability or with nothing at all: a suggestion never crosses it. A field there could not express four of the six states the page must distinguish.

The Remote boundary types live in the package's type-only `./types` subpath, because the generator requires every boundary type to be reachable from a public non-root subpath and because a Client program that imports the package barrel pulls its Host runtime modules and their Node builtins into a browser program.

The projection deliberately omits the row's own declaration: the page edits that in a draft, so the Host's copy would be stale between an edit and its commit, and the page renders what the draft says. It also omits the route's settings fields and the sync decision, which a surface has no use for.

A fixture origin renders without an origin line rather than with the word `fixture`: the row still reports its database, provider, and match, and no build-time vocabulary reaches a shipped surface.

The page reports a public claim that a declaration outranks instead of hiding it. That is the note's own "a resolved public claim beside an existing declaration is reported, not applied", carried to the surface that shows the declaration.

## Risks

A bundled snapshot ages: the generation date must be visible in diagnostics and gated so it cannot silently rot. The public databases are third-party claims about a gateway, not guarantees, so provider-aware matching must stay strict enough that a near-miss host does not attribute one gateway's controls to another. Caching adds a second durable artifact whose corruption must degrade to the snapshot rather than to an error. Scope: the provenance mechanism is built to carry more capabilities, and this change must not grow into implementing them.
