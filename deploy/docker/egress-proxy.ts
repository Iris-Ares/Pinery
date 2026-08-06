/**
 * Pinery egress 白名单代理(自建加固,docs/sandbox-evaluation.md §4)。
 *
 * 部署形态:compose 里 pinery 容器挂在 `internal: true` 的网络上(无法直接出网),
 * 唯一出口是本代理;代理同时挂内部网与外部网,按域名白名单放行。
 * 这样「数据出不去」不依赖应用层自律——即使 agent 被 prompt injection 完全接管,
 * 白名单外的目标在网络层就到不了(PRD §5 / §8-Q9 的最硬一道)。
 *
 * 支持:
 * - HTTPS:CONNECT 隧道,按 host 白名单;端口限 443(可配)
 * - HTTP:普通代理请求,按 host 白名单
 * 白名单语法:`example.com`(精确)、`.example.com` / `*.example.com`(含子域)。
 *
 * 环境变量:
 *   EGRESS_ALLOW   逗号分隔白名单(必填,空 = 全拒)
 *   EGRESS_PORT    监听端口(默认 3128)
 *   EGRESS_PORTS   允许的目标端口(默认 443,80)
 *   EGRESS_LOG     "all" 记录放行+拒绝,默认仅记录拒绝
 *
 * 运行:bun deploy/docker/egress-proxy.ts
 */
import { connect } from "node:net";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

const PORT = Number(process.env["EGRESS_PORT"] ?? 3128);
const ALLOW = (process.env["EGRESS_ALLOW"] ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const ALLOWED_PORTS = new Set(
  (process.env["EGRESS_PORTS"] ?? "443,80").split(",").map((s) => Number(s.trim())).filter(Boolean),
);
const LOG_ALL = process.env["EGRESS_LOG"] === "all";

function log(verdict: "ALLOW" | "DENY", detail: string): void {
  if (verdict === "DENY" || LOG_ALL) {
    console.log(`${new Date().toISOString()} ${verdict} ${detail}`);
  }
}

/** 白名单匹配:精确域名,或 .suffix / *.suffix 匹配子域(不匹配裸域,除非同时列出) */
export function hostAllowed(host: string, allow: string[] = ALLOW): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (!h) return false;
  return allow.some((rule) => {
    if (rule.startsWith("*.")) return h === rule.slice(2) || h.endsWith(rule.slice(1));
    if (rule.startsWith(".")) return h === rule.slice(1) || h.endsWith(rule);
    return h === rule;
  });
}

/** 从 CONNECT target / Host 头解析 host:port */
export function parseTarget(raw: string, defaultPort: number): { host: string; port: number } | undefined {
  if (!raw) return undefined;
  // IPv6 字面量 [::1]:443
  const v6 = raw.match(/^\[([^\]]+)\]:?(\d+)?$/);
  if (v6) return { host: v6[1]!, port: v6[2] ? Number(v6[2]) : defaultPort };
  const parts = raw.split(":");
  if (parts.length > 2) return undefined;
  const host = parts[0]!;
  const port = parts[1] ? Number(parts[1]) : defaultPort;
  if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) return undefined;
  return { host, port };
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  // 普通 HTTP 代理请求(绝对 URI)
  let url: URL;
  try {
    url = new URL(req.url ?? "", `http://${req.headers.host ?? ""}`);
  } catch {
    res.writeHead(400).end("bad request target\n");
    return;
  }
  const port = Number(url.port || 80);
  if (!hostAllowed(url.hostname) || !ALLOWED_PORTS.has(port)) {
    log("DENY", `HTTP ${url.hostname}:${port}`);
    res.writeHead(403, { "content-type": "text/plain" }).end("blocked by pinery egress allowlist\n");
    return;
  }
  log("ALLOW", `HTTP ${url.hostname}:${port}`);

  const upstream = httpRequest(
    { host: url.hostname, port, path: url.pathname + url.search, method: req.method, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", (e) => {
    log("DENY", `HTTP upstream error ${url.hostname}: ${e.message}`);
    if (!res.headersSent) res.writeHead(502);
    res.end("upstream error\n");
  });
  req.pipe(upstream);
});

// HTTPS:CONNECT 隧道
server.on("connect", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  const target = parseTarget(req.url ?? "", 443);
  if (!target || !hostAllowed(target.host) || !ALLOWED_PORTS.has(target.port)) {
    log("DENY", `CONNECT ${req.url}`);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\nblocked by pinery egress allowlist\r\n");
    return;
  }
  log("ALLOW", `CONNECT ${target.host}:${target.port}`);

  const upstream = connect(target.port, target.host, () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const fail = (e: Error) => {
    log("DENY", `CONNECT upstream error ${target.host}: ${e.message}`);
    socket.destroy();
  };
  upstream.on("error", fail);
  socket.on("error", () => upstream.destroy());
});

if (ALLOW.length === 0) {
  console.log("⚠️  EGRESS_ALLOW 为空 —— 所有出站请求都会被拒绝(默认拒绝语义)");
}
server.listen(PORT, () => {
  console.log(`🌲 pinery egress proxy :${PORT}`);
  console.log(`   白名单(${ALLOW.length}):${ALLOW.join(", ") || "(空)"}`);
  console.log(`   放行端口:${[...ALLOWED_PORTS].join(", ")}`);
});
