import {
  repoCheckoutDir,
  resolvePaths,
  type PineryConfig,
  type ProvidedWorkspace,
  type RepoConfig,
  type WorkspaceProvider,
} from "@pinery/core";
import { TaskWorkspaceManager } from "@pinery/runner-pi";

/**
 * 本地工作区 provider(主路径,PRD §3.3):
 * - 会话(L0):共享 checkout,只读语义(工具集只读 + 容器 :ro 挂载双保险)
 * - 任务(L1+):每任务 git worktree + `pinery/task-<id>` 分支,结束即删,失败保留
 *
 * 网络与文件系统的硬边界由部署层承担(deploy/docker:internal 网络 + egress
 * 白名单代理 + cap_drop/只读挂载),见 docs/sandbox-evaluation.md §4。
 */
export class LocalWorkspaceProvider implements WorkspaceProvider {
  readonly kind = "local";
  private readonly managers = new Map<string, TaskWorkspaceManager>();

  constructor(private readonly cfg: PineryConfig) {}

  acquireSession(repo: RepoConfig, sessionKey: string): Promise<ProvidedWorkspace> {
    return Promise.resolve({
      handle: `session:${sessionKey}`,
      repo: repo.name,
      dir: repoCheckoutDir(this.cfg, repo),
      readOnly: true,
    });
  }

  async acquireTask(repo: RepoConfig, taskId: string): Promise<ProvidedWorkspace> {
    const mgr = this.managerFor(repo);
    const wt = await mgr.create(taskId);
    return {
      handle: `task:${repo.name}:${taskId}`,
      repo: repo.name,
      dir: wt.dir,
      readOnly: false,
      branch: wt.branch,
    };
  }

  async release(ws: ProvidedWorkspace, opts: { keep?: boolean } = {}): Promise<void> {
    const [kind, repoName, taskId] = ws.handle.split(":");
    if (kind !== "task" || !repoName || !taskId) return; // 会话工作区常驻,无需释放
    if (opts.keep) return; // 失败保留现场供排查
    const repo = this.cfg.repos.find((r) => r.name === repoName);
    if (!repo) return;
    await this.managerFor(repo).remove(taskId, { deleteBranch: false });
  }

  private managerFor(repo: RepoConfig): TaskWorkspaceManager {
    let mgr = this.managers.get(repo.name);
    if (!mgr) {
      const paths = resolvePaths(this.cfg);
      mgr = new TaskWorkspaceManager(repoCheckoutDir(this.cfg, repo), `${paths.worktreesDir}/${repo.name}`);
      this.managers.set(repo.name, mgr);
    }
    return mgr;
  }
}
