---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-17-working-directory-transitions

English | [中文](2026-10-17-working-directory-transitions.zh.md)

## Summary

Records effective Session directory transitions and attributes their queued model notices.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-17-working-directory-transitions
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-21-user-question-reply"
    after: "9a36727716d0e73f681f3b725e7f28f89417c68174c8af0ff2b1ef52b08326a0"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "ba5b10ea77d68f4a29439a9bd2a14f6a560acf55731749d57237757cc72fbc06"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-16-title-prepared-call-config"
    after: "6e6e023b36eeb36b153cf1734fbced73c082c68175a0c1e87c23572ab8a09406"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "2ace3b8059b82b6d9837fed518ca97a99eb37c4482df7aad0e71c85489428ade"
    decision: same-version
  - root: "event:working-directory/change"
    previous: null
    after: "124aa62078ca3311353b39cc3bf6c75da281338be6bbf672f8b361d828cddca3"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The additive working-directory/change event is mandatory on read: older builds that do not recognize it must refuse changed Sessions instead of executing in an obsolete directory. The working-directory message-source kind changes attribution only. Existing logs and immutable Session headers remain unchanged; reading, listing and the first unchanged legacy request do not append an initial directory event or publish a migration. Current execution directories never replace original workspace, settings or sandbox authority. No structural writer-version increase is required by the classifier.

<a id="verification"></a>
## Verification

Source checks: 47 directory, SDK shutdown and sealed-runtime compatibility tests passed; 8 focused persistence cases passed, including required-event replay, malformed directory rejection and unchanged predecessor bytes; 68 one-shot driver, inherited policy, preset, structured-output and scheduling tests passed. TypeScript SDK directory wire tests passed. Python files parsed successfully, but runtime tests are deferred because bundled Python lacks pytest and pydantic. No app build, real-account request, migration of user data, restart, installation or push was performed. An earlier aggregate persistence run reported a worker exit; the complete JSONL file subsequently passed 184 tests in its configured process-bound project. The aggregate exit was not reproduced or established as fixed.

<a id="dev-note"></a>
## Dev Note

None.
