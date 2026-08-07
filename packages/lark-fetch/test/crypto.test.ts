import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computeLarkSignature,
  decryptEventBody,
  safeEqualStr,
  verifyLarkSignature,
} from "../src/crypto.js";

/** 飞书侧加密的参考实现(文档口径):AES-256-CBC,key=sha256(encrypt_key),IV 前置 */
function encryptLikeLark(encryptKey: string, plaintext: string): string {
  const key = createHash("sha256").update(encryptKey, "utf8").digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, ct]).toString("base64");
}

describe("decryptEventBody", () => {
  it("round-trips payloads encrypted the way Lark does", async () => {
    const key = "kudryavka-encrypt-key";
    for (const msg of [
      "hello world",
      "中文事件正文,含标点。",
      JSON.stringify({ schema: "2.0", header: { event_id: "e-1" }, event: { text: "问题" } }),
      "x".repeat(15), // padding 边界:15 字节 → 1 字节 padding
      "y".repeat(16), // 整块:16 字节 → 追加整块 padding
    ]) {
      expect(await decryptEventBody(key, encryptLikeLark(key, msg))).toBe(msg);
    }
  });

  it("rejects truncated ciphertext", async () => {
    await expect(decryptEventBody("k", Buffer.from("short").toString("base64"))).rejects.toThrow();
  });

  it("fails on wrong key", async () => {
    const b64 = encryptLikeLark("right-key", '{"a":1}');
    await expect(decryptEventBody("wrong-key", b64)).rejects.toThrow();
  });
});

describe("signature", () => {
  it("matches the documented sha256(timestamp+nonce+key+body) construction", async () => {
    const [ts, nonce, key, body] = ["1786000000", "n-42", "enc-key", '{"encrypt":"abc"}'];
    const expected = createHash("sha256").update(ts + nonce + key + body, "utf8").digest("hex");
    expect(await computeLarkSignature(key, ts, nonce, body)).toBe(expected);
    expect(await verifyLarkSignature(key, ts, nonce, body, expected)).toBe(true);
    expect(await verifyLarkSignature(key, ts, nonce, body, expected.toUpperCase())).toBe(true);
  });

  it("rejects tampered body or headers", async () => {
    const sig = await computeLarkSignature("k", "t", "n", "body");
    expect(await verifyLarkSignature("k", "t", "n", "body-tampered", sig)).toBe(false);
    expect(await verifyLarkSignature("k", "t2", "n", "body", sig)).toBe(false);
  });
});

describe("safeEqualStr", () => {
  it("compares equal and unequal strings", () => {
    expect(safeEqualStr("abc", "abc")).toBe(true);
    expect(safeEqualStr("abc", "abd")).toBe(false);
    expect(safeEqualStr("abc", "ab")).toBe(false);
  });
});
