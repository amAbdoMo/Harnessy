---
kind: upgrade-guide
description: "Saved website profiles gain remembered access choices and a new metadata version."
---

# Saved website access

English | [中文](guide.zh.md)

## Change

Saved website profiles support Automatic, Ask each time, and Disabled access independently of filesystem permissions. Automatic requests open their account tab and wait for native admission without a per-operation approval. Pause retains the saved login; Continue selects the next waiting request. Automatic work can continue while the app is minimized. Guest loss, account changes, cancellation, and Host replacement still revoke the request.

Website profile metadata advances to version 2. Version 1 profiles load with Ask access, preserving their identities, addresses, MCP bindings, and browser storage. The next profile mutation writes version 2; older builds cannot read that version. Optional saved passwords use a separate OS-encrypted local vault and never enter model messages or profile metadata. Automatic sign-in supports conventional same-origin login forms; MFA and unsupported flows need human interaction.

## Migration

1. Retain the installation's existing data directory. Do not copy browser profiles or credentials between installed and staging apps.
2. Open the saved website and select Automatic once to allow unattended work on that account. Existing profiles remain on Ask until changed; Disabled rejects agent work while retaining the profile.
3. Optionally choose Save login. Finish any MFA or unsupported login yourself, then Continue. Sign out clears browser authentication and returns the profile to Ask; Remove saved login deletes the encrypted login, and Forget removes both the profile and its encrypted login after cleanup succeeds.
4. Check that a trusted website request proceeds without an approval prompt and that Pause stops further agent operations. Website cookies can still expire according to the site's own policy.
