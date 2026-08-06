import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { repoCheckoutDir, type PineryConfig, type RepoConfig } from "@pinery/core";

const run = promisify(execFile);

/**
 * 共享 checkout 管理(PRD §3.3):L0 共享只读 checkout,定时 pull。
 * 生产环境建议由 sidecar(deploy/docker)持有读写挂载执行 sync,
 * 应用容器对 repo 目录只读挂载。
 */

export async function ensureCheckout(cfg: PineryConfig, repo: RepoConfig): Promise<string> {
  const dir = repoCheckoutDir(cfg, repo);
  if (existsSync(dir)) return dir;
  mkdirSync(dirname(dir), { recursive: true });
  await run("git", ["clone", "--single-branch", repo.url, dir], { timeout: 10 * 60_000 });
  return dir;
}

export async function pullCheckout(cfg: PineryConfig, repo: RepoConfig): Promise<{ ok: boolean; detail: string }> {
  const dir = repoCheckoutDir(cfg, repo);
  if (!existsSync(dir)) return { ok: false, detail: "checkout 不存在" };
  try {
    const { stdout } = await run("git", ["-C", dir, "pull", "--ff-only"], { timeout: 5 * 60_000 });
    return { ok: true, detail: stdout.trim().split("\n")[0] ?? "" };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

export async function headInfo(dir: string): Promise<{ short: string; time: string } | undefined> {
  try {
    const { stdout } = await run("git", ["-C", dir, "log", "-1", "--format=%h|%cd", "--date=format:%m-%d %H:%M"]);
    const [short, time] = stdout.trim().split("|");
    if (!short) return undefined;
    return { short, time: time ?? "" };
  } catch {
    return undefined;
  }
}

/** 进程内 pull 循环(pull_interval_min=0 时关闭) */
export function startPullLoop(
  cfg: PineryConfig,
  onLog: (line: string) => void,
): { stop: () => void } {
  const interval = cfg.workspace.pull_interval_min;
  if (interval <= 0) return { stop: () => {} };
  const timer = setInterval(
    () => {
      for (const repo of cfg.repos) {
        void pullCheckout(cfg, repo).then((r) => {
          if (!r.ok) onLog(`[repo-sync] ${repo.name} pull 失败:${r.detail}`);
        });
      }
    },
    interval * 60_000,
  );
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
