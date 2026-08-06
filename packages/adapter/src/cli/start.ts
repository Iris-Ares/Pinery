import { loadConfig, resolvePaths } from "@pinery/core";
import { Orchestrator } from "../orchestrator.js";
import { ensureCheckout, startPullLoop } from "../repo-sync.js";
import { createRunner } from "../runner-factory.js";
import { createWorkspaceProvider } from "../workspace/factory.js";
import type { LocalWorkspaceProvider } from "../workspace/local.js";
import { LarkService } from "../lark/service.js";
import { Storage } from "../storage.js";
import { VERSION } from "../version.js";

/** pinery start:长连接常驻服务(PRD §3.1 全链路) */
export async function runStart(opts: { config: string }): Promise<void> {
  const cfg = loadConfig(opts.config);
  const paths = resolvePaths(cfg);
  const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

  log(
    `🌲 Pinery v${VERSION} 启动(runner=${cfg.runner.kind},workspace=${cfg.workspace.provider},model=${cfg.model.provider}/${cfg.model.id})`,
  );

  const storage = new Storage(paths.storageDb);
  const runner = await createRunner(cfg);
  const workspaces = await createWorkspaceProvider(cfg);

  // 本地 checkout 只对 local provider 有意义:远程后端(CF Computer 等)的工具
  // 全部经 operations 委托到云端工作区,本地克隆既用不上,又会让只有工作区
  // 端点访问权限的 adapter 在启动时失败。
  const usesLocalCheckout = workspaces.kind === "local";
  // pull 经 provider 的空窗门控执行:它会原地改写共享 checkout,
  // 与调查并发会让同一次调查读到分属不同 commit 的文件
  const pullLoop = usesLocalCheckout
    ? startPullLoop(cfg, log, (repoName, fn) =>
        (workspaces as LocalWorkspaceProvider).withIdleCheckout(repoName, fn),
      )
    : { stop: () => {} };
  if (usesLocalCheckout) {
    for (const repo of cfg.repos) {
      log(`[repo] 准备 ${repo.name} …`);
      const dir = await ensureCheckout(cfg, repo);
      log(`[repo] ${repo.name} @ ${dir}`);
    }
  } else {
    log(`[repo] workspace provider = ${workspaces.kind},跳过本地 checkout(仓库由远端工作区准备)`);
  }

  const lark = new LarkService(cfg.lark);
  const bot = await lark.fetchBotIdentity();
  if (bot.name) log(`[lark] 机器人身份:${bot.name}(${bot.openId ?? "?"})`);
  else log("[lark] ⚠️ 未能获取机器人身份:群聊 @ 识别可能失效(检查凭据与权限)");

  const orchestrator = new Orchestrator({ cfg, storage, runner, lark, workspaces, log });

  const shutdown = () => {
    log("收到退出信号,正在关闭 …");
    pullLoop.stop();
    storage.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log("[lark] 建立长连接(免公网回调)…");
  await lark.listen(bot, (msg) => orchestrator.handle(msg));
  log("[lark] 长连接就绪,等待消息。");
}
