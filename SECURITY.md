# 安全策略 · Security Policy

Pinery 是一个会在你的内网里读取代码、(在更高级别下)执行命令的 agent,我们非常严肃地对待安全问题。

## 报告漏洞 · Reporting a vulnerability

**请勿通过公开 issue 报告安全漏洞。**
Please **do not** report security vulnerabilities through public GitHub issues.

请使用 GitHub 私密漏洞报告:
👉 **[github.com/Iris-Ares/Pinery/security/advisories/new](https://github.com/Iris-Ares/Pinery/security/advisories/new)**

报告时请尽量包含:受影响的组件与版本(commit)、复现步骤或 PoC、影响评估。我们的目标是 **7 天内首次响应**;确认后会在修复发布前与你协调披露时间。

## 范围 · Scope

- 部署前请阅读 **[威胁模型与已知限制](docs/threat-model.md)** —— 其中已列出的已知限制不构成新漏洞,但绕过其中声明的防线(如 L0 工具白名单逃逸、secret 出站过滤绕过、路径围栏逃逸、鉴权绕过)属于我们最关注的高价值报告。
- L1+ 写能力的安全前提是容器边界:**在容器外开启写能力**属于文档明确警告的不支持用法。
- 依赖上游(pi SDK、飞书 SDK 等)的漏洞请同时报给上游;若 Pinery 的用法放大了其影响,也请告知我们。

## 支持版本 · Supported versions

| 版本 | 支持 |
|---|---|
| `main`(0.x) | ✅ |

1.0 前只修复 `main` 分支;发布版本化后本表会更新。
