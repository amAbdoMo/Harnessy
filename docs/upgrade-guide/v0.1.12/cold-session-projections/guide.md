---
kind: upgrade-guide
description: "Custom Session Controller projection readers must handle migration-deferred hints separately from exact baselines."
---

# Cold Session projection replies

English | [中文](guide.zh.md)

## Change

Session Controller's `projections` Remote returns `null`, a `{ kind: 'sequenced', asOfSeq, values }` baseline, or `{ kind: 'migration-required', values }` cached hints. The previous non-null reply had no `kind` and always represented an exact baseline. Custom Remote clients must handle the new discriminant. Reading a historical Session that needs migration no longer opens its event body merely to supply projections.

Session summaries may include `formatStatus: 'current' | 'migration-required'`. An absent status is unknown; a translated logical header does not establish that the stored physical generation is current. The shipped client keeps deferred hints retryable without activating a Session or treating them as a complete baseline.

## Migration

1. Use matching Host, Client and generated Remote declarations. Update custom projection readers to distinguish `null`, `sequenced` and `migration-required` replies.
2. Apply `asOfSeq` only to `sequenced` values. Treat deferred values as optional cached hints: do not invent a sequence, restore keys an exact baseline declared absent, or mark the read complete. Keep explicit refresh available.
3. Ignore responses from retired connection generations. Do not activate, fork or migrate a Session solely to populate a list or hover preview.
4. Confirm that a deferred projection read leaves retained historical bytes unchanged and creates no successor file. After an independently requested activation or migration, confirm that a new exact baseline supersedes the hints.

The [Session Controller reference](../../../../packages/api/session-controller/README.md) owns the projection and list behavior. No Session-format version, committed historical generation or default profile changes are required for these reply fields.
