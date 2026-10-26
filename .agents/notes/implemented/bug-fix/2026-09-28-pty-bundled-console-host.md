# Agent Note: Windows PTYs use node-pty's bundled console host

Status: implemented

English | [中文](2026-09-28-pty-bundled-console-host.zh.md)

## Problem

Some Windows console hosts repaint a scrolled PowerShell prompt as `\ndsh>\x1b[1C` instead of the controlled `dsh> ` tail. The arrived tail does not prefix the expected text, so persistent commands use the silence tier despite a prompt marker. A longer [tail grace](2026-09-27-pwsh-prompt-tail-grace.md) helps a delayed valid tail, but cannot repair this malformed render.

## Decision

`subprocess-local` sets node-pty's `useConptyDll: true` only on Windows. The bundled OpenConsole renders the PTY instead of the operating system's console host; POSIX allocation remains unchanged. Readiness still requires the controlled prompt evidence and retains its existing fallback rules.

## Alternatives considered

**Extend prompt-tail grace.** Rejected for this failure: a tail that has already arrived in a non-prefixing form never satisfies the condition the grace extends.

**Normalize the operating system host's repaint sequences.** Rejected: it couples the sanitizer to one console renderer's cursor-motion encoding and leaves other repaint forms unresolved.

**Require newer Windows hosts.** Rejected: it transfers a runtime dependency to each installation even though node-pty already ships a replaceable console host.

## Consequences

Windows terminal allocation requires node-pty's bundled ConPTY DLL and OpenConsole executable. Missing or incorrectly unpacked assets fail allocation without a system-host fallback. node-pty marks the option experimental, so dependency upgrades require packaged-terminal validation. SIGINT remains a console-wide Ctrl-C input, and the reported PTY pid still identifies the shell.

## Testing

The [provider option test](../../../../packages/subprocess/subprocess-local/tests/local.spec.ts) requires the option on Windows and its absence on POSIX. The [real Loader composition](../../../../packages/shell/tool-pwsh-persistent/tests/loader-composition.spec.ts) checks prompt readiness after scrolling, retained state, exit and restart. The [Desktop file policy](../../../../apps/desktop/tests/runtime-file-policy.spec.ts) pins the required assets; the payload smoke selects the same Windows option. These checks have separate source, native-runtime and packaged-runtime responsibilities.
