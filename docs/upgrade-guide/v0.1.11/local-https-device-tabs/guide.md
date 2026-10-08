---
kind: upgrade-guide
description: "Local HTTPS device tabs use isolated temporary storage instead of shared workspace storage."
---
# Local HTTPS device tabs use isolated storage

English | [中文](guide.zh.md)

## Change

Ordinary Desktop Browser tabs at `localhost` or literal loopback, private, and link-local HTTPS addresses use a fresh storage partition per tab. They do not share workspace cookies or another device tab’s login. Changing between storage scopes replaces the guest and loses its native history and page memory. Existing saved-account partitions and ordinary public-site workspace sharing remain unchanged. The [Desktop Browser policy](../../../../apps/desktop/README.md#local-https-devices) describes explicit certificate consent and unsupported POST transitions.

## Migration

1. Open the local device in an ordinary Browser tab and sign in again if needed. Keep that tab open for the visit; closing it clears its temporary login storage.
2. If an unverified-certificate warning appears, inspect the device address and certificate fingerprint. Cancel unless you recognize the device and trust the network. Certificate acceptance applies only within that isolated tab.
3. Confirm that a second tab does not inherit the first tab’s device login or certificate acceptance. No settings keys, certificate installation, or persisted Session-data migration are required.
