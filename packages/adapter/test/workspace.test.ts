import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, type ProvidedWorkspace, type WorkspaceProvider } from "@pinery/core";
import { describe, expect, it } from "vitest";
import { createWorkspaceProvider } from "../src/workspace/factory.js";
import { LocalWorkspaceProvider } from "../src/workspace/local.js";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pinery-wsp-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@pinery.dev");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "# t");
  git("add", "-A");
  git("commit", "-qm", "init");
  return dir;
}

function makeConfig(repoDir: string, root: string, provider = "local") {
  return parseConfig(
    `
lark: { app_id: x, app_secret: y }
repos:
  - name: demo
    url: "${repoDir}"
    path: "${repoDir}"
workspace:
  root: "${root}"
  provider: ${provider}
`,
    {} as NodeJS.ProcessEnv,
  );
}

describe("LocalWorkspaceProvider", () => {
  it("session workspace is the shared checkout, read-only, no branch", async () => {
    const repoDir = makeRepo();
    const cfg = makeConfig(repoDir, mkdtempSync(join(tmpdir(), "pinery-wsp-root-")));
    const p = new LocalWorkspaceProvider(cfg);
    const ws = await p.acquireSession(cfg.repos[0]!, "p2p:oc_1");
    expect(ws.dir).toBe(repoDir);
    expect(ws.readOnly).toBe(true);
    expect(ws.branch).toBeUndefined();
    expect(ws.operations).toBeUndefined(); // 本地:工具直接操作文件系统
    // 会话工作区常驻:release 不删共享 checkout
    await p.release(ws);
    expect(existsSync(join(repoDir, "README.md"))).toBe(true);
  });

  it("task workspace is an isolated worktree on pinery/ branch, removed on release", async () => {
    const repoDir = makeRepo();
    const cfg = makeConfig(repoDir, mkdtempSync(join(tmpdir(), "pinery-wsp-root-")));
    const p = new LocalWorkspaceProvider(cfg);

    const ws = await p.acquireTask(cfg.repos[0]!, "task1");
    expect(ws.dir).not.toBe(repoDir);
    expect(ws.readOnly).toBe(false);
    expect(ws.branch).toBe("pinery/task-task1");
    expect(existsSync(join(ws.dir, "README.md"))).toBe(true);

    await p.release(ws);
    expect(existsSync(ws.dir)).toBe(false);
    // 分支保留(可能已 push),仅工作目录回收
    const branches = execFileSync("git", ["branch", "--list", "pinery/*"], { cwd: repoDir }).toString();
    expect(branches).toContain("pinery/task-task1");
  });

  it("keep option preserves a failed task workspace for debugging", async () => {
    const repoDir = makeRepo();
    const cfg = makeConfig(repoDir, mkdtempSync(join(tmpdir(), "pinery-wsp-root-")));
    const p = new LocalWorkspaceProvider(cfg);
    const ws = await p.acquireTask(cfg.repos[0]!, "keepme");
    await p.release(ws, { keep: true });
    expect(existsSync(ws.dir)).toBe(true);
  });

  it("concurrent tasks get separate worktrees", async () => {
    const repoDir = makeRepo();
    const cfg = makeConfig(repoDir, mkdtempSync(join(tmpdir(), "pinery-wsp-root-")));
    const p = new LocalWorkspaceProvider(cfg);
    const a = await p.acquireTask(cfg.repos[0]!, "a");
    const b = await p.acquireTask(cfg.repos[0]!, "b");
    expect(a.dir).not.toBe(b.dir);
    writeFileSync(join(a.dir, "only-a.txt"), "x");
    expect(existsSync(join(b.dir, "only-a.txt"))).toBe(false);
    await p.release(a);
    await p.release(b);
  });
});

describe("createWorkspaceProvider", () => {
  it("defaults to local", async () => {
    const repoDir = makeRepo();
    const cfg = makeConfig(repoDir, mkdtempSync(join(tmpdir(), "pinery-wsp-root-")));
    expect((await createWorkspaceProvider(cfg)).kind).toBe("local");
  });

  it("rejects a module that does not export createWorkspaceProvider", async () => {
    const repoDir = makeRepo();
    const cfg = makeConfig(repoDir, mkdtempSync(join(tmpdir(), "pinery-wsp-root-")), "node:path");
    await expect(createWorkspaceProvider(cfg)).rejects.toThrow(/createWorkspaceProvider/);
  });
});

describe("WorkspaceProvider 契约(云沙箱后端可替换)", () => {
  it("a remote provider can supply operations for tool delegation", async () => {
    // 模拟 CF Computer 类后端:目录是远程的,文件操作经 operations 委托
    const remote: WorkspaceProvider = {
      kind: "fake-remote",
      acquireSession: (repo, key) =>
        Promise.resolve({
          handle: `remote:${key}`,
          repo: repo.name,
          dir: "/workspace",
          readOnly: true,
          operations: { read: { readFile: () => Promise.resolve(Buffer.from("remote")) } },
        } satisfies ProvidedWorkspace),
      acquireTask: (repo, id) =>
        Promise.resolve({ handle: `remote:${id}`, repo: repo.name, dir: "/workspace", readOnly: false }),
      release: () => Promise.resolve(),
    };
    const repoDir = makeRepo();
    const cfg = makeConfig(repoDir, mkdtempSync(join(tmpdir(), "pinery-wsp-root-")));
    const ws = await remote.acquireSession(cfg.repos[0]!, "k");
    expect(ws.operations?.read).toBeDefined();
    expect(ws.dir).toBe("/workspace");
  });
});
