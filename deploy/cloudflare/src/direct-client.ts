import type { WorkspaceHandle } from "@cloudflare/computer";
import { CfComputerError, type WorkspaceRpc } from "@pinery/workspace-cf-computer";
import {
  normalizeWorkspacePath,
  type WireOp,
  type WireRequest,
  type WireResultMap,
} from "@pinery/workspace-cf-computer/protocol";
import { WireError, handleRpc } from "./rpc.js";

/**
 * WorkspaceRpc 的 Worker 内直连实现:Agent DO → WORKSPACE DO stub → handleRpc,
 * 免去 HTTP 跳板与 Bearer 鉴权(同 Worker 内,信任边界为 binding)。
 * 错误映射与 CfComputerClient 对齐:WireError → CfComputerError(code 保留),
 * 上层 operations/provider 因此对两种传输零感知。
 */
export class DirectWorkspaceClient implements WorkspaceRpc {
  constructor(private readonly ns: DurableObjectNamespace) {}

  async call<Op extends WireOp>(
    workspaceId: string,
    request: Extract<WireRequest, { op: Op }>,
    _opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<WireResultMap[Op]> {
    // 客户端侧路径围栏(纵深第一层,与 HTTP 客户端同款;服务端 guardPath 是第二层)
    const withPath = request as { path?: unknown };
    if (typeof withPath.path === "string") {
      const normalized = normalizeWorkspacePath(withPath.path);
      if (!normalized) {
        throw new CfComputerError(`路径越出工作区:${withPath.path}`, "path_escape");
      }
      withPath.path = normalized;
    }

    const stub = this.ns.get(this.ns.idFromName(workspaceId));
    try {
      return (await handleRpc(stub as unknown as WorkspaceHandle, workspaceId, request)) as WireResultMap[Op];
    } catch (e) {
      if (e instanceof WireError) throw new CfComputerError(e.message, e.code);
      const message = e instanceof Error ? e.message : String(e);
      throw new CfComputerError(`调用 Workspace DO 失败(${request.op}):${message}`, "internal");
    }
  }
}
