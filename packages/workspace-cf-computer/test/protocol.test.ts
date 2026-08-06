import { describe, expect, it } from "vitest";
import { WORKSPACE_ROOT, normalizeWorkspacePath } from "../src/protocol.js";

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
