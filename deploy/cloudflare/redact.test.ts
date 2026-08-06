import { describe, expect, it } from "vitest";
import { redactRepoUrl } from "./src/repo-marker.js";

/**
 * 回归(PR review 四轮 P1):私有仓库的推荐写法是 https://<token>@host/...,
 * 该 URL 曾被原样写进 checkout 内的仓库标记,而 L0 的 read 工具能读到它。
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
});
