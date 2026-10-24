---
kind: upgrade-guide
description: "Ordinary Session forks stop emitting subagent-start notifications and can be resumed through ordinary-session entry points."
---

# Ordinary forks are classified separately from subagents

English | [中文](guide.zh.md)

## Change

SDK `subagent.started` notifications identify Sessions whose `origin` is `subagent` and that have a direct creator. Ordinary forks no longer emit this notification. ACP lists and resumes ordinary forks; headless adoption accepts them when working-directory, ownership and preset checks pass. Client lineage indentation and Harnessy notifications distinguish ordinary forks from subagents through `origin`.

Harnessy retains ordinary forks' saved source links, copied history, seed boundaries, titles, Workspace membership and source-adjacent manual placement. Existing Session files are not rewritten, and the stored format is unchanged. A parent id alone does not identify a subagent or grant continuation authority.

## Migration

1. Replace external consumer checks that classify every `parentSession` or `parentSessionId` as a subagent with `origin === 'subagent'`. Keep source tracing separate from subagent classification.
2. Observe ordinary forks through normal Session lifecycle events instead of relying on `subagent.started`. Keep subagent continuation checks tied to their own valid continuation descriptor.
3. Confirm that an ordinary fork resumes in its recorded working directory and produces no `subagent.started`, while a real subagent retains its creator and notification. No manual Session-file migration is required.
