# Agent Note: Custom Harness fork CI

Status: implemented

[English](2026-09-09-custom-harness-fork-ci.md) | 中文

## Problem

继承的默认分支工作流依赖 DeepSeek 自有的 API 密钥、自托管运行器和多平台发布维护。在个人 Windows fork 中自动运行这些任务，会产生无法反映受支持 Custom Harness 构建状态的失败和长期排队检查。

## Decision

[Harnessy Windows](../../../../.github/workflows/custom-harness-windows.yml) 对 `master` 推送和拉取请求自动运行，也支持手动触发。其专用托管 Windows x64 检查不需要产品凭据，保留通常的 Harnessy 构建（包括完整 Host 与 Client 类型检查），以及产品、已保存设置、浏览器账户、恢复和打包策略检查。手动运行或头部提交包含 `[build-installer]` 的 `master` 推送，还会构建未签名的 Windows x64 安装程序、执行已打包运行时验证，并将生成的文件上传为工作流产物。打包失败时，检查批注会显示最新的脱敏打包日志，并将完整日志与安装程序日志一起保存在诊断产物中。成功生成的安装程序产物与上游签名发布路径保持区分，也不会上传到更新源。

继承的 pull-request、master、sandbox 和真实 API 工作流保留源定义及现有手动触发器，用于上游同步诊断。只有仓库变量 `CUSTOM_HARNESS_RUN_UPSTREAM_CI` 等于 `true` 时，其自动任务才会运行；启用该变量还需要对应的密钥、运行器容量和多平台维护意图。继承的 pull-request aggregate 与其 worker 使用相同的明确启用条件，这些可选检查未启用时也会跳过该 aggregate。

## Alternatives considered

**删除继承的工作流。** 这样会简化 Actions 列表，但也会删除有用的参考自动化，使上游同步更加困难。

**配置全部上游基础设施。** 这样可以保留所有上游信号，但需要个人 Windows 产品并不需要的私有 API 凭据、专用运行器以及 macOS/Linux 维护。

**忽略红色检查。** 持续存在的无关失败会让人难以区分最新受支持版本与真正的桌面回归。

## Consequences

默认 GitHub 状态反映专用 Windows 桌面产品检查，并且不需要密钥；它不声称覆盖全量测试或完整的继承平台矩阵。维护者无需准备本地 Visual Studio 工具链，即可通过手动工作流运行获得经过验证的未签名安装程序。此 fork 不会自动检查上游多平台或真实服务回归；诊断上游合并时，维护者必须明确启用并配置这些工作流。按[产物构建政策](2026-10-05-pr-artifact-typechecks.zh.md)，受支持的普通构建负责两个完整 aggregate 检查，无需重复执行单独的 Host 编译。
