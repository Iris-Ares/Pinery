import type { PineryConfig, WorkspaceProvider } from "@pinery/core";
import { LocalWorkspaceProvider } from "./local.js";

/**
 * WorkspaceProvider 装配。`workspace.provider`:
 * - "local"(默认):共享 checkout + git worktree
 * - 其他:动态加载模块,需导出 createWorkspaceProvider(cfg)
 *   (CF 云路径 `@pinery/workspace-cf-computer` 按此接入,S2)
 */
export async function createWorkspaceProvider(cfg: PineryConfig): Promise<WorkspaceProvider> {
  const kind = cfg.workspace.provider;
  if (kind === "local") return new LocalWorkspaceProvider(cfg);

  const mod = (await import(kind)) as {
    createWorkspaceProvider?: (cfg: PineryConfig) => WorkspaceProvider | Promise<WorkspaceProvider>;
  };
  if (typeof mod.createWorkspaceProvider !== "function") {
    throw new Error(`workspace provider 模块 ${kind} 未导出 createWorkspaceProvider(cfg)`);
  }
  return mod.createWorkspaceProvider(cfg);
}
