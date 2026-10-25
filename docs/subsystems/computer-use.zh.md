# 计算机操作

[English](computer-use.md) | 中文

计算机操作让模型通过配置的提供方观察并操作本地桌面。DSH 的共享能力称为 **computer use（计算机操作）**；**Cua Driver** 是上游实现的名称。

## 选择提供方

在同一组合中挂载 [`dsh-computer-use`](../../packages/computer-use/computer-use/README.zh.md) 和一个提供方。两个 Cua Driver 提供方都是公开发布到 npm 的实验性包，均需显式启用。

| 提供方 | 运行时 |
|---|---|
| [Cua Driver MCP](../../packages/experimental/computer-use-cua-driver-mcp/README.zh.md) | 通过 MCP 连接已安装的 `cua-driver` 可执行文件 |
| [Cua Driver 原生](../../packages/experimental/computer-use-cua-driver-native/README.zh.md) | 随 npm 依赖安装的平台原生运行时 |
| [Mac 应用对象](../../packages/experimental/cua-macos/README.zh.md) | macOS 14 及以上的可选 Swift helper，带共享[权限页](../../packages/experimental/cua/README.zh.md) |

各提供方提供上游工具目录。共享服务只注册名称，并拒绝任何第二个提供方，包括使用相同名称的另一个实例。服务不包含通用桌面操作方法或模型控制的选择器。

Harnessy 的可选 [Computer Use 组合包](../../packages/experimental/cua-bundle/README.zh.md)默认关闭。其 `cua` 工具要求存活的 Agent 和独立的应用授权。`ctx.cuaAccess` 负责系统权限查询与应用决策，使用 `CuaApplicationState`、`CuaApplicationId`、`CuaSystemPermission` 和 `CuaSystemPermissionState`。截图尺寸沿用所选模型适配器的策略。每个 PTC 程序重新导入 bridge 并选择应用；此 Harnessy 运行时不在调用之间保留变量。原生 Mac 编译、权限归属与桌面输入仍需在 Mac 上验证。

## 生命周期和桌面共享

提供方在关闭工具和自有资源期间保留注册。启动失败会释放此次尝试的注册。MCP 提供方在重连期间保留注册。

一个已注册的提供方不会为某个 Session 预留桌面。调用方负责协调跨 Session 和独立 DSH 进程的完整观察、操作和验证流程。取消调用无法撤销桌面已收到的输入。

## 结果和平台要求

工具使用常规执行流程和 Session 日志。支持图像的模型路由在挂载附件存储时接收持久化截图；不支持图像的路由接收现有 MCP 图像诊断。提供方 README 负责说明安装、权限和平台限制。

[决策记录](../../.agents/notes/implemented/architecture/2026-09-12-computer-use-provider-registration.zh.md)解释只负责注册的服务和两个 Cua Driver 集成。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcomputeruse--computeruseregistry"></a>

### `ctx.computerUse` — `ComputerUseRegistry`

Owns one optional provider registration in the shared computer-use service.

```ts cordis-catalog
/**
 * Reserve the sole provider slot until the contribution is disposed.
 * A second registration fails even when it repeats the current name. Providers
 * must stop their tools and await owned work before releasing this registration.
 * @param name - provider-owned name used in registration diagnostics.
 * @returns the effect disposer for this exact registration.
 */
register(name: ComputerUseProviderName): () => Promise<void>
```

Source: [`packages/computer-use/computer-use/src/index.ts`](../../packages/computer-use/computer-use/src/index.ts)

<a id="ctxcuaaccess--cuaaccess"></a>

### `ctx.cuaAccess` — `CuaAccess`

Browser controls for provider-owned native permission and application decisions.

```ts cordis-catalog
/** Read the persistent-PTC configuration supported by this Harnessy integration.
 * @returns Unavailable controls; the current runtime interface exposes no persistence setting.
 */
@Remote ptcConfiguration(): { persistent: boolean; writable: boolean }

/** Refuse an unsupported PTC setting before changing the profile.
 * @returns A rejection explaining the runtime limitation.
 */
@Remote enablePersistentPtc(): Promise<void>

/**
 * Read application decisions without waiting for the native helper.
 * @returns Saved grants and refused applications with their persistence owner.
 */
@Remote applications(): CuaApplicationState

/**
 * Inspect system privileges independently of application decisions and icons.
 * @returns Fresh native preflight and launch metadata.
 */
@Remote async systemStatus(): Promise<CuaSystemPermissionState>

/**
 * Load presentation icons separately from application decisions.
 * @returns Optional native PNG icons keyed by executable path for saved and blocked applications.
 */
@Remote async applicationIcons(): Promise<Record<string, string>>

/**
 * Request a system privilege explicitly selected by the user.
 * @param permission macOS privilege to request.
 * @returns Preflight state after requesting; a false value never implies consent.
 */
@Remote async requestPermission(permission: CuaSystemPermission): Promise<CuaSystemPermissionState>

/**
 * Open the macOS privacy pane selected by the user.
 * @param permission Corresponding system privilege.
 * @returns Completion after macOS accepted the open request.
 */
@Remote async openSettings(permission: CuaSystemPermission): Promise<void>

/**
 * Remove saved and session access and join affected operations.
 * @param id Application identity displayed on the permission page.
 * @returns Completion after persistence and cancellation; dispatched input cannot be undone.
 */
@Remote revoke(id: CuaApplicationId): Promise<void>

/**
 * Clear this application's refusals across sessions so each session may ask for access again.
 * @param id Refused or revoked application displayed on the permission page.
 * @returns Completion after clearing refusals; no permission is granted and no action is replayed.
 */
@Remote async retryApproval(id: CuaApplicationId): Promise<void>
```

Source: [`packages/experimental/cua/src/access.ts`](../../packages/experimental/cua/src/access.ts)
<!-- END GENERATED cordis-surface -->
