import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface TaskWorktree {
  dir: string;
  branch: string;
}

/**
 * L1+ 任务工作区(PRD §3.3):每任务一个 git worktree + 独立分支
 * `pinery/task-<id>`,任务结束即删,失败保留供排查。
 */
export class TaskWorkspaceManager {
  constructor(
    /** 共享 checkout(worktree 的宿主仓库) */
    private readonly repoDir: string,
    /** worktree 存放根目录 */
    private readonly worktreesRoot: string,
  ) {}

  taskBranch(taskId: string): string {
    return `pinery/task-${taskId}`;
  }

  taskDir(taskId: string): string {
    return join(this.worktreesRoot, taskId);
  }

  async create(taskId: string): Promise<TaskWorktree> {
    const dir = this.taskDir(taskId);
    const branch = this.taskBranch(taskId);
    mkdirSync(this.worktreesRoot, { recursive: true });
    await run("git", ["worktree", "add", "-b", branch, dir, "HEAD"], { cwd: this.repoDir });
    return { dir, branch };
  }

  /**
   * 移除任务 worktree。
   * @param deleteBranch 一并删除本地分支(丢弃任务时);已 push 的分支在远端仍在
   */
  async remove(taskId: string, opts: { deleteBranch?: boolean } = {}): Promise<void> {
    const dir = this.taskDir(taskId);
    const branch = this.taskBranch(taskId);
    if (existsSync(dir)) {
      try {
        await run("git", ["worktree", "remove", "--force", dir], { cwd: this.repoDir });
      } catch {
        // worktree 元数据损坏时兜底清理
        rmSync(dir, { recursive: true, force: true });
        await run("git", ["worktree", "prune"], { cwd: this.repoDir }).catch(() => {});
      }
    }
    if (opts.deleteBranch) {
      await run("git", ["branch", "-D", branch], { cwd: this.repoDir }).catch(() => {});
    }
  }

  async list(): Promise<string[]> {
    const { stdout } = await run("git", ["worktree", "list", "--porcelain"], { cwd: this.repoDir });
    return stdout
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length));
  }
}
