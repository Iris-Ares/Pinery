import type { RepoConfig } from "./config.js";
import type { RunnerWorkspace } from "./runner.js";

/**
 * WorkspaceProvider 窄接口(沙箱后端可替换,AgentRunner 哲学的第二次应用)。
 *
 * 见 docs/sandbox-evaluation.md:
 * - 主路径 `local`:共享只读 checkout(L0)+ git worktree(L1+),自建 Docker 加固;
 * - 云路径 `cf-computer`(计划,S2):Durable Object VFS + worker-shell / container 后端。
 *
 * 远程后端通过 `operations` 把文件与命令执行委托出去(pi 的七个内置工具均支持
 * Operations 注入),runner 无需为每个后端重写。
 */

/** pi 工具可注入的操作实现集合;字段为 unknown,由 runner 侧收窄到具体 harness 类型 */
export interface ToolOperationsBundle {
  read?: unknown;
  write?: unknown;
  edit?: unknown;
  grep?: unknown;
  find?: unknown;
  ls?: unknown;
  bash?: unknown;
}

export interface ProvidedWorkspace extends RunnerWorkspace {
  /** provider 内部句柄(release 时回传;本地实现用 taskId,远程实现可放会话/容器 id) */
  handle: string;
  /** 远程后端的工具委托;缺省表示直接操作本地文件系统 */
  operations?: ToolOperationsBundle;
}

export interface WorkspaceProvider {
  readonly kind: string;
  /** 会话工作区(L0 只读调查):可复用,长期存在 */
  acquireSession(repo: RepoConfig, sessionKey: string): Promise<ProvidedWorkspace>;
  /** 任务工作区(L1+ 写):隔离,用完即毁 */
  acquireTask(repo: RepoConfig, taskId: string): Promise<ProvidedWorkspace>;
  /**
   * 释放工作区。
   * @param opts.keep 保留现场(任务失败时供排查,PRD §3.3)
   */
  release(ws: ProvidedWorkspace, opts?: { keep?: boolean }): Promise<void>;
}
