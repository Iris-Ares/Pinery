import { describe, expect, it } from "vitest";
import { sourceObjectKey } from "./cloudflare/src/source-upload.js";

describe("sourceObjectKey", () => {
  it("accepts an encoded snapshot object key", () => {
    expect(sourceObjectKey("/v1/source/example%2Fabc123%2Fsrc%2Fmain.ts")).toBe(
      "example/abc123/src/main.ts",
    );
  });

  it("rejects traversal and ambiguous separators", () => {
    expect(sourceObjectKey("/v1/source/example%2F..%2Fsecret")).toBeUndefined();
    expect(sourceObjectKey("/v1/source/example%2Fabc%5Csecret")).toBeUndefined();
    expect(sourceObjectKey("/v1/source/example//README.md")).toBeUndefined();
  });

  it("rejects malformed or missing keys", () => {
    expect(sourceObjectKey("/v1/source/%E0%A4%A")).toBeUndefined();
    expect(sourceObjectKey("/v1/source/")).toBeUndefined();
    expect(sourceObjectKey("/health")).toBeUndefined();
  });
});
