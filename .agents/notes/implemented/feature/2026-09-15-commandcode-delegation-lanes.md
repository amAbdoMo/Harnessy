# Agent Note: Harnessy delegates to Command Code through user-owned lanes

Status: implemented

English | [中文](2026-09-15-commandcode-delegation-lanes.zh.md)

## Problem

Harnessy users who also run Command Code wanted to hand a self-contained task to that CLI from inside a session. Two things made the existing delegation surface a poor fit.

The shipped product providers (`dsh-subagent-codex`, `dsh-subagent-claude-code`) register a `ctx.subagents` provider whose entire run policy comes from the composition row. The shipped consumer for them (`dsh-tool-subagent`) then either exposes no policy at all or, with `modelSelectionSettings: true`, exposes `provider`, `model`, and `reasoning_effort` to the model. Neither shape can carry a per-call *lane* — a named bundle of model, reasoning effort, and access level — without handing the model the access level itself, which is the one field a delegated task must never be able to widen. The generic subagent seam also has no field for a lane, and adding one would let a single product's concept dictate a contract shared by every official composition.

Command Code additionally owns its own installation, authentication, model catalog, and permission flags. Harnessy must not vendor or redistribute the `command-code` npm package (it is UNLICENSED), must not read or store its credentials, and must not silently fall back to any other product, model, or executable when it is unavailable.

## Decision

`@deepseek-ai/dsh-subagent-commandcode` is a dedicated consumer of the existing seams rather than a provider on `ctx.subagents`. It resolves the current workspace's lanes from a live settings namespace and drives the user's own CLI directly, reusing the subagent seam's out-of-process vocabulary (`settleRun`, `settleRunResult`, `subprocessRunHandle`, `SubagentResult`, `SubagentRun`) and the generic job registry for background scheduling.

The consumer owns three things:

- **The `commandcode-delegation` settings namespace**, holding the global lane directory, the three run bounds (`maxConcurrentRuns`, `timeoutMs`, `maxTurns`), and `projects`, which keys per-workspace lane overrides by canonical workspace path. An override is a field patch: an omitted field inherits, a named field replaces. Deleting a lane deletes every override that patched it.
- **Two token-stable model-facing tools.** `list_commandcode_lanes` reports the enabled lanes resolved for the workspace — id, name, purpose, model, effort, access — and nothing else. `commandcode_delegate` takes a lane id, a self-contained task, and an optional `run_in_background`; it has no model, effort, timeout, turn, executable, credential, or permission field.
- **The `commandcode` Remote namespace**, exposing only the CLI's detected version and sign-in state, its advisory model catalog, and the resolved lanes for one workspace. No secret, path, or process fact rides it.

Two facts keep the model-visible contract honest. The brief is written to the CLI's stdin (`-p` with no query argument is its documented piped-input form), so task text never enters argv and no shell ever sees a value. And the parent-visible text is bounded to 12 KiB of UTF-8 at the source in this package's run, so every consumer inherits the same limit and the same truncation marker.

A background delegation registers before anything else happens. The job registry hands back the id synchronously, and the starter it then calls owns the CLI preflight, the concurrency slot, the process, and the teardown under one task-owned controller — so a caller is never held behind an earlier run or behind a probe. Killing a job that is still probing or queued settles it as killed, starts no Command Code process, and returns the slot it held or takes none; a delegation that never reached a run settles as a failed job whose detail is the same fixed product-owned diagnostic a failed run uses, never a host path, command, or raw product error.

The `custom-harness` bundle patch layer mounts both halves. Because the Host row registers the two tools into the root scope, every agent composed from any Harnessy preset sees them — which is exactly why the official web bundle disables host-plane tool rows — and no other profile mounts the row at all.

## Alternatives considered

