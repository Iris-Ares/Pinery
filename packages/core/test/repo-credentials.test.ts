import { describe, expect, it } from "vitest";
import { redactRepoUrl, splitRepoCredentials } from "../src/repo-credentials.js";

/**
 * 回归(PR review 六轮 P1):凭据不能出现在 clone 的 URL 里——git 会把它记进
 * checkout 内的 .git/config(以及 .git/FETCH_HEAD),而那是 L0 读得到的文件。
 */
describe("splitRepoCredentials", () => {
  it("moves a token into an Authorization header", () => {
    const r = splitRepoCredentials("https://ghp_secret@github.com/org/repo.git");
    expect(r.url).toBe("https://github.com/org/repo.git");
    // GitHub PAT 写法:token 当用户名,密码留空
    expect(r.headers?.["Authorization"]).toBe(`Basic ${btoa("ghp_secret:")}`);
    expect(JSON.stringify(r.url)).not.toContain("ghp_secret");
  });

  it("handles user:password form", () => {
    const r = splitRepoCredentials("https://alice:s3cr3t@gitlab.com/org/repo.git");
    expect(r.url).toBe("https://gitlab.com/org/repo.git");
    expect(r.headers?.["Authorization"]).toBe(`Basic ${btoa("alice:s3cr3t")}`);
  });

  it("decodes percent-encoded credentials", () => {
    const r = splitRepoCredentials("https://user:p%40ss@host/x.git");
    expect(r.headers?.["Authorization"]).toBe(`Basic ${btoa("user:p@ss")}`);
  });

  it("returns no headers for a credential-free url", () => {
    const r = splitRepoCredentials("https://github.com/org/repo.git");
    expect(r.url).toBe("https://github.com/org/repo.git");
    expect(r.headers).toBeUndefined();
  });

  it("does not treat an @ in the path as credentials", () => {
    const r = splitRepoCredentials("https://host/org/@scope/repo.git");
    expect(r.url).toBe("https://host/org/@scope/repo.git");
    expect(r.headers).toBeUndefined();
  });

  it("agrees with redactRepoUrl on the sanitized address", () => {
    for (const u of [
      "https://tok@host/x.git",
      "https://a:b@host/x.git",
      "https://host/x.git",
      "https://host/org/@scope/x.git",
    ]) {
      expect(splitRepoCredentials(u).url).toBe(redactRepoUrl(u));
    }
  });
});
