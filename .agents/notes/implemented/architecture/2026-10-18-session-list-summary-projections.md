# Agent Note: Serve Session-list summaries without transferring full turn details

Status: implemented

English | [中文](2026-10-18-session-list-summary-projections.zh.md)

## Problem

Session-list responses carry the whole turn outline, statistics, todos and shared image limits for every row. The outline grows with each Session even though list navigation does not render it. Harnessy's notification center does consume its latest recorded outcome, so removing the outline without a replacement would suppress completion, stopped-task and failure notifications.

## Decision

Projection owners mark detailed values with `SessionProjectionSummaryExcluded<T>` and require `wire.summary: false` on those registrations. The registry derives one stable summary key set until registrations change. Live and cold list readers select these keys before producing wire values; full Session reads keep every view. Client view types strip the marker, while summary types omit marked keys. The marker never enters durable or wire JSON.

The excluded keys are `turnOutline`, `sessionStats`, `todos` and `imageLimits`. The turn-outline plugin also supplies the constant-size `turnOutcome` projection: the latest started turn number and its optional terminal outcome. A later turn clears the old outcome. Harnessy's existing notification observer consumes this field and retains its silent startup baseline, root-only outcomes, pending-action precedence and duplicate suppression. No list or notification UI changes.

The [cache identity and client merge rules](2026-09-19-projection-cache-listing-identity-and-cached-rows.md) remain authoritative. Checkpoints and full reads keep every projection. Summary selection changes neither Session format nor cache state versions; an absent new cache entry is materialized through the existing full-read path.

## Alternatives considered

**Drop the outline without checking custom consumers.** Rejected: the notification observer reads it through an unknown-valued helper; a direct property search misses that dependency. The Client typecheck exposed the notification fixture before delivery.

**Keep transferring the full outline for notifications.** Rejected: the observer needs only the newest turn and outcome, so each row would retain work proportional to the Session's history.

**Filter fields after building complete views.** Rejected: this retains per-row parsing and view cost. The key-taking reads already select before that work.

**Hardcode excluded keys in the controller or add a second summary read API.** Rejected: owning registrations provide the selection once, and the existing read APIs accept the derived set directly.

## Consequences

The list payload no longer grows with the excluded outline, and notifications retain their recorded lifecycle source. Each summary now includes a small latest-turn value. Registration and final disposal must invalidate the summary set; nullable marked types keep null outside the marker. Full snapshots remain available to chat navigation, details and other consumers.

## Testing

The projection, cache, Session Controller and notification suites cover summary selection, cold reads, full follow snapshots, nullable values, registry disposal, terminal outcomes, reconnect replacement and silent startup. The real turn-outline Loader composition verifies a completed summary and clearing its outcome at the next turn. The assembled paged-history browser scenario checks full statistics and outline availability while its list response omits detailed keys and retains the terminal outcome.

The manual [list diagnostic](../../../../packages/api/session-controller/tests/session-list.perf.ts) measures the built Host's warm attached-list preparation plus JSON serialization with fixed synthetic corpus metadata. It emits seven raw timing and byte samples after three warmups. Run from the repository root after a Host build; transpile only the diagnostic wrapper, then run plain Node:

```sh
node --input-type=module -e "import ts from 'typescript'; import fs from 'node:fs'; fs.mkdirSync('.artifacts', {recursive:true}); fs.writeFileSync('.artifacts/session-list.perf.mjs', ts.transpileModule(fs.readFileSync('packages/api/session-controller/tests/session-list.perf.ts', 'utf8'), {compilerOptions:{target:ts.ScriptTarget.ES2024,module:ts.ModuleKind.ESNext}}).outputText)"
node --expose-gc .artifacts/session-list.perf.mjs 100 300
node --expose-gc .artifacts/session-list.perf.mjs 100 300 --full-projections
```

The last command is a negative control that reintroduces full projection selection. This is a local diagnostic with no timing budget. It excludes Session creation, corpus queries, cold persistence, model/network latency, browser paint and retained-memory claims; it does not establish CI or complete product latency.

Local Windows measurements on 2026-10-24 used Node 24.14.0, three warmups and seven samples per fresh process. The baseline was the attached-list implementation before summary selection, identified in the [upstream review ledger](../../../../scripts/harnessy-upstream-review.json); the candidate also retains the new compact notification outcome. Timing includes the attached-list read and JSON serialization, with both returned rows and serialized output available at completion.

| Synthetic workload | Baseline median / bytes | Summary median / bytes |
|---|---|---|
| 20 Sessions × 30 closed turns | 3.536 ms / 49,232 | 1.690 ms / 6,492 |
| 100 Sessions × 300 closed turns | 37.830 ms / 2,154,393 | 7.940 ms / 32,693 |

Raw large-case milliseconds were baseline `[43.988, 39.106, 36.757, 38.556, 34.287, 37.830, 33.823]`, summary `[6.795, 8.000, 7.949, 7.107, 7.037, 8.558, 7.939]`, and full-selection negative control `[34.597, 51.852, 35.874, 37.060, 33.532, 36.731, 38.519]`. The control restored 2,159,293 bytes and a 36.731 ms median. The checked-in diagnostic, with fixed Session IDs, independently measured 7.934 ms / 33,691 bytes versus its 40.012 ms / 2,160,291-byte control. No private corpus or timing budget was used.
