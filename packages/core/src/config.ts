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
  /** 聊天中的自然称呼/简称;用于意图路由,不要求用户理解 workspace */
  aliases: z.array(z.string().min(1)).default([]),
  url: z.string().min(1),
  /** CF Computer 预水合快照 workspace;必须按仓库显式绑定,不得跨仓共用 */
  snapshot_id: z
    .string()
    .regex(/^s-[A-Za-z0-9._-]{1,126}$/, "snapshot_id 必须以 s- 开头,且只含安全字符(最长 128)")
    .optional(),
  /** 本地 checkout 路径;缺省 <workspace.root>/repos/<name> */
  path: z.string().optional(),
  /** 可选的群默认项目提示;不是默认访问白名单 */
  chats: z.array(z.string()).default([]),
  permissions: z.array(permissionEntrySchema).default([]),
  /** 群聊默认开放 L0;关闭后只有 chats 登记群或显式 permissions 用户可访问 */
  group_open: z.boolean().default(true),
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
  /** 硬超时前预留给停止探索、整理已有证据与输出结论的时间 */
  synthesis_reserve_sec: z.number().nonnegative().max(3600).default(30),
  /** thread 空闲多久后封存(fresh + 注入摘要续接) */
  session_idle_archive_min: z.number().positive().default(240),
  max_concurrent_tasks: z.number().int().positive().default(2),
  answer_max_chars: z.number().int().positive().default(3500),
  document_read_max_chars: z.number().int().positive().max(100_000).default(12_000),
  document_write_max_chars: z.number().int().positive().max(20_000).default(20_000),
  document_confirmation_timeout_min: z.number().positive().max(1440).default(10),
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
    /** OpenAPI 基地址覆盖(飞书私有化部署/本地端到端;缺省按 endpoint 推导) */
    api_base: z.string().optional(),
    /** webhook 形态(CF 部署)的事件解密密钥;长连接形态不需要 */
    encrypt_key: z.string().optional(),
    /** webhook 形态的 Verification Token(challenge/事件 token 弱校验,可选) */
    verification_token: z.string().optional(),
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

/** 按 chat 获取可选默认项目;单项目直接返回,不把聊天绑定暴露为产品概念。 */
export function repoForChat(
  cfg: PineryConfig,
  chatId: string,
  _chatType: "p2p" | "group",
): RepoConfig | undefined {
  const byChat = cfg.repos.find((r) => r.chats.includes(chatId));
  if (byChat) return byChat;
  if (cfg.repos.length === 1) return cfg.repos[0];
  return undefined;
}

export interface RepoIntentResolution {
  repo?: RepoConfig;
  candidates: RepoConfig[];
  source: "intent" | "session" | "chat-default" | "single" | "ambiguous";
}

/**
 * 聊天项目路由:明确名称/别名优先,然后延续话题项目、群默认项目、单项目。
 * 多项目未命中或多义时不猜,把候选交给上层生成澄清卡片。
 */
export function resolveRepoIntent(
  cfg: PineryConfig,
  input: { chatId: string; text: string; activeRepo?: string },
): RepoIntentResolution {
  const matches = cfg.repos.filter((repo) => repoIntentTerms(repo).some((term) => textMentionsTerm(input.text, term)));
  if (matches.length === 1) return { repo: matches[0], candidates: matches, source: "intent" };
  if (matches.length > 1) return { candidates: matches, source: "ambiguous" };

  if (input.activeRepo) {
    const active = cfg.repos.find((repo) => repo.name === input.activeRepo);
    if (active) return { repo: active, candidates: [active], source: "session" };
  }

  const chatDefaults = cfg.repos.filter((repo) => repo.chats.includes(input.chatId));
  if (chatDefaults.length === 1) {
    return { repo: chatDefaults[0], candidates: chatDefaults, source: "chat-default" };
  }
  if (chatDefaults.length > 1) return { candidates: chatDefaults, source: "ambiguous" };

  if (cfg.repos.length === 1) {
    return { repo: cfg.repos[0]!, candidates: [cfg.repos[0]!], source: "single" };
  }
  return { candidates: cfg.repos, source: "ambiguous" };
}

export function repoDisplayName(repo: RepoConfig): string {
  return repo.aliases[0] ?? repo.name;
}

function repoIntentTerms(repo: RepoConfig): string[] {
  const urlName = repo.url
    .replace(/[?#].*$/, "")
    .replace(/\/$/, "")
    .split("/")
    .at(-1)
    ?.replace(/\.git$/i, "");
  return [...new Set([repo.name, ...repo.aliases, urlName].filter((term): term is string => !!term && term.length >= 2))];
}

function textMentionsTerm(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (/^[A-Za-z0-9._-]+$/.test(term)) {
    return new RegExp(`(^|[^A-Za-z0-9])${escaped}(?=$|[^A-Za-z0-9])`, "i").test(text);
  }
  return text.toLocaleLowerCase().includes(term.toLocaleLowerCase());
}

/**
 * 解析用户在 repo 上的能力级别(PRD §3.5 鉴权规则)。
 * 返回 undefined = 无权限。
 * - 显式 permissions 条目优先
 * - 群聊默认开放 L0;group_open=false 时 chats 才成为限制
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
  if (chatType === "group" && (repo.group_open || chatRegistered)) return 0;
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
