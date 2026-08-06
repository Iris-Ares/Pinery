import { createServer, type Server } from "node:http";
import { ERROR_STATUS, type WireRequest, type WireErrorCode } from "../src/protocol.js";

/**
 * 内存版假 Worker:实现同一套线协议,用真实 HTTP 跑端到端测试。
 * 这样客户端的鉴权、重试、错误映射、Operations 语义都在真实网络路径上验证,
 * 而不是靠 mock 断言调用参数。
 */

export interface FakeWorkerOptions {
  token: string;
  /** 前 N 次请求返回 500(验证重试) */
  failFirst?: number;
  /** 人为延迟(验证超时) */
  delayMs?: number;
  /** 指定 op 始终失败(验证单点故障下的降级) */
  failOps?: string[];
}

interface FileNode {
  content: Buffer;
}

export interface FakeWorker {
  url: string;
  close: () => Promise<void>;
  /** 请求计数,按 op 分类 */
  calls: string[];
  files: Map<string, FileNode>;
  execHandler: (command: string, cwd: string) => { stdout: string; stderr: string; exitCode: number };
  cloned?: { url: string; ref?: string };
  /** 让测试把远端同步时间往回调,模拟「工作区已陈旧」 */
  setSyncedAt: (ts: number | undefined) => void;
}

const ROOT = "/workspace";

export async function startFakeWorker(options: FakeWorkerOptions): Promise<FakeWorker> {
  const files = new Map<string, FileNode>();
  const calls: string[] = [];
  let remainingFailures = options.failFirst ?? 0;

  const state: Pick<FakeWorker, "execHandler" | "cloned"> & { syncedAt?: number; pulls: number } = {
    execHandler: () => ({ stdout: "", stderr: "", exitCode: 0 }),
    pulls: 0,
  };

  const dirsOf = (path: string): Set<string> => {
    const out = new Set<string>();
    for (const p of files.keys()) {
      if (!p.startsWith(`${path === ROOT ? ROOT : path}/`)) continue;
      const rest = p.slice(path.length + 1);
      const first = rest.split("/")[0]!;
      out.add(first);
    }
    return out;
  };

  const isDir = (path: string): boolean => {
    if (path === ROOT) return true;
    for (const p of files.keys()) if (p.startsWith(`${path}/`)) return true;
    return false;
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));

        const send = (status: number, body: unknown) => {
          const payload = JSON.stringify(body);
          res.writeHead(status, { "content-type": "application/json" });
          res.end(payload);
        };
        const failWith = (code: WireErrorCode, message: string) =>
          send(ERROR_STATUS[code], { ok: false, error: { code, message } });

        const auth = req.headers.authorization ?? "";
        if (auth !== `Bearer ${options.token}`) return failWith("unauthorized", "鉴权失败");

        if (!req.url?.match(/^\/v1\/ws\/[^/]+\/rpc$/) || req.method !== "POST") {
          return failWith("not_found", "未知路由");
        }

        if (remainingFailures > 0) {
          remainingFailures--;
          res.writeHead(500, { "content-type": "text/plain" });
          res.end("upstream boom");
          return;
        }

        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WireRequest;
        calls.push(body.op);

        if (options.failOps?.includes(body.op)) {
          return failWith("internal", `${body.op} 故障(测试注入)`);
        }

        switch (body.op) {
          case "info":
            return send(200, {
              ok: true,
              result: {
                protocol: 1,
                workspaceId: "fake",
                backends: ["worker-shell"],
                repo: state.cloned,
                syncedAt: state.syncedAt,
              },
            });

          case "gitPull":
            state.pulls++;
            state.syncedAt = Date.now();
            return send(200, { ok: true, result: { updated: true } });

          case "stat": {
            const f = files.get(body.path);
            if (f) return send(200, { ok: true, result: { exists: true, isFile: true, isDirectory: false, size: f.content.length } });
            if (isDir(body.path)) return send(200, { ok: true, result: { exists: true, isFile: false, isDirectory: true, size: 0 } });
            return send(200, { ok: true, result: { exists: false, isFile: false, isDirectory: false, size: 0 } });
          }

          case "readFile": {
            const f = files.get(body.path);
            if (!f) return failWith("not_found", `ENOENT ${body.path}`);
            const encoding = body.encoding ?? "utf8";
            return send(200, {
              ok: true,
              result: { content: encoding === "base64" ? f.content.toString("base64") : f.content.toString("utf8"), encoding },
            });
          }

          case "writeFile": {
            const content = body.encoding === "base64" ? Buffer.from(body.content, "base64") : Buffer.from(body.content, "utf8");
            files.set(body.path, { content });
            return send(200, { ok: true, result: {} });
          }

          case "mkdir":
            return send(200, { ok: true, result: {} });

          case "rm": {
            for (const p of [...files.keys()]) {
              if (p === body.path || (body.recursive && p.startsWith(`${body.path}/`))) files.delete(p);
            }
            return send(200, { ok: true, result: {} });
          }

          case "readdir": {
            if (!isDir(body.path)) return failWith("not_found", "not a dir");
            const names = [...dirsOf(body.path)];
            return send(200, {
              ok: true,
              result: {
                entries: names.map((name) => {
                  const full = `${body.path}/${name}`;
                  return { name, isFile: files.has(full), isDirectory: !files.has(full) };
                }),
              },
            });
          }

          case "find": {
            const paths = [...files.keys()].filter((p) => p.startsWith(`${body.path}/`) || p === body.path);
            const rx = new RegExp(`${body.pattern.replace(/\./g, "\\.").replace(/\*\*/g, "§").replace(/\*/g, "[^/]*").replace(/§/g, ".*")}$`);
            return send(200, { ok: true, result: { paths: paths.filter((p) => rx.test(p)).slice(0, body.limit ?? 1000) } });
          }

          case "grep": {
            const matches: Array<{ path: string; line: number; text: string }> = [];
            for (const [p, f] of files) {
              if (!p.startsWith(body.path)) continue;
              const lines = f.content.toString("utf8").split("\n");
              lines.forEach((text, i) => {
                const hay = body.ignoreCase ? text.toLowerCase() : text;
                const needle = body.ignoreCase ? body.pattern.toLowerCase() : body.pattern;
                if (hay.includes(needle)) matches.push({ path: p, line: i + 1, text });
              });
            }
            return send(200, { ok: true, result: { matches: matches.slice(0, body.limit ?? 100) } });
          }

          case "exec": {
            const r = state.execHandler(body.command, body.cwd ?? ROOT);
            return send(200, { ok: true, result: r });
          }

          case "gitClone": {
            state.cloned = { url: body.url, ref: body.ref };
            state.syncedAt = Date.now();
            files.set(`${ROOT}/README.md`, { content: Buffer.from("# cloned\n") });
            return send(200, { ok: true, result: {} });
          }

          default:
            return failWith("bad_request", "unknown op");
        }
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    calls,
    files,
    get execHandler() {
      return state.execHandler;
    },
    set execHandler(fn) {
      state.execHandler = fn;
    },
    get cloned() {
      return state.cloned;
    },
    setSyncedAt: (ts) => {
      state.syncedAt = ts;
    },
  };
}
