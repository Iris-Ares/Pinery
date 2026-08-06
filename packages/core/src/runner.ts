import type { PermissionLevel } from "./levels.js";

/**
 * AgentRunner 窄接口(PRD §3.2 / §8-Q1)。
 *
 * 这是 adapter 与 harness 之间唯一的耦合面:pi 只是默认实现
 * (@pinery/runner-pi),社区可以提供 runner-claude-code 等替代实现。
 * 接口刻意保持窄:一次任务进去,事件流出来,结果返回。
 */

export type RunnerTaskKind = "investigate" | "code" | "bootstrap";

export interface RunnerTask {
  /** 任务 id(uuid),用于审计与轨迹关联 */
  id: string;
  kind: RunnerTaskKind;
  /** 用户原始诉求(已剥离 @ 提及) */
  prompt: string;
  /** 注入的上下文:上一轮结论摘要、glossary 提示等(数据非指令框架由 runner 负责) */
  context?: string;
  /** 续跑凭据:上次 RunnerResult.sessionRef,存在则 resume 同一会话 */
  resume?: string;
}

export interface RunnerWorkspace {
  /** repo 名(pinery.yaml 中的 name) */
  repo: string;
  /** agent 的工作目录(L0 共享 checkout / L1+ 独立 worktree) */
  dir: string;
  /** true 时 runner 必须以只读工具集运行 */
  readOnly: boolean;
  /** L1+ 任务分支名(pinery/task-<id>) */
  branch?: string;
}

export interface RunnerModelConfig {
  provider: string;
  id: string;
  /** API key 所在环境变量名,缺省按 provider 惯例(如 OPENROUTER_API_KEY) */
  apiKeyEnv?: string;
  /** 接口协议(openai-completions / anthropic-messages …);自定义 provider 必填 */
  api?: string;
  /** 端点覆写:CF AI Gateway / 代理 / 本地模型 */
  baseUrl?: string;
  /** 附加请求头(值已完成环境变量插值) */
  headers?: Record<string, string>;
  thinking?: "off" | "minimal" | "low" | "medium" | "high";
}

/** runner 产生的过程事件:adapter 转为进度卡片与审计日志 */
export type RunnerEvent =
  | { type: "tool_start"; tool: string; detail: string }
  | { type: "tool_end"; tool: string; ok: boolean; detail?: string }
  | { type: "turn"; n: number }
  | { type: "policy_block"; tool: string; reason: string }
  | { type: "note"; text: string };

export interface RunnerRunOptions {
  level: PermissionLevel;
  maxTurns: number;
  timeoutMs: number;
  signal?: AbortSignal;
  onEvent?: (event: RunnerEvent) => void;
  model?: RunnerModelConfig;
}

export type RunnerAbortReason = "timeout" | "user" | "turn-limit";

export interface RunnerUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface RunnerResult {
  ok: boolean;
  /** 最终 markdown 回答(未过 secret 过滤,出站过滤是 adapter 的职责) */
  answer: string;
  /** 续跑凭据(pi 实现为 session 文件路径) */
  sessionRef?: string;
  turns: number;
  toolCalls: number;
  /** 本次触达的文件相对路径(尽力收集,文件级缓存的地基) */
  filesTouched: string[];
  usage?: RunnerUsage;
  aborted?: RunnerAbortReason;
  error?: string;
}

export interface AgentRunner {
  readonly kind: string;
  run(task: RunnerTask, workspace: RunnerWorkspace, opts: RunnerRunOptions): Promise<RunnerResult>;
}
