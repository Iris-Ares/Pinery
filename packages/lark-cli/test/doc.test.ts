import { describe, expect, it } from "vitest";
import { parseDocRef } from "../src/doc.js";

describe("parseDocRef", () => {
  it("parses docx urls", () => {
    expect(parseDocRef("https://acme.feishu.cn/docx/AbCd1234EfGh5678")).toEqual({
      kind: "docx",
      token: "AbCd1234EfGh5678",
    });
  });

  it("parses wiki urls with query", () => {
    expect(parseDocRef("https://acme.feishu.cn/wiki/WikiToken123456?from=chat")).toEqual({
      kind: "wiki",
      token: "WikiToken123456",
    });
  });

  it("accepts bare tokens as docx", () => {
    expect(parseDocRef("AbCd1234EfGh5678")).toEqual({ kind: "docx", token: "AbCd1234EfGh5678" });
  });

  it("rejects garbage", () => {
    expect(() => parseDocRef("not a link")).toThrow(/无法识别/);
  });
});
