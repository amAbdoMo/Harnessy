# 原生伴侣

[English](companion.md) | 中文

可选的 [Companion Host](../../packages/host/companion-host/README.zh.md) 提供 Desktop 原生配对控制，以及经过认证的手机 Session 读取与文本提交。管理调用由 Desktop main 使用，不属于渲染器或 Typert Remote API。配对链接包含一次性密钥，不得进入渲染器状态、遥测或模型上下文。

[Host 集成参考](../../packages/host/companion-host/INTEGRATION.md) 负责原生控制、授权、凭据存储与清理要求。[共享协议参考](../../packages/util/companion-protocol/README.zh.md) 负责线编码与密码学；[中继参考](../../packages/host/companion-relay/README.zh.md) 负责传输路由与准入限制。源代码和无需密钥的测试不能证明实体 Android 互操作性或原生 Windows 安全验收已完成。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcompanionhost--companionhost"></a>

### `ctx.companionHost` — `CompanionHost`

No Typert Remote decorations: this API is callable only by trusted same-process native controls.

```ts cordis-catalog
/**
 * Report public management metadata without the one-time invitation secret or private signing key.
 * @returns Fresh native-management status; the renderer receives only availability, connection and count.
 */
describe(): CompanionStatus

/**
 * Create one ephemeral invitation; only Desktop main may receive its fragment secret for clipboard use.
 * @returns A one-time harnessy://pair link; no existing PC launch token or durable identity secret.
 */
createInvitation(): Promise<PrivateInvitation>

/**
 * Abort candidate authority immediately, then remove any grant committed by its in-flight approval.
 * @returns Provider commit and teardown; failures disable this Host incarnation.
 */
cancelInvitation(): Promise<void>

/**
 * Enroll exactly the candidate whose locally displayed fingerprint the operator confirmed.
 * @param candidateId - Current main-owned candidate, not a phone or relay-selected grant id.
 * @param confirmFingerprint - Exact SHA-256 hex shown by describe().
 * @returns Committed public device; failed welcome delivery does not undo enrollment or imply a safe retry.
 */
approveCandidate(candidateId: CandidateId, confirmFingerprint: string): Promise<PairedDevice>

/**
 * Withdraw the channel authorization capability synchronously, then remove the durable current row.
 * @param grantId - PC-issued current record identifier.
 * @returns Completion after provider commit and affected application teardown; any failure disables this Host incarnation.
 */
revokeGrant(grantId: GrantId): Promise<void>

/**
 * Withdraw current channels immediately and commit explicit per-phone chat management consent without re-pairing.
 * @param command - Native-confirmed grant id, generation, fingerprint and permission;
 *   all three identifiers are rechecked under the update lock.
 * @returns Provider commit and channel teardown; any failure disables this Host until explicit recovery.
 */
setSessionManagement(command: Extract<CompanionControlCommand, { readonly kind: 'setSessionManagement' }>): Promise<void>
```

Source: [`packages/host/companion-host/src/index.ts`](../../packages/host/companion-host/src/index.ts)
<!-- END GENERATED cordis-surface -->
