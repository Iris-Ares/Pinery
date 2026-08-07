import { getWorkspace, type WorkspaceHandle } from "@cloudflare/computer";
import {
  PROTOCOL_VERSION,
  WORKSPACE_ROOT,
  normalizeWorkspacePath,
  type WireErrorCode,
  type WireRequest,
} from "@pinery/workspace-cf-computer/protocol";
import { execDeadline, withDeadline } from "./exec-deadline.js";
import { REPO_MARKER, type RepoMarker } from "./repo-marker.js";
import { matchGlob, regexGrep, type GrepFilesystem } from "./search.js";

/**
 * 线协议的唯一执行点(原 worker.ts handleRpc 原样迁出):
 * - HTTP 路由(POST /v1/ws/:id/rpc,本地 adapter 混合形态)与
 * - DirectWorkspaceClient(CF 形态,Agent DO 内直连)
 * 共用本函数,两条传输路径语义零漂移。
 */

export class WireError extends Error {
  constructor(
    public readonly code: WireErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** 服务端路径围栏(纵深第二层:客户端已归一化过,这里不信任) */
function guardPath(input: string | undefined): string {
  const normalized = normalizeWorkspacePath(input ?? WORKSPACE_ROOT);
  if (!normalized) throw new WireError("path_escape", `路径越出工作区:${input}`);
  return normalized;
}

export async function readMarker(ws: { fs: { readFile: (p: string, e: "utf8") => Promise<string> } }): Promise<RepoMarker | undefined> {
  try {
    return JSON.parse(await ws.fs.readFile(REPO_MARKER, "utf8")) as RepoMarker;
  } catch {
    return undefined;
  }
}

export async function writeMarker(
  ws: {
    fs: {
      writeFile: (p: string, c: string) => Promise<void>;
      mkdir: (p: string, o?: { recursive?: boolean }) => Promise<unknown>;
    };
  },
  marker: RepoMarker,
): Promise<void> {
  const dir = REPO_MARKER.slice(0, REPO_MARKER.lastIndexOf("/"));
  if (dir) await ws.fs.mkdir(dir, { recursive: true }).catch(() => {});
  await ws.fs.writeFile(REPO_MARKER, JSON.stringify(marker));
}

/** git 网络操作的结构化结果(跨 RPC 边界自定义 Error 会丢原型,以值传错) */
export interface GitOpFailure {
  error: { code: WireErrorCode; message: string };
}

/**
 * clone/pull 由 PineryWorkspace 的自有 RPC 方法执行(worker.ts):
 * @cloudflare/computer 0.1.1 跨 RPC 边界的 WorkspaceGitStub 只暴露 `cli(argv)`,
 * typed git API(headers 凭据不进 .git/config 的关键)仅在 DO 本地可用。
 */
export interface WorkspaceGitOps {
  gitCloneOp(req: { url: string; ref?: string; depth?: number }): Promise<GitOpFailure | Record<string, never>>;
  gitPullOp(req: { ref?: string; url?: string }): Promise<GitOpFailure | { updated: boolean; detail?: string }>;
}

function unwrapGitOp<T extends object>(result: GitOpFailure | T): T {
  if ("error" in result && result.error) {
    const failure = result as GitOpFailure;
    throw new WireError(failure.error.code, failure.error.message);
  }
  return result as T;
}

export async function handleRpc(handle: WorkspaceHandle, workspaceId: string, req: WireRequest): Promise<unknown> {
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

    case "gitClone":
      return unwrapGitOp(
        await (handle as unknown as WorkspaceGitOps).gitCloneOp({ url: req.url, ref: req.ref, depth: req.depth }),
      );

    case "gitPull":
      return unwrapGitOp(await (handle as unknown as WorkspaceGitOps).gitPullOp({ ref: req.ref, url: req.url }));

    default: {
      const exhaustive: never = req;
      throw new WireError("bad_request", `未知操作:${JSON.stringify(exhaustive)}`);
    }
  }
}
