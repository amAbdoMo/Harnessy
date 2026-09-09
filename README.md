# Custom Harness

Custom Harness is a personal Windows desktop AI harness maintained by [amAbdoMo](https://github.com/amAbdoMo). It is built from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and keeps the upstream plugin-based runtime while providing independent branding, isolated application data, and a compact Windows installer.

This repository is the source-code backup and version history for the customized application. Stable versions are published as installers under [GitHub Releases](https://github.com/amAbdoMo/Harnessy/releases).

## Project goals

- Preserve the desktop harness features and UI used by the personal build.
- Install and launch like a normal Windows application without a terminal window.
- Keep Custom Harness data separate from other Harness installations.
- Support browser-based OpenAI account sign-in for Codex models without requiring an API key.
- Record each source adjustment in Git and provide restorable installers for stable versions.
- Keep upstream DeepSeek Harness available as a source of compatible fixes and improvements.

<a id="run"></a>

## Install on Windows

The personal Custom Harness release currently targets Windows x64.

1. Open the [latest release](https://github.com/amAbdoMo/Harnessy/releases/latest).
2. Download the `CustomHarness-Setup-*-win-x64.exe` asset.
3. Run the installer and choose an installation directory when prompted.
4. Launch **Custom Harness** after installation.

The personal installer is not code-signed, so Windows SmartScreen may display a warning. Confirm that the installer came from this repository's Releases page before running it.

## Use the application

Open **Settings > Models** to configure a provider. For Codex models, use **Sign in with OpenAI** and complete authentication in your default browser; Custom Harness activates the OpenAI Codex model route after the callback succeeds. API-key providers remain available separately.

OpenAI account sign-in uses the existing Codex OAuth flow described in the [official authentication documentation](https://learn.chatgpt.com/docs/auth). The resulting grant stays in the local Custom Harness credential store and is not committed to this repository.

Application state is stored under `%LOCALAPPDATA%\CustomHarness`. Installing a newer Custom Harness version uses the same product data directory; source code and installers do not contain your local sessions or credentials.

Custom Harness does not currently check for or install updates automatically. Install a newer version from GitHub Releases when one is published.

## Version and backup flow

Git commits preserve individual source changes. A version tag identifies each stable snapshot, and the matching GitHub Release carries its Windows installer. This keeps development history separate from the smaller set of versions intended for installation.

Personal application data is not committed to GitHub. Back up `%LOCALAPPDATA%\CustomHarness` separately when you need a copy of local sessions and settings, and protect any credentials stored there.

<a id="run-from-source"></a>

## Build a personal installer

Building requires Windows x64, Node.js 24, and pnpm 11.7.0.

```powershell
git clone https://github.com/amAbdoMo/Harnessy.git
cd Harnessy
pnpm install --frozen-lockfile
pnpm run package:desktop:win:x64:local
```

The unsigned installer is written to `apps/desktop/.desktop-build/targets/win-x64/artifacts/`. Build outputs and installed dependencies are intentionally excluded from Git so the repository remains a source backup rather than a copy of generated files.

The upstream signed packaging commands remain separate and fail when the required signing credentials are unavailable. The `:local` command is the explicit path for this personal unsigned Windows build.

## Development checks

For changes to the local Windows packaging path, run:

```powershell
pnpm exec tsc -b tsconfig.host.json --pretty false
pnpm exec vitest run apps/desktop/tests/package-target.spec.ts apps/desktop/tests/macos-signature.spec.ts
```

GitHub runs the same focused desktop checks on Windows for pushes and pull requests. Inherited upstream multi-platform, sandbox, and live-API workflows are disabled by default because they require DeepSeek's runners and secrets.

## Relationship to DeepSeek Harness

Custom Harness is an independent personal derivative and is not an official DeepSeek product. The upstream project, its documentation, and its community are available from the [DeepSeek Harness repository](https://github.com/deepseek-ai/deepseek-harness).

## License

The source remains available under the [MIT License](LICENSE). Third-party dependencies and their licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
