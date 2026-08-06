import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { isPermissionLevel, type PermissionLevel } from "./levels.js";
import type { RunnerModelConfig } from "./runner.js";

/** pinery.yaml schema(PRD §3.8) */

const permissionEntrySchema = z.object({
  user: z.string().min(1),
  level: z.number().int().min(0).max(3),
});

const repoSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9._-]+$/, "repo name 仅允许字母数字与 ._-"),
  url: z.string().min(1),
  /** 本地 checkout 路径;缺省 <workspace.root>/repos/<name> */
  path: z.string().optional(),
  /** L0 授权群 chat_id 列表 */
  chats: z.array(z.string()).default([]),
  permissions: z.array(permissionEntrySchema).default([]),
  /** 允许任何能私聊到 bot 的用户 L0 提问(组织内可见性由飞书后台控制) */
  p2p_open: z.boolean().default(true),
});

const modelSchema = z.object({
  /**
   * pi-ai 内置 provider 名(anthropic/openai/google/deepseek/openrouter/groq/xai/
   * mistral/cerebras/zai/cloudflare-workers-ai/vercel-ai-gateway…)或自定义名。
   */
  provider: z.string().default("openrouter"),
  id: z.string().default("deepseek/deepseek-chat"),
  /** API key 环境变量名;缺省按 provider 惯例(OPENROUTER_API_KEY 等) */
  api_key_env: z.string().optional(),
  /**
   * 接口协议:openai-completions | anthropic-messages | openai-responses |
   * google-generative-ai …(pi-ai Api 类型)。自定义 provider 必填;
   * 内置 provider 自动继承。
   */
  api: z.string().optional(),
  /**
   * 覆写 API 端点:走 Cloudflare AI Gateway / 自建代理 / 本地模型
   * (如 https://gateway.ai.cloudflare.com/v1/<acct>/<gw>/anthropic)。
   * 内置 provider 只写 base_url 即整体改道,api key 仍按 provider 惯例。
   */
  base_url: z.string().optional(),
  /** 附加请求头(如 CF AI Gateway 鉴权 cf-aig-authorization),值支持 ${ENV} 插值 */
  headers: z.record(z.string(), z.string()).optional(),
  thinking: z.enum(["off", "minimal", "low", "medium", "high"]).optional(),
});

const limitsSchema = z.object({
  session_max_turns: z.number().int().positive().default(20),
  task_timeout_min: z.number().positive().default(30),
  /** thread 空闲多久后封存(fresh + 注入摘要续接) */
  session_idle_archive_min: z.number().positive().default(240),
  max_concurrent_tasks: z.number().int().positive().default(2),
  answer_max_chars: z.number().int().positive().default(3500),
  rate_per_user_per_min: z.number().int().positive().default(6),
});

const workspaceSchema = z.object({
  root: z.string().default("~/.pinery"),
  /** 共享 checkout 的拉取间隔;0 = 关闭(交给 sidecar/宿主 cron) */
  pull_interval_min: z.number().min(0).default(10),
  /**
   * 工作区后端:local(默认,共享 checkout + git worktree)
   * 或导出 createWorkspaceProvider(cfg) 的模块名(云沙箱后端,见
   * docs/sandbox-evaluation.md)。
   */
  provider: z.string().default("local"),
  /**
   * provider 自定义配置(core 不解释内容,由各 provider 模块自读)。
   * 值支持 ${ENV} 插值,secret 走环境变量。
   * 例(CF Computer):{ endpoint: "https://x.workers.dev", token: "${PINERY_CF_TOKEN}" }
   */
  options: z.record(z.string(), z.string()).default({}),
});

const configSchema = z.object({
  lark: z.object({
    app_id: z.string().min(1),
    app_secret: z.string().min(1),
    endpoint: z.enum(["feishu", "lark"]).default("feishu"),
  }),
  repos: z.array(repoSchema).min(1),
  model: modelSchema.prefault({}),
  limits: limitsSchema.prefault({}),
  workspace: workspaceSchema.prefault({}),
  storage: z
    .object({
      /** SQLite 路径;缺省 <workspace.root>/pinery.db */
      path: z.string().optional(),
    })
    .prefault({}),
  runner: z
    .object({
      kind: z.string().default("pi"),
    })
    .prefault({}),
});

