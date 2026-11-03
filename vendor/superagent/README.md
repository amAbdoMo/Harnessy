# Super Agent for Harnessy

Super Agent watches one GitHub repository, evaluates authorized requests, tracks Tickets and runs each assignment in a managed Harnessy Session. Its sidebar panel shows work, pending decisions, account setup and execution settings. This optional bundle adapts the [official DSH research prototype](https://github.com/deepseek-ai/dsh-superagent-prototype); its MIT license is retained in [LICENSE](LICENSE).

## Setup

1. Open **Plugins**, find **Super Agent** and enable it. Opening its sidebar panel shows any remaining setup requirements.
2. Under **Settings → Sources → GitHub**, choose the repository and an authenticated `gh` executable. The executable's active account is the identity used for GitHub activity; an existing personal account is supported when the owner chooses it.
3. Under **Policy**, allow only the GitHub accounts that may request work. An empty list authorizes nobody. Leave evaluation in **Observe** while reviewing prospective proactive work.
4. Under **Execution**, choose the working directory and preparation command, model and concurrency. On Windows the preparation command runs in PowerShell; other systems use `sh`. Pause execution while changing an active deployment.
5. From an allowed account, post a new GitHub request mentioning the configured identity. When using your own personal account, enable **Accept my /superagent requests** and start a new issue comment with `/superagent` followed by the request; repository comment polling receives it without relying on a notification to yourself. Automatic replies carrying the plugin's marker are excluded. Super Agent records the request and shows its Ticket in the panel. Editing an existing issue body does not create a new notification.

The default state directory is `SuperAgent` inside the active Harness home. Main and staging therefore keep separate databases, settings and Tickets. Account credentials remain with GitHub CLI; the plugin does not copy them between Harnessy installations. Git/PATH overrides apply only to managed Super Agent shells and commands. Normal chats retain their own environment and preset. Default delivery leaves merging and releases to the owner.

## Build and verification

`pnpm run build:superagent` typechecks and builds this vendored plugin after the Host and Client libraries exist. The external plugin consumes those declarations instead of joining Harnessy's separate source compiler programs. `pnpm --dir vendor/superagent exec vitest run` runs the imported tests and Harnessy's adaptation tests. Unix shell/service tests require the upstream environment; Windows behavior has native PowerShell checks. The repository build runs this phase once after both library phases, and Desktop packaging includes it through the CLI's runtime dependency.

## Model experience

Only Super Agent's managed Sessions receive its role prompts, work tools, source context and ticket instructions. Their content uses the ordinary durable Session APIs. Repository context and conversation history add tokens to those Sessions; changes to role prompts or tool sets can reduce prefix cache reuse. Installing the disabled bundle adds no model request or prompt content to ordinary chats.

## Known limitations and deferred work

The upstream project is a research prototype. Its workers operate with the OS user's filesystem access; command wrappers select accounts but do not provide OS isolation. Its managed presets are intended for Super Agent Sessions. Configuration and account probes do not establish successful model-generated work or pull-request delivery. Repository checkout preparation remains owner-configured; installing this bundle does not create another Harnessy clone or worktree. The optional Feishu source retains the upstream CLI requirements and is disabled by default.
