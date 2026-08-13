import { AuthStorage, ModelRegistry, SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  parseWorkersPiSessionSnapshot,
  registerModelOverrides,
  resolveHeaderValues,
  restoreWorkersPiSession,
  WorkersPiRunner,
  workersPiWorkspaceBinding,
} from "../src/workers-runner.js";

/**
 * WorkersPiRunner 的无盘装配逻辑(注册三态 + env 解析 + 早期失败路径)。
 * 完整 agent loop 的 workerd 内验证在 deploy/cloudflare 的 spike/pool-workers 侧。
 */

const WS = { repo: "demo", dir: "/workspace", readOnly: true } as never;
const BASE_OPTS = { level: 0 as const, maxTurns: 3, timeoutMs: 5_000 };

describe("registerModelOverrides", () => {
  const fresh = () => ModelRegistry.inMemory(AuthStorage.inMemory());

  it("builtin provider without overrides registers nothing", () => {
    const registry = fresh();
    registerModelOverrides(registry, { provider: "openai", id: "gpt-4.1" }, true, undefined, "k");
    // 内置目录原样可用(找得到 openai 自己的模型即可,不强求特定 id)
    expect(registry.find("openai", "gpt-4.1")?.baseUrl).toBeDefined();
  });

  it("builtin provider with baseUrl reroutes existing models (AI Gateway form B)", () => {
    const registry = fresh();
    const gateway = "https://gateway.ai.cloudflare.com/v1/acct/gw/openai";
    registerModelOverrides(registry, { provider: "openai", id: "gpt-4.1", baseUrl: gateway }, true, { "cf-aig-authorization": "Bearer t" }, undefined);
    const model = registry.find("openai", "gpt-4.1");
    expect(model?.baseUrl).toBe(gateway);
  });

  it("custom provider requires base_url and api", () => {
    const registry = fresh();
    expect(() => registerModelOverrides(registry, { provider: "my-gw", id: "m1" }, false, undefined, undefined)).toThrow(
      /base_url/,
    );
    expect(() =>
      registerModelOverrides(registry, { provider: "my-gw", id: "m1", baseUrl: "https://x" }, false, undefined, undefined),
    ).toThrow(/api/);
  });

  it("custom provider registers a full model entry", () => {
    const registry = fresh();
    registerModelOverrides(
      registry,
      { provider: "my-gw", id: "qwen3-coder", baseUrl: "http://127.0.0.1:11434/v1", api: "openai-completions" },
      false,
      undefined,
      undefined,
    );
    const model = registry.find("my-gw", "qwen3-coder");
    expect(model).toMatchObject({ id: "qwen3-coder", provider: "my-gw", baseUrl: "http://127.0.0.1:11434/v1" });
  });
});

describe("resolveHeaderValues", () => {
  it("resolves env variable names and keeps literals", () => {
    expect(
      resolveHeaderValues({ "cf-aig-authorization": "CF_AIG_HEADER", "x-static": "literal" }, { CF_AIG_HEADER: "Bearer x" }),
    ).toEqual({ "cf-aig-authorization": "Bearer x", "x-static": "literal" });
    expect(resolveHeaderValues(undefined, {})).toBeUndefined();
  });
});

describe("WorkersPiRunner durable resume", () => {
  it("round-trips the resolved Pi conversation and workspace binding", () => {
    const source = SessionManager.inMemory("/workspace");
    source.appendMessage({ role: "user", content: "remember this", timestamp: 1 });
    const binding = workersPiWorkspaceBinding({
      handle: "s-demo-chat",
      repo: "demo",
      dir: "/workspace",
      readOnly: true,
      branch: "main",
    });
    const raw = JSON.parse(
      JSON.stringify({
        version: 1,
        binding,
        messages: source.buildSessionContext().messages,
        updatedAt: 2,
      }),
    );
    const snapshot = parseWorkersPiSessionSnapshot(raw);
    expect(snapshot?.binding.workspaceHandle).toBe("s-demo-chat");
    expect(restoreWorkersPiSession(snapshot!, "/workspace").buildSessionContext().messages).toMatchObject([
      { role: "user", content: "remember this" },
    ]);
  });

  it("continues appending after a restored turn instead of replacing history", () => {
    const binding = workersPiWorkspaceBinding({
      handle: "s-demo-chat",
      repo: "demo",
      dir: "/workspace",
      readOnly: true,
    });
    const first = SessionManager.inMemory("/workspace");
    first.appendMessage({ role: "user", content: "first turn", timestamp: 1 });
    const restored = restoreWorkersPiSession(
      {
        version: 1,
        binding,
        messages: first.buildSessionContext().messages,
        updatedAt: 2,
      },
      "/workspace",
    );
    restored.appendMessage({ role: "user", content: "second turn", timestamp: 3 });
    const restoredAgain = restoreWorkersPiSession(
      {
        version: 1,
        binding,
        messages: restored.buildSessionContext().messages,
        updatedAt: 4,
      },
      "/workspace",
    );
    expect(restoredAgain.buildSessionContext().messages).toMatchObject([
      { role: "user", content: "first turn" },
      { role: "user", content: "second turn" },
    ]);
  });

  it("rejects malformed snapshots and workspaces without a stable handle", () => {
    expect(parseWorkersPiSessionSnapshot({ version: 1, messages: [] })).toBeUndefined();
    expect(() => workersPiWorkspaceBinding({ repo: "demo", dir: "/workspace", readOnly: true })).toThrow(
      /workspace.handle/,
    );
  });
});

describe("WorkersPiRunner early failures", () => {
  it("fails with actionable message when builtin key missing", async () => {
    const runner = new WorkersPiRunner({ env: {} });
    const result = await runner.run(
      { id: "t1", kind: "investigate", prompt: "q" },
      WS,
      { ...BASE_OPTS, model: { provider: "anthropic", id: "claude-sonnet-4-5" } },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ANTHROPIC_API_KEY");
  });

  it("fails when custom provider lacks base_url", async () => {
    const runner = new WorkersPiRunner({ env: {} });
    const result = await runner.run(
      { id: "t2", kind: "investigate", prompt: "q" },
      WS,
      { ...BASE_OPTS, model: { provider: "nonexistent-gw", id: "m" } },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("base_url");
  });

  it("rejects builtin reroute to an id missing from the catalog", async () => {
    const runner = new WorkersPiRunner({ env: { OPENAI_API_KEY: "k" } });
    const result = await runner.run(
      { id: "t3", kind: "investigate", prompt: "q" },
      WS,
      { ...BASE_OPTS, model: { provider: "openai", id: "totally-new-model", baseUrl: "https://gw.example" } },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("自定义 provider");
  });
});
