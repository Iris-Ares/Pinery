import { existsSync, writeFileSync } from "node:fs";
import * as p from "@clack/prompts";
import YAML from "yaml";
import { larkChecklist } from "./checklist.js";

/**
 * pinery init(PRD §3.8):生成 pinery.yaml + .env.example,并打印飞书后台配置清单。
 * 飞书后台是最大摩擦源,init 的职责是把「要配什么」一次性说清。
 */
export async function runInit(opts: { config: string; force?: boolean }): Promise<void> {
  p.intro("🌲 Pinery init — 生成配置");

  if (existsSync(opts.config) && !opts.force) {
    p.log.error(`${opts.config} 已存在;用 --force 覆盖,或直接编辑该文件。`);
    p.outro("已取消");
    return;
  }

  const endpoint = (await ask(
    p.select({
      message: "飞书还是 Lark(海外)?",
      options: [
        { value: "feishu", label: "feishu(飞书,国内)" },
        { value: "lark", label: "lark(Lark Suite,海外)" },
      ],
    }),
  )) as "feishu" | "lark";

  const appId = await ask(
    p.text({
      message: "App ID(飞书开发者后台「凭证与基础信息」)",
      placeholder: "cli_xxx",
      validate: (v) => (v && v.trim() ? undefined : "必填"),
    }),
  );

  const repoName = await ask(
    p.text({
      message: "仓库名(标识用,如 order-service)",
      validate: (v) => (/^[A-Za-z0-9._-]+$/.test(v ?? "") ? undefined : "仅允许字母数字与 ._-"),
    }),
  );

  const repoUrl = await ask(
    p.text({
      message: "仓库 git 地址(建议用只读 deploy key 的 ssh 地址)",
      placeholder: "git@github.com:org/repo.git",
      validate: (v) => (v && v.trim() ? undefined : "必填"),
    }),
  );

  const chatsRaw = await ask(
    p.text({
      message: "默认项目群 chat_id(可选,仅多项目路由需要;逗号分隔)",
      defaultValue: "",
      placeholder: "oc_xxx,oc_yyy",
    }),
  );

  const { model, envVars } = await promptModelConfig();

  const chats = chatsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const config = {
    lark: { app_id: appId.trim(), app_secret: "${LARK_APP_SECRET}", endpoint },
    repos: [{ name: repoName.trim(), url: repoUrl.trim(), chats }],
    model,
    limits: { session_max_turns: 20, task_timeout_min: 30 },
    workspace: { root: "~/.pinery" },
  };

  writeFileSync(opts.config, YAML.stringify(config), "utf8");

  const envExample = [
    "# Pinery 环境变量(复制为 .env 并填入真实值;.env 已被 gitignore)",
    "LARK_APP_SECRET=",
    ...envVars.map((v) => `${v}=`),
    "",
  ].join("\n");
  if (!existsSync(".env.example")) writeFileSync(".env.example", envExample, "utf8");

  p.log.success(`已生成 ${opts.config} 与 .env.example`);
  p.log.message(larkChecklist(endpoint));
  p.outro("下一步:填好 .env → pinery doctor");
}

interface ModelSection {
  provider: string;
  id: string;
  api?: string;
  base_url?: string;
  api_key_env?: string;
  headers?: Record<string, string>;
}

/**
 * 模型接入向导:官方 provider 直连 / Cloudflare AI Gateway 改道 / 自定义兼容端点。
 * pi-ai 内置 26 个 provider 适配,直连场景零额外配置。
 */