export type PineryConfig = z.infer<typeof configSchema>;
export type RepoConfig = PineryConfig["repos"][number];

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** ${VAR} 环境变量插值;缺失的变量收集后统一报错 */
export function interpolateEnv(raw: string, env: NodeJS.ProcessEnv = process.env): string {
  const missing = new Set<string>();
  const out = raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    const v = env[name];
    if (v === undefined) {
      missing.add(name);
      return "";
    }
    return v;
  });
  if (missing.size > 0) {
    throw new ConfigError(`环境变量缺失:${[...missing].join(", ")}(pinery.yaml 中以 \${VAR} 引用)`);
  }
  return out;
}

export function parseConfig(rawYaml: string, env: NodeJS.ProcessEnv = process.env): PineryConfig {
  const interpolated = interpolateEnv(rawYaml, env);
  let data: unknown;
  try {
    data = YAML.parse(interpolated);
  } catch (e) {
    throw new ConfigError(`pinery.yaml 解析失败:${(e as Error).message}`);
  }
  const parsed = configSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`pinery.yaml 校验失败:\n${issues}`);
  }
  return parsed.data;
}

export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): PineryConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(`找不到配置文件:${path}(先运行 pinery init)`);
  }
  return parseConfig(raw, env);
}

// ---------------------------------------------------------------------------
// 派生路径与鉴权辅助
// ---------------------------------------------------------------------------

export interface ResolvedPaths {
  root: string;
  storageDb: string;
  reposDir: string;
  worktreesDir: string;
  sessionsDir: string;
  /** pi 的 agentDir(隔离,不用 ~/.pi,避免吸入宿主机个人配置) */
  agentDir: string;
}

export function resolvePaths(cfg: PineryConfig): ResolvedPaths {
  const root = resolve(expandHome(cfg.workspace.root));
  return {
    root,
    storageDb: cfg.storage.path ? resolve(expandHome(cfg.storage.path)) : join(root, "pinery.db"),
    reposDir: join(root, "repos"),
    worktreesDir: join(root, "worktrees"),
    sessionsDir: join(root, "sessions"),
    agentDir: join(root, "agent"),
  };
}

export function repoCheckoutDir(cfg: PineryConfig, repo: RepoConfig): string {
  if (repo.path) {
    const p = expandHome(repo.path);
    return isAbsolute(p) ? p : resolve(p);
  }
  return join(resolvePaths(cfg).reposDir, repo.name);
}

/** 按 chat 定位 repo(M1 单 repo:群未登记时回退唯一 repo 的 p2p 语义) */
export function repoForChat(cfg: PineryConfig, chatId: string, chatType: "p2p" | "group"): RepoConfig | undefined {
  const byChat = cfg.repos.find((r) => r.chats.includes(chatId));
  if (byChat) return byChat;
  if (chatType === "p2p" && cfg.repos.length === 1) return cfg.repos[0];
  return undefined;
}

/**
 * 解析用户在 repo 上的能力级别(PRD §3.5 鉴权规则)。
 * 返回 undefined = 无权限。
 * - 显式 permissions 条目优先
 * - 群聊(chat 已登记):默认 L0(答案可见范围 = 群)
 * - 单聊:p2p_open 时默认 L0
 */
export function resolveUserLevel(
  repo: RepoConfig,
  userId: string,
  chatType: "p2p" | "group",
  chatRegistered: boolean,
): PermissionLevel | undefined {
  const entry = repo.permissions.find((p) => p.user === userId);
  if (entry && isPermissionLevel(entry.level)) return entry.level;
  if (chatType === "group" && chatRegistered) return 0;
  if (chatType === "p2p" && repo.p2p_open) return 0;
  return undefined;
}

/** 配置 → AgentRunner 模型参数(单一转换点,orchestrator 与 bootstrap 共用) */
export function runnerModelConfig(cfg: PineryConfig): RunnerModelConfig {
  const m = cfg.model;
  return {
    provider: m.provider,
    id: m.id,
    apiKeyEnv: m.api_key_env,
    api: m.api,
    baseUrl: m.base_url,
    headers: m.headers,
    thinking: m.thinking,
  };
}

/** provider → 默认 API key 环境变量(与 pi-ai findEnvKeys 约定对齐) */
export function defaultApiKeyEnv(provider: string): string {
  const map: Record<string, string> = {
    openrouter: "OPENROUTER_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    google: "GEMINI_API_KEY",
    groq: "GROQ_API_KEY",
    xai: "XAI_API_KEY",
    "cloudflare-workers-ai": "CLOUDFLARE_API_KEY",
    "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
    "azure-openai-responses": "AZURE_OPENAI_API_KEY",
    "kimi-coding": "KIMI_API_KEY",
    minimax: "MINIMAX_API_KEY",
    "minimax-cn": "MINIMAX_CN_API_KEY",
  };
  return map[provider] ?? `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}
