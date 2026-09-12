# Agent Note: Optional Workspace sessions

Status: implemented

English | [中文](2026-09-12-optional-workspace-sessions.zh.md)

## Problem

The global New Session action inherited the current or most recently active Workspace. When no Workspace was available, the empty composer required a directory choice before accepting a prompt. Browser-led work such as managing a WordPress site therefore carried an unrelated project-folder decision on every new conversation.

## Decision

The global New Session action creates or reuses one unarchived, ungrouped blank Session. Session creation omits both `workspaceId` and `cwd`, so the Host supplies its configured default working directory without exposing a folder prompt. Concurrent global requests share one creation attempt and open the same provisional Session.

Workspace-scoped actions keep passing their Workspace id and retain the existing per-Workspace blank reuse. The application-start navigation policy may still reopen the most recent Workspace; the explicit global New Session gesture is the operation whose default is ungrouped.

An ungrouped blank Session renders **No project** in the interactive Workspace chip and keeps the composer writable. The user can send a browser-oriented task immediately or choose an existing Workspace or new folder before the first prompt.

## Alternatives considered

- **Always open the directory picker** — rejected because it makes a local filesystem decision mandatory for browser-only tasks.
- **Inherit the current or most recent Workspace** — rejected because an unrelated code project silently grants the next task a misleading working context.
- **Remove Workspace selection from New Session entirely** — rejected because local development remains a primary workflow and still needs an explicit project choice.

## Consequences

Browser-led sessions start with one click and appear under Ungrouped until a project is selected. Local coding work adds one explicit project choice through the existing chip or Workspace-scoped action. The Host still assigns every agent a valid working directory, so providers and tools that require an absolute `cwd` keep their existing contract.

Focused Workspace-service tests cover blank reuse, archived and Workspace-owned exclusions, concurrent creation, and explicit targeting. Conversation tests cover the writable ungrouped hero and its optional project chip.
