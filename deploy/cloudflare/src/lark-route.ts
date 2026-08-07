import { normalizeMessage, type RawReceiveEvent } from "@pinery/adapter/lark/events";
import { sessionKeyFor } from "@pinery/adapter/sessions";
import { LarkFetchClient, parseWebhookBody, safeEqualStr, verifyLarkSignature } from "@pinery/lark-fetch";
import type { PineryConfig } from "@pinery/core";
import { getAgentByName } from "agents";
import type { PineryAgent } from "./agent.js";
import { loadWorkerConfig, type PineryWorkerEnv } from "./config.js";

/**
 * 飞书 webhook 入口(POST /lark/events):
 * 验签(原始密文体)→ 解密/challenge 分流 → 归一化 → 按 session_key 路由到
 * PineryAgent(handleEvent 轻活立即返回)→ 200。
 * challenge 走 1 秒预算不经 DO;事件走 3 秒预算(去重与入列 <100ms)。
 */

/** isolate 级配置缓存(YAML 解析每 isolate 一次) */
let cachedCfg: PineryConfig | undefined;
/** isolate 级 bot 身份缓存(识别 @ 提及;10 分钟 TTL) */
let botCache: { value: { openId?: string; name?: string }; at: number } | undefined;
const BOT_TTL_MS = 10 * 60_000;

function workerConfig(env: PineryWorkerEnv): PineryConfig {
  cachedCfg ??= loadWorkerConfig(env);
  return cachedCfg;
}

async function botIdentity(cfg: PineryConfig): Promise<{ openId?: string; name?: string }> {
  if (botCache && Date.now() - botCache.at < BOT_TTL_MS) return botCache.value;
  const client = new LarkFetchClient({
    appId: cfg.lark.app_id,
    appSecret: cfg.lark.app_secret,
    domain: cfg.lark.endpoint,
    baseUrl: cfg.lark.api_base,
  });
  const value = await client.botInfo(); // 失败返回 {}:p2p 不受影响,群聊 @ 判定退化
  botCache = { value, at: Date.now() };
  return value;
}

export async function handleLarkEvents(request: Request, env: PineryWorkerEnv): Promise<Response> {
  let cfg: PineryConfig;
  try {
    cfg = workerConfig(env);
  } catch (e) {
    return new Response(e instanceof Error ? e.message : "config error", { status: 500 });
  }
  const encryptKey = cfg.lark.encrypt_key;
  if (!encryptKey) return new Response("lark.encrypt_key 未配置", { status: 500 });

  const raw = await request.text();

  // 验签在解密之前、对原始请求体做(飞书对配置了 Encrypt Key 的应用全量签名)
  const timestamp = request.headers.get("X-Lark-Request-Timestamp") ?? "";
  const nonce = request.headers.get("X-Lark-Request-Nonce") ?? "";
  const signature = request.headers.get("X-Lark-Signature") ?? "";
  if (!(await verifyLarkSignature(encryptKey, timestamp, nonce, raw, signature))) {
    return new Response("signature mismatch", { status: 401 });
  }

  const parsed = await parseWebhookBody(raw, encryptKey);

  switch (parsed.kind) {
    case "challenge": {
      // Verification Token 弱校验(配置了才比;Encrypt Key 验签已是强校验)
      if (cfg.lark.verification_token && !safeEqualStr(parsed.token ?? "", cfg.lark.verification_token)) {
        return new Response("verification token mismatch", { status: 401 });
      }
      return Response.json({ challenge: parsed.challenge });
    }
    case "unsupported":
      // 结构不识别不给 4xx:避免飞书按失败重试同一事件(15s/5m/1h/6h)
      return Response.json({ ok: true, ignored: parsed.reason });
    case "event":
      break;
  }

  if (parsed.eventType !== "im.message.receive_v1") {
    return Response.json({ ok: true, ignored: parsed.eventType });
  }
  if (cfg.lark.verification_token && parsed.header.token && !safeEqualStr(parsed.header.token, cfg.lark.verification_token)) {
    return new Response("verification token mismatch", { status: 401 });
  }

  const bot = await botIdentity(cfg);
  const msg = normalizeMessage(parsed.event as RawReceiveEvent, bot);
  if (!msg) return Response.json({ ok: true, ignored: "non-user-or-non-text" });

  const agent = await getAgentByName(env.AGENT as never, sessionKeyFor(msg));
  const result = await (agent as unknown as PineryAgent).handleEvent({ eventId: parsed.eventId, msg });
  return Response.json({ ok: true, ...result });
}
