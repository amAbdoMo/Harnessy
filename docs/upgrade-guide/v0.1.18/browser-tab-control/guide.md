---
kind: upgrade-guide
description: "Desktop browser access uses chat-owned tabs and moves account controls out of the browser header."
---

# Browser tab control

English | [中文](guide.zh.md)

## Change

Desktop browser work uses stable `preview_*` tools on chat-owned tabs. Agents can observe tabs during human control, and can act on their own or unclaimed tabs after the human releases control. Browser access no longer requires a paired MCP server or a saved-website preparation request. Queued actions are rejected when control changes; takeover waits for running actions to settle.

The browser header removes the Desktop, Tablet and Mobile buttons and moves saved-account actions into a collapsed menu. The default Desktop tool inventory replaces `website_profiles` and `website_prepare` with preview tools. Saved Ask, Automatic and Disabled choices govern only explicitly installed legacy paired requests; preview tools use chat ownership and human control for every account. Select, Region, Draw and Erase prepare annotated screenshots and element context in the chat draft. Adding feedback does not send the message.

## Migration

1. Keep the existing application data directory and saved browser accounts. Main and staging retain separate data directories; do not copy logins between them.
2. Open a browser tab in the intended chat. Use `preview_status` to discover its tab identity and `preview_open` to open a new tab. Agents should use the stable preview tools for ordinary browser work.
3. Choose Take control before manual interaction and Resume agent when finished. The agent can still inspect the page during takeover, but cannot dispatch new actions. Each parallel chat uses its own tabs.
4. Use the annotation tools and Add to chat to stage feedback, then review and send it through the ordinary composer.
