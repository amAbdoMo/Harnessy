# Agent Note: Scoped website handoff

Status: implemented

English | [中文](2026-09-27-scoped-website-handoff.zh.md)

## Problem

Website administration combines an authenticated browser, an MCP connection and repeated Agent operations. Reusing model-provider accounts for website login confuses unrelated credentials. A persistent browser login alone cannot distinguish Human interaction from Agent permission, and canceling a request does not establish that an upstream mutation or native operation stopped.

## Decision

Desktop website profiles remember a site/account label and MCP pairing while isolating browser authentication in a persistent Electron partition. Website cookies remain separate from the [model credential records](../architecture/2026-08-13-credential-records-and-authorization-flows.md). The [optional Workspace decision](2026-09-12-optional-workspace-sessions.md) continues to own the working directory, not website authorization.

Human Login and Takeover prohibit Agent observation of the page, including its title and screenshots. Preparation identifies the initiating Session and exact guest but grants no access. Explicit Resume authorizes one live request, and each invocation still requires fresh scoped consent. Remembered login and projected account reservation never imply page permission; this prevents a reopened profile or alias from silently inheriting authority.

MCP is the preferred route for supported work. Browser fallback receives separate consent because an MCP permission does not authorize a different mechanism. Native and Host checks bind permission to the exact Session, owner, guest, profile, MCP binding and current request revision. Takeover revokes admission immediately, while account reservations remain until dispatched upstream calls and native work physically settle. Failed drainage retains those reservations rather than exposing the same account to overlapping operations.

The [Desktop README](../../../../apps/desktop/README.md) and [Sidebar Browser README](../../../../packages/client/ui-sidebar-browser/README.md) own operation limits and platform behavior. Web mode does not claim Desktop's persistent native browser or login isolation.

## Alternatives considered

**Use model-provider login for website accounts.** Rejected because provider authorization neither authenticates the website nor separates multiple website accounts.

**Remember Agent authority with the browser login.** Rejected because durable authentication would silently authorize future Sessions, pages and invocations without fresh consent.

**Release an account when cancellation is requested.** Rejected because a canceled caller can leave a dispatched MCP mutation or native operation running. Physical settlement, including uncertain cleanup, controls reuse.

**Permit arbitrary page JavaScript after Resume.** Rejected because scripts and workers can outlive Takeover; reloading cannot guarantee their termination.

## Consequences

Login survives according to site cookie expiry without making future work implicitly trusted. Exact-request consent and retained drainage failures add user interaction and can block account reuse until cleanup succeeds. Restricting browser operations gives up arbitrary automation in exchange for bounded, revocable admission. Recorded Session checkpoints retain consent and tool outcomes without recording Human login secrets; tests use controlled adapters, while real Electron login and live-provider acceptance remain separate evidence.
