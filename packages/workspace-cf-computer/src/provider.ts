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
  /**
   * 会话工作区的刷新间隔(ms)。超过该时长的工作区在下次提问前执行 git pull,
   * 对应本地路径的 workspace.pull_interval_min。默认 10 分钟。
   */
  refreshIntervalMs?: number;
}

export class CfComputerWorkspaceProvider implements WorkspaceProvider {
  readonly kind = "cf-computer";
  private readonly client: CfComputerClient;
  /** workspaceId → 本进程内上次同步(clone/pull)时间戳 */
  private readonly syncedAt = new Map<string, number>();

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
    this.syncedAt.delete(ws.handle);
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

  /**
   * 准备仓库内容。会话工作区的 VFS 是持久的(DO 休眠即封存),因此除了
   * 首次 clone,还必须**按同步策略刷新**——否则长期存在的话题会一直基于
   * 初始浅克隆回答,仓库更新后答案静默过时(远程后端下本地 pull loop 也不跑)。
   */
  private async ensureRepo(repo: RepoConfig, workspaceId: string): Promise<void> {
    // Computer 用 isomorphic-git,无 SSH 传输 —— 尽早给出可操作的错误,
    // 而不是等 clone 在远端失败(私有仓库用 https + token)
    if (!/^https:\/\//i.test(repo.url)) {
      throw new Error(
        `CF Computer 后端只支持 HTTPS 仓库地址(repo ${repo.name} 当前为 ${repo.url});` +
          `请改用 https:// 形式,私有仓库用 https://<token>@host/org/repo.git`,
      );
    }

    const refreshMs = this.options.refreshIntervalMs ?? 10 * 60_000;
    const lastSync = this.syncedAt.get(workspaceId);
    if (lastSync !== undefined && Date.now() - lastSync < refreshMs) return; // 冷却期内不重复同步

    const info = await this.client.call(workspaceId, { op: "info" });
    if (info.repo?.url !== repo.url) {
      await this.client.call(
        workspaceId,
        { op: "gitClone", url: repo.url, depth: this.options.cloneDepth ?? 1 },
        { timeoutMs: 10 * 60_000 },
      );
      this.syncedAt.set(workspaceId, Date.now());
      return;
    }

    // 远端已有该仓库:按 syncedAt 判断是否需要 pull(跨进程重启也生效)
    const remoteAge = info.syncedAt ? Date.now() - info.syncedAt : Number.POSITIVE_INFINITY;
    if (remoteAge < refreshMs) {
      this.syncedAt.set(workspaceId, info.syncedAt as number);
      return;
    }
    // pull 失败不应阻断提问:退化为「用现有快照回答」,由审计与日志暴露
    await this.client.call(workspaceId, { op: "gitPull" }, { timeoutMs: 5 * 60_000 }).catch(() => undefined);
    this.syncedAt.set(workspaceId, Date.now());
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
    // 远程后端不跑本地 pull loop,刷新节奏沿用同一个配置项
    refreshIntervalMs: cfg.workspace.pull_interval_min > 0 ? cfg.workspace.pull_interval_min * 60_000 : undefined,
  });
}