**Register a `commandcode` provider on `ctx.subagents`.** This is the sibling shape and would have reused the most machinery. It lost on the lane: the seam's `SubagentStartRequest` has no field for one, and the only request fields that could carry it (`agentOptions`, `persona`) mean something else and are validated as such. Adding a lane field would put one product's policy inside a contract shared by every official composition.

**Expose the lane's model and effort through `tool-subagent`'s `modelSelectionSettings`.** It would have required no new package. It lost because that path exposes model selection *to the model*, and access level has no field there at all — so the access level would have had to come from the row, which is not per-workspace and not user-editable at runtime.

**Give each lane its own `ctx.subagents` provider instance.** Attractive because lifecycle events and closure semantics would come for free. It lost because lanes are live settings: adding, renaming, or deleting one would have to reconcile a global provider registry on every settings change, and a run that started during a reconcile would race its own provider's identity. Reading the lane at call time has no such window.

**Pass the brief in argv.** The CLI documents `cmd -p "query"`. It lost on two counts: the contract asks for task text to stay out of argv where the CLI supports it, and the CLI does — its headless reference documents `echo "…" | cmd -p` — and Windows caps a command line far below the size of a real brief.

**Mount the tools from a shipped Agent Preset row.** It would have matched how every other tool reaches a Harnessy agent. It lost because preset files are shared by every profile: a row naming a package that only the Harnessy bundle installs would fail to resolve in official profiles. Mounting the plugin in the product patch layer reaches the same agents because the tools registry's global layer is visible to every scope, and it leaves official profiles untouched.

**Add a lane field to `SubagentStartRequest`.** Rejected for the reason above: one product's policy does not belong in the shared seam, and every official provider would then have to decide what to do with it.

**Let the generic job registry deliver the final answer as a final-output job.** Dropping `readOutput` would have made `JobRegistry.read()` return the settled outcome's `output`, which is the obvious way to reach a background answer. It lost because the contract also asks for a coarse live category while the run is in flight, and a stream job's `read()` never consults that outcome at all. The hook therefore serves both halves: activity deltas while live, and the same bounded text a foreground call returns once the run has settled.

**Bind the shared installation probe to its first caller's signal.** Deduplicating probes by memoizing the promise is what keeps a page load from spawning a helper pair per reader, but the signal that bounded it belonged to whoever asked first — so that reader's cancellation turned a healthy CLI into an unavailable one for everyone else, while a later reader's cancellation was ignored until the first probe finished. The probe now runs under a controller the plugin owns, each caller races it against its own cancellation, and a caller that is already cancelled starts no probe at all.

## Consequences

Harnessy gains a delegation backend with no new seam, no new process owner, and no change to `agent-loop` or to `dsh-subagent`. It costs a dedicated consumer whose lane resolution and job adaptation are its own, and whose probes spawn two short-lived helper processes per delegation (deduplicated while one is in flight). A delegated run is not observable through `subagent/start` and `subagent/end`; its live status reaches the parent through the generic job runtime's completion notice and `job_output` instead.

The seed of this decision is that access level is stored policy, never a call argument. Anything that would let a task widen it — a per-call override, a model-chosen lane, a fallback to another executable — is out of contract, and the two tool schemas are pinned verbatim by the Loader composition test so a later change has to be deliberate.

The settings page pays for that policy with a write path of its own. Every edit is applied to the section the editor currently shows and persisted as only the top-level fields it moved, because a write only reaches the mirrored snapshot a round-trip later and two edits inside one round-trip would otherwise each re-derive from the same stale document. The resolved view is re-read after every accepted write — and each read aborted when a newer one supersedes it or the page unmounts — so inheritance and reset state converge on what the Host committed rather than on what the page last saw.

## Related

- [Two named product subagent providers](../../implemented/feature/2026-08-04-claude-code-and-codex-subagent-backends.md) — the sibling product backends and the shape this one deliberately does not take.
- [Per-session agent presets](../../implemented/architecture/2026-08-03-per-session-agent-presets.md) — why a host-plane registration is visible inside every preset.
