import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { repoCheckoutDir, splitRepoCredentials, type PineryConfig, type RepoConfig } from "@pinery/core";

const run = promisify(execFile);

/**
 * 共享 checkout 管理(PRD §3.3):L0 共享只读 checkout,定时 pull。
 * 生产环境建议由 sidecar(deploy/docker)持有读写挂载执行 sync,
 * 应用容器对 repo 目录只读挂载。
 */

/**
 * 凭据经 `-c http.extraHeader` 传入,**不进 URL**。
 *
 * `git clone https://<token>@host/...` 会把完整地址记进 checkout 内的
 * `.git/config`(以及 `.git/FETCH_HEAD`),而那是 L0 读得到的文件——
 * 一句 `cat .git/config` 就能把 token 交给模型。header 只存在于进程参数里。
 */
function gitAuthArgs(repo: RepoConfig): { args: string[]; url: string } {
  const { url, headers } = splitRepoCredentials(repo.url);
  const args = headers?.["Authorization"]
    ? ["-c", `http.extraHeader=Authorization: ${headers["Authorization"]}`]
    : [];
  return { args, url };
}

export async function ensureCheckout(cfg: PineryConfig, repo: RepoConfig): Promise<string> {
  const dir = repoCheckoutDir(cfg, repo);
  if (existsSync(dir)) return dir;
  mkdirSync(dirname(dir), { recursive: true });
  const { args, url } = gitAuthArgs(repo);
  await run("git", [...args, "clone", "--single-branch", url, dir], { timeout: 10 * 60_000 });
  return dir;
}

export async function pullCheckout(cfg: PineryConfig, repo: RepoConfig): Promise<{ ok: boolean; detail: string }> {
  const dir = repoCheckoutDir(cfg, repo);
  if (!existsSync(dir)) return { ok: false, detail: "checkout 不存在" };
  try {
    const { args } = gitAuthArgs(repo);
    const { stdout } = await run("git", ["-C", dir, ...args, "pull", "--ff-only"], { timeout: 5 * 60_000 });
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

/**
 * 进程内 pull 循环(pull_interval_min=0 时关闭)。
 *
 * `gate` 由 LocalWorkspaceProvider 提供:pull 会原地改写共享 checkout,
 * 若与调查并发,一次跨越刷新周期的调查会读到分属不同 commit 的文件,
 * 而卡片上的 HEAD 只显示 pull 之后的版本——矛盾的证据会被归因到代码本身。
 * 没有空窗就跳过本轮(周期性刷新错过一轮没有代价,拖住调查却有)。
 */
export function startPullLoop(
  cfg: PineryConfig,
  onLog: (line: string) => void,
  gate?: <T>(repoName: string, fn: () => Promise<T>) => Promise<T | undefined>,
): { stop: () => void } {
  const interval = cfg.workspace.pull_interval_min;
  if (interval <= 0) return { stop: () => {} };
  const runOne = async (repo: RepoConfig) => {
    const exec = () => pullCheckout(cfg, repo);
    const r = gate ? await gate(repo.name, exec) : await exec();
    if (r === undefined) {
      onLog(`[repo-sync] ${repo.name} 有调查正在读取 checkout,跳过本轮刷新`);
      return;
    }
    if (!r.ok) onLog(`[repo-sync] ${repo.name} pull 失败:${r.detail}`);
  };
  const timer = setInterval(
    () => {
      for (const repo of cfg.repos) void runOne(repo).catch(() => {});
    },
    interval * 60_000,
  );
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
