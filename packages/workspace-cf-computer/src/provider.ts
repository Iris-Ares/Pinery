import type {
  PineryConfig,
  ProvidedWorkspace,
  RepoConfig,
  WorkspaceProvider,
} from "@pinery/core";
import { CfComputerClient, type CfComputerClientOptions } from "./client.js";
import { createRemoteOperations } from "./operations.js";
import { WORKSPACE_ROOT } from "./protocol.js";

/**
 * Cloudflare Computer 工作区后端(S2 实验路径,docs/sandbox-evaluation.md §4.3)。
 *
 * 会话/任务各对应一个 Durable Object 工作区 id:
 * - 会话(L0):id = `s-<repo>-<sessionKey hash>`,VFS 持久 → DO 休眠即封存,
 *   下次提问自动唤醒,仓库无需重新 clone;
 * - 任务(L1+):id = `t-<repo>-<taskId>`,用完即毁(release 调 rm)。
 *
 * 首次取得工作区时按需 gitClone(浅克隆,应对 Computer 的 ~10GB/FUSE 约束)。
 */
export interface CfComputerProviderOptions extends CfComputerClientOptions {
  /** exec 后端 id:worker-shell(免容器,快)| container(真 Linux) */
  execBackend?: string;
  /** clone 深度(0 = 完整克隆);默认 1 */
  cloneDepth?: number;
  execTimeoutMs?: number;
}

export class CfComputerWorkspaceProvider implements WorkspaceProvider {
  readonly kind = "cf-computer";
  private readonly client: CfComputerClient;
  /** 已初始化(clone 完成)的工作区 id */
  private readonly initialized = new Set<string>();

  constructor(private readonly options: CfComputerProviderOptions) {
    this.client = new CfComputerClient(options);
  }

  acquireSession(repo: RepoConfig, sessionKey: string): Promise<ProvidedWorkspace> {
    return this.acquire(repo, `s-${workspaceSlug(repo.name)}-${hashId(sessionKey)}`, true);
  }

  acquireTask(repo: RepoConfig, taskId: string): Promise<ProvidedWorkspace> {
    return this.acquire(repo, `t-${workspaceSlug(repo.name)}-${workspaceSlug(taskId)}`, false);
  }

  async release(ws: ProvidedWorkspace, opts: { keep?: boolean } = {}): Promise<void> {
    if (!ws.handle.startsWith("t-")) return; // 会话工作区常驻(DO 休眠即封存,不计费)
    if (opts.keep) return; // 失败保留现场供排查
    this.initialized.delete(ws.handle);
    await this.client.call(ws.handle, { op: "rm", path: WORKSPACE_ROOT, recursive: true }).catch(() => {
      // 清理失败不影响主流程;DO 空闲后自行休眠
    });
  }

  private async acquire(repo: RepoConfig, workspaceId: string, readOnly: boolean): Promise<ProvidedWorkspace> {
    await this.ensureRepo(repo, workspaceId);
    return {
      handle: workspaceId,
      repo: repo.name,
      dir: WORKSPACE_ROOT,
      readOnly,
      operations: createRemoteOperations({
        client: this.client,
        workspaceId,
        root: WORKSPACE_ROOT,
        execBackend: this.options.execBackend,
        execTimeoutMs: this.options.execTimeoutMs,
      }),
    };
  }

  /** 幂等:远端已有该仓库则跳过(DO 唤醒后 VFS 仍在) */
  private async ensureRepo(repo: RepoConfig, workspaceId: string): Promise<void> {
    if (this.initialized.has(workspaceId)) return;
    // Computer 用 isomorphic-git,无 SSH 传输 —— 尽早给出可操作的错误,
    // 而不是等 clone 在远端失败(私有仓库用 https + token)
    if (!/^https:\/\//i.test(repo.url)) {
      throw new Error(
        `CF Computer 后端只支持 HTTPS 仓库地址(repo ${repo.name} 当前为 ${repo.url});` +
          `请改用 https:// 形式,私有仓库用 https://<token>@host/org/repo.git`,
      );
    }
    const info = await this.client.call(workspaceId, { op: "info" });
    if (info.repo?.url !== repo.url) {
      await this.client.call(
        workspaceId,
        { op: "gitClone", url: repo.url, depth: this.options.cloneDepth ?? 1 },
        { timeoutMs: 10 * 60_000 },
      );
    }
    this.initialized.add(workspaceId);
  }
}

/** DO id 片段:仅保留安全字符 */
function workspaceSlug(input: string): string {
  return input.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 48);
}

/** session_key 可能含 chat/message id,做短哈希避免超长与字符问题 */
function hashId(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * WorkspaceProvider 工厂(adapter 的 workspace/factory.ts 按此约定加载)。
 * 配置来自 pinery.yaml 的 workspace.options(值支持 ${ENV} 插值)。
 */
export function createWorkspaceProvider(cfg: PineryConfig): WorkspaceProvider {
  const o = cfg.workspace.options;
  const endpoint = o["endpoint"];
  const token = o["token"];
  if (!endpoint) {
    throw new Error("workspace.options.endpoint 缺失(Cloudflare Worker 地址)");
  }
  if (!token) {
    throw new Error("workspace.options.token 缺失(建议写 ${PINERY_CF_TOKEN} 由环境变量提供)");
  }
  return new CfComputerWorkspaceProvider({
    endpoint,
    token,
    execBackend: o["exec_backend"] ?? "worker-shell",
    cloneDepth: o["clone_depth"] ? Number(o["clone_depth"]) : 1,
    execTimeoutMs: o["exec_timeout_ms"] ? Number(o["exec_timeout_ms"]) : undefined,
  });
}
