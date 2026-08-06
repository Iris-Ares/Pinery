import { describe, expect, it } from "vitest";
import { WORKSPACE_ROOT, normalizeWorkspacePath, redactRepoUrl } from "../src/protocol.js";

/**
 * 回归(PR review 四轮 P1 + 五轮 P2):私有仓库的推荐写法是
 * https://<token>@host/...。该 URL 曾被原样写进 checkout 内的仓库标记
 * (L0 的 read 工具能读到);修复后又必须保证协议两侧用**同一个**脱敏函数,
 * 否则含凭据的地址与脱敏后的标记永不相等,私有仓库会永远停在初次克隆。
 */
describe("redactRepoUrl", () => {
  it("strips credentials from clone urls", () => {
    expect(redactRepoUrl("https://ghp_secrettoken@github.com/org/repo.git")).toBe(
      "https://github.com/org/repo.git",
    );
    expect(redactRepoUrl("https://user:pass@gitlab.com/org/repo.git")).toBe("https://gitlab.com/org/repo.git");
    expect(redactRepoUrl("http://tok@host/x.git")).toBe("http://host/x.git");
  });

  it("leaves credential-free urls untouched", () => {
    expect(redactRepoUrl("https://github.com/org/repo.git")).toBe("https://github.com/org/repo.git");
  });

  it("does not strip an @ that appears in the path", () => {
    expect(redactRepoUrl("https://host/org/@scope/repo.git")).toBe("https://host/org/@scope/repo.git");
  });

  it("is idempotent, so both sides of the protocol compare equal", () => {
    const once = redactRepoUrl("https://tok@host/x.git");
    expect(redactRepoUrl(once)).toBe(once);
  });
});

describe("marker location", () => {
  it("keeps the repo marker unreachable from the workspace fence", () => {
    // 标记存在工作区之外,agent 的读工具必须够不到
    expect(normalizeWorkspacePath("/.pinery-state/repo.json")).toBeUndefined();
  });
});

describe("normalizeWorkspacePath", () => {
  it("normalizes absolute paths inside the workspace", () => {
    expect(normalizeWorkspacePath("/workspace/src/a.ts")).toBe("/workspace/src/a.ts");
    expect(normalizeWorkspacePath("/workspace")).toBe("/workspace");
    expect(normalizeWorkspacePath("/workspace/./src//a.ts")).toBe("/workspace/src/a.ts");
    expect(normalizeWorkspacePath("/workspace/src/../src/a.ts")).toBe("/workspace/src/a.ts");
  });

  it("resolves relative paths against the workspace root", () => {
    expect(normalizeWorkspacePath("src/a.ts")).toBe("/workspace/src/a.ts");
    expect(normalizeWorkspacePath("./src/a.ts")).toBe("/workspace/src/a.ts");
  });

  it("rejects escapes out of the workspace root", () => {
    expect(normalizeWorkspacePath("/etc/passwd")).toBeUndefined();
    expect(normalizeWorkspacePath("/workspace/../etc/passwd")).toBeUndefined();
    expect(normalizeWorkspacePath("../../etc/passwd")).toBeUndefined();
    expect(normalizeWorkspacePath("/")).toBeUndefined();
    expect(normalizeWorkspacePath("")).toBeUndefined();
  });

  it("rejects sibling-prefix confusion", () => {
    // /workspace-evil 不得因前缀匹配通过
    expect(normalizeWorkspacePath("/workspace-evil/x")).toBeUndefined();
  });

  it("honors a custom root", () => {
    expect(normalizeWorkspacePath("/srv/repo/a.ts", "/srv/repo")).toBe("/srv/repo/a.ts");
    expect(normalizeWorkspacePath("/srv/other/a.ts", "/srv/repo")).toBeUndefined();
  });

  it("exports the expected root constant", () => {
    expect(WORKSPACE_ROOT).toBe("/workspace");
  });
});
