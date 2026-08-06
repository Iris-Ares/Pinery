import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { ModelConfigError, buildModelsConfig, isBuiltinProvider, syncModelsJson } from "../src/models-json.js";

const dir = () => mkdtempSync(join(tmpdir(), "pinery-models-"));

describe("isBuiltinProvider", () => {
  it("recognizes pi-ai built-in providers", () => {
    expect(isBuiltinProvider("anthropic")).toBe(true);
    expect(isBuiltinProvider("openrouter")).toBe(true);
    expect(isBuiltinProvider("cloudflare-workers-ai")).toBe(true);
    expect(isBuiltinProvider("my-own-gateway")).toBe(false);
  });
});

describe("buildModelsConfig", () => {
  it("builtin provider without overrides needs no models.json", () => {
    expect(buildModelsConfig({ provider: "openrouter", id: "deepseek/deepseek-chat" })).toBeUndefined();
    expect(buildModelsConfig({ provider: "anthropic", id: "claude-sonnet-4-5" })).toBeUndefined();
  });

  it("builtin provider with base_url produces provider-level override (CF AI Gateway 形态)", () => {
    const c = buildModelsConfig({
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      baseUrl: "https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic",
      headers: { "cf-aig-authorization": "Bearer tok" },
    });
    expect(c?.providers["anthropic"]?.baseUrl).toContain("gateway.ai.cloudflare.com");
    expect(c?.providers["anthropic"]?.headers?.["cf-aig-authorization"]).toBe("Bearer tok");
    expect(c?.providers["anthropic"]?.models?.[0]?.id).toBe("claude-sonnet-4-5");
  });

  it("custom provider requires base_url and api", () => {
    expect(() => buildModelsConfig({ provider: "my-gw", id: "m" })).toThrow(ModelConfigError);
    expect(() =>
      buildModelsConfig({ provider: "my-gw", id: "m", baseUrl: "https://x/v1" }),
    ).toThrow(/model\.api/);
    const c = buildModelsConfig({
      provider: "my-gw",
      id: "m",
      baseUrl: "https://x/v1",
      api: "openai-completions",
    });
    expect(c?.providers["my-gw"]?.api).toBe("openai-completions");
    // apiKey 写 env 变量名(pi 请求时解析,secret 不落盘)
    expect(c?.providers["my-gw"]?.apiKey).toBe("MY_GW_API_KEY");
  });

  it("custom provider apiKey honors api_key_env", () => {
    const c = buildModelsConfig({
      provider: "my-gw",
      id: "m",
      baseUrl: "https://x/v1",
      api: "openai-completions",
      apiKeyEnv: "CF_AIG_TOKEN",
    });
    expect(c?.providers["my-gw"]?.apiKey).toBe("CF_AIG_TOKEN");
  });
});

describe("syncModelsJson", () => {
  it("writes 0600 file and removes it when overrides are gone", () => {
    const agentDir = dir();
    const p = syncModelsJson(agentDir, {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      baseUrl: "https://gw.example/anthropic",
    });
    expect(p).toBeDefined();
    expect(existsSync(p!)).toBe(true);
    const mode = statSync(p!).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(JSON.parse(readFileSync(p!, "utf8")).providers.anthropic.baseUrl).toBe("https://gw.example/anthropic");

    // 移除覆写 → 文件清除,避免陈旧改道
    const p2 = syncModelsJson(agentDir, { provider: "anthropic", id: "claude-sonnet-4-5" });
    expect(p2).toBeUndefined();
    expect(existsSync(join(agentDir, "models.json"))).toBe(false);
  });
});

describe("ModelRegistry 集成(pi 真实解析)", () => {
  function makeRegistry(agentDir: string): ModelRegistry {
    const auth = AuthStorage.create(join(agentDir, "auth.json"));
    return ModelRegistry.create(auth, join(agentDir, "models.json"));
  }

  it("resolves builtin anthropic model rerouted through gateway", () => {
    const agentDir = dir();
    syncModelsJson(agentDir, {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      baseUrl: "https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic",
      headers: { "cf-aig-authorization": "Bearer tok" },
    });
    const registry = makeRegistry(agentDir);
    const model = registry.find("anthropic", "claude-sonnet-4-5");
    expect(model).toBeDefined();
    expect(model?.baseUrl).toBe("https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic");
    expect(model?.api).toBe("anthropic-messages");
  });

  it("resolves custom openai-compatible gateway model (CF compat 端点形态)", () => {
    const agentDir = dir();
    syncModelsJson(agentDir, {
      provider: "cf-gateway",
      id: "anthropic/claude-sonnet-4-5",
      api: "openai-completions",
      baseUrl: "https://gateway.ai.cloudflare.com/v1/acct/gw/compat",
    });
    const registry = makeRegistry(agentDir);
    const model = registry.find("cf-gateway", "anthropic/claude-sonnet-4-5");
    expect(model).toBeDefined();
    expect(model?.api).toBe("openai-completions");
    expect(model?.baseUrl).toContain("/compat");
  });

  it("resolves uncataloged model id under builtin provider", () => {
    const agentDir = dir();
    syncModelsJson(agentDir, {
      provider: "openrouter",
      id: "some-org/brand-new-model",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    const registry = makeRegistry(agentDir);
    const model = registry.find("openrouter", "some-org/brand-new-model");
    expect(model).toBeDefined();
    expect(model?.api).toBe("openai-completions");
  });
});
