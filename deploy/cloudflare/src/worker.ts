import {
  getWorkspace,
  withWorkspace,
  type DurableObjectStorageLike,
  type WorkspaceHandle,
} from "@cloudflare/computer";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import { createGitClient } from "@cloudflare/computer/git";
import { DurableObject } from "cloudflare:workers";
import {
  ERROR_STATUS,
  PROTOCOL_VERSION,
  WORKSPACE_ROOT,
  splitRepoCredentials,
  type WireErrorCode,
  type WireRequest,
} from "@pinery/workspace-cf-computer/protocol";
import { handleLarkEvents } from "./lark-route.js";
import { WireError, handleRpc, readMarker, writeMarker, type GitOpFailure } from "./rpc.js";

export { PineryAgent } from "./agent.js";

/**
 * Pinery Cloudflare Worker。
 *
 * 每个工作区 = 一个 Durable Object:SQLite VFS 持久,DO 休眠即封存、
 * 请求到达自动唤醒(与 Pinery 的 thread 封存/唤醒模型同构)。
 * 线协议执行点在 rpc.ts(HTTP 路由与 CF 形态的 DirectWorkspaceClient 共用);
 * 本文件只剩路由、鉴权与 DO 类导出。
 * 对外 HTTP 入口鉴权用共享密钥(wrangler secret put PINERY_TOKEN)。
 *
 * ⚠️ @cloudflare/computer 目前是 PREVIEW,API 可能变动,已 pin 到 0.1.1。
 */

interface Env {
  // 不参数化:PineryWorkspace 由 mixin 生成,参数化会造成类型自引用
  WORKSPACE: DurableObjectNamespace;
  AGENT: DurableObjectNamespace;
  LOADER: unknown;
  PINERY_TOKEN: string;
  PINERY_CONFIG?: string;
  [key: string]: unknown;
}

/**
 * 基类:把 DurableObject 的 protected 成员(ctx/env)以公开只读访问器暴露,
 * 供 withWorkspace 的 options 工厂读取(工厂在类体外,拿不到 protected)。
 */
class WorkspaceBase extends DurableObject<Env> {
  /**
   * 运行时就是 DurableObjectStorage;显式收敛是因为 computer@0.1.1 的
   * `DurableObjectStorageLike` 用泛型 Row 声明 sql.exec,与 workers-types v5 的
   * `Record<string, SqlStorageValue>` 存在型变冲突(纯类型层面,形状一致)。
   */
  get storage(): DurableObjectStorageLike {
    return this.ctx.storage as unknown as DurableObjectStorageLike;
  }
  get execCtx(): DurableObjectState {
    return this.ctx;
  }
  get loaderBinding(): unknown {
    return this.env.LOADER;
  }
  get workspaceDoId(): string {
    return this.ctx.id.toString();
  }
}

