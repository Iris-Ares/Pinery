import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertInsideWorkspace,
  buildToolset,
  describeToolCall,
  extractTouchedFile,
  sanitizeEnv,
} from "../src/toolset.js";

const ws = () => mkdtempSync(join(tmpdir(), "pinery-ws-"));

describe("buildToolset", () => {
  it("L0 assembles read-only tools + bash", () => {
    const names = buildToolset({ cwd: ws(), level: 0 }).map((d) => d.name).sort();
    expect(names).toEqual(["bash", "find", "grep", "ls", "read"]);
  });

  it("L1 assembles coding tools + search tools", () => {
    const names = buildToolset({ cwd: ws(), level: 1 }).map((d) => d.name).sort();
    expect(names).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
  });

  it("bash denies policy-violating command before spawn", async () => {
    const blocks: string[] = [];
    const tools = buildToolset({
      cwd: ws(),
      level: 0,
      onPolicyBlock: (i) => blocks.push(i.reason),
    });
    const bash = tools.find((d) => d.name === "bash")!;
    await expect(
      bash.execute("t1", { command: "rm -rf /" }, undefined, undefined, {} as never),
    ).rejects.toThrow(/pinery-policy/);
    expect(blocks.length).toBe(1);
  });

  it("bash executes allowed command with sanitized env", async () => {
    process.env["PINERY_TEST_SECRET_TOKEN"] = "leak-me";
    try {
      const dir = ws();
      const tools = buildToolset({ cwd: dir, level: 1 });
      const bash = tools.find((d) => d.name === "bash")!;
      const result = await bash.execute(
        "t2",
        { command: 'echo "value=[$PINERY_TEST_SECRET_TOKEN]"' },
        undefined,
        undefined,
        {} as never,
      );
      const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
      expect(text).toContain("value=[]");
      expect(text).not.toContain("leak-me");
    } finally {
      delete process.env["PINERY_TEST_SECRET_TOKEN"];
    }
  });

  it("read tool refuses paths outside workspace", async () => {
    const dir = ws();
    writeFileSync(join(dir, "ok.txt"), "hello");
    const tools = buildToolset({ cwd: dir, level: 0 });
    const read = tools.find((d) => d.name === "read")!;
    await expect(
      read.execute("t3", { path: "/etc/hosts" }, undefined, undefined, {} as never),
    ).rejects.toThrow(/工作区外/);
    await expect(
      read.execute("t4", { path: "../../etc/hosts" }, undefined, undefined, {} as never),
    ).rejects.toThrow(/工作区外/);
    const ok = await read.execute("t5", { path: "ok.txt" }, undefined, undefined, {} as never);
    expect(ok.content.map((c) => ("text" in c ? c.text : "")).join("")).toContain("hello");
  });
});

describe("assertInsideWorkspace", () => {
  it("accepts inside and rejects outside", () => {
    expect(() => assertInsideWorkspace("/a/b", "src/x.ts", "read")).not.toThrow();
    expect(() => assertInsideWorkspace("/a/b", "/a/b/c.ts", "read")).not.toThrow();
    expect(() => assertInsideWorkspace("/a/b", "/a/other", "read")).toThrow();
    expect(() => assertInsideWorkspace("/a/b", "../../etc", "read")).toThrow();
  });
});

describe("sanitizeEnv", () => {
  it("L0 keeps only allowlisted vars", () => {
    const out = sanitizeEnv({ PATH: "/bin", HOME: "/home/x", RANDOM_VAR: "1", MY_TOKEN: "t" }, 0);
    expect(out["PATH"]).toBe("/bin");
    expect(out["RANDOM_VAR"]).toBeUndefined();
    expect(out["MY_TOKEN"]).toBeUndefined();
  });

  it("L1 strips secret-shaped vars but keeps toolchain env", () => {
    const out = sanitizeEnv(
      { PATH: "/bin", NODE_OPTIONS: "--max-old-space-size=4096", OPENROUTER_API_KEY: "k", LARK_APP_SECRET: "s" },
      1,
    );
    expect(out["NODE_OPTIONS"]).toBe("--max-old-space-size=4096");
    expect(out["OPENROUTER_API_KEY"]).toBeUndefined();
    expect(out["LARK_APP_SECRET"]).toBeUndefined();
  });
});

describe("describeToolCall / extractTouchedFile", () => {
  it("describes calls compactly", () => {
    expect(describeToolCall("bash", { command: "ls -la" })).toBe("ls -la");
    expect(describeToolCall("grep", { pattern: "refund", path: "src" })).toBe("refund in src");
    expect(describeToolCall("read", { path: "a/b.ts" })).toBe("a/b.ts");
    expect(describeToolCall("bash", { command: "x".repeat(300) }).length).toBeLessThanOrEqual(120);
  });

  it("extracts touched files only for file tools", () => {
    expect(extractTouchedFile("read", { path: "src/a.ts" })).toBe("src/a.ts");
    expect(extractTouchedFile("write", { path: "src/b.ts" })).toBe("src/b.ts");
    expect(extractTouchedFile("bash", { command: "cat x" })).toBeUndefined();
    expect(extractTouchedFile("grep", { pattern: "x" })).toBeUndefined();
  });
});
