import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TaskWorkspaceManager } from "../src/workspace.js";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pinery-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@pinery.dev");
  git("config", "user.name", "pinery-test");
  writeFileSync(join(dir, "README.md"), "# test");
  git("add", "-A");
  git("commit", "-qm", "init");
  return dir;
}

describe("TaskWorkspaceManager", () => {
  it("creates and removes task worktrees with pinery/ branch prefix", async () => {
    const repo = makeRepo();
    const root = mkdtempSync(join(tmpdir(), "pinery-wt-"));
    const mgr = new TaskWorkspaceManager(repo, root);

    const wt = await mgr.create("abc123");
    expect(wt.branch).toBe("pinery/task-abc123");
    expect(existsSync(join(wt.dir, "README.md"))).toBe(true);

    const branches = execFileSync("git", ["branch", "--list", "pinery/*"], { cwd: repo }).toString();
    expect(branches).toContain("pinery/task-abc123");

    await mgr.remove("abc123", { deleteBranch: true });
    expect(existsSync(wt.dir)).toBe(false);
    const after = execFileSync("git", ["branch", "--list", "pinery/*"], { cwd: repo }).toString();
    expect(after).not.toContain("pinery/task-abc123");
  });

  it("keeps branch when not asked to delete", async () => {
    const repo = makeRepo();
    const root = mkdtempSync(join(tmpdir(), "pinery-wt-"));
    const mgr = new TaskWorkspaceManager(repo, root);
    await mgr.create("keepme");
    await mgr.remove("keepme");
    const branches = execFileSync("git", ["branch", "--list", "pinery/*"], { cwd: repo }).toString();
    expect(branches).toContain("pinery/task-keepme");
  });
});
