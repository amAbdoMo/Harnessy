# AGENTS.md — Native Android companion

These instructions apply to `apps/android`. Follow the repository-wide instructions and the [Android application contract](README.md).

## Native stack

- Write new application code in Kotlin. Build native UI with Jetpack Compose and Material 3; do not introduce Flutter, React Native, Expo, HTML-based UI or WebViews.
- Use MVVM, unidirectional data flow, Coroutines and Flow/StateFlow. Keep business logic outside Composables and collect state with lifecycle awareness.
- Use Hilt for application and ViewModel dependency ownership, official Compose navigation, Gradle Kotlin DSL and compatible stable dependencies verified against official documentation.
- Use DataStore for ordinary phone preferences. Introduce Room only when structured local persistence has a concrete owner; PC session history remains PC-owned.
- Preserve the tested Java cryptographic/transport core through Kotlin interoperability until an independently verified migration replaces it. Do not rewrite cryptography as part of a presentation change.

## Ownership and safety

- Privileged tools, orchestration, repositories and AI provider credentials remain on the secured PC/backend. Never embed provider API keys or export PC account credentials to Android.
- Maintain one application-scoped serialized platform owner and one foreground controller per presentation owner. ViewModel survival across configuration changes must not keep the network alive after Activity stop.
- Keep invitation text and drafts in bounded RAM only; clear incoming Intent data, extras and ClipData. Never automatically enroll a link, regenerate a missing paired identity, or navigate an invitation as a website.
- Preserve AndroidKeyStore aliases, pairing metadata, repair markers and durable delivery fences. Do not migrate their storage without fail-closed, interruption-tested migration semantics.
- Inbox admission is not durable delivery or task completion. Never automatically resend an uncertain or offline mutation. Forget and uncertainty review require explicit confirmation.
- Model/account controls need independently approved PC capabilities and final executor authorization checks. Do not forward generic operator RPC, settings or credential APIs.
- Closed-app notifications require configured push infrastructure. Keep push payloads generic; fetch private details through the authenticated encrypted channel. Do not claim background delivery when configuration or acceptance evidence is missing.

## Development and evidence

- Keep copy in Android string resources with English/Chinese parity; support light/dark themes, accessibility, tablets, IME and system insets.
- Prefer the owner's physical Android device through ADB, Android Studio/Logcat or optional scrcpy. Emulator use is optional; never change virtualization settings or restart Windows implicitly.
- Use a separate debug application ID. Do not uninstall the signed release or clear its data to solve a debug-install problem without explicit permission.
- Run discoverable JUnit tests and focused Compose UI tests. Distinguish compilation, JVM tests, device tests, crypto interoperability and end-to-end pairing evidence.
- Follow [safe staging builds](../../HARNESSY-STAGING-DELIVERY.md#safe-builds). Android builds do not authorize rebuilding, stopping or replacing the running Desktop GUI. Preserve concurrent PC/account/companion changes and coordinate overlapping edits first.
