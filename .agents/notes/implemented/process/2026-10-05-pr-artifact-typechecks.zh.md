# Agent Note: PR 产物构建与 aggregate TypeScript 检查

Status: implemented

[English](2026-10-05-pr-artifact-typechecks.md) | 中文

## 问题

兼容性、打包和运行时检查需要已编译的 workspace 产物。即使已有独立的完整构建负责检查，在每个产物生成方重复诊断全仓测试和脚本仍会增加工作。单独编译包不能代替 aggregate 诊断，因为根 program 还包含额外的源文件。

## 决定

普通 `build`、`build:custom-harness` 和 `typecheck` 保留完整 Host 与 Client aggregate 检查。受支持的 fork 工作流保留通常的 Harnessy 构建；继承的多平台 CI 仍遵循 [fork CI 明确启用政策](2026-09-09-custom-harness-fork-ci.zh.md)。

显式 `--artifacts-only` 构建检查并编译从各 compiler face 读取的全部现有 reference，然后执行通常的 Typert、打 bundle、Desktop 和 Web 阶段。reference 包括 translator 和 plugin-record 等辅助测试 program；helper 不维护另一份仅含包的列表。Host 编译先于 Host 打 bundle 和 Desktop，随后执行 Client 编译与打 bundle。调用方必须独立保留阻塞失败的完整 Host 与 Client 检查，以覆盖仅属于 aggregate 的测试和脚本。

Python 可执行文件 builder 在验证运行时闭包后接受 `--artifacts-only`，并拒绝与 `--skip-build` 同时使用。默认仍为完整构建。继承的 PR 运行时工作流仅为 CI 调用选择产物编译；release 和普通手动调用保留完整编译。Node 22 兼容性检查先准备产物，再执行基于构建产物的 lazy-search 检查；普通兼容性命令保留完整 typecheck，除非调用方明确在别处负责该检查。

兼容性源码用例共享一次串行 Vitest 调用，保留 fork 隔离及单 worker 环境覆盖。工作流的兼容性用例逐个运行，双目标 Python 运行时矩阵等待无需密钥的 SDK job。精简覆盖率耗时累加互不重叠的 environment、preparation、setup、collection 和 execution 成本；cache key 隔离平台、environment 和运行器池。耗时只影响调度：完整源码清单、合并后的覆盖率阈值及 reporter 失败仍为必需检查。

Release 打包默认按 family 顺序串行执行。显式并行打包使用锁定 pnpm 的有界调度器和精确 member filter；先验证 tarball，再记录发布顺序。Harnessy 的 client-profile 检查及禁止发布标记在两种模式下都保持必需。

## 考虑过的替代方案

**从所有构建中移除 aggregate 检查。** 包 reference 不覆盖全部测试和脚本。因此，产物专用编译需要另一个阻塞失败的完整检查 owner，不能代替普通构建。

**为 benchmark 使用不检查类型的 library 发射。** 本 fork 默认不保证存在已启用的独立完整检查工作流。benchmark 准备保留普通的带检查编译，不让其诊断依赖可选 CI。

**增加 worker 或 job 并发。** 串行兼容性调度和有界打包保留现有资源上限，不增加对共享运行器的需求。

**跨 revision 缓存编译产物。** 文件耗时是辅助调度数据；复用编译产物会增加独立的正确性与失效管理义务。

## 后果

产物专用模式按设计省略根 aggregate 诊断。其 fixture 检查比较完整构建与 reference 构建的 JavaScript、声明、map 和 build-information 输出，在两条路径中都拒绝包及被引用测试的错误，并保留完整 compiler 对仅属于 aggregate 的错误的拒绝。调用方移除独立完整检查后，就会失去该诊断覆盖。

锁定 pnpm 的打包 fixture 验证精确 filter、lifecycle hook、有界重叠、失败、自定义 profile 及 Harnessy 的禁止发布标记。升级 pnpm 时，新版本必须先通过这些真实 CLI 检查，才能负责并行打包。本地 fixture 耗时不能确立托管 CI 延迟或原生平台验证结果。
