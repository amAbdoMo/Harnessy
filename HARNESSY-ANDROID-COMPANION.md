---
description: "Connect an Android phone to the same Harnessy Desktop sessions through private Tailscale HTTPS, with explicit pairing and offline activation."
---

# Cookbook: connect Android to Harnessy

## Summary

Use your Android phone to check the PC's sessions and progress, send messages, and start another task. Harnessy and its agents run on the PC; the phone opens the authenticated Web interface. The PC must remain running, awake, and connected to Tailscale.

This setup requires the PC owner's verification on both devices. Static source checks do not confirm Tailscale routing, Android installation, or the rebuilt Desktop window. Follow the [safe build workflow](HARNESSY-STAGING-DELIVERY.md#safe-builds) before activating source changes.

## Table of Contents

- [Prerequisites and access limits](#prerequisites)
- [Configure the private connection](#configure)
- [Pair and install on Android](#pair)
- [Verify and recover](#verify)
- [Disable access](#disable)
- [Dev Note](#dev-note)

-----

<a id="prerequisites"></a>
## Prerequisites and access limits

Install [Tailscale](https://tailscale.com/download) on Windows and Android and sign in to the same private network. Follow Tailscale's [Serve documentation](https://tailscale.com/kb/1242/tailscale-serve) for private HTTPS and its certificate prerequisites. Restrict the network's access rules to your intended devices. Do not enable Funnel, router port forwarding, or an Internet-facing listener.

The phone uses the same Desktop Host, agents, workspaces, and sessions. Do not start a second `dsh web` process against Desktop's data. Installing the Web interface does not install an Android agent, copy PC files to an offline cache, or keep tasks running on the phone.

Pairing grants the phone the existing operator's access, not a sessions-only permission tier. Protect the phone and the pairing link. The link can be reused while its Host process runs; it is not a one-time code. It contains a login credential; messaging services, clipboard synchronization, browser history, and link previews can disclose it. Transfer it only through a trusted private channel, do not publish it, and do not include it in screenshots or diagnostics.

Reserve the PC's private HTTPS root for Harnessy. An existing Serve mapping must not be overwritten without checking its owner and purpose.

-----

<a id="configure"></a>
## Configure the private connection

Choose an unused, fixed loopback port and obtain the PC's full Tailscale DNS name. The examples below use `19488` and `my-pc.my-network.ts.net`; replace the hostname with your own. They follow Tailscale's [Serve CLI](https://raw.githubusercontent.com/tailscale/tailscale/main/cmd/tailscale/cli/serve_v2.go). The PC owner must verify the installed client's syntax and resulting mapping against the linked documentation.

1. Fully quit staging through its application menu or tray, and quit the installed Harnessy app. Closing a window to the tray is not sufficient. Never rebuild beneath an active staging window.
2. On this PC, the machine-local [Start-Harnessy-Staging-App.cmd](Start-Harnessy-Staging-App.cmd) can build and start Desktop with the connection settings. This convenience launcher is not part of a clean checkout; the environment-variable alternative below works with the normal Desktop launch workflow:

   ```powershell
   .\Start-Harnessy-Staging-App.cmd -RemoteUrl "https://my-pc.my-network.ts.net/" -ListenPort 19488
   ```

3. Configure private Tailscale Serve HTTPS to proxy its root to the same loopback port:

   ```powershell
   tailscale serve --bg http://127.0.0.1:19488
   tailscale serve status
   ```

4. Check that the displayed HTTPS hostname matches `RemoteUrl`, the backend is `http://127.0.0.1:19488`, and access is private to the intended network. Do not proceed if Funnel is enabled or the mapping targets another application.

For other Desktop launch arrangements, supply both `DSH_DESKTOP_REMOTE_URL` and `DSH_DESKTOP_LISTEN_PORT` in the launch environment. With neither configured, Desktop retains its ordinary local-only startup. The remote URL must be an HTTPS root on the PC's Tailscale DNS hostname, without credentials, a path prefix, query, fragment, or a nonstandard HTTPS port. The listener stays on `127.0.0.1`; Tailscale supplies the private HTTPS entry, not Harnessy.

For a normal Desktop launch from PowerShell, set the pair in that same shell, then use the documented [Desktop development or production workflow](apps/desktop/README.md):

```powershell
$env:DSH_DESKTOP_REMOTE_URL = 'https://my-pc.my-network.ts.net/'
$env:DSH_DESKTOP_LISTEN_PORT = '19488'
```

Restart Desktop after changing these settings. The launcher does not reconfigure an already-running Host or install, sign in to, or manage Tailscale. If the selected port is occupied, choose another unused port and update both settings and the Serve target; do not start another Harnessy instance.

-----

<a id="pair"></a>
## Pair and install on Android

1. In Desktop, open **Settings → General → PC–phone connection** and copy the pairing link. Check the clean HTTPS address shown there before copying.
2. On Android, connect Tailscale, paste the pairing link into Chrome's address bar, and wait for Harnessy to remove the login token from the address through its authentication redirect. Keep the tokenized link private.
3. Confirm that an existing PC session appears and its recent messages match Desktop. Open that session to inspect progress or send a task message. Use the existing new-session action for a separate task.
4. From Chrome's menu, use **Install app** or **Add to home screen**, according to the browser's available action. Install from the clean address, not a URL containing the pairing token.

The home-screen interface connects to the PC each time it opens. The browser retains an authority-bound authentication cookie; Tailscale membership alone does not log another device into Harnessy. After authentication expires or the browser cookie is cleared, copy a current pairing link from Desktop again.

-----

<a id="verify"></a>
## Verify and recover

The PC owner verifies these outcomes before relying on remote access:

- Desktop still opens normally and keeps the same existing sessions.
- An unpaired browser visiting the private root cannot access sessions or send commands without Harnessy authentication.
- The paired Android phone shows an existing session's progress and can send a message to that same session. Verify the message in Desktop rather than trusting only the phone's display.
- With phone Wi-Fi disabled and mobile data enabled, the connection still works through Tailscale.
- Losing the connection shows disconnected or reconnecting state; restoring it refreshes the live session without sending a task twice.
- The Android keyboard leaves the composer usable, session navigation fits the viewport, and the installed home-screen entry opens the clean address.

If the phone cannot connect, check that the PC is awake, Desktop is running, both devices are connected to Tailscale, and Serve points to the configured port. A stale mapping can reach the wrong service. A sign-in rejection requires a current pairing link pasted into the address bar; do not disable authentication or request-trust checks. If sending reports a connection failure, inspect the session after reconnecting before resending: the PC may already have received the task. A blank rebuilt Desktop window requires captured renderer errors and launcher diagnostics before closing it, as described in the [safe build workflow](HARNESSY-STAGING-DELIVERY.md#safe-builds).

For a lost phone, remove or disable that device in your Tailscale network immediately. Clearing a cookie only on another browser does not revoke the lost phone's existing cookie.

-----

<a id="disable"></a>
## Disable access

Fully quit Desktop, remove both remote launch settings, and reopen it normally. Remove the Harnessy-owned Serve mapping through Tailscale's documented controls without resetting unrelated mappings. Do not leave a private proxy targeting a port that another application could later occupy. A previously paired browser must no longer reach the private entry after the mapping is removed.

-----

<a id="dev-note"></a>
## Dev Note

Real Tailscale proxy compatibility, Android installation, keyboard behavior, and away-from-home access require the manual verification above; they are not established by source inspection or successful compilation.
