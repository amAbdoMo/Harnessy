# Agent Note: Custom Harness 根目录 README 仅保留英文

Status: implemented

[English](2026-09-09-custom-harness-english-root-readme.md) | 中文

## 问题

Custom Harness 使用仓库根目录 README 作为简洁的个人落地页。维护第二份根目录译文会重复产品说明，而所有者只希望以英文提供这个落地页。继承的技术文档仍保持双语，并且仍可能需要引用根目录中的安装和源码运行说明。

## 决策

根目录 `README.md` 在 `scripts/translation-pairing.manifest.json` 中列为显式排除项。它不再有 `README.zh.md`、根目录配对 sidecar 或语言切换行。以前链接到根目录中文文件的中文技术指南，改为链接英文根目录 README 中的对应锚点。其他所有活跃文档仍遵循双语配对政策。

## 考虑过的替代方案

**保留中文根目录 README。** 按所有者的要求否决。

**删除所有中文技术文档。** 否决，因为所要求的变更针对仓库落地页。删除继承的技术译文会成为范围大得多且无关的变更。

## 后果

GitHub 落地页仅提供英文。中文技术页面可能会把读者引导到根目录中的英文安装和构建说明，而这些技术页面自身的配对内容仍会受到维护和校验。
