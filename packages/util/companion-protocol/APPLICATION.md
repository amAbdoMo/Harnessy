# Companion application JSON v1

English | [中文](APPLICATION.zh.md)

## Summary

This reference freezes the text-only application payloads parsed by [application.ts](src/application.ts). These payloads travel only after encrypted key confirmation; the PC connector owns authorization and execution. It must not adapt them to arbitrary operator RPC calls.

## Table of Contents

- [Requests and results](#requests-and-results)
- [Encoding and limits](#encoding-and-limits)
- [PC admission and read ownership](#pc-admission-and-read-ownership)
- [Manual acceptance](#manual-acceptance)

## Requests and results

Every object has `v:1` and the exact listed fields. A question mark marks an optional field; omitted means absent, not `null`. Request correlation uses `requestId`, never a Gateway RPC ID. The table defines field order only for readability: application JSON is encrypted as transmitted bytes, not signed as a canonical JSON representation.

| Request `type` | Fields after `v,type,requestId` | Result `type` | Fields after `v,type,requestId` |
|---|---|---|---|
| `listSessions` | `cursor?,limit` | `sessions` | `sessions,cursor?` |
| `readHistory` | `sessionId,cursor?,limit` | `history` | `sessionId,rows,cursor?` |
| `watchProgress` | `sessionId,cursor?` | `watching` | `sessionId,subscriptionId` |
| `submitText` | `sessionId,text,submissionId` | `submitted` | `sessionId,submissionId,admission:"inMemoryInbox"` |
| `cancelRead` | `subscriptionId` | `cancelled` | `subscriptionId` |

A request can instead return `{v:1,type:"error",requestId,code}` with `code` exactly `denied`, `notFound`, `limit`, `expired`, or `unavailable`. A live read emits `{v:1,type:"progress",subscriptionId,sessionId,rows,status,cursor?}`; it has no request ID. The phone must correlate result type, request ID, Session ID, and submission or subscription ID with its outstanding operation before accepting a result; parsing alone does not provide that correlation.

Each Session summary has exactly `sessionId,title,status`; `status` is `idle`, `queued`, `running`, or `closed`. Each history row has exactly `role,seq,id,text`; `role` is `user`, `assistant`, `tool`, or `notice`. Tool rows contain approved bounded text, not tool arguments or arbitrary result projections. History and progress rows must have strictly increasing sequences and distinct IDs within each batch. The PC and phone must also preserve ordering across subscription batches using the PC-issued cursor.

Example input, with a fresh production request ID substituted for the illustrative zero value:

```json
{"v":1,"type":"readHistory","requestId":"AAAAAAAAAAAAAAAAAAAAAA","sessionId":"session-1","limit":20}
```

Example inbox-admission acknowledgement, not a completion receipt:

```json
{"v":1,"type":"submitted","requestId":"AAAAAAAAAAAAAAAAAAAAAA","sessionId":"session-1","submissionId":"AQEBAQEBAQEBAQEBAQEBAQ","admission":"inMemoryInbox"}
```

## Encoding and limits

JSON is well-formed Unicode encoded as UTF-8. Parsers reject unsupported versions, operations, fields, `null` optionals, lone surrogates, and malformed identifiers. Plain text can contain user-written URL text, but the protocol has no URL, attachment, file, terminal, approval, or settings fields. The native UI must render text literally, not execute HTML or activate arbitrary links.

`requestId`, `submissionId`, and `subscriptionId` are canonical unpadded base64url encodings of exactly 16 bytes. Production callers generate fresh random IDs. Session IDs and history row IDs are ASCII tokens of 1–128 bytes matching `[A-Za-z0-9][A-Za-z0-9._:-]*`; the PC refuses an existing Session whose ID cannot be represented rather than inventing an alias. `seq` is exactly eight unsigned big-endian bytes encoded as canonical base64url, never a JSON number. `cursor` is canonical unpadded base64url text of 1–256 characters; the issuing PC validates its scope and meaning.

The fixed mobile JSON ceiling is 49,152 UTF-8 bytes, including every wrapper, row, ID, title, and cursor. `parseApplicationBudget` requires all fields below, rejects unknown fields, and returns a frozen deployment budget. Complete request and result encoders apply the same parsers before encryption; oversized results must be paginated or rejected, never partially truncated into invalid JSON. The cryptographic frame and relay envelope budgets remain separate and must accommodate base64 expansion and routing metadata.

| Budget field | Valid inclusive range | Enforcer |
|---|---|---|
| `maxRequestBytes,maxResultBytes` | 512–49,152 | Application parsers and encoders |
| `maxTextBytes` | 1–49,152, plus 256 must fit both byte limits | Application parsers and encoders |
| `maxTitleBytes` | 1–1,024, plus 256 must fit result bytes | Application parsers and encoders |
| `maxRows,maxSessions` | 1–256 | Application parsers and encoders |
| `maxSubscriptionsPerGrant,maxPendingSubmissionsPerGrant` | 1–64 | PC connector before retention/admission |
| `readTimeoutMs` | 100–60,000 | PC connector per read |
| `subscriptionLifetimeMs` | 1,000–3,600,000 | PC connector per subscription |

`limit` is required for list and history requests and must be 1 through the configured corresponding count maximum. A valid budget does not guarantee that its maximum row count fits the byte limit; the complete encoded result is the authoritative size check. The 256-byte configuration headroom detects unusable budgets, not a guarantee that all maximum-size fields fit.

## PC admission and read ownership

The PC connector must authorize the authenticated grant and its current generation on every dispatch, bind subscriptions and cursors to that grant and Session, cancel them on revocation/disconnection, and bound process-wide retention in addition to these per-grant limits. Pairing, identity trust, Session selection, progress projection, and inbox admission are not performed by this library.

`submitText` means one fixed queued follow-up into an existing Session. It cannot create a Session, steer an active request, select a model, change approvals, or attach content. The submission identifier is scoped to `(authenticated phone grant, sessionId, submissionId)`; it is not a global operator command identifier. The PC must serialize admission decisions and reject conflicting reuse of an identifier within its bounded live admission window. It must not send `submitted` until the in-memory inbox has accepted the text.

A successful acknowledgement reports volatile admission only: the PC can later discard unstarted input, fail, or restart without executing it. A lost acknowledgement means **delivery unknown**, even when the phone retained the submission ID. There is no receipt lookup endpoint, no durable submission ledger, and no automatic mutation retry, including after reconnect. The user may explicitly choose a new submission while being warned that duplicate execution is possible. Read retries require fresh request IDs and a newly authorized encrypted connection; subscriptions never survive a socket generation.

## Manual acceptance

No application operations or regression sources have been executed as part of this bounded source work. Before activation, the parent must integrate the PC consumer and native Android peer, type-check their use of [application-types.ts](src/application-types.ts), and run the source regressions in [application.spec.ts](tests/application.spec.ts). Validate count and total UTF-8 byte edges, rejected metadata, request/result correlation, revoked grants, subscription disposal, inbox rejection, duplicate live IDs, and lost-ack delivery-unknown behavior. Android native UI and APK source are separate work, not a PWA supplied by this library.

### Dev Note

None.
