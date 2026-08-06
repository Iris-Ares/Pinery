#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig } from "@pinery/core";
import { loadDotEnv } from "../env.js";
import { pullCheckout, ensureCheckout } from "../repo-sync.js";
import { VERSION } from "../version.js";
import { runBootstrap } from "./bootstrap.js";
import { runDoctor } from "./doctor.js";
import { runGoldenExport, runGoldenList, runGoldenMark } from "./golden.js";
import { runInit } from "./init.js";
import { runStart } from "./start.js";

/** pinery CLI 入口(PRD 命名注:CLI 入口 `pinery`) */

loadDotEnv([".env"]);

const program = new Command();
program
  .name("pinery")
  .description("Pinery — Your engineering teammate in Lark. 飞书里的工程同事。")
  .version(VERSION)
  .option("-c, --config <path>", "配置文件路径", process.env["PINERY_CONFIG"] ?? "pinery.yaml");

const cfgPath = (): string => program.opts<{ config: string }>().config;

program
  .command("init")
  .description("交互式生成 pinery.yaml,并打印飞书后台配置清单")
  .option("--force", "覆盖已存在的配置文件")
  .action(async (opts: { force?: boolean }) => {
    await runInit({ config: cfgPath(), force: opts.force });
  });

program
  .command("doctor")
  .description("部署自检:配置/环境/依赖逐项校验")
  .option("--online", "额外校验飞书凭据(需要网络)")
  .action(async (opts: { online?: boolean }) => {
    process.exitCode = await runDoctor({ config: cfgPath(), online: opts.online });
  });

program
  .command("bootstrap")
  .description("agent 自扫仓库生成 glossary 草稿 + 安装默认 skills(冷启动)")
  .option("--repo <name>", "仓库名(缺省第一个)")
  .option("--offline", "不调用模型,仅按目录结构生成骨架")
  .action(async (opts: { repo?: string; offline?: boolean }) => {
    process.exitCode = await runBootstrap({ config: cfgPath(), repo: opts.repo, offline: opts.offline });
  });

program
  .command("start")
  .description("启动长连接常驻服务")
  .action(async () => {
    await runStart({ config: cfgPath() });
  });

const repo = program.command("repo").description("仓库 checkout 管理");
repo
  .command("sync")
  .description("克隆缺失的仓库并 pull 更新(可作为 sidecar 周期任务)")
  .option("--watch <minutes>", "循环模式:每 N 分钟 pull 一次")
  .action(async (opts: { watch?: string }) => {
    const cfg = loadConfig(cfgPath());
    const syncOnce = async () => {
      for (const r of cfg.repos) {
        await ensureCheckout(cfg, r);
        const res = await pullCheckout(cfg, r);
        console.log(`[repo-sync] ${r.name}: ${res.ok ? res.detail || "ok" : `失败 ${res.detail}`}`);
      }
    };
    await syncOnce();
    const watch = opts.watch ? Number(opts.watch) : 0;
    if (watch > 0) {
      console.log(`[repo-sync] 循环模式:每 ${watch} 分钟`);
      setInterval(() => void syncOnce(), watch * 60_000);
    }
  });

const golden = program.command("golden").description("golden set 标注与导出(评估地基)");
golden
  .command("list")
  .description("最近问答记录(★ = 已标注 golden)")
  .option("--golden", "只看已标注")
  .option("-n, --limit <n>", "条数", "20")
  .action((opts: { golden?: boolean; limit: string }) => {
    runGoldenList({ config: cfgPath(), goldenOnly: opts.golden, limit: Number(opts.limit) });
  });
golden
  .command("mark <id>")
  .description("把某条问答标注为 golden(答案正确可作为评估基准)")
  .option("-n, --note <note>", "备注(如修正说明)")
  .action((id: string, opts: { note?: string }) => {
    process.exitCode = runGoldenMark({ config: cfgPath(), id: Number(id), note: opts.note });
  });
golden
  .command("export")
  .description("导出 JSONL(默认仅 golden;--all 导出全部)")
  .option("--all", "导出全部问答")
  .option("-o, --out <file>", "输出文件(缺省 stdout)")
  .action((opts: { all?: boolean; out?: string }) => {
    runGoldenExport({ config: cfgPath(), out: opts.out, all: opts.all });
  });

program.parseAsync().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