export class PineryWorkspace extends withWorkspace(WorkspaceBase, (self) => ({
  storage: self.storage,
  git: createGitClient(),
  defaultGitIdentity: { name: "Pinery", email: "pinery@localhost" },
  backends: [
    new WorkerShellBackend({
      loader: self.loaderBinding as never,
      workspace: { binding: "WORKSPACE", id: self.workspaceDoId },
      ctx: self.execCtx as never,
    }),
  ],
})) {
  // clone/pull 是 DO 自有 RPC 方法:computer 0.1.1 跨 RPC 边界的 git stub 只暴露
  // cli(argv),而 argv 形式的凭据只能进 URL(会被 isomorphic-git 写进 .git/config,
  // agent 读得到)。本地 getWorkspace(this) 直通 Workspace 对象,typed API 的
  // headers 凭据语义(不落盘)得以保留。错误以值返回:自定义 Error 跨 RPC 丢原型。

  async gitCloneOp(req: { url: string; ref?: string; depth?: number }): Promise<GitOpFailure | Record<string, never>> {
    using ws = await getWorkspace(this);
    // isomorphic-git 无 SSH 传输:URL 必须是 HTTPS(provider 侧也会校验)
    if (!/^https:\/\//i.test(req.url)) {
      return { error: { code: "bad_request", message: `CF 路径只支持 HTTPS 仓库地址(收到:${req.url})` } };
    }
    // 幂等:多个调用方可能同时请求初始化同一工作区。DO 天然串行,
    // 所以「检查 marker + clone」在这里是原子的;已是同一仓库就直接返回,
    // 避免第二次 clone 在第一次的调查读取过程中改写 WORKSPACE_ROOT。
    const existing = await readMarker(ws);
    const { url, headers } = splitRepoCredentials(req.url);
    if (existing?.url === url) return {};
    // 凭据走 Authorization 头,**不进 URL**:isomorphic-git 会把 clone 用的
    // 地址写进 WORKSPACE_ROOT/.git/config 的 remote origin,而那是 agent
    // 读得到的文件(cat .git/config)。
    await ws.git.clone({
      url,
      dir: WORKSPACE_ROOT,
      ...(headers ? { headers } : {}),
      ...(req.ref ? { ref: req.ref } : {}),
      ...(req.depth !== undefined ? { depth: req.depth } : {}),
    });
    // 只记脱敏地址:凭据留在请求里,不写入任何持久介质
    await writeMarker(ws, { url, ref: req.ref, syncedAt: Date.now() });
    return {};
  }

  async gitPullOp(req: { ref?: string; url?: string }): Promise<GitOpFailure | { updated: boolean; detail?: string }> {
    using ws = await getWorkspace(this);
    // 会话工作区的 VFS 是持久的:不刷新就会一直基于初次克隆回答
    const marker = await readMarker(ws);
    if (!marker) return { error: { code: "not_found", message: "工作区尚未初始化,请先 gitClone" } };
    // remote origin 存的是脱敏地址,私有仓库的 pull 因此拿不到凭据 ——
    // 由请求方在每次调用时带上来源地址,这里同样只取认证头
    const auth = req.url ? splitRepoCredentials(req.url) : undefined;
    try {
      await ws.git.pull({
        dir: WORKSPACE_ROOT,
        ...(req.ref ?? marker.ref ? { ref: (req.ref ?? marker.ref) as string } : {}),
        ...(auth?.headers ? { headers: auth.headers } : {}),
        singleBranch: true,
        fastForwardOnly: true, // 只读工作区不产生合并提交
      });
      await writeMarker(ws, { ...marker, syncedAt: Date.now() });
      return { updated: true };
    } catch (e) {
      // 浅克隆下的 pull 可能失败(非 ff、历史不足);标记已尝试,避免每次提问都重试
      await writeMarker(ws, { ...marker, syncedAt: Date.now() });
      return { updated: false, detail: (e as Error).message };
    }
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fail(code: WireErrorCode, message: string): Response {
  return json({ ok: false, error: { code, message } }, ERROR_STATUS[code]);
}

/** 常量时间比较,避免 token 逐字符时序泄漏 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") return json({ ok: true, protocol: PROTOCOL_VERSION });

    // CF 形态:飞书 webhook 事件入口(验签/解密在路由内,不走 Bearer 鉴权)
    if (url.pathname === "/lark/events" && request.method === "POST") {
      return handleLarkEvents(request, env as never);
    }

    const match = url.pathname.match(/^\/v1\/ws\/([^/]+)\/rpc$/);
    if (!match || request.method !== "POST") {
      return fail("not_found", "未知路由;协议入口为 POST /v1/ws/:workspaceId/rpc");
    }

    const auth = request.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!env.PINERY_TOKEN || !safeEqual(token, env.PINERY_TOKEN)) {
      return fail("unauthorized", "鉴权失败");
    }

    const workspaceId = decodeURIComponent(match[1] as string);
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(workspaceId)) {
      return fail("bad_request", "非法 workspaceId");
    }

    let body: WireRequest;
    try {
      body = (await request.json()) as WireRequest;
    } catch {
      return fail("bad_request", "请求体不是合法 JSON");
    }
    if (!body || typeof body.op !== "string") return fail("bad_request", "缺少 op 字段");

    const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
    try {
      const result = await handleRpc(stub as unknown as WorkspaceHandle, workspaceId, body);
      return json({ ok: true, result });
    } catch (e) {
      if (e instanceof WireError) return fail(e.code, e.message);
      return fail("internal", `执行 ${body.op} 失败:${(e as Error).message}`);
    }
  },
} satisfies ExportedHandler<Env>;
