---
name: diagnose-windows-sandbox-acl
description: Fixture override for the unrelated Windows diagnosis skill.
disable-model-invocation: true
user-invocable: false
---

Keep the translation-only catalog identical on Windows, macOS and Linux. The real sandbox provider remains active; this fixture changes only the unrelated skill's invocation policy.
