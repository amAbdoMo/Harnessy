---
kind: upgrade-guide
description: "Desktop companion activation uses packaged relay configuration and one-time native consent instead of requiring companion environment variables on every launch."
---

# Native companion activation

English | [中文](guide.zh.md)

## Change

Desktop loads its app-owned relay deployment when both companion environment variables are absent. It does not create a PC identity or contact the relay until the user explicitly enables the connection in native phone settings. Committed, origin-bound consent restores the connection on subsequent ordinary starts. Existing phone grants, identity keys and fingerprint approval remain unchanged.

Complete operator overrides using `DSH_DESKTOP_COMPANION_HTTPS_ORIGIN` and `DSH_DESKTOP_COMPANION_BUDGETS` still apply together. Partial, blank or invalid overrides fail instead of falling back to the packaged deployment. Removing both overrides now selects the product deployment; it no longer disables the deployment. A deployment intentionally packaged as `{}` remains disabled.

## Migration

1. Install the qualified Desktop update through the normal application update workflow. Source edits alone do not update the running app; do not rebuild browser/Desktop artifacts underneath an active instance.
2. Open **Settings → General → Android phone companion → Phone settings** and explicitly choose **Enable**. Keep the PC awake and Harnessy running. After the relay connects, create an invitation and approve only the complete matching phone fingerprint. Enabling the connection does not approve a phone.
3. Existing paired phones keep their keys and grants. Do not delete credentials or regenerate the PC identity. The local consent record is stored separately as `companion-host/desktop-consent`; corruption, origin changes and consent withdrawal fail closed.
4. Confirm the phone reconnects after an ordinary Desktop restart without the pilot helper launcher. A configured deployment is not evidence of relay connectivity, device execution or successful encrypted pairing; verify those separately. Operator deployments that need disabling must package an explicit disabled deployment and retire the running Host rather than merely remove its override values.
