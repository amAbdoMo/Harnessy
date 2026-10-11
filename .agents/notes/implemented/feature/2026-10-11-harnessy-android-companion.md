# Agent Note: Private Android access to the Desktop Host

Status: implemented

English | [中文](2026-10-11-harnessy-android-companion.zh.md)

## Problem

An Android phone must inspect and message agents already running on the PC, including away from the local Wi-Fi. A second Web process does not own those live agents and can race on Desktop's data. Network reachability alone does not authenticate a caller to the tool-capable Host.

## Decision

The companion reuses the existing Desktop Host's authenticated Web frontend and Session APIs. Remote access is an explicit launch opt-in: a fixed loopback port and a root HTTPS URL on the PC's Tailscale DNS hostname. The user owns private Tailscale Serve configuration; Harnessy neither installs the VPN nor creates public routing. Desktop retains its separate loopback login and ordinary local-only default.

The owned Desktop application can describe the clean remote root and request a Main-process clipboard copy of its current Host's pairing URL. The renderer cannot choose the destination or receive the credential. Credential-bearing startup URLs are suppressed on Desktop's stdout. Host replacement and shutdown invalidate a pending pairing operation.

The [browser launch-token authentication](../architecture/2026-08-24-browser-token-authentication.md) and [carrier request-trust rules](../architecture/2026-07-28-api-browser-trust-boundary.md) remain authoritative. Tailscale identity headers and proxy-forwarding headers grant no application identity. A paired phone has the existing operator's authority; a mobile layout is not a sessions-only authorization tier.

## Alternatives considered

**Start a separate Web profile.** It cannot connect to the existing process's live agents and introduces another owner for persistent data. Reusing the Desktop Host retains one process owner.

**Bind the Host to the network or publish a tunnel.** The requested away-from-home access does not require an Internet-facing tool-capable server. Private HTTPS forwarding preserves the loopback listener and existing authentication.

**Manage Serve automatically on each dynamic port.** This couples app startup to user-owned network configuration and can replace another application's mappings. An explicit fixed port permits stable forwarding without granting Harnessy VPN administration.

## Consequences

The PC must stay awake, connected, and running. The phone is a presentation client, not an Android execution runtime or offline Session cache. A copied pairing link is sensitive, including on synchronized clipboards. Cookies retain the existing lifetime and revocation semantics; removing a lost phone from the private network is an immediate reachability control, not cookie revocation.

The [setup guide](../../../../HARNESSY-ANDROID-COMPANION.md) assigns real proxy, Android installation, keyboard, reconnect, and mobile-data verification to the PC owner. Static validation does not establish those outcomes. Source changes require an offline rebuild before activation under the [staging workflow](../../../../HARNESSY-STAGING-DELIVERY.md#safe-builds).

The authentication and request-trust notes remain active because their independent security rationale still applies; no note is fully superseded or archived.
