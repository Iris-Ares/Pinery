import type { RemoteToolOperations } from "@pinery/runner-pi";
import { CfComputerError, type WorkspaceRpc } from "./client.js";

/**
 * pi 工具 Operations → Computer 远程调用的映射。
 *
 * 签名逐字段对齐 pi 的接口定义(ReadOperations / WriteOperations / …),
 * 语义差异在此吸收:
 * - pi 的 `access` 语义是「不可读就抛」→ 映射为 stat + 不存在则抛;
 * - pi 的 `readFile` 要 Buffer → 远端以 base64 回传后解码(二进制安全,图片可读);
 * - pi 的 `stat` 要返回带 isDirectory() 方法的对象 → 包一层;
 * - grep 不走 Operations(pi 会本地 spawn ripgrep),改用 grepSearch 整体替换工具。
 */

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

function extensionMime(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext ? (IMAGE_MIME[ext] ?? null) : null;
}

/** 把相对工作区根的路径还原为展示用相对路径(grep 结果用) */
function toRelative(path: string, root: string): string {
  if (path === root) return ".";
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

export interface RemoteOperationsOptions {
  client: WorkspaceRpc;
  workspaceId: string;
  /** 工作区根(pi 侧 cwd 与远端根一致) */
  root: string;
  /** exec 默认超时 */
  execTimeoutMs?: number;
  /** exec 使用的后端 id(如 worker-shell / container) */
  execBackend?: string;
}

export function createRemoteOperations(options: RemoteOperationsOptions): RemoteToolOperations {
  const { client, workspaceId, root } = options;
  const call: WorkspaceRpc["call"] = (id, req, o) => client.call(id, req, o);

  const readBuffer = async (absolutePath: string): Promise<Buffer> => {
    const res = await call(workspaceId, { op: "readFile", path: absolutePath, encoding: "base64" });
    return Buffer.from(res.content, "base64");
  };

  const readText = async (absolutePath: string): Promise<string> => {
    const res = await call(workspaceId, { op: "readFile", path: absolutePath, encoding: "utf8" });
    return res.content;
  };

  const assertAccessible = async (absolutePath: string): Promise<void> => {
    const st = await call(workspaceId, { op: "stat", path: absolutePath });
    if (!st.exists) throw new CfComputerError(`ENOENT: ${absolutePath}`, "not_found");
  };

  const writeText = async (absolutePath: string, content: string): Promise<void> => {
    await call(workspaceId, { op: "writeFile", path: absolutePath, content, encoding: "utf8" });
  };

  const exists = async (absolutePath: string): Promise<boolean> => {
    const st = await call(workspaceId, { op: "stat", path: absolutePath });
    return st.exists;
  };

  return {
    repositoryContext: {
      readText: async (absolutePath, maxBytes) => {
        const res = await call(workspaceId, {
          op: "readFile",
          path: absolutePath,
          encoding: "utf8",
          maxBytes,
        });
        return { text: res.content, truncated: res.truncated ?? false };
      },
      find: async (pattern, cwd, limit) => {
        const res = await call(workspaceId, {
          op: "find",
          path: cwd,
          pattern,
          limit,
        });
        return res.paths;
      },
    },

    read: {
      readFile: readBuffer,
      access: assertAccessible,
      // 远端不做内容嗅探:按扩展名判断,避免为每次 read 多跑一次往返
      detectImageMimeType: (p) => Promise.resolve(extensionMime(p)),
    },

    write: {
      writeFile: writeText,
      mkdir: async (dir) => {
        await call(workspaceId, { op: "mkdir", path: dir });
      },
    },

    edit: {
      readFile: readBuffer,
      writeFile: writeText,
      access: assertAccessible,
    },

    ls: {
      exists,
      stat: async (absolutePath) => {
        const st = await call(workspaceId, { op: "stat", path: absolutePath });
        if (!st.exists) throw new CfComputerError(`ENOENT: ${absolutePath}`, "not_found");
        // pi 期望 fs.Stats 风格:isDirectory 是方法而非字段
        return { isDirectory: () => st.isDirectory };
      },
      readdir: async (absolutePath) => {
        const res = await call(workspaceId, { op: "readdir", path: absolutePath });
        return res.entries.map((e) => e.name);
      },
    },

    find: {
      exists,
      glob: async (pattern, cwd, opts) => {
        const res = await call(workspaceId, {
          op: "find",
          path: cwd,
          pattern,
          limit: opts.limit,
        });
        // pi 允许返回绝对路径;ignore 由远端不处理时在此兜底过滤
        const ignore = opts.ignore ?? [];
        return res.paths.filter((p) => !ignore.some((ig) => p.includes(ig.replace(/^\*\*\//, "").replace(/\/\*\*$/, ""))));
      },
    },

    // grep 工具被整体替换(见 remote-grep.ts 的说明)
    grepSearch: async (query) => {
      const res = await call(workspaceId, {
        op: "grep",
        path: query.path ?? root,
        pattern: query.pattern,
        glob: query.glob,
        ignoreCase: query.ignoreCase,
        literal: query.literal,
        limit: query.limit,
      });
      return res.matches.map((m) => ({ ...m, path: toRelative(m.path, root) }));
    },

    bash: {
      exec: async (command, cwd, execOpts) => {
        const timeoutMs = execOpts.timeout ? execOpts.timeout * 1000 : options.execTimeoutMs;
        const res = await call(
          workspaceId,
          {
            op: "exec",
            command,
            cwd,
            timeoutMs,
            backend: options.execBackend,
          },
          { timeoutMs: timeoutMs ? timeoutMs + 5_000 : undefined, signal: execOpts.signal },
        );
        // pi 以流式 onData 收集输出;远端一次性返回,这里一次投递
        if (res.stdout) execOpts.onData(Buffer.from(res.stdout, "utf8"));
        if (res.stderr) execOpts.onData(Buffer.from(res.stderr, "utf8"));
        return { exitCode: res.exitCode };
      },
    },
  };
}

export { toRelative as __toRelativeForTests, extensionMime as __extensionMimeForTests };
