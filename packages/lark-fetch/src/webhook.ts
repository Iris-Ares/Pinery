import { decryptEventBody } from "./crypto.js";

/**
 * 飞书 webhook(「将事件发送至开发者服务器」)envelope 解析:
 * challenge 分流、可选 AES 解密、schema 2.0 事件提取。
 * 验签在路由层用 crypto.ts 的 verifyLarkSignature 对**原始密文体**做。
 */

/** v2.0 事件公共头 */
export interface LarkEventHeader {
  event_id?: string;
  event_type?: string;
  create_time?: string;
  token?: string;
  app_id?: string;
  tenant_key?: string;
}

export type ParsedLarkWebhook =
  | { kind: "challenge"; challenge: string; token?: string }
  | { kind: "event"; eventId: string; eventType: string; header: LarkEventHeader; event: unknown }
  | { kind: "unsupported"; reason: string };

interface Envelope {
  encrypt?: string;
  challenge?: string;
  token?: string;
  type?: string;
  schema?: string;
  header?: LarkEventHeader;
  event?: unknown;
  uuid?: string;
}

/**
 * 解析 webhook 请求体。
 * @param rawBody 原始 HTTP body(可能是 {"encrypt": "..."} 包裹)
 * @param encryptKey 后台配置的 Encrypt Key;配了加密时必传
 */
export async function parseWebhookBody(rawBody: string, encryptKey?: string): Promise<ParsedLarkWebhook> {
  let outer: Envelope;
  try {
    outer = JSON.parse(rawBody) as Envelope;
  } catch {
    return { kind: "unsupported", reason: "请求体不是合法 JSON" };
  }

  let payload: Envelope = outer;
  if (typeof outer.encrypt === "string") {
    if (!encryptKey) return { kind: "unsupported", reason: "收到加密事件但未配置 encrypt key" };
    try {
      payload = JSON.parse(await decryptEventBody(encryptKey, outer.encrypt)) as Envelope;
    } catch (e) {
      return { kind: "unsupported", reason: `事件解密失败:${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // URL 验证(配置回调地址时的一次性握手;1 秒内回显 challenge)
  if (payload.type === "url_verification" && typeof payload.challenge === "string") {
    return { kind: "challenge", challenge: payload.challenge, token: payload.token };
  }

  if (payload.schema === "2.0" && payload.header) {
    const { event_id: eventId, event_type: eventType } = payload.header;
    if (!eventId || !eventType) return { kind: "unsupported", reason: "v2 事件缺少 event_id/event_type" };
    return { kind: "event", eventId, eventType, header: payload.header, event: payload.event };
  }

  // v1.0 事件(uuid + event,无 schema):Pinery 只支持 v2 订阅,提示重新配置
  if (payload.uuid) return { kind: "unsupported", reason: "收到 v1.0 事件;请在飞书后台使用 v2.0 事件订阅" };
  return { kind: "unsupported", reason: "无法识别的事件结构" };
}
