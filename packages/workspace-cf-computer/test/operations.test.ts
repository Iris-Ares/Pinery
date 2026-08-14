import { parseConfig } from "@pinery/core";
import { buildToolset } from "@pinery/runner-pi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CfComputerClient, CfComputerError } from "../src/client.js";
import { createRemoteOperations } from "../src/operations.js";
import { CfComputerWorkspaceProvider, createWorkspaceProvider } from "../src/provider.js";
import { WORKSPACE_ROOT } from "../src/protocol.js";
import { startFakeWorker, type FakeWorker } from "./fake-worker.js";

const TOKEN = "test-token";
let worker: FakeWorker;

beforeEach(async () => {
  worker = await startFakeWorker({ token: TOKEN });
});
afterEach(async () => {
  await worker.close();
});

const clientFor = (w: FakeWorker, over: Partial<{ token: string; retries: number }> = {}) =>
  new CfComputerClient({ endpoint: w.url, token: over.token ?? TOKEN, retries: over.retries ?? 0 });

const opsFor = (w: FakeWorker) =>
  createRemoteOperations({ client: clientFor(w), workspaceId: "ws1", root: WORKSPACE_ROOT });

describe("CfComputerClient", () => {
  it("authenticates with a bearer token", async () => {
    const bad = clientFor(worker, { token: "wrong" });
    await expect(bad.call("ws1", { op: "info" })).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("maps remote business errors to CfComputerError with code", async () => {
    const client = clientFor(worker);
    const err = await client.call("ws1", { op: "readFile", path: "/workspace/missing.ts" }).catch((e) => e);
    expect(err).toBeInstanceOf(CfComputerError);
    expect((err as CfComputerError).isNotFound).toBe(true);
  });

  it("guards path escapes client-side before hitting the network", async () => {
    const client = clientFor(worker);
    await expect(client.call("ws1", { op: "readFile", path: "/etc/passwd" })).rejects.toMatchObject({
      code: "path_escape",
    });
    expect(worker.calls).toHaveLength(0); // 没有发出请求
  });

  it("retries idempotent ops on transient failures", async () => {
    const flaky = await startFakeWorker({ token: TOKEN, failFirst: 2 });
    try {
      const client = new CfComputerClient({ endpoint: flaky.url, token: TOKEN, retries: 2 });
      const info = await client.call("ws1", { op: "info" });
      expect(info.protocol).toBe(1);
    } finally {
      await flaky.close();
    }
  });

  it("does not retry non-idempotent ops", async () => {
    const flaky = await startFakeWorker({ token: TOKEN, failFirst: 1 });
    try {
      const client = new CfComputerClient({ endpoint: flaky.url, token: TOKEN, retries: 3 });
      await expect(client.call("ws1", { op: "writeFile", path: "/workspace/a.txt", content: "x" })).rejects.toThrow();
    } finally {
      await flaky.close();
    }
  });

  it("times out slow requests", async () => {
    const slow = await startFakeWorker({ token: TOKEN, delayMs: 300 });
    try {
      const client = new CfComputerClient({ endpoint: slow.url, token: TOKEN, retries: 0, requestTimeoutMs: 50 });
      await expect(client.call("ws1", { op: "info" })).rejects.toThrow(/失败/);
    } finally {
      await slow.close();
    }
  });
});

describe("远程 Operations 与 pi 接口契约", () => {
  it("read: returns a Buffer and access() throws on missing files", async () => {
    worker.files.set("/workspace/src/a.ts", { content: Buffer.from("export const a = 1;\n") });
    const ops = opsFor(worker);
    const buf = await ops.read!.readFile("/workspace/src/a.ts");
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString("utf8")).toContain("export const a");
    await expect(ops.read!.access("/workspace/src/a.ts")).resolves.toBeUndefined();
    await expect(ops.read!.access("/workspace/nope.ts")).rejects.toThrow();
  });

  it("read: preserves binary content through base64 round-trip", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    worker.files.set("/workspace/img.png", { content: png });
    const ops = opsFor(worker);
    const out = await ops.read!.readFile("/workspace/img.png");
    expect(out.equals(png)).toBe(true);
    await expect(ops.read!.detectImageMimeType!("/workspace/img.png")).resolves.toBe("image/png");
    await expect(ops.read!.detectImageMimeType!("/workspace/a.ts")).resolves.toBeNull();
  });

  it("write + edit: round-trips through the remote workspace", async () => {
    const ops = opsFor(worker);
    await ops.write!.mkdir("/workspace/src");
    await ops.write!.writeFile("/workspace/src/new.ts", "hello");
    expect(worker.files.get("/workspace/src/new.ts")?.content.toString()).toBe("hello");

    const edited = (await ops.edit!.readFile("/workspace/src/new.ts")).toString("utf8").replace("hello", "world");
    await ops.edit!.writeFile("/workspace/src/new.ts", edited);
    expect(worker.files.get("/workspace/src/new.ts")?.content.toString()).toBe("world");
  });

  it("ls: stat exposes isDirectory() as a method (pi expects fs.Stats shape)", async () => {
    worker.files.set("/workspace/src/a.ts", { content: Buffer.from("a") });
    worker.files.set("/workspace/src/b.ts", { content: Buffer.from("b") });
    const ops = opsFor(worker);

    expect(await ops.ls!.exists("/workspace/src")).toBe(true);
    expect(await ops.ls!.exists("/workspace/zzz")).toBe(false);

    const st = await ops.ls!.stat("/workspace/src");
    expect(typeof st.isDirectory).toBe("function");
    expect(st.isDirectory()).toBe(true);

    const fileStat = await ops.ls!.stat("/workspace/src/a.ts");
    expect(fileStat.isDirectory()).toBe(false);

    expect((await ops.ls!.readdir("/workspace/src")).sort()).toEqual(["a.ts", "b.ts"]);
    await expect(ops.ls!.stat("/workspace/missing")).rejects.toThrow();
  });

  it("find: delegates globbing to the remote workspace", async () => {
    worker.files.set("/workspace/src/a.ts", { content: Buffer.from("a") });
    worker.files.set("/workspace/src/b.js", { content: Buffer.from("b") });
    const ops = opsFor(worker);
    const found = await ops.find!.glob("**/*.ts", "/workspace", { ignore: [], limit: 100 });
    expect(found).toEqual(["/workspace/src/a.ts"]);
  });

  it("repository guidance reads are bounded at the remote data source", async () => {
    worker.files.set("/workspace/AGENTS.md", { content: Buffer.from("123456789") });
    const ops = opsFor(worker);
    const result = await ops.repositoryContext!.readText("/workspace/AGENTS.md", 4);
    expect(result).toEqual({ text: "1234", truncated: true });
    expect(worker.calls).toContain("readFile");
  });

  it("grepSearch: searches server-side and returns workspace-relative paths", async () => {
    worker.files.set("/workspace/src/pay.ts", { content: Buffer.from("const REFUND = 1;\nother\n") });
    const ops = opsFor(worker);
    const matches = await ops.grepSearch!({ pattern: "REFUND", limit: 10 });
    expect(matches).toEqual([{ path: "src/pay.ts", line: 1, text: "const REFUND = 1;" }]);

    const ci = await ops.grepSearch!({ pattern: "refund", ignoreCase: true, limit: 10 });
    expect(ci).toHaveLength(1);
  });

  it("bash: forwards stdout/stderr through onData and returns the exit code", async () => {
    worker.execHandler = (command) => ({
      stdout: `ran: ${command}`,
      stderr: "warn",
      exitCode: 3,
    });
    const ops = opsFor(worker);
    const chunks: string[] = [];
    const result = await ops.bash!.exec("npm test", "/workspace", {
      onData: (d) => chunks.push(d.toString("utf8")),
    });
    expect(result.exitCode).toBe(3);
    expect(chunks.join("")).toContain("ran: npm test");
    expect(chunks.join("")).toContain("warn");
  });
});

