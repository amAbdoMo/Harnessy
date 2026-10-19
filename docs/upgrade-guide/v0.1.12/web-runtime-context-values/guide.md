---
kind: upgrade-guide
description: "The Web prompt sections no longer embed the checkout path and GUI URL; those values arrive as runtime context, and @deepseek-ai/dsh-app-boot no longer exports addHarnessSourceSection."
---

# Keep the Web prompt values in runtime context

English | [中文](guide.zh.md)

## Change

`dsh web` used to name the implementation checkout and the advertised GUI URL inside the `harness:source` and `app:web-surface` prompt sections. Both values differ between processes, so a session resumed after a restart saw a different request prefix and the signed thinking of its earlier turns no longer validated. The two sections are now value-free, and the checkout path and GUI URL arrive as runtime context, which the session reads per request. A session that already admitted the earlier value-bearing paragraphs keeps them verbatim, so its request prefix does not change at all. `@deepseek-ai/dsh-app-boot` no longer exports `addHarnessSourceSection` or `HARNESS_SOURCE_SECTION`; the Web bundle owns both sections, their runtime contexts, and the projection that keeps an admitted paragraph. The `surfaceContext` configuration, the `DSH_WEB_URL` environment variable, and the Web composition itself are unchanged.

## Migration

1. Remove `addHarnessSourceSection` and `HARNESS_SOURCE_SECTION` imports from `@deepseek-ai/dsh-app-boot`. A composition that wants the same paragraphs mounts `@deepseek-ai/dsh-web-app` instead; a composition that registered its own `harness:source` section keeps that name and its own text.
2. Expect the model to receive the checkout path and the GUI URL in the runtime-context snapshot rather than in the system prompt. Scripts that assert on the system prompt text must read the runtime-context snapshot.
3. Open a session that started before this change and confirm its system prompt still carries the earlier paragraphs verbatim.
