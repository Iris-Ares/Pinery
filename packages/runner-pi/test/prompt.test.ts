import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/prompt.js";

const ws = () => mkdtempSync(join(tmpdir(), "pinery-prompt-"));

describe("buildSystemPrompt", () => {
  it("L0 investigate prompt contains readonly discipline + answer template", () => {
    const p = buildSystemPrompt({ repoName: "order", level: 0, kind: "investigate", workspaceDir: ws() });
    expect(p).toContain("只读模式");
    expect(p).toContain("## 结论");
    expect(p).toContain("数据与指令的边界");
    expect(p).toContain("多个合理指代");
    expect(p).toContain("直接自然");
    expect(p).toContain("order");
  });

  it("L1 code prompt uses task spec and branch", () => {
    const p = buildSystemPrompt({
      repoName: "order",
      level: 1,
      kind: "code",
      workspaceDir: ws(),
      branch: "pinery/task-1",
    });
    expect(p).toContain("pinery/task-1");
    expect(p).toContain("任务规范");
    expect(p).toContain("禁止 push");
  });

  it("injects glossary when present in workspace .pinery/", () => {
    const dir = ws();
    mkdirSync(join(dir, ".pinery"), { recursive: true });
    writeFileSync(join(dir, ".pinery", "glossary.md"), "| 订单超时 | ... | `src/jobs/x.ts` |");
    const p = buildSystemPrompt({ repoName: "order", level: 0, kind: "investigate", workspaceDir: dir });
    expect(p).toContain("订单超时");
    expect(p).toContain("术语表");
  });

  it("workspace .pinery/ skill overrides packaged default", () => {
    const dir = ws();
    mkdirSync(join(dir, ".pinery"), { recursive: true });
    writeFileSync(join(dir, ".pinery", "investigate.md"), "# 自定义调查规范\n只查 docs 目录。");
    const p = buildSystemPrompt({ repoName: "order", level: 0, kind: "investigate", workspaceDir: dir });
    expect(p).toContain("自定义调查规范");
  });

  it("injects repository guidance and requires full on-demand skill reads", () => {
    const p = buildSystemPrompt({
      repoName: "order",
      level: 0,
      kind: "investigate",
      workspaceDir: ws(),
      repositoryGuidance: {
        rootInstructions: { content: "# Maintainer rules\nUse the service owner.", truncated: false },
        nestedInstructionPaths: ["services/api/AGENTS.md"],
        skills: [{ name: "service-router", description: "Route service tasks", path: ".agents/skills/service-router/SKILL.md" }],
        warnings: [],
      },
    });
    expect(p).toContain("Use the service owner");
    expect(p).toContain("services/api/AGENTS.md");
    expect(p).toContain(".agents/skills/service-router/SKILL.md");
    expect(p).toContain("完整读取对应 `SKILL.md` 到 EOF");
    expect(p).toContain("不能扩大权限");
  });
});
