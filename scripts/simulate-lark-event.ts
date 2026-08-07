/**
 * 飞书 webhook 事件模拟器:按官方口径构造「AES-256-CBC 加密 + X-Lark-Signature
 * 签名」的请求打到 /lark/events,用于本地端到端与压测(无需真实飞书后台)。
 *
 * 用法(Bun / Node ≥22):
 *   bun scripts/simulate-lark-event.ts --mode challenge
 *   bun scripts/simulate-lark-event.ts --mode message --text "下单超时会自动退款吗?"
 *   参数:--url(默认 http://127.0.0.1:8787/lark/events)--key(Encrypt Key,
 *   默认 e2e-encrypt-key)--chat oc_e2e --user ou_e2e --event-id evt-<ts>
 *   --chat-type p2p|group --tamper(故意破坏签名,验证 401)
 */
import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";

interface Args {
  url: string;
  key: string;
  mode: "challenge" | "message";
  text: string;
  chat: string;
  user: string;
  eventId: string;
  chatType: "p2p" | "group";
  tamper: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string, fallback: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : fallback;
  };
  return {
    url: get("url", "http://127.0.0.1:8787/lark/events"),
    key: get("key", "e2e-encrypt-key"),
    mode: get("mode", "message") as Args["mode"],
    text: get("text", "README 的第一行是什么?"),
    chat: get("chat", "oc_e2e"),
    user: get("user", "ou_e2e"),
    eventId: get("event-id", `evt-${Date.now()}`),
    chatType: get("chat-type", "p2p") as Args["chatType"],
    tamper: argv.includes("--tamper"),
  };
}

function encrypt(encryptKey: string, plaintext: string): string {
  const key = createHash("sha256").update(encryptKey, "utf8").digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, ct]).toString("base64");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const payload =
    args.mode === "challenge"
      ? { challenge: `chal-${randomUUID()}`, token: "e2e-verification-token", type: "url_verification" }
      : {
          schema: "2.0",
          header: {
            event_id: args.eventId,
            event_type: "im.message.receive_v1",
            create_time: String(Date.now()),
            tenant_key: "e2e",
            app_id: "cli_e2e",
            token: "e2e-verification-token",
          },
          event: {
            sender: { sender_id: { open_id: args.user }, sender_type: "user" },
            message: {
              message_id: `om_${randomUUID().slice(0, 8)}`,
              chat_id: args.chat,
              chat_type: args.chatType,
              message_type: "text",
              content: JSON.stringify({ text: args.text }),
            },
          },
        };

  const body = JSON.stringify({ encrypt: encrypt(args.key, JSON.stringify(payload)) });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomUUID().slice(0, 12);
  const signature = createHash("sha256")
    .update(timestamp + nonce + args.key + body, "utf8")
    .digest("hex");

  const res = await fetch(args.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Lark-Request-Timestamp": timestamp,
      "X-Lark-Request-Nonce": nonce,
      "X-Lark-Signature": args.tamper ? `${signature.slice(0, -2)}00` : signature,
    },
    body,
  });
  console.log(`${res.status} ${await res.text()}`);
  if (args.mode === "challenge" && !args.tamper && res.status !== 200) process.exitCode = 1;
}

void main();
