import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getProviders } from "@mariozechner/pi-ai";
import { defaultApiKeyEnv, type RunnerModelConfig } from "@pinery/core";

/**
 * 模型接入泛化(经 pi 的 models.json 注册机制):
 *
 * - 内置 provider(pi-ai 已适配 anthropic/openai/google/deepseek/openrouter/
 *   cloudflare-workers-ai/vercel-ai-gateway 等 26 个):什么都不写也能用;
 *   配置 base_url/headers 时生成 provider 级覆写 → 全部请求改道
 *   (Cloudflare AI Gateway 就是这一形态)。
 * - 自定义 provider(自建网关/本地模型/CF Gateway compat 端点):要求
 *   base_url + api,注册为自定义模型。
 *
 * models.json 位于 pinery 专属 agentDir,由本模块按 pinery.yaml 声明式生成
 * (headers 可能含网关 token,文件权限 0600;请勿手工编辑,每次运行会重写)。
 */

export class ModelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelConfigError";
  }
}

export function isBuiltinProvider(provider: string): boolean {
  const providers = getProviders() as unknown as string[];
  return providers.includes(provider);
}

interface ModelsJson {
  providers: Record<
    string,
    {
      baseUrl?: string;
      api?: string;
      /**
       * pi 的 resolveConfigValue 语义:值先按环境变量名解析,再退回字面量,
       * "!cmd" 前缀则执行命令取 stdout。写 env 变量名即可让 secret 不落盘。
       */
      apiKey?: string;
      headers?: Record<string, string>;
      models?: Array<{ id: string; api?: string }>;
    }
  >;
}

/**
 * 由模型配置推导 models.json 内容。
 * 无任何覆写(纯内置 provider + 目录内模型)时返回 undefined。
 */
export function buildModelsConfig(m: RunnerModelConfig): ModelsJson | undefined {
  const builtin = isBuiltinProvider(m.provider);
  const hasOverride = !!(m.baseUrl || m.api || m.headers);

  if (builtin && !hasOverride) return undefined;

  if (!builtin) {
    if (!m.baseUrl) {
      throw new ModelConfigError(
        `自定义 provider「${m.provider}」需要配置 model.base_url(pi-ai 内置 provider:${(getProviders() as unknown as string[]).join(", ")})`,
      );
    }
    if (!m.api) {
      throw new ModelConfigError(
        `自定义 provider「${m.provider}」需要配置 model.api(openai-completions | anthropic-messages | openai-responses | google-generative-ai)`,
      );
    }
  }

  return {
    providers: {
      [m.provider]: {
        ...(m.baseUrl ? { baseUrl: m.baseUrl } : {}),
        ...(m.api ? { api: m.api } : {}),
        // 自定义 provider:pi 要求 apiKey 字段;写 env 变量名,请求时解析,不落盘
        ...(builtin ? {} : { apiKey: m.apiKeyEnv ?? defaultApiKeyEnv(m.provider) }),
        ...(m.headers ? { headers: m.headers } : {}),
        // 同时声明目标模型:内置 provider 时继承其 api/baseUrl 缺省,
        // 未收录的新模型 id 也因此可用
        models: [{ id: m.id, ...(m.api ? { api: m.api } : {}) }],
      },
    },
  };
}

/**
 * 把 models.json 声明式落盘(无覆写时清除旧文件,避免陈旧改道残留)。
 * 返回文件路径(未写入时 undefined)。
 */
export function syncModelsJson(agentDir: string, m: RunnerModelConfig): string | undefined {
  const path = join(agentDir, "models.json");
  const config = buildModelsConfig(m);
  if (!config) {
    if (existsSync(path)) rmSync(path);
    return undefined;
  }
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return path;
}
