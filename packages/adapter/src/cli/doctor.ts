import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ConfigError,
  defaultApiKeyEnv,
  loadConfig,
  repoCheckoutDir,
  resolvePaths,
  type PineryConfig,
} from "@pinery/core";
import { LarkService } from "../lark/service.js";
import { Storage } from "../storage.js";

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
  fatal?: boolean;
}

/**
 * pinery doctor:部署自检(「30 分钟跑通」的守门员,PRD §8-Q10)。
 * --online 时额外校验飞书凭据(拉 bot 信息)。
 */
export async function runDoctor(opts: { config: string; online?: boolean }): Promise<number> {
  const results: CheckResult[] = [];
  const push = (r: CheckResult) => {
    results.push(r);
    console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  };

  // 运行时版本(Bun >= 1.2 或 Node >= 22.13)
  if (process.versions.bun) {
    const [bMajor, bMinor] = process.versions.bun.split(".").map(Number);
    const bunOk = (bMajor ?? 0) > 1 || ((bMajor ?? 0) === 1 && (bMinor ?? 0) >= 2);
    push({ name: "Bun >= 1.2", ok: bunOk, detail: `bun ${process.versions.bun}`, fatal: true });
  } else {
    const [major, minor] = process.versions.node.split(".").map(Number);
    const nodeOk = (major ?? 0) > 22 || ((major ?? 0) === 22 && (minor ?? 0) >= 13);
    push({ name: "Node.js >= 22.13", ok: nodeOk, detail: `node ${process.versions.node}`, fatal: true });
  }

  // git
  let gitOk = false;
  let gitVer = "";
  try {
    gitVer = execFileSync("git", ["--version"]).toString().trim();
    gitOk = true;
  } catch {
    /* not found */
  }
  push({ name: "git 可用", ok: gitOk, detail: gitVer, fatal: true });

  // 配置
  let cfg: PineryConfig | undefined;
  try {
    cfg = loadConfig(opts.config);
    push({ name: `配置解析 ${opts.config}`, ok: true, detail: `${cfg.repos.length} 个 repo` });
  } catch (e) {
    push({
      name: `配置解析 ${opts.config}`,
      ok: false,
      detail: e instanceof ConfigError ? e.message : String(e),
      fatal: true,
    });
  }

  if (cfg) {
    // 模型 key
    const keyEnv = cfg.model.api_key_env ?? defaultApiKeyEnv(cfg.model.provider);
    push({
      name: `模型 API key(${keyEnv})`,
      ok: !!process.env[keyEnv],
      detail: process.env[keyEnv]
        ? cfg.model.base_url
          ? `已设置(经 ${cfg.model.base_url} 改道)`
          : "已设置"
        : cfg.model.base_url
          ? "未设置(自定义网关若经 headers/BYOK 鉴权可忽略本项)"
          : "未设置 — L0 问答无法运行",
    });

    // workspace 可写
    const paths = resolvePaths(cfg);
    try {
      mkdirSync(paths.root, { recursive: true });
      const probe = join(paths.root, ".pinery-doctor-probe");
      writeFileSync(probe, "ok");
      rmSync(probe);
      push({ name: `workspace 可写 ${paths.root}`, ok: true });
    } catch (e) {
      push({ name: `workspace 可写 ${paths.root}`, ok: false, detail: String(e), fatal: true });
    }

    // SQLite
    try {
      const s = new Storage(paths.storageDb);
      s.close();
      push({ name: `SQLite ${paths.storageDb}`, ok: true });
    } catch (e) {
      push({ name: `SQLite ${paths.storageDb}`, ok: false, detail: String(e), fatal: true });
    }

    // repo checkout(仅 local provider 需要本地克隆;远程工作区由后端准备)
    const localWorkspace = cfg.workspace.provider === "local";
    if (!localWorkspace) {
      push({
        name: "工作区后端",
        ok: true,
        detail: `${cfg.workspace.provider}(远程:跳过本地 checkout 检查)`,
      });
    }
    for (const repo of cfg.repos) {
      if (localWorkspace) {
        const dir = repoCheckoutDir(cfg, repo);
        const exists = existsSync(join(dir, ".git"));
        push({
          name: `repo ${repo.name} checkout`,
          ok: exists,
          detail: exists ? dir : `${dir} 不存在 — 运行 pinery repo sync 克隆`,
        });
      } else if (!/^https:\/\//i.test(repo.url)) {
        // 云工作区多用 isomorphic-git,无 SSH 传输
        push({
          name: `repo ${repo.name} 地址`,
          ok: false,
          detail: `远程工作区通常只支持 HTTPS 仓库地址(当前 ${repo.url})`,
        });
      }
      if (repo.chats.length === 0) {
        push({ name: `repo ${repo.name} 授权群`, ok: false, detail: "chats 为空:群聊不可用(单聊仍可用)" });
      }
    }

    // 飞书凭据(在线)
    if (opts.online) {
      const lark = new LarkService(cfg.lark);
      const bot = await lark.fetchBotIdentity();
      push({
        name: "飞书凭据(bot 信息)",
        ok: !!bot.name,
        detail: bot.name ? `${bot.name}(${bot.openId ?? "?"})` : "获取失败:检查 app_id/app_secret 与网络",
      });
    } else {
      console.log("- 跳过在线检查(加 --online 校验飞书凭据)");
    }
  }

  const fatal = results.filter((r) => !r.ok && r.fatal);
  const soft = results.filter((r) => !r.ok && !r.fatal);
  console.log("");
  if (fatal.length > 0) {
    console.log(`✗ ${fatal.length} 项硬性检查未通过,无法启动。`);
    return 1;
  }
  if (soft.length > 0) {
    console.log(`△ 可启动,但有 ${soft.length} 项提醒需要处理。`);
    return 0;
  }
  console.log("✓ 全部通过,可以 pinery start。");
  return 0;
}
