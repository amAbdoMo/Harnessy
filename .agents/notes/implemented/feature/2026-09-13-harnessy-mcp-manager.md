# Agent Note: Harnessy MCP manager

Status: implemented

English | [中文](2026-09-13-harnessy-mcp-manager.zh.md)

## Problem

The MCP client originally required declarative Loader configuration. Harnessy's personal Windows user needed a reusable visual workflow that could save several local or remote servers, inspect their health and tools, and enable or remove them without editing configuration files or restarting the application.

## Decision

The Settings controller owns one global `mcpManager` Remote namespace and stores a versioned server registry in Harnessy's credential provider. Browser responses include only display fields, non-secret launch fields, authentication presence, live status, and tool names. HTTP authorization values and stdio environment values never cross back to the renderer.

Enabled profiles start through `startManagedConnection`, the same MCP lifecycle used by declarative plugin entries. It reserves `mcp__<serverName>__*`, supervises reconnects, reports connection snapshots, and releases both tools and namespace on disposal. The controller serializes saves and reconciliation, starts saved enabled profiles on composition, and restarts only profiles whose complete protected record changed.

Settings > MCP Servers supports Streamable HTTP over HTTPS (plus loopback HTTP for local development) and direct stdio commands. It provides add, edit, test/restart, enable/disable, remove, live status, and discovered-tool controls. The page polls redacted state every three seconds while mounted.

## Alternatives considered

- **Continue with `cordis.yml` only** — rejected because it requires technical file editing and restart for routine personal use.
- **Store secrets in browser settings** — rejected because rendered settings and browser state are the wrong trust boundary for authorization values.
- **Create an unrelated connection implementation** — rejected because it could bypass namespace collision protection and diverge from MCP reconnect and disposal behavior.
- **Push every status transition over a new event protocol** — deferred because bounded polling is simpler and status is relevant only while the Settings page is visible.

## Consequences

MCP tools from enabled saved profiles are global to Harnessy sessions and use the established server-qualified naming contract. Secrets stay in the application-local credential store but remain readable to processes running as the same Windows user, so this is local protection rather than a remote secret manager. A remote profile cannot embed URL credentials or fragments, and non-loopback HTTP is rejected. Tool schemas still contribute tokens to model requests while registered; disabling or removing a server unregisters them.
