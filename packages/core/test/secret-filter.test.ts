import { describe, expect, it } from "vitest";
import { filterSecrets } from "../src/secret-filter.js";

describe("filterSecrets", () => {
  it("redacts AWS access keys", () => {
    const r = filterSecrets("key is AKIAIOSFODNN7EXAMPLE ok");
    expect(r.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(r.text).toContain("[已脱敏:aws-access-key]");
    expect(r.redacted).toBe(true);
  });

  it("redacts GitHub tokens", () => {
    const token = "ghp_" + "a1B2".repeat(9); // 36 chars
    const r = filterSecrets(`token: ${token}`);
    expect(r.text).not.toContain(token);
  });

  it("redacts private key blocks including body", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----";
    const r = filterSecrets(`看这里\n${pem}\n结束`);
    expect(r.text).not.toContain("MIIEowIBAAKCAQEA");
    expect(r.text).toContain("[已脱敏:private-key]");
  });

  it("redacts unterminated private key blocks", () => {
    const r = filterSecrets("-----BEGIN PRIVATE KEY-----\nMIIabcdef\n(截断)");
    expect(r.text).not.toContain("MIIabcdef");
  });

  it("redacts openrouter/anthropic/openai style keys", () => {
    const r = filterSecrets("用 sk-or-v1-0123456789abcdef0123456789abcdef 调用");
    expect(r.text).not.toContain("sk-or-v1-0123456789abcdef");
  });

  it("redacts JWTs", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const r = filterSecrets(`token=${jwt}`);
    expect(r.text).not.toContain(jwt.slice(0, 40));
  });

  it("redacts generic assignments but keeps the key name", () => {
    const r = filterSecrets('app_secret: "AbCdEfGh12345678XyZ"');
    expect(r.text).toContain("app_secret");
    expect(r.text).not.toContain("AbCdEfGh12345678XyZ");
  });

  it("leaves normal code untouched", () => {
    const code = "const timeout = 30_000; // 订单超时阈值\nfunction refund(orderId: string) {}";
    const r = filterSecrets(code);
    expect(r.text).toBe(code);
    expect(r.redacted).toBe(false);
  });

  it("reports findings per rule", () => {
    const r = filterSecrets("AKIAIOSFODNN7EXAMPLE and AKIAIOSFODNN7EXAMPLE");
    const aws = r.findings.find((f) => f.rule === "aws-access-key");
    expect(aws?.count).toBe(2);
  });
});
