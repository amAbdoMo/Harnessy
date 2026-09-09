# Agent Note: Custom Harness OpenAI account login

Status: implemented

English | [中文](2026-09-09-custom-harness-openai-account-login.zh.md)

## Problem

Custom Harness exposed API-key provider forms but had no product surface for the OpenAI account login already supported by the installed pi-ai provider. Reimplementing OAuth in the browser would move token exchange and storage into an untrusted presentation layer, while merely adding an OpenAI API-key form would not satisfy account-based ChatGPT subscription access. A successful grant also needed to make Codex models selectable without requiring the user to edit `settings.yaml` afterward.

## Decision

The Custom Harness product bundle mounts the existing neutral `authorization` service. The inherited dormant `llm-pi-ai` adapter registers its `llm-pi-ai/openai-codex` OAuth flow against that seam before any provider route is configured.

`dsh-api-settings-controller` owns a narrow `openAIAccount` Remote namespace. Its `describe` method projects only availability and state flags. `signIn` selects OAuth and browser login, accepts only an HTTPS authorization destination, opens it through the Host native-command boundary, and waits for the provider's localhost callback. The pi-ai flow remains the only writer of the OAuth grant. After the authorization service confirms the record write, the controller adds `providers.openai-codex` to the existing `llm-pi-ai` settings namespace. `signOut` deletes the matching record and route.

The Custom Harness brand client occupies `settings.models.footer` with a localized account card. It renders disconnected, waiting, connected, failure, and sign-out states from injected callbacks and never receives a credential payload. Closing the waiting dialog aborts the Remote request and authorization attempt.

## Alternatives considered

- **Implement OAuth directly in React** — rejected because the browser would become responsible for PKCE, callback handling, refresh-token persistence, and provider-specific behavior already owned by pi-ai.
- **Expose the complete neutral authorization conversation over Remote** — deferred because the current product needs one Windows browser-login path. A generic prompt/notice transport would add device-code and arbitrary provider UI that has no present caller.
- **Store the grant in settings** — rejected because settings are configuration, can be rendered and edited, and are not the credential authority.
- **Enable the route before authorization completes** — rejected because the selector would offer models that cannot make a request and a cancelled login would leave misleading configuration behind.
- **Accept arbitrary login URLs** — rejected because the Host browser opener is a security boundary; account login admits only HTTPS destinations produced by the registered flow.

## Consequences

Users can sign in with an OpenAI account from Settings > Models and see supported Codex models after the browser callback completes. OAuth material remains in the Custom Harness credential store and does not cross Remote responses, settings documents, or session logs. Signing out removes both the grant and its dependent provider route. The UI currently chooses the desktop browser method automatically; headless device-code and manual-code presentation remain outside this product surface.

Focused Host, client, native-command, and assembled-profile tests cover redacted status, secure URL handling, provider activation, cancellation, sign-out, OS browser dispatch, and the real product slot/composition.
