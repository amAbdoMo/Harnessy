# AGENTS.md — GitHub Actions

`custom-harness-windows.yml` is the automatic check for this personal Windows fork. Run Windows jobs under native `pwsh`; keep the check keyless and limited to the desktop host and local unsigned packaging policy.

Inherited upstream master, sandbox, and real-API jobs remain available for synchronization diagnostics. Their automatic jobs require the repository variable `CUSTOM_HARNESS_RUN_UPSTREAM_CI=true`; do not enable it without the matching upstream secrets, runners, and multi-platform maintenance intent.
