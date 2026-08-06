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
  normalizeWorkspacePath,
  splitRepoCredentials,
  type WireErrorCode,
  type WireRequest,
} from "@pinery/workspace-cf-computer/protocol";
import { execDeadline, withDeadline } from "./exec-deadline.js";
import { REPO_MARKER, type RepoMarker } from "./repo-marker.js";
import { InvalidPatternError, matchGlob, regexGrep, type GrepFilesystem } from "./search.js";

/**
 * Pinery Cloudflare Worker(S2 实验路径)。
 *
 * 每个工作区 = 一个 Durable Object:SQLite VFS 持久,DO 休眠即封存、
 * 请求到达自动唤醒(与 Pinery 的 thread 封存/唤醒模型同构)。
 * 对外只暴露 Pinery 线协议,鉴权用共享密钥(wrangler secret put PINERY_TOKEN)。
 *
 * ⚠️ @cloudflare/computer 目前是 PREVIEW,API 可能变动,已 pin 到 0.1.1。
 */

interface Env {
  // 不参数化:PineryWorkspace 由 mixin 生成,参数化会造成类型自引用
  WORKSPACE: DurableObjectNamespace;
  LOADER: unknown;
  PINERY_TOKEN: string;
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
})) {}

class WireError extends Error {
  constructor(
    public readonly code: WireErrorCode,
    message: string,
  ) {
    super(message);
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

/** 服务端路径围栏(纵深第二层:客户端已归一化过,这里不信任) */
function guardPath(input: string | undefined): string {
  const normalized = normalizeWorkspacePath(input ?? WORKSPACE_ROOT);
  if (!normalized) throw new WireError("path_escape", `路径越出工作区:${input}`);
  return normalized;
}

async function readMarker(ws: { fs: { readFile: (p: string, e: "utf8") => Promise<string> } }): Promise<RepoMarker | undefined> {
  try {
    return JSON.parse(await ws.fs.readFile(REPO_MARKER, "utf8")) as RepoMarker;
  } catch {
    return undefined;
  }
}

async function writeMarker(
  ws: { fs: { writeFile: (p: string, c: string) => Promise<void> } },
  marker: RepoMarker,
): Promise<void> {
  await ws.fs.writeFile(REPO_MARKER, JSON.stringify(marker));
}

async function handleRpc(handle: WorkspaceHandle, workspaceId: string, req: WireRequest): Promise<unknown> {
  using ws = await getWorkspace(handle);

  switch (req.op) {
    case "info": {
      const marker = await readMarker(ws);
      return {
        protocol: PROTOCOL_VERSION,
        workspaceId,
        backends: ["worker-shell"],
        repo: marker ? { url: marker.url, ref: marker.ref } : undefined,
        syncedAt: marker?.syncedAt,
      };
    }

    case "stat": {
      const path = guardPath(req.path);
      try {
        const st = await ws.fs.stat(path);
        return { exists: true, isFile: st.isFile, isDirectory: st.isDirectory, size: st.size };
      } catch {
        return { exists: false, isFile: false, isDirectory: false, size: 0 };
      }
    }

    case "readFile": {
      const path = guardPath(req.path);
      const encoding = req.encoding ?? "utf8";
      try {
        if (encoding === "utf8") {
          return { content: await ws.fs.readFile(path, "utf8"), encoding: "utf8" };
        }
        const stream = await ws.fs.readFile(path);
        const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
        let binary = "";
        for (const b of bytes) binary += String.fromCharCode(b);
        return { content: btoa(binary), encoding: "base64" };
      } catch (e) {
        throw new WireError("not_found", `读取失败 ${path}:${(e as Error).message}`);
      }
    }

    case "writeFile": {
      const path = guardPath(req.path);
      const content =
        req.encoding === "base64" ? Uint8Array.from(atob(req.content), (c) => c.charCodeAt(0)) : req.content;
      const parent = path.slice(0, path.lastIndexOf("/"));
      if (parent) await ws.fs.mkdir(parent, { recursive: true }).catch(() => {});
      await ws.fs.writeFile(path, content);
      return {};
    }

    case "mkdir": {
      await ws.fs.mkdir(guardPath(req.path), { recursive: true });
      return {};
    }

    case "rm": {
      await ws.fs.rm(guardPath(req.path), { recursive: req.recursive ?? false }).catch(() => {});
      return {};
    }

    case "readdir": {
      const entries = await ws.fs.readdir(guardPath(req.path), req.limit ? { limit: req.limit } : undefined);
      return { entries: entries.map((e) => ({ name: e.name, isFile: e.isFile, isDirectory: e.isDirectory })) };
    }

    case "find": {
      const found = await ws.fs.find(guardPath(req.path), req.pattern);
      const limit = req.limit ?? 1000;
      return {
        paths: found
          .filter((f) => f.type === "file")
          .slice(0, limit)
          .map((f) => f.path),
      };
    }

    case "grep": {
      // Matching happens server-side; only hit lines travel back (no repo transfer).
      //
      // Computer's VFS grep is substring-only (`text.includes(needle)`), so it
      // implements the tool's `literal: true` mode exactly and cannot implement
      // the regex mode the tool offers by default. Regex is therefore evaluated
      // here, over the same VFS.
      const path = guardPath(req.path);
      const limit = req.limit ?? 100;
      const matches = req.literal
        ? await ws.fs.grep(req.pattern, path, { ignoreCase: req.ignoreCase })
        : await regexGrep(ws.fs as unknown as GrepFilesystem, path, req);
      const globbed = req.glob ? matches.filter((m) => matchGlob(m.path, req.glob as string)) : matches;
      return { matches: globbed.slice(0, limit) };
    }

    case "exec": {
      const cwd = guardPath(req.cwd ?? WORKSPACE_ROOT);
      // timeoutMs must reach the runtime: without it a non-terminating command
      // (`tail -f`) keeps running after the client gives up on the HTTP request,
      // holding resources and able to keep mutating a task workspace.
      const timeoutMs = execDeadline(req.timeoutMs);
      using run = await ws.runtime.exec(req.command, {
        encoding: "utf8",
        cwd,
        timeoutMs,
        ...(req.backend ? { backend: req.backend } : {}),
      });
      // Second layer: a backend that ignores timeoutMs must not turn into an
      // unbounded await here. On expiry the run is killed explicitly.
      const result = await withDeadline(
        run,
        timeoutMs,
        (ms) => new WireError("exec_failed", `命令执行超过 ${Math.round(ms / 1000)}s 已终止`),
      );
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? null,
      };
    }

    case "gitClone": {
      // isomorphic-git 无 SSH 传输:URL 必须是 HTTPS(provider 侧也会校验)
      if (!/^https:\/\//i.test(req.url)) {
        throw new WireError("bad_request", `CF 路径只支持 HTTPS 仓库地址(收到:${req.url})`);
      }
      // 幂等:多个 adapter 副本可能同时请求初始化同一工作区。DO 天然串行,
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

    case "gitPull": {
      // 会话工作区的 VFS 是持久的:不刷新就会一直基于初次克隆回答
      const marker = await readMarker(ws);
      if (!marker) throw new WireError("not_found", "工作区尚未初始化,请先 gitClone");
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

    default: {
      const exhaustive: never = req;
      throw new WireError("bad_request", `未知操作:${JSON.stringify(exhaustive)}`);
    }
  }
}


export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") return json({ ok: true, protocol: PROTOCOL_VERSION });

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
