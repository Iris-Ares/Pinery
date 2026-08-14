import { describe, expect, it } from "vitest";
import {
  ConfigError,
  defaultApiKeyEnv,
  parseConfig,
  repoForChat,
  resolveRepoIntent,
  resolveUserLevel,
  runnerModelConfig,
} from "../src/config.js";

const BASE_YAML = `
lark:
  app_id: cli_test123
  app_secret: \${TEST_LARK_SECRET}
repos:
  - name: order-service
    url: git@github.com:org/order.git
    chats: [oc_abc]
    permissions:
      - { user: ou_alice, level: 2 }
      - { user: ou_bob, level: 1 }
model:
  provider: openrouter
  id: deepseek/deepseek-chat
`;

const env = { TEST_LARK_SECRET: "s3cret" } as NodeJS.ProcessEnv;

describe("parseConfig", () => {
  it("parses valid config with env interpolation", () => {
    const cfg = parseConfig(BASE_YAML, env);
    expect(cfg.lark.app_secret).toBe("s3cret");
    expect(cfg.repos[0]!.name).toBe("order-service");
    expect(cfg.repos[0]!.aliases).toEqual([]);
    expect(cfg.repos[0]!.group_open).toBe(true);
    expect(cfg.repos[0]!.snapshot_id).toBeUndefined();
    expect(cfg.limits.session_max_turns).toBe(20);
    expect(cfg.limits.synthesis_reserve_sec).toBe(30);
    expect(cfg.runner.kind).toBe("pi");
    expect(cfg.workspace.root).toBe("~/.pinery");
  });

  it("throws on missing env var with variable name in message", () => {
    expect(() => parseConfig(BASE_YAML, {} as NodeJS.ProcessEnv)).toThrowError(/TEST_LARK_SECRET/);
  });

  it("throws ConfigError on schema violation", () => {
    expect(() => parseConfig("lark: {app_id: x, app_secret: y}\nrepos: []", env)).toThrowError(ConfigError);
  });

  it("rejects illegal repo names", () => {
    const bad = BASE_YAML.replace("order-service", "../evil");
    expect(() => parseConfig(bad, env)).toThrowError(ConfigError);
  });

  it("validates repository-scoped snapshot workspace ids", () => {
    const valid = parseConfig(BASE_YAML.replace("url: git@github.com:org/order.git", "url: https://example.com/order.git\n    snapshot_id: s-order-main"), env);
    expect(valid.repos[0]!.snapshot_id).toBe("s-order-main");

    const invalid = BASE_YAML.replace("url: git@github.com:org/order.git", "url: https://example.com/order.git\n    snapshot_id: t-not-a-snapshot");
    expect(() => parseConfig(invalid, env)).toThrowError(/snapshot_id/);
  });
});

describe("repoForChat", () => {
  const cfg = parseConfig(BASE_YAML, env);

  it("finds repo by registered chat", () => {
    expect(repoForChat(cfg, "oc_abc", "group")?.name).toBe("order-service");
  });

  it("falls back to the only repo for p2p", () => {
    expect(repoForChat(cfg, "oc_other", "p2p")?.name).toBe("order-service");
  });

  it("falls back to the only repo for an unregistered group", () => {
    expect(repoForChat(cfg, "oc_other", "group")?.name).toBe("order-service");
  });
});

describe("resolveRepoIntent", () => {
  const multi = parseConfig(
    `
lark: { app_id: x, app_secret: y }
repos:
  - { name: order-service, aliases: [订单], url: "https://example.com/order.git", chats: [oc_order] }
  - { name: stock-service, aliases: [库存], url: "https://example.com/stock.git" }
model: { provider: openrouter, id: test/model }
`,
    env,
  );

  it("prefers an explicit project alias", () => {
    const result = resolveRepoIntent(multi, {
      chatId: "oc_order",
      text: "库存项目的扣减逻辑在哪里?",
      activeRepo: "order-service",
    });
    expect(result.repo?.name).toBe("stock-service");
    expect(result.source).toBe("intent");
  });

  it("continues the active project when the message has no project intent", () => {
    const result = resolveRepoIntent(multi, {
      chatId: "oc_other",
      text: "继续看刚才的问题",
      activeRepo: "stock-service",
    });
    expect(result.repo?.name).toBe("stock-service");
    expect(result.source).toBe("session");
  });

  it("uses chats as an optional default routing hint", () => {
    const result = resolveRepoIntent(multi, { chatId: "oc_order", text: "这个功能怎么实现?" });
    expect(result.repo?.name).toBe("order-service");
    expect(result.source).toBe("chat-default");
  });

  it("returns candidates instead of guessing across multiple projects", () => {
    const result = resolveRepoIntent(multi, { chatId: "oc_other", text: "这个功能怎么实现?" });
    expect(result.repo).toBeUndefined();
    expect(result.source).toBe("ambiguous");
    expect(result.candidates.map((repo) => repo.name)).toEqual(["order-service", "stock-service"]);
  });
});