describe("buildToolset 与远程工作区集成", () => {
  it("swaps in the remote grep tool and keeps the full toolset", () => {
    const ops = opsFor(worker);
    const tools = buildToolset({ cwd: WORKSPACE_ROOT, level: 0, operations: ops });
    expect(tools.map((t) => t.name).sort()).toEqual(["bash", "find", "grep", "ls", "read"]);
    // 远程 grep 的描述来自 remote-grep.ts(不是 pi 的本地 ripgrep 版本)
    expect(tools.find((t) => t.name === "grep")!.description).toContain("remote workspace");
  });

  it("remote grep tool actually searches through the wire", async () => {
    worker.files.set("/workspace/src/pay.ts", { content: Buffer.from("timeout = 30\n") });
    const tools = buildToolset({ cwd: WORKSPACE_ROOT, level: 0, operations: opsFor(worker) });
    const grep = tools.find((t) => t.name === "grep")!;
    const res = await grep.execute("t1", { pattern: "timeout" }, undefined, undefined, {} as never);
    const text = res.content.map((c) => ("text" in c ? c.text : "")).join("");
    expect(text).toContain("src/pay.ts:1");
    expect(text).toContain("timeout = 30");
  });

  it("read tool reads through the wire end to end", async () => {
    worker.files.set("/workspace/README.md", { content: Buffer.from("# Pinery\n") });
    const tools = buildToolset({ cwd: WORKSPACE_ROOT, level: 0, operations: opsFor(worker) });
    const read = tools.find((t) => t.name === "read")!;
    const res = await read.execute("t2", { path: "/workspace/README.md" }, undefined, undefined, {} as never);
    expect(res.content.map((c) => ("text" in c ? c.text : "")).join("")).toContain("# Pinery");
  });

  it("bash policy still applies before reaching the remote backend", async () => {
    const blocked: string[] = [];
    const tools = buildToolset({
      cwd: WORKSPACE_ROOT,
      level: 0,
      operations: opsFor(worker),
      onPolicyBlock: (i) => blocked.push(i.reason),
    });
    const bash = tools.find((t) => t.name === "bash")!;
    await expect(bash.execute("t3", { command: "curl http://evil" }, undefined, undefined, {} as never)).rejects.toThrow(
      /pinery-policy/,
    );
    expect(blocked).toHaveLength(1);
    expect(worker.calls.filter((c) => c === "exec")).toHaveLength(0); // 未触达远端
  });
});

