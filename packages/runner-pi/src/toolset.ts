import { isAbsolute, relative, resolve } from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type BashToolOptions,
  type EditToolOptions,
  type FindToolOptions,
  type GrepToolOptions,
  type LsToolOptions,
  type ReadToolOptions,
  type ToolDefinition,
  type WriteToolOptions,
} from "@mariozechner/pi-coding-agent";
import { evaluateBashCommand, type PermissionLevel } from "@pinery/core";
import { createRemoteGrepToolDefinition, type RemoteGrepSearch } from "./remote-grep.js";

/**
 * 工具策略引擎(PRD §3.2,M1 安全地基):
 * 按 level 装配 pi 工具集,bash 经 spawnHook 做策略拦截 + 环境净化,
 * 文件类工具做工作区路径围栏。
 */

export class PolicyViolationError extends Error {
  constructor(
    message: string,
    public readonly rule?: string,
  ) {
    super(message);
    this.name = "PolicyViolationError";
  }
}

/** 密钥类环境变量模式(bash 子进程一律剥离) */
const SENSITIVE_ENV_PATTERN = /(secret|token|key|password|passwd|credential|auth)/i;

/** L0 最小环境白名单 */
const L0_ENV_ALLOWLIST = new Set([
  "PATH", "HOME", "SHELL", "USER", "LOGNAME", "TERM", "TMPDIR", "LANG",
  "LC_ALL", "LC_CTYPE", "TZ", "PWD",
]);

/**
 * bash 子进程环境净化:
 * - L0:白名单制,只保留最小集合(进程环境里有 LARK_APP_SECRET / 模型 key)
 * - L1+:黑名单制,剥离密钥类命名的变量(保留构建工具链所需的其余环境)
 */
export function sanitizeEnv(env: NodeJS.ProcessEnv, level: PermissionLevel): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (level === 0) {
      if (L0_ENV_ALLOWLIST.has(k)) out[k] = v;
    } else if (!SENSITIVE_ENV_PATTERN.test(k)) {
      out[k] = v;
    }
  }
  // 禁用 pager 类交互
  out["GIT_PAGER"] = "cat";
  out["PAGER"] = "cat";
  return out;
}

/** 工作区路径围栏:相对路径按工作区解析,越界即拒(纵深防御,硬边界在容器只读挂载) */
export function assertInsideWorkspace(workspaceDir: string, p: string, toolName: string): void {
  const abs = isAbsolute(p) ? p : resolve(workspaceDir, p);
  const rel = relative(resolve(workspaceDir), abs);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  throw new PolicyViolationError(`${toolName} 拒绝访问工作区外路径:${p}`, "path-escape");
}

type AnyToolDefinition = ToolDefinition<any, any, any>;

