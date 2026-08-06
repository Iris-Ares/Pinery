# 参与贡献 · Contributing

感谢你愿意为 Pinery 出力!🌲 无论是报 bug、提想法、改文档、补测试,还是实现一个替代 runner / workspace 后端,都非常欢迎。

> English speakers: issues and PRs in English are absolutely welcome — see the [English summary](#english-summary) at the bottom.

## 开始之前

- **Bug**:请用 [Bug 反馈模板](https://github.com/Iris-Ares/Pinery/issues/new?template=bug_report.yml)提 issue,附复现步骤与环境信息。
- **新能力 / 较大改动**:请先开 issue 讨论方向,避免白写。
- **安全漏洞**:请勿开公开 issue,走[私密报告](https://github.com/Iris-Ares/Pinery/security/advisories/new),详见 [SECURITY.md](SECURITY.md)。

## 开发环境

前置:[Bun](https://bun.sh) ≥ 1.2(推荐)或 Node ≥ 22.13。

```bash
bun install
bun run build     # tsc -b 全 workspace
bun run test      # vitest 全量用例
```

仓库结构见 [README](README.md#-仓库结构);各包职责在各自 `package.json` 的 description 中有一句话说明。

## 提交规范

- Commit message 遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/):`feat: ...` / `fix: ...` / `docs: ...` / `refactor: ...` / `test: ...` / `chore: ...`
- 涉及具体包时建议带 scope:`feat(adapter): ...`、`fix(runner-pi): ...`
- 一个 PR 聚焦一件事,保持可 review 的体量。

## PR 流程

1. Fork 并从 `main` 切出分支
2. 开发,**新逻辑请补测试**,确保 `bun run build` 与 `bun run test` 通过
3. 如改动影响使用方式,同步更新 README / docs(中英两份 README 都要)
4. 提 PR 到 `main`,按模板填写变更说明与关联 issue

## 特别欢迎的方向

- **替代 harness**:实现 `runner-claude-code` 等新的 AgentRunner(窄接口见 `@pinery/core`,配置 `runner.kind` 即可切换)
- **工作区后端**:新的 WorkspaceProvider 实现(参考 `@pinery/workspace-cf-computer`)
- **安全加固**:secret 过滤规则、bash 策略、egress 代理的改进
- **文档与示例**:部署踩坑记录、配置示例、飞书配置教程的修订

## English summary

Pinery welcomes contributions in English. Quick version: discuss larger changes in an issue first; use Conventional Commits; make sure `bun run build` and `bun run test` pass; update both READMEs if behavior changes; report security issues privately via [SECURITY.md](SECURITY.md). Alternative AgentRunner harnesses (e.g. `runner-claude-code`) and WorkspaceProvider backends are especially welcome — both are narrow interfaces defined in `@pinery/core`.