describe("CfComputerWorkspaceProvider", () => {
  const repo = {
    name: "demo",
    aliases: [],
    url: "https://github.com/org/demo.git",
    chats: [],
    permissions: [],
    group_open: true,
    p2p_open: true,
  };

  it("clones once per workspace and reuses on the next acquire", async () => {
    const p = new CfComputerWorkspaceProvider({ endpoint: worker.url, token: TOKEN, retries: 0 });
    const ws1 = await p.acquireSession(repo, "p2p:oc_1");
    expect(worker.cloned?.url).toBe(repo.url);
    expect(ws1.dir).toBe(WORKSPACE_ROOT);
    expect(ws1.readOnly).toBe(true);
    expect(ws1.operations).toBeDefined();

    const clonesBefore = worker.calls.filter((c) => c === "gitClone").length;
    await p.acquireSession(repo, "p2p:oc_1");
    expect(worker.calls.filter((c) => c === "gitClone").length).toBe(clonesBefore);
  });

  it("derives stable workspace ids and separates session from task", async () => {
    const p = new CfComputerWorkspaceProvider({ endpoint: worker.url, token: TOKEN, retries: 0 });
    const a = await p.acquireSession(repo, "thread:om_root");
    const b = await p.acquireSession(repo, "thread:om_root");
    const t = await p.acquireTask(repo, "task-9");
    expect(a.handle).toBe(b.handle);
    expect(a.handle.startsWith("s-demo-")).toBe(true);
    expect(t.handle).toBe("t-demo-task-9");
    expect(t.readOnly).toBe(false);
  });

  it("shares one pre-hydrated snapshot workspace across L0 sessions", async () => {
    const p = new CfComputerWorkspaceProvider({
      endpoint: worker.url,
      token: TOKEN,
      retries: 0,
      sharedSnapshots: { demo: "s-example-main-snapshot" },
    });
    const a = await p.acquireSession(repo, "p2p:oc_1");
    const b = await p.acquireSession(repo, "group:oc_2");
    expect(a.handle).toBe("s-example-main-snapshot");
    expect(b.handle).toBe(a.handle);
    expect(worker.calls.filter((call) => call === "gitClone")).toHaveLength(1);
  });

  it("rejects SSH repo urls with an actionable message (isomorphic-git has no SSH)", async () => {
    const p = new CfComputerWorkspaceProvider({ endpoint: worker.url, token: TOKEN, retries: 0 });
    await expect(
      p.acquireSession({ ...repo, url: "git@github.com:org/demo.git" }, "k"),
    ).rejects.toThrow(/HTTPS/);
  });

  // 回归(PR review P2):会话工作区的 VFS 是持久的,长期话题必须按同步策略刷新,
  // 否则会一直基于初次浅克隆回答(远程后端下本地 pull loop 也不跑)
  it("refreshes a stale session workspace instead of answering from the initial clone", async () => {
    const p = new CfComputerWorkspaceProvider({
      endpoint: worker.url,
      token: TOKEN,
      retries: 0,
      refreshIntervalMs: 60_000,
    });
    await p.acquireSession(repo, "k");
    expect(worker.calls.filter((c) => c === "gitClone")).toHaveLength(1);
    expect(worker.calls.filter((c) => c === "gitPull")).toHaveLength(0);

    // 远端已陈旧(上次同步在刷新窗口之外)→ 下次取用应触发 pull
    worker.setSyncedAt(Date.now() - 10 * 60_000);
    const fresh = new CfComputerWorkspaceProvider({
      endpoint: worker.url,
      token: TOKEN,
      retries: 0,
      refreshIntervalMs: 60_000,
    });
    await fresh.acquireSession(repo, "k");
    expect(worker.calls.filter((c) => c === "gitPull")).toHaveLength(1);
    expect(worker.calls.filter((c) => c === "gitClone")).toHaveLength(1); // 不重复克隆
  });

  it("does not re-sync within the refresh window", async () => {
    const p = new CfComputerWorkspaceProvider({
      endpoint: worker.url,
      token: TOKEN,
      retries: 0,
      refreshIntervalMs: 60_000,
    });
    await p.acquireSession(repo, "k");
    await p.acquireSession(repo, "k");
    await p.acquireSession(repo, "k");
    expect(worker.calls.filter((c) => c === "gitPull")).toHaveLength(0);
    expect(worker.calls.filter((c) => c === "gitClone")).toHaveLength(1);
  });

  // 回归(PR review P2):同一会话工作区的并发取用必须串行,
  // 否则会重复 clone/pull,且 pull 可能在前一次调查读取时改写 checkout
  it("serializes concurrent acquisitions of the same workspace", async () => {
    const p = new CfComputerWorkspaceProvider({ endpoint: worker.url, token: TOKEN, retries: 0 });
    const [a, b, c] = await Promise.all([
      p.acquireSession(repo, "same"),
      p.acquireSession(repo, "same"),
      p.acquireSession(repo, "same"),
    ]);
    expect(a.handle).toBe(b.handle);
    expect(b.handle).toBe(c.handle);
    // 三个并发调用只触发一次准备
    expect(worker.calls.filter((x) => x === "gitClone")).toHaveLength(1);
    expect(worker.calls.filter((x) => x === "info")).toHaveLength(1);
  });

  it("propagates preparation failure to every concurrent caller", async () => {
    const broken = await startFakeWorker({ token: TOKEN, failOps: ["info"] });
    try {
      const p = new CfComputerWorkspaceProvider({ endpoint: broken.url, token: TOKEN, retries: 0 });
      const results = await Promise.allSettled([p.acquireSession(repo, "x"), p.acquireSession(repo, "x")]);
      expect(results.every((r) => r.status === "rejected")).toBe(true);
      // 失败后不残留:下一次取用会重新尝试
      expect(broken.calls.filter((x) => x === "info").length).toBeGreaterThanOrEqual(1);
    } finally {
      await broken.close();
    }
  });

  // 回归(PR review 五轮 P2):服务端只持久化脱敏地址,客户端若拿含凭据的
  // URL 去比,私有仓库永远被判成「不同仓库」→ 走 clone 分支 → 服务端视为
  // 幂等 no-op,于是每个刷新周期都记账却从不 fetch
  it("pulls (not re-clones) an authenticated repo whose marker is redacted", async () => {
    const authed = { ...repo, url: "https://ghp_tok@example.com/org/repo.git" };
    const p = new CfComputerWorkspaceProvider({
      endpoint: worker.url,
      token: TOKEN,
      retries: 0,
      refreshIntervalMs: 0, // 强制每次取用都判定刷新
    });

    await p.acquireSession(authed, "s1");
    expect(worker.calls.filter((c) => c === "gitClone")).toHaveLength(1);

    worker.calls.length = 0;
    await p.acquireSession(authed, "s1");
    // 第二次必须走 pull,而不是又一次(被当成 no-op 的)clone
    expect(worker.calls).toContain("gitPull");
    expect(worker.calls).not.toContain("gitClone");
  });

  it("degrades to the existing snapshot when the refresh pull fails", async () => {
    const flaky = await startFakeWorker({ token: TOKEN, failOps: ["gitPull"] });
    try {
      const p = new CfComputerWorkspaceProvider({
        endpoint: flaky.url,
        token: TOKEN,
        retries: 0,
        refreshIntervalMs: 60_000,
      });
      await p.acquireSession(repo, "k"); // 首次 clone
      flaky.setSyncedAt(Date.now() - 10 * 60_000); // 变陈旧

      const fresh = new CfComputerWorkspaceProvider({
        endpoint: flaky.url,
        token: TOKEN,
        retries: 0,
        refreshIntervalMs: 60_000,
      });
      // pull 失败不应阻断提问 —— 用现有快照回答好过完全不回答
      const ws = await fresh.acquireSession(repo, "k");
      expect(ws.dir).toBe(WORKSPACE_ROOT);
      expect(ws.operations).toBeDefined();
      expect(flaky.calls.filter((c) => c === "gitPull")).toHaveLength(1);
    } finally {
      await flaky.close();
    }
  });

  it("release removes task workspaces but keeps session workspaces", async () => {
    const p = new CfComputerWorkspaceProvider({ endpoint: worker.url, token: TOKEN, retries: 0 });
    const task = await p.acquireTask(repo, "t1");
    await p.release(task);
    expect(worker.calls.filter((c) => c === "rm").length).toBe(1);

    const session = await p.acquireSession(repo, "s1");
    await p.release(session);
    expect(worker.calls.filter((c) => c === "rm").length).toBe(1); // 未新增

    const kept = await p.acquireTask(repo, "t2");
    await p.release(kept, { keep: true });
    expect(worker.calls.filter((c) => c === "rm").length).toBe(1); // keep 时保留现场
  });
});

