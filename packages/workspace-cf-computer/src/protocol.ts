/**
 * Pinery ↔ Cloudflare Computer 线协议(客户端与 Worker 的唯一真相源)。
 *
 * 形态:adapter 是常驻 Node/Bun 进程(飞书长连接),Computer 的 Workspace 活在
 * Durable Object 里 —— 两者只能经 HTTP 通信:
 *
 *   adapter(@pinery/workspace-cf-computer)
 *      │  POST /v1/ws/:workspaceId/rpc   Bearer <token>
 *      ▼
 *   Worker(deploy/cloudflare)→ DO stub → Workspace(VFS + backends)
 *
 * 单端点 + op 判别联合,便于批量与鉴权收口;所有路径均为**工作区内绝对路径**
 * (以 / 开头),由 Worker 侧再做一次围栏。
 */

export const PROTOCOL_VERSION = 1;

/** 工作区内的绝对路径根 */
export const WORKSPACE_ROOT = "/workspace";

export type WireRequest =
  | { op: "stat"; path: string }
  | { op: "readFile"; path: string; encoding?: "utf8" | "base64" }
  | { op: "writeFile"; path: string; content: string; encoding?: "utf8" | "base64" }
  | { op: "mkdir"; path: string }
  | { op: "rm"; path: string; recursive?: boolean }
  | { op: "readdir"; path: string; limit?: number }
  | { op: "find"; path: string; pattern: string; limit?: number }
  | { op: "grep"; path: string; pattern: string; glob?: string; ignoreCase?: boolean; literal?: boolean; limit?: number }
  | { op: "exec"; command: string; cwd?: string; timeoutMs?: number; backend?: string }
  | { op: "gitClone"; url: string; ref?: string; depth?: number }
  | { op: "gitPull"; ref?: string }
  | { op: "info" };

export type WireOp = WireRequest["op"];

export interface WireStatResult {
  exists: boolean;
  isFile: boolean;
  isDirectory: boolean;
  size: number;
}

export interface WireDirent {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

export interface WireGrepMatch {
  path: string;
  line: number;
  text: string;
}

export interface WireExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface WireInfo {
  protocol: number;
  workspaceId: string;
  backends: string[];
  /** 已 clone 的仓库(便于 provider 判断是否需要初始化) */
  repo?: { url: string; ref?: string; head?: string };
  /** 上次 clone/pull 的时间戳(ms),provider 据此决定是否刷新 */
  syncedAt?: number;
}

export type WireResultMap = {
  stat: WireStatResult;
  readFile: { content: string; encoding: "utf8" | "base64" };
  writeFile: Record<string, never>;
  mkdir: Record<string, never>;
  rm: Record<string, never>;
  readdir: { entries: WireDirent[] };
  find: { paths: string[] };
  grep: { matches: WireGrepMatch[] };
  exec: WireExecResult;
  gitClone: { head?: string };
  gitPull: { updated: boolean; detail?: string };
  info: WireInfo;
};

export type WireResponse<Op extends WireOp = WireOp> =
  | { ok: true; result: WireResultMap[Op] }
  | { ok: false; error: { code: WireErrorCode; message: string } };

export type WireErrorCode =
  | "unauthorized"
  | "bad_request"
  | "not_found"
  | "path_escape"
  | "no_backend"
  | "exec_failed"
  | "internal";

/** HTTP 状态码 → 线错误码(客户端与 Worker 共用,保持一致) */
export const ERROR_STATUS: Record<WireErrorCode, number> = {
  unauthorized: 401,
  bad_request: 400,
  not_found: 404,
  path_escape: 403,
  no_backend: 503,
  exec_failed: 500,
  internal: 500,
};

/**
 * 工作区内路径归一化 + 围栏。返回归一化的绝对路径;越界返回 undefined。
 * 客户端与 Worker 双侧执行(纵深:客户端防误用,Worker 防恶意)。
 */
export function normalizeWorkspacePath(input: string, root = WORKSPACE_ROOT): string | undefined {
  if (!input) return undefined;
  const raw = input.startsWith("/") ? input : `${root}/${input}`;
  const segments: string[] = [];
  for (const seg of raw.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(seg);
  }
  const normalized = `/${segments.join("/")}`;
  const rootSegments = root.split("/").filter(Boolean);
  // 必须仍在 root 之内
  for (let i = 0; i < rootSegments.length; i++) {
    if (segments[i] !== rootSegments[i]) return undefined;
  }
  return normalized;
}