function withPathGuard(def: AnyToolDefinition, workspaceDir: string): AnyToolDefinition {
  return {
    ...def,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const path = (params as { path?: unknown } | undefined)?.path;
      if (typeof path === "string" && path.length > 0) {
        assertInsideWorkspace(workspaceDir, path, def.name);
      }
      return def.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

/**
 * 远程工作区的工具委托(pi 七个内置工具均支持 Operations 注入)。
 * 本地工作区不传即用 pi 默认的本地文件系统实现;
 * 云沙箱后端(如 @cloudflare/computer 的 workspace.fs / runtime.exec)
 * 由 WorkspaceProvider 提供实现,见 docs/sandbox-evaluation.md §4.2。
 */
export interface RemoteToolOperations {
  read?: ReadToolOptions["operations"];
  write?: WriteToolOptions["operations"];
  edit?: EditToolOptions["operations"];
  grep?: GrepToolOptions["operations"];
  find?: FindToolOptions["operations"];
  ls?: LsToolOptions["operations"];
  bash?: BashToolOptions["operations"];
  /**
   * 服务端搜索。提供时**整体替换** pi 的 grep 工具:
   * pi 内置 grep 无条件在本地 spawn ripgrep(注入的 GrepOperations 仅用于
   * 取上下文行),远程工作区上会搜错文件系统。见 remote-grep.ts。
   */
  grepSearch?: RemoteGrepSearch;
}

export interface BuildToolsetOptions {
  cwd: string;
  level: PermissionLevel;
  /** 策略拦截时回调(审计/进度) */
  onPolicyBlock?: (info: { tool: string; command: string; rule?: string; reason: string }) => void;
  /** 远程工作区委托;缺省直接操作本地文件系统 */
  operations?: RemoteToolOperations;
}

/**
 * 按级别装配工具集:
 * - L0:read/grep/find/ls + 受策略约束的 bash(只读白名单)
 * - L1+:read/bash/edit/write + grep/find/ls(bash denylist;交付面命令在
 *   会话内一律拒绝——push/PR 是 adapter 卡片确认后的带外动作,PRD §3.6)
 */
export function buildToolset(options: BuildToolsetOptions): AnyToolDefinition[] {
  const { cwd, level, onPolicyBlock, operations } = options;

  const bashDef = createBashToolDefinition(cwd, {
    ...(operations?.bash ? { operations: operations.bash } : {}),
    spawnHook: (ctx) => {
      const verdict = evaluateBashCommand(ctx.command, level);
      if (verdict.decision !== "allow") {
        const reason =
          verdict.decision === "confirm"
            ? `${verdict.reason ?? "该命令属交付面操作"}(请完成任务后在飞书卡片中确认,由 Pinery 带外执行)`
            : (verdict.reason ?? "命令被策略拒绝");
        onPolicyBlock?.({ tool: "bash", command: ctx.command, rule: verdict.rule, reason });
        throw new PolicyViolationError(`[pinery-policy] ${reason}`, verdict.rule);
      }
      return { ...ctx, env: sanitizeEnv(ctx.env, level) };
    },
  });

  const ops = <K extends keyof RemoteToolOperations>(k: K) =>
    operations?.[k] ? { operations: operations[k] } : undefined;

  const grepDef: AnyToolDefinition = operations?.grepSearch
    ? createRemoteGrepToolDefinition(operations.grepSearch)
    : createGrepToolDefinition(cwd, ops("grep"));

  const readOnly: AnyToolDefinition[] = [
    createReadToolDefinition(cwd, ops("read")),
    grepDef,
    createFindToolDefinition(cwd, ops("find")),
    createLsToolDefinition(cwd, ops("ls")),
  ];
  const defs: AnyToolDefinition[] =
    level === 0
      ? [...readOnly, bashDef]
      : [
          ...readOnly,
          bashDef,
          createEditToolDefinition(cwd, ops("edit")),
          createWriteToolDefinition(cwd, ops("write")),
        ];

  return defs.map((d) => withPathGuard(d, cwd));
}

/** 工具调用的单行描述(进度卡片与审计用;截断防刷屏) */
export function describeToolCall(tool: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  let detail = "";
  switch (tool) {
    case "bash":
      detail = str(a["command"]);
      break;
    case "read":
      detail = str(a["path"]);
      break;
    case "grep":
      detail = `${str(a["pattern"])}${a["path"] ? ` in ${str(a["path"])}` : ""}`;
      break;
    case "find":
      detail = str(a["pattern"]);
      break;
    case "ls":
      detail = str(a["path"]) || ".";
      break;
    case "edit":
    case "write":
      detail = str(a["path"]);
      break;
    default:
      detail = JSON.stringify(a).slice(0, 80);
  }
  detail = detail.replace(/\s+/g, " ").trim();
  return detail.length > 120 ? `${detail.slice(0, 117)}…` : detail;
}

/** 从工具调用提取触达文件(文件级缓存地基;只记确定的文件路径) */
export function extractTouchedFile(tool: string, args: unknown): string | undefined {
  if (tool !== "read" && tool !== "edit" && tool !== "write") return undefined;
  const path = (args as { path?: unknown } | undefined)?.path;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}