describe("createWorkspaceProvider 工厂契约", () => {
  const base = `
lark: { app_id: x, app_secret: y }
repos: [{ name: r, url: "https://github.com/o/r.git" }]
`;

  it("builds a provider from workspace.options", () => {
    const cfg = parseConfig(
      `${base}
workspace:
  provider: "@pinery/workspace-cf-computer"
  options:
    endpoint: https://pinery.workers.dev
    token: \${PINERY_CF_TOKEN}
`,
      { PINERY_CF_TOKEN: "tok" } as NodeJS.ProcessEnv,
    );
    const p = createWorkspaceProvider(cfg);
    expect(p.kind).toBe("cf-computer");
  });

  it("fails fast with actionable messages when options are missing", () => {
    const cfg = parseConfig(`${base}\nworkspace: { provider: "@pinery/workspace-cf-computer" }\n`, {} as NodeJS.ProcessEnv);
    expect(() => createWorkspaceProvider(cfg)).toThrow(/endpoint/);
  });

  it("uses one repo-scoped snapshot while another repo gets its own session workspace", async () => {
    const cfg = parseConfig(
      `
lark: { app_id: x, app_secret: y }
repos:
  - { name: alpha, url: "https://github.com/o/alpha.git", snapshot_id: s-alpha-snapshot }
  - { name: beta, url: "https://github.com/o/beta.git" }
workspace:
  options:
    endpoint: ${worker.url}
    token: ${TOKEN}
`,
      {} as NodeJS.ProcessEnv,
    );
    const p = createWorkspaceProvider(cfg);
    const alpha = await p.acquireSession(cfg.repos[0]!, "same-session");
    const beta = await p.acquireSession(cfg.repos[1]!, "same-session");
    expect(alpha.handle).toBe("s-alpha-snapshot");
    expect(beta.handle).toMatch(/^s-beta-/);
    expect(beta.handle).not.toBe(alpha.handle);
  });

  it("rejects legacy global snapshots for a multi-repo configuration", () => {
    const cfg = parseConfig(
      `
lark: { app_id: x, app_secret: y }
repos:
  - { name: alpha, url: "https://github.com/o/alpha.git" }
  - { name: beta, url: "https://github.com/o/beta.git" }
workspace:
  options:
    endpoint: https://pinery.workers.dev
    token: tok
    shared_snapshot_id: s-global-snapshot
`,
      {} as NodeJS.ProcessEnv,
    );
    expect(() => createWorkspaceProvider(cfg)).toThrow(/\u5355\u4ed3\u5e93/);
  });

  it("rejects one snapshot workspace bound to two repositories", () => {
    const cfg = parseConfig(
      `
lark: { app_id: x, app_secret: y }
repos:
  - { name: alpha, url: "https://github.com/o/alpha.git", snapshot_id: s-same }
  - { name: beta, url: "https://github.com/o/beta.git", snapshot_id: s-same }
workspace:
  options:
    endpoint: https://pinery.workers.dev
    token: tok
`,
      {} as NodeJS.ProcessEnv,
    );
    expect(() => createWorkspaceProvider(cfg)).toThrow(/\u540c\u65f6\u7ed1\u5b9a/);
  });
});
