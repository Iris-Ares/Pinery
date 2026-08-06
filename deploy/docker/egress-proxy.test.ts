import { describe, expect, it } from "vitest";
import { hostAllowed, parseTarget } from "./egress-proxy.js";

const ALLOW = ["open.feishu.cn", ".github.com", "*.npmjs.org", "openrouter.ai"];

describe("hostAllowed", () => {
  it("matches exact hosts", () => {
    expect(hostAllowed("open.feishu.cn", ALLOW)).toBe(true);
    expect(hostAllowed("openrouter.ai", ALLOW)).toBe(true);
  });

  it("matches subdomains for .suffix and *.suffix rules, including the bare domain", () => {
    expect(hostAllowed("api.github.com", ALLOW)).toBe(true);
    expect(hostAllowed("codeload.github.com", ALLOW)).toBe(true);
    expect(hostAllowed("github.com", ALLOW)).toBe(true);
    expect(hostAllowed("registry.npmjs.org", ALLOW)).toBe(true);
    expect(hostAllowed("npmjs.org", ALLOW)).toBe(true);
  });

  it("is case-insensitive and tolerates the trailing root dot", () => {
    expect(hostAllowed("OPEN.FEISHU.CN", ALLOW)).toBe(true);
    expect(hostAllowed("open.feishu.cn.", ALLOW)).toBe(true);
  });

  it("denies anything not listed", () => {
    expect(hostAllowed("evil.example", ALLOW)).toBe(false);
    expect(hostAllowed("", ALLOW)).toBe(false);
    expect(hostAllowed("attacker.io", ALLOW)).toBe(false);
  });

  it("denies suffix-confusion bypasses (the classic allowlist hole)", () => {
    // 后缀拼接:evil-github.com / notgithub.com 不得因 endsWith 命中
    expect(hostAllowed("evilgithub.com", ALLOW)).toBe(false);
    expect(hostAllowed("evil-github.com", ALLOW)).toBe(false);
    expect(hostAllowed("notnpmjs.org", ALLOW)).toBe(false);
    // 前缀伪装:把白名单域放在自己域名左边
    expect(hostAllowed("open.feishu.cn.evil.example", ALLOW)).toBe(false);
    expect(hostAllowed("github.com.evil.example", ALLOW)).toBe(false);
  });

  it("empty allowlist denies everything (default-deny)", () => {
    expect(hostAllowed("github.com", [])).toBe(false);
  });
});

describe("parseTarget", () => {
  it("parses host:port and applies the default port", () => {
    expect(parseTarget("github.com:443", 443)).toEqual({ host: "github.com", port: 443 });
    expect(parseTarget("github.com", 443)).toEqual({ host: "github.com", port: 443 });
    expect(parseTarget("registry.npmjs.org:80", 443)).toEqual({ host: "registry.npmjs.org", port: 80 });
  });

  it("parses IPv6 literals", () => {
    expect(parseTarget("[::1]:443", 443)).toEqual({ host: "::1", port: 443 });
  });

  it("rejects malformed targets", () => {
    expect(parseTarget("", 443)).toBeUndefined();
    expect(parseTarget("a:b:c", 443)).toBeUndefined();
    expect(parseTarget("host:0", 443)).toBeUndefined();
    expect(parseTarget("host:99999", 443)).toBeUndefined();
    expect(parseTarget("host:notaport", 443)).toBeUndefined();
  });
});
