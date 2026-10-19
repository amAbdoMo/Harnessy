# 保留的 Git 工作树

[English](worktrees.md) | 中文

可选的 [`worktree` 服务](../../packages/experimental/worktree/README.zh.md)通过 `ctx.worktrees` 提供保留的本地检出目录。其[工具消费方](../../packages/experimental/tool-worktree/README.zh.md)创建新分支，并通过 [Session 目录服务](../../packages/session/working-directory/README.zh.md)选择检出目录。必须显式组合；默认 profile 不会激活它。包参考文档拥有配置、取消、保留规则及 Git 要求的说明。

## 请求与结果

请求选择新名称与本地可用的版本。结果不会授予额外访问权限，也不会替换原始项目目录。

```ts type-equiv
/** A new checkout from a locally available Git commit, branch, or tag. */
interface CreateWorktreeRequest {
  /** New branch name, also used as the relative checkout directory; omission generates a name. */
  name?: string
  /** Local revision to resolve before creation; omission selects HEAD. */
  from?: string
}
```

```ts type-equiv
/** Committed Git baseline and the calling Session's resulting working directory. */
interface CreatedWorktree {
  /** Canonical absolute checkout directory in the filesystem provider's execution world. */
  path: string
  /** Newly created branch name. */
  branch: string
  /** Resolved commit object name; repository-local replacement refs can change its checked-out content. */
  baseCommit: string
  /** Canonical root of the source checkout. */
  repositoryRoot: string
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxworktrees--worktreeservice"></a>

### `ctx.worktrees` — `WorktreeService`

Creates retained Git worktrees under the mounted filesystem and sandbox providers.

```ts cordis-catalog
/**
 * Create a fresh branch and checkout at a pinned local revision, then enter it.
 * Existing branches or checkout paths fail. Uncommitted files stay in the source checkout.
 * Checkout disables configured clean, smudge, and process filters without changing Git config.
 * Repository-local replacement refs still apply; baseCommit reports the resolved object name.
 * The new checkout becomes current only after Git setup succeeds. Failures may retain newly
 * allocated Git/filesystem artifacts; no branch or checkout is removed automatically.
 * The allocated checkout keeps the device and inode identity its allocation reported, and its
 * Git administration directory must be the one Git registered for it; a replaced destination or
 * pointer fails the operation before any file is written.
 * @param agent - caller whose current directory selects the source repository and file policy.
 * @param request - optional new name and local revision; defaults are generated name and HEAD.
 * @param signal - cancellation of lookup, creation, and working-directory publication.
 * @returns canonical checkout path, branch name, pinned commit, and source repository root.
 */
async create(agent: Agent, request: CreateWorktreeRequest = {}, signal?: AbortSignal): Promise<CreatedWorktree>
```

Types: [Agent](core.zh.md)

Source: [`packages/experimental/worktree/src/index.ts`](../../packages/experimental/worktree/src/index.ts)
<!-- END GENERATED cordis-surface -->