describe("resolveUserLevel", () => {
  const cfg = parseConfig(BASE_YAML, env);
  const repo = cfg.repos[0]!;

  it("explicit permission wins", () => {
    expect(resolveUserLevel(repo, "ou_alice", "group", true)).toBe(2);
    expect(resolveUserLevel(repo, "ou_bob", "p2p", false)).toBe(1);
  });

  it("group members default to L0 without chat binding", () => {
    expect(resolveUserLevel(repo, "ou_stranger", "group", true)).toBe(0);
    expect(resolveUserLevel(repo, "ou_stranger", "group", false)).toBe(0);
  });

  it("can explicitly restrict group access", () => {
    expect(resolveUserLevel({ ...repo, group_open: false }, "ou_stranger", "group", false)).toBeUndefined();
    expect(resolveUserLevel({ ...repo, group_open: false }, "ou_stranger", "group", true)).toBe(0);
  });

  it("p2p_open grants L0 in private chat", () => {
    expect(resolveUserLevel(repo, "ou_stranger", "p2p", false)).toBe(0);
  });
});

describe("defaultApiKeyEnv", () => {
  it("maps known providers per pi-ai conventions", () => {
    expect(defaultApiKeyEnv("openrouter")).toBe("OPENROUTER_API_KEY");
    expect(defaultApiKeyEnv("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(defaultApiKeyEnv("google")).toBe("GEMINI_API_KEY");
    expect(defaultApiKeyEnv("cloudflare-workers-ai")).toBe("CLOUDFLARE_API_KEY");
    expect(defaultApiKeyEnv("vercel-ai-gateway")).toBe("AI_GATEWAY_API_KEY");
  });
  it("derives for unknown providers", () => {
    expect(defaultApiKeyEnv("my-llm")).toBe("MY_LLM_API_KEY");
  });
});

describe("model provider 配置(官方 / CF AI Gateway / 自定义)", () => {
  it("parses official provider config", () => {
    const cfg = parseConfig(
      BASE_YAML.replace("provider: openrouter", "provider: anthropic").replace(
        "id: deepseek/deepseek-chat",
        "id: claude-sonnet-4-5",
      ),
      env,
    );
    expect(cfg.model.provider).toBe("anthropic");
    expect(cfg.model.base_url).toBeUndefined();
  });

  it("parses CF AI Gateway routing with header env interpolation", () => {
    const yaml = `
lark: { app_id: x, app_secret: y }
repos: [{ name: r, url: "git@x:o/r.git" }]
model:
  provider: anthropic
  id: claude-sonnet-4-5
  base_url: https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic
  headers:
    cf-aig-authorization: Bearer \${CF_AIG_TOKEN}
`;
    const cfg = parseConfig(yaml, { CF_AIG_TOKEN: "tok123" } as NodeJS.ProcessEnv);
    expect(cfg.model.base_url).toContain("gateway.ai.cloudflare.com");
    expect(cfg.model.headers?.["cf-aig-authorization"]).toBe("Bearer tok123");
    const rm = runnerModelConfig(cfg);
    expect(rm.baseUrl).toBe(cfg.model.base_url);
    expect(rm.headers).toEqual(cfg.model.headers);
  });

  it("parses custom provider with api", () => {
    const yaml = `
lark: { app_id: x, app_secret: y }
repos: [{ name: r, url: "git@x:o/r.git" }]
model:
  provider: my-gateway
  id: some/model
  api: openai-completions
  base_url: https://llm.internal/v1
  api_key_env: MY_GATEWAY_TOKEN
`;
    const cfg = parseConfig(yaml, env);
    const rm = runnerModelConfig(cfg);
    expect(rm.api).toBe("openai-completions");
    expect(rm.apiKeyEnv).toBe("MY_GATEWAY_TOKEN");
  });
});
