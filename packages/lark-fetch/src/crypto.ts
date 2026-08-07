/**
 * 飞书 webhook 的密码学原语(纯 WebCrypto,Node ≥ 20 / Bun / workerd 通用):
 * - 事件解密:AES-256-CBC,key = SHA-256(encrypt_key) 原始 digest,
 *   密文 base64 解码后前 16 字节为 IV(PKCS7 padding 由 WebCrypto 处理);
 * - 验签:X-Lark-Signature = hex(sha256(timestamp + nonce + encrypt_key + body)),
 *   body 为原始 HTTP 请求体(密文形态)。
 * 参考:open.feishu.cn 事件订阅「加密与验签」文档。
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 常量时间字符串比较(签名/token 比对,避免逐字符时序泄漏) */
export function safeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 解密事件 envelope 的 encrypt 字段,返回明文 JSON 字符串 */
export async function decryptEventBody(encryptKey: string, encryptB64: string): Promise<string> {
  const keyBytes = await crypto.subtle.digest("SHA-256", encoder.encode(encryptKey));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["decrypt"]);
  const data = base64ToBytes(encryptB64);
  if (data.length < 17) throw new Error("密文过短:缺少 IV 或内容");
  const iv = data.slice(0, 16);
  const ciphertext = data.slice(16);
  const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, ciphertext);
  return decoder.decode(plain);
}

/** 计算事件签名(hex 小写) */
export async function computeLarkSignature(
  encryptKey: string,
  timestamp: string,
  nonce: string,
  rawBody: string,
): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(timestamp + nonce + encryptKey + rawBody));
  return bytesToHex(digest);
}

/** 校验 X-Lark-Signature(常量时间比较) */
export async function verifyLarkSignature(
  encryptKey: string,
  timestamp: string,
  nonce: string,
  rawBody: string,
  signature: string,
): Promise<boolean> {
  const expected = await computeLarkSignature(encryptKey, timestamp, nonce, rawBody);
  return safeEqualStr(expected, signature.toLowerCase());
}
