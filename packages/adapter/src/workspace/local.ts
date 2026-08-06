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
  /**
   * repo → 正在读取该共享 checkout 的会话数。
   *
   * L0 会话共用一个 checkout,而 pull 会原地改写它:一次跨越刷新周期的调查
   * 会读到分属不同 commit 的文件,给出的证据互相矛盾,而卡片上的 HEAD 只显示
   * pull 之后的版本——错误会被归因到「代码就是这样」而不是「快照被换掉了」。
   * 所以刷新必须避开正在进行的调查。
   */
  private readonly readers = new Map<string, number>();
  /** repo → 等待读者清零的 resolver(pull 侧挂在这里) */
  private readonly idleWaiters = new Map<string, Array<() => void>>();

  constructor(private readonly cfg: PineryConfig) {}

  acquireSession(repo: RepoConfig, sessionKey: string): Promise<ProvidedWorkspace> {
    this.readers.set(repo.name, (this.readers.get(repo.name) ?? 0) + 1);
    return Promise.resolve({
      handle: `session:${repo.name}:${sessionKey}`,
      repo: repo.name,
      dir: repoCheckoutDir(this.cfg, repo),
      readOnly: true,
    });
  }

  /**
   * 在「没有调查正在读取该 checkout」的窗口里执行 fn。
   *
   * 等待而不是加锁排队:pull 是周期性的,错过一轮没有代价,拖住调查却有。
   * 超过 waitMs 仍无窗口就跳过本轮(下个周期再试)。
   */
  async withIdleCheckout<T>(repoName: string, fn: () => Promise<T>, waitMs = 30_000): Promise<T | undefined> {
    if ((this.readers.get(repoName) ?? 0) > 0) {
      const waited = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          const list = this.idleWaiters.get(repoName);
          if (list) this.idleWaiters.set(repoName, list.filter((w) => w !== onIdle));
          resolve(false);
        }, waitMs);
        const onIdle = () => {
          clearTimeout(timer);
          resolve(true);
        };
        const list = this.idleWaiters.get(repoName) ?? [];
        list.push(onIdle);
        this.idleWaiters.set(repoName, list);
      });
      if (!waited) return undefined; // 仍有调查在读,跳过本轮刷新
    }
    return fn();
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
    if (kind === "session" && repoName) {
      const left = (this.readers.get(repoName) ?? 1) - 1;
      this.readers.set(repoName, Math.max(0, left));
      if (left <= 0) {
        // 最后一个读者离开:唤醒等待刷新窗口的 pull
        const waiters = this.idleWaiters.get(repoName);
        this.idleWaiters.delete(repoName);
        for (const w of waiters ?? []) w();
      }
      return;
    }
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
