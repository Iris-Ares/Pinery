import { readdirSync, statSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { filterSecrets, loadConfig, repoCheckoutDir, runnerModelConfig } from "@pinery/core";
import { installSkills, readSkill } from "@pinery/skills";
import { createRunner } from "../runner-factory.js";
import { ensureCheckout } from "../repo-sync.js";

/**
 * pinery bootstrap(PRD §8-Q4 冷启动自动化):
 * agent 自扫 repo 生成 glossary 草稿,工程师只 review 修正。
 * --offline 时退化为目录结构骨架(无 LLM)。
 */
export async function runBootstrap(opts: {
  config: string;
  repo?: string;
  offline?: boolean;
}): Promise<number> {
  const cfg = loadConfig(opts.config);
  const repo = opts.repo ? cfg.repos.find((r) => r.name === opts.repo) : cfg.repos[0];
  if (!repo) {
    console.error(`找不到 repo:${opts.repo ?? "(未配置)"}`);
    return 1;
  }

  console.log(`[bootstrap] 准备仓库 ${repo.name} …`);
  const dir = await ensureCheckout(cfg, repo);

  const installed = installSkills(dir);
  if (installed.length > 0) {
    console.log(`[bootstrap] 已安装默认 skills 到 .pinery/:${installed.join(", ")}`);
  }

  const glossaryPath = join(dir, ".pinery", "glossary.md");
  if (existsSync(glossaryPath)) {
    console.log(`[bootstrap] ${glossaryPath} 已存在,跳过生成(删除后可重新生成)。`);
    return 0;
  }

  let markdown: string;
  if (opts.offline) {
    markdown = offlineGlossarySkeleton(dir);
    console.log("[bootstrap] 离线模式:按目录结构生成骨架。");
  } else {
    console.log("[bootstrap] agent 扫描仓库中(首次约 1-3 分钟)…");
    const runner = await createRunner(cfg);
    const result = await runner.run(
      {
        id: randomUUID(),
        kind: "bootstrap",
        prompt: readSkill("bootstrap-glossary", dir),
      },
      { repo: repo.name, dir, readOnly: true },
      {
        level: 0,
        maxTurns: Math.max(40, cfg.limits.session_max_turns),
        timeoutMs: cfg.limits.task_timeout_min * 60_000,
        model: runnerModelConfig(cfg),
        onEvent: (e) => {
          if (e.type === "tool_start") console.log(`  · ${e.tool} ${e.detail}`);
        },
      },
    );
    if (!result.ok && !result.answer) {
      console.error(`[bootstrap] 生成失败:${result.error ?? result.aborted ?? "未知错误"}`);
      console.error("可改用 --offline 先生成骨架。");
      return 1;
    }
    markdown = filterSecrets(result.answer).text;
  }

  mkdirSync(join(dir, ".pinery"), { recursive: true });
  writeFileSync(glossaryPath, markdown, "utf8");
  console.log(`[bootstrap] 已写入 ${glossaryPath}`);
  console.log("下一步:请工程师 review 修正术语表(这是答案质量的地基),然后提交:");
  console.log(`  cd ${dir} && git add .pinery && git commit -m 'chore: add pinery glossary'`);
  return 0;
}

/** 离线骨架:一级目录 + README 首段 */
function offlineGlossarySkeleton(repoDir: string): string {
  const template = readSkill("glossary-template", repoDir);
  const dirs = readdirSync(repoDir)
    .filter((name) => !name.startsWith(".") && name !== "node_modules")
    .filter((name) => {
      try {
        return statSync(join(repoDir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();

  let readmeIntro = "";
  for (const cand of ["README.md", "readme.md", "README.zh.md"]) {
    const p = join(repoDir, cand);
    if (existsSync(p)) {
      readmeIntro = readFileSync(p, "utf8").split("\n\n").slice(0, 2).join("\n\n").slice(0, 500);
      break;
    }
  }

  const moduleRows = dirs.map((d) => `| \`${d}/\` | (待确认) |`).join("\n");
  return [
    template.split("## 模块地图")[0]?.trimEnd() ?? "",
    "",
    "## 模块地图",
    "",
    "| 目录 | 职责 |",
    "|---|---|",
    moduleRows || "| (空仓库) | |",
    "",
    "## 领域约定",
    "",
    readmeIntro ? `- README 摘要:${readmeIntro.replace(/\n/g, " ").slice(0, 300)}(待确认)` : "- (待补充)",
    "",
    "## 已知坑位",
    "",
    "- (待补充)",
    "",
  ].join("\n");
}
