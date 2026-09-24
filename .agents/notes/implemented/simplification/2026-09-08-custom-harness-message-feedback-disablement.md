# Agent Note: Custom Harness disables per-message feedback

Status: implemented

English | [中文](2026-09-08-custom-harness-message-feedback-disablement.zh.md)

## Problem

The shared Web composition offers Good response, Bad response, and Add a note actions on individual assistant messages. Custom Harness deliberately omits that product surface, but hiding only the buttons would leave its Host Remote callable by an older client or a direct request. Removing the shared feedback implementation would also change the stock Web product and risk conflating message annotations with the separate session-level feedback and safety controls.

## Decision

The `custom-harness` profile disables the `message-feedback` Host row and the `ui-message-feedback` client row in `packages/bundle/custom-harness/cordis.patch.yml`. The client therefore contributes no per-message controls, while the Host registers no `messageFeedback/list`, `messageFeedback/put`, or `messageFeedback/delete` Remote handlers. The authenticated gateway rejects those unclaimed paths with HTTP 404.

Per-message feedback never has a model tool, so the profile introduces no tool alias, tombstone, or replacement schema. Existing session logs remain compatible because ratings and notes use a separate sidecar instead of session events. The profile performs no migration or deletion of that sidecar.

The `/feedback` command, telemetry feedback gating, authentication, approvals, permission presets, sandboxing, and filesystem policy remain composed. They are separate operational, privacy, or safety controls rather than alternate routes to per-message annotations.

## Verification

The Web composition coverage boots the custom overlay, checks the missing Host service, sends authenticated requests to all three Remote paths, and restarts into the same denied composition. The built-client smoke checks that the feedback UI plugin is absent, cold-opens an existing session without feedback controls, and retains the Copy action. The composition coverage also retains the `read` tool and the separate `/feedback` command.

## Alternatives considered

**Hide only the client controls.** This leaves the Host Remote available to stale clients and handcrafted requests, so the capability is not disabled end to end.

**Delete or change the shared feedback packages.** Those packages remain supported by the stock Web profile. Product-specific omission belongs in the downstream profile layer, which also keeps the change easy to reverse without destabilizing shared code.

**Disable the `/feedback` command or telemetry feedback gating too.** Their session-level and privacy roles are independent of per-message ratings and notes. Removing them expands the decision and weakens retained operational controls.

**Erase existing feedback sidecars.** Destructive cleanup is unnecessary for disabling access and would discard user data without a migration requirement.

## Consequences

Custom Harness users cannot rate or annotate individual messages, including through older clients that call the Remote directly. Existing session histories still replay normally, and no stored annotation data is rewritten. The stock Web profile keeps the feature. Reintroducing per-message feedback requires deliberately re-enabling both profile rows and restoring the denial coverage to positive feature coverage.

## Related

The independent product identity is recorded in [Custom Harness brand identity](../feature/2026-09-08-custom-harness-brand-identity.md).
