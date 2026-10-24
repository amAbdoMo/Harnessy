# Agent Note: Session 列表摘要不传输完整轮次详情

Status: implemented

[English](2026-10-18-session-list-summary-projections.md) | 中文

## 问题

Session 列表响应为每一行携带完整 turn outline、统计、todo 和共享图片上限。outline 随每个 Session 增长，但列表导航并不渲染它。Harnessy 通知中心会消费其中最新的已记录结果，因此直接移除 outline 而不提供替代数据，会导致完成、停止和失败通知缺失。

## 决策

投影所属包使用 `SessionProjectionSummaryExcluded<T>` 标记详情值，并要求对应注册声明 `wire.summary: false`。注册表派生一个稳定的摘要 key 集合，直到注册项变化。实时和冷列表读取在生成 wire 值之前选择这些 key；完整 Session 读取保留所有视图。客户端视图类型移除标记，摘要类型则省略带标记的 key。标记不会进入持久化或 wire JSON。

排除的 key 为 `turnOutline`、`sessionStats`、`todos` 和 `imageLimits`。turn-outline 插件同时提供大小固定的 `turnOutcome` 投影：最新已开始的轮次编号及其可选终止结果。后续轮次会清除旧结果。Harnessy 既有通知观察器消费此字段，并保留静默启动基线、仅根会话结果、待处理用户操作优先级和重复抑制。列表和通知 UI 不变。

[缓存身份与客户端合并规则](2026-09-19-projection-cache-listing-identity-and-cached-rows.zh.md) 仍为权威。checkpoint 和完整读取保留全部投影。摘要选择不改变 Session 格式或缓存状态版本；缺失的新缓存条目通过既有完整读取路径物化。

## 考虑过的替代方案

**不检查自定义消费方就移除 outline。** 否决：通知观察器通过 unknown 值辅助函数读取它；直接属性搜索会遗漏此依赖。客户端类型检查在交付前暴露了通知测试数据的依赖。

**继续为通知传输完整 outline。** 否决：观察器只需要最新轮次和结果，每个列表行无需继续承担随会话历史增长的工作量。

**构建完整视图后再筛选字段。** 否决：这仍保留每行解析和视图生成成本。带 key 的读取已经可以在这些工作之前完成选择。

**在控制器硬编码排除 key 或增加第二套摘要读取 API。** 否决：所属注册项只提供一次选择，既有读取 API 直接接收派生集合。

## 后果

列表负载不再随被排除的 outline 增长，通知仍以已记录生命周期为数据源。每份摘要新增一个很小的最新轮次值。注册和最终注销必须使摘要集合失效；带标记的可空类型将 null 放在标记之外。完整快照继续服务聊天导航、详情和其他消费方。

## 测试

投影、缓存、Session Controller 和通知测试覆盖摘要选择、冷读取、完整 follow 快照、可空值、注册表注销、终止结果、重新连接替换和静默启动。真实 turn-outline Loader 组合验证完成摘要以及下一轮开始时清除结果。组装后的分页历史浏览器场景检查完整统计和 outline 仍可获取，同时列表响应省略详情 key 并保留终止结果。

手动[列表诊断](../../../../packages/api/session-controller/tests/session-list.perf.ts) 使用固定合成语料元数据，测量构建后 Host 的已附加 Session 热列表准备与 JSON 序列化。三次预热后输出七组原始时间和字节数样本。在 Host 构建完成后从仓库根目录运行；仅转译诊断包装器，然后使用普通 Node 执行：

```sh
node --input-type=module -e "import ts from 'typescript'; import fs from 'node:fs'; fs.mkdirSync('.artifacts', {recursive:true}); fs.writeFileSync('.artifacts/session-list.perf.mjs', ts.transpileModule(fs.readFileSync('packages/api/session-controller/tests/session-list.perf.ts', 'utf8'), {compilerOptions:{target:ts.ScriptTarget.ES2024,module:ts.ModuleKind.ESNext}}).outputText)"
node --expose-gc .artifacts/session-list.perf.mjs 100 300
node --expose-gc .artifacts/session-list.perf.mjs 100 300 --full-projections
```

最后一个命令是恢复完整投影选择的负对照。这是没有时间预算的本地诊断。它排除 Session 创建、语料查询、冷持久化、模型及网络延迟、浏览器绘制和保留内存结论；不代表 CI 或完整产品延迟。

2026-10-24 的本地 Windows 测量使用 Node 24.14.0，每个新进程先预热三次，再采集七个样本。基线为 摘要选择前的已附加 Session 列表实现，其准确版本记录在[上游评审账本](../../../../scripts/harnessy-upstream-review.json)中；候选实现还保留了新的紧凑通知结果。计时包括已附加 Session 列表读取和 JSON 序列化，完成时返回行和序列化输出都可用。

| 合成工作负载 | 基线中位数 / 字节数 | 摘要中位数 / 字节数 |
|---|---|---|
| 20 个 Session × 30 个已关闭轮次 | 3.536 ms / 49,232 | 1.690 ms / 6,492 |
| 100 个 Session × 300 个已关闭轮次 | 37.830 ms / 2,154,393 | 7.940 ms / 32,693 |

大负载原始毫秒样本为基线 `[43.988, 39.106, 36.757, 38.556, 34.287, 37.830, 33.823]`、摘要 `[6.795, 8.000, 7.949, 7.107, 7.037, 8.558, 7.939]`，以及完整选择负对照 `[34.597, 51.852, 35.874, 37.060, 33.532, 36.731, 38.519]`。对照恢复至 2,159,293 字节和 36.731 ms 中位数。仓库内使用固定 Session ID 的诊断独立测得 7.934 ms / 33,691 字节，而其对照为 40.012 ms / 2,160,291 字节。未使用私有语料或时间预算。
