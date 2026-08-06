import {
  normalizeWorkspacePath,
  type WireOp,
  type WireRequest,
  type WireResponse,
  type WireResultMap,
} from "./protocol.js";

/** 远端返回的结构化错误(保留 code 便于上层区分「文件不存在」与「网络故障」) */
export class CfComputerError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "CfComputerError";
  }
  get isNotFound(): boolean {
    return this.code === "not_found";
  }
}

/** 瞬时故障(5xx/429/网络层):幂等操作可重试,不暴露给调用方 */
class TransientError extends Error {}

export interface CfComputerClientOptions {
  /** Worker 端点,如 https://pinery-computer.acme.workers.dev */
  endpoint: string;
  /** 共享密钥(Bearer);来自环境变量,不落盘 */
  token: string;
  /** 单次请求超时(默认 60s;exec 用自己的超时) */
  requestTimeoutMs?: number;
  /** 瞬时故障重试次数(默认 2;仅幂等读操作与网络层错误重试) */
  retries?: number;
  /** 注入 fetch(测试用) */
  fetch?: typeof globalThis.fetch;
}

const IDEMPOTENT_OPS = new Set<WireOp>(["stat", "readFile", "readdir", "find", "grep", "info"]);

/**
 * Worker RPC 客户端。职责刻意最小:鉴权、超时、重试、错误映射。
 * 语义映射(pi Operations ↔ 线协议)在 operations.ts。
 */
export class CfComputerClient {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly requestTimeoutMs: number;
  private readonly retries: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: CfComputerClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.token = options.token;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.retries = options.retries ?? 2;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async call<Op extends WireOp>(
    workspaceId: string,
    request: Extract<WireRequest, { op: Op }>,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<WireResultMap[Op]> {
    // 客户端侧路径围栏(纵深第一层;Worker 侧还有一层)
    const withPath = request as { path?: unknown };
    if (typeof withPath.path === "string") {
      const normalized = normalizeWorkspacePath(withPath.path);
      if (!normalized) {
        throw new CfComputerError(`路径越出工作区:${withPath.path}`, "path_escape");
      }
      withPath.path = normalized;
    }

    const url = `${this.endpoint}/v1/ws/${encodeURIComponent(workspaceId)}/rpc`;
    const timeoutMs = opts.timeoutMs ?? this.requestTimeoutMs;
    const maxAttempts = IDEMPOTENT_OPS.has(request.op) ? this.retries + 1 : 1;

    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const timer = new AbortController();
      const timeout = setTimeout(() => timer.abort(), timeoutMs);
      const onOuterAbort = () => timer.abort();
      opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
      try {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.token}`,
          },
          body: JSON.stringify(request),
          signal: timer.signal,
        });

        const text = await res.text();
        let payload: WireResponse<Op> | undefined;
        try {
          payload = JSON.parse(text) as WireResponse<Op>;
        } catch {
          payload = undefined;
        }

        if (payload && !payload.ok) {
          // 结构化业务错误不重试:重试解决不了 404/403
          throw new CfComputerError(payload.error.message, payload.error.code, res.status);
        }
        if (!payload) {
          // 非 JSON 响应:5xx/429 视为瞬时故障(Worker 重启、CF 边缘错误)可重试;
          // 其余状态码是协议违约,直接失败
          const message = `Worker 返回非 JSON 响应(HTTP ${res.status}):${text.slice(0, 200)}`;
          if (res.status >= 500 || res.status === 429) throw new TransientError(message);
          throw new CfComputerError(message, "internal", res.status);
        }
        return payload.result;
      } catch (e) {
        lastError = e;
        // 业务错误与用户主动取消直接抛出;仅网络/超时重试
        if (e instanceof CfComputerError) throw e;
        if (opts.signal?.aborted) throw e;
        if (attempt === maxAttempts - 1) break;
        await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
      } finally {
        clearTimeout(timeout);
        opts.signal?.removeEventListener("abort", onOuterAbort);
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new CfComputerError(`调用 Worker 失败(${request.op}):${message}`, "internal");
  }
}
