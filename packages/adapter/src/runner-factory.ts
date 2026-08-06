import { resolvePaths, type AgentRunner, type PineryConfig } from "@pinery/core";

/**
 * AgentRunner 装配(PRD §8-Q1):pi 是默认实现;runner.kind 指向其他模块时
 * 动态加载(模块需导出 createRunner(cfg) 或默认导出 AgentRunner 类)。
 */
export async function createRunner(cfg: PineryConfig): Promise<AgentRunner> {
  const paths = resolvePaths(cfg);
  if (cfg.runner.kind === "pi") {
    const { PiRunner } = await import("@pinery/runner-pi");
    return new PiRunner({ agentDir: paths.agentDir, sessionsDir: paths.sessionsDir });
  }
  const mod = (await import(cfg.runner.kind)) as {
    createRunner?: (cfg: PineryConfig) => AgentRunner | Promise<AgentRunner>;
  };
  if (typeof mod.createRunner !== "function") {
    throw new Error(`runner 模块 ${cfg.runner.kind} 未导出 createRunner(cfg)`);
  }
  return mod.createRunner(cfg);
}