async function promptModelConfig(): Promise<{ model: ModelSection; envVars: string[] }> {
  const choice = (await ask(
    p.select({
      message: "模型接入方式?",
      options: [
        { value: "openrouter", label: "OpenRouter 聚合(默认,DeepSeek 高性价比)" },
        { value: "anthropic", label: "Anthropic 官方" },
        { value: "openai", label: "OpenAI 官方" },
        { value: "google", label: "Google Gemini 官方" },
        { value: "deepseek", label: "DeepSeek 官方" },
        { value: "cf-gateway", label: "Cloudflare AI Gateway(统一观测/BYOK)" },
        { value: "custom", label: "自定义(OpenAI 兼容网关 / 本地模型)" },
      ],
    }),
  )) as string;

  const idDefaults: Record<string, string> = {
    openrouter: "deepseek/deepseek-chat",
    anthropic: "claude-sonnet-4-5",
    deepseek: "deepseek-chat",
  };
  const keyEnvDefaults: Record<string, string> = {
    openrouter: "OPENROUTER_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    google: "GEMINI_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
  };

  if (choice === "cf-gateway") {
    const account = await ask(p.text({ message: "Cloudflare Account ID", validate: req }));
    const gateway = await ask(p.text({ message: "AI Gateway 名称(gateway id)", validate: req }));
    const upstream = (await ask(
      p.select({
        message: "网关背后的上游?",
        options: [
          { value: "anthropic", label: "Anthropic" },
          { value: "openai", label: "OpenAI" },
          { value: "deepseek", label: "DeepSeek" },
          { value: "workers-ai", label: "Workers AI(Cloudflare 自家模型)" },
          { value: "compat", label: "OpenAI 兼容统一端点(/compat,配合 BYOK)" },
        ],
      }),
    )) as string;
    const base = `https://gateway.ai.cloudflare.com/v1/${account.trim()}/${gateway.trim()}`;
    const authed = await ask(
      p.confirm({ message: "网关开启了鉴权(cf-aig-authorization)吗?", initialValue: false }),
    );
    const headers = authed ? { "cf-aig-authorization": "Bearer ${CF_AIG_TOKEN}" } : undefined;

    if (upstream === "compat") {
      const id = await ask(
        p.text({ message: "模型 id(provider/model 形式)", placeholder: "anthropic/claude-sonnet-4-5", validate: req }),
      );
      // compat 端点 + BYOK:密钥存在 CF,本地只持网关 token
      return {
        model: {
          provider: "cf-gateway",
          id: id.trim(),
          api: "openai-completions",
          base_url: `${base}/compat`,
          api_key_env: "CF_AIG_TOKEN",
          ...(headers ? { headers } : {}),
        },
        envVars: ["CF_AIG_TOKEN"],
      };
    }

    const provider = upstream === "workers-ai" ? "cloudflare-workers-ai" : upstream;
    const keyEnv = upstream === "workers-ai" ? "CLOUDFLARE_API_KEY" : keyEnvDefaults[provider]!;
    const id = await ask(
      p.text({
        message: "模型 id",
        defaultValue: idDefaults[provider] ?? "",
        placeholder: idDefaults[provider] ?? "模型 id",
        validate: req,
      }),
    );
    return {
      model: {
        provider,
        id: id.trim(),
        base_url: `${base}/${upstream}`,
        ...(headers ? { headers } : {}),
      },
      envVars: [keyEnv, ...(authed ? ["CF_AIG_TOKEN"] : [])],
    };
  }

  if (choice === "custom") {
    const provider = await ask(
      p.text({ message: "provider 标识名", defaultValue: "my-gateway", placeholder: "my-gateway" }),
    );
    const baseUrl = await ask(
      p.text({ message: "base_url(如 https://llm.internal/v1)", validate: req }),
    );
    const api = (await ask(
      p.select({
        message: "接口协议?",
        options: [
          { value: "openai-completions", label: "openai-completions(绝大多数网关/本地模型)" },
          { value: "anthropic-messages", label: "anthropic-messages" },
          { value: "openai-responses", label: "openai-responses" },
          { value: "google-generative-ai", label: "google-generative-ai" },
        ],
      }),
    )) as string;
    const id = await ask(p.text({ message: "模型 id", validate: req }));
    const keyEnv = await ask(
      p.text({ message: "API key 环境变量名", defaultValue: "MY_GATEWAY_API_KEY", placeholder: "MY_GATEWAY_API_KEY" }),
    );
    return {
      model: {
        provider: provider.trim(),
        id: id.trim(),
        api,
        base_url: baseUrl.trim(),
        api_key_env: keyEnv.trim(),
      },
      envVars: [keyEnv.trim()],
    };
  }

  const id = await ask(
    p.text({
      message: "模型 id",
      defaultValue: idDefaults[choice] ?? "",
      placeholder: idDefaults[choice] ?? "模型 id(见各家模型目录)",
      validate: req,
    }),
  );
  return { model: { provider: choice, id: id.trim() }, envVars: [keyEnvDefaults[choice]!] };
}

const req = (v: string | undefined): string | undefined => (v && v.trim() ? undefined : "必填");

async function ask<T>(value: Promise<T | symbol>): Promise<T> {
  const v = await value;
  if (p.isCancel(v)) {
    p.cancel("已取消");
    process.exit(1);
  }
  return v as T;
}
