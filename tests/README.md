# Browser e2e tests

English | [中文](README.zh.md)

This suite uses [e2e](https://e2e.tester.army/docs/quickstart.md) to test Harnessy through its real Web host. The [configuration](../e2e.config.ts) uses ChatGPT `gpt-6-luna` to drive browser actions. The app itself uses a [tool-free recorded response](../snapshots/web/deepseek-messages-chat/session.v3.jsonl), not a live model provider.

## Run

After [installing repository dependencies](../docs/development.md), build matching host and browser artifacts and authenticate ChatGPT once:

```sh
pnpm run build:custom-harness
npx e2e login openai
```

Run the suite from the repository root:

```sh
npm run test:e2e:ui
```

The [smoke test](example.e2e.ts) makes no model calls. The [conversation test](conversation.e2e.ts) connects a workspace, starts a session, sends a message, and checks the user message and assistant response after reload. To run that flow without action-cache replay:

```sh
npx e2e run tests/conversation.e2e.ts --no-cache
```

Native Windows execution is verified with Node.js 24.14.0. Upstream platform guidance remains in the [quickstart](https://e2e.tester.army/docs/quickstart.md).

## Isolation and failures

The runner starts the built `dsh web` CLI on an allocated loopback port and stops it afterward. Each CLI run has a unique home and log under ignored `.e2e/` directories, shared with its workers through `HARNESS_E2E_RUN_ID`. Each conversation owns and removes its workspace; home and log artifacts remain available for diagnosis. The [authentication fixture](support/harness.ts) exchanges only the owned server's generated launch URL. It does not copy credentials or cookies from the running GUI. Server logs contain the test process's launch token; do not publish them.

`APP_URL` opts the smoke test into an externally started app; supply its authenticated launch URL locally. The conversation test refuses external targets. The running GUI is not replaced.

A stale host/browser build can produce “Failed to load plugins”; rebuild with the command above. Other failures have screenshots, traces, and step details under `.e2e/`; use `npx e2e run --last-failed --reporter list,markdown`. The existing real-API `test:e2e` script and CI jobs remain unchanged.
