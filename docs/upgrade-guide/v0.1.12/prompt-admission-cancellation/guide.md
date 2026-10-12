---
kind: upgrade-guide
description: "Session prompt cancellation remains effective until inbox insertion rather than only before admission starts."
---
# Prompt cancellation during admission

English | [中文](guide.zh.md)

## Change

`session.prompt` checks caller cancellation after asynchronous Agent and attachment resolution and immediately before inbox insertion. A cancelled request cannot insert a new prompt or return an existing-request acceptance. Cancellation after insertion does not remove the prompt or stop the Agent.

The response acknowledges in-memory inbox admission, not a durable checkpoint or task completion. A lost response or PC crash can leave delivery uncertain.

## Migration

1. Direct Host calls supply a second argument: `ctx.sessionController.prompt(request, controller.signal)`. Keep that `AbortSignal` alive while admission is pending. RPC carries request JSON only and uses its request-owned cancellation signal. Aborting can reject a request that has already started resolving its Session.
2. Handle `gateway/cancelled` without automatically submitting another prompt. Inspect the Session when delivery is uncertain; do not interpret transport failure as proof that nothing was admitted.
3. During acceptance verification, cancel a request while Agent or attachment resolution is pending and confirm that no new inbox entry appears. Confirm that cancellation after insertion leaves the admitted prompt unchanged.
