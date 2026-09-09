# Agent Note: Custom Harness fork CI

Status: implemented

[English](2026-09-09-custom-harness-fork-ci.md) | 中文

## Problem

继承的默认分支工作流依赖 DeepSeek 自有的 API 密钥、自托管运行器和多平台发布维护。在个人 Windows fork 中自动运行这些任务，会产生无法反映受支持 Custom Harness 构建状态的失败和长期排队检查。

## Decision

[Custom Harness Windows](../../../../.github/workflows/custom-harness-windows.yml) 是此 fork 针对推送和拉取请求自动运行的工作流。它在托管的 Windows x64 运行器上无凭据运行，检查桌面宿主的类型，并执行区分个人未签名安装程序与上游签名发布路径的专用打包策略测试。

继承的 master、sandbox 和真实 API 工作流保留手动触发器及源定义，用于上游同步诊断。只有仓库变量 `CUSTOM_HARNESS_RUN_UPSTREAM_CI` 等于 `true` 时，其自动任务才会运行；启用该变量还需要对应的密钥、运行器容量和多平台维护意图。

## Alternatives considered

**删除继承的工作流。** 这样会简化 Actions 列表，但也会删除有用的参考自动化，使上游同步更加困难。

**配置全部上游基础设施。** 这样可以保留所有上游信号，但需要个人 Windows 产品并不需要的私有 API 凭据、专用运行器以及 macOS/Linux 维护。

**忽略红色检查。** 持续存在的无关失败会让人难以区分最新受支持版本与真正的桌面回归。

## Consequences

默认 GitHub 状态能够反映 Windows 桌面产品，并且不需要密钥。此 fork 不会自动检查上游多平台或真实服务回归；诊断上游合并时，维护者必须明确启用并配置这些工作流。
