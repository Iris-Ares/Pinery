/**
 * 飞书 im.message.receive_v1 事件归一化。
 * 只保留 M1 需要的字段;非文本消息与机器人自身消息归一化为 undefined(忽略)。
 */

export interface IncomingMessage {
  chatId: string;
  chatType: "p2p" | "group";
  messageId: string;
  /** 话题根消息 id(在话题内发言时存在) */
  rootId?: string;
  senderOpenId: string;
  /** 已剥离 @ 提及、去首尾空白的正文 */
  text: string;
  mentionsBot: boolean;
}

interface RawMention {
  key?: string;
  id?: { open_id?: string };
  name?: string;
}

export interface RawReceiveEvent {
  sender?: {
    sender_id?: { open_id?: string };
    sender_type?: string;
  };
  message?: {
    message_id?: string;
    root_id?: string;
    parent_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    mentions?: RawMention[];
  };
}

interface PostNode {
  tag?: string;
  text?: string;
  [k: string]: unknown;
}

/** 提取 text / post 消息的纯文本 */
export function extractText(messageType: string, content: string): string | undefined {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (messageType === "text") {
      return typeof parsed["text"] === "string" ? (parsed["text"] as string) : undefined;
    }
    if (messageType === "post") {
      // post: {title, content: PostNode[][]}(或包一层语言 key 的旧结构)
      const root = (parsed["content"] ?? Object.values(parsed).find(Array.isArray)) as unknown;
      if (!Array.isArray(root)) return undefined;
      const lines: string[] = [];
      for (const para of root as PostNode[][]) {
        if (!Array.isArray(para)) continue;
        const line = para
          .map((node) => (typeof node.text === "string" ? node.text : ""))
          .join("");
        lines.push(line);
      }
      return lines.join("\n");
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** 剥离 @_user_N 占位符 */
export function stripMentions(text: string, mentions: RawMention[] | undefined): string {
  let out = text;
  for (const m of mentions ?? []) {
    if (m.key) out = out.split(m.key).join(" ");
  }
  return out.replace(/\s+/g, " ").trim();
}

export function normalizeMessage(
  event: RawReceiveEvent,
  bot: { openId?: string; name?: string },
): IncomingMessage | undefined {
  const msg = event.message;
  const sender = event.sender;
  if (!msg?.message_id || !msg.chat_id || !msg.content || !msg.message_type) return undefined;
  // 机器人消息(含自身回复)一律忽略,防回环
  if (sender?.sender_type && sender.sender_type !== "user") return undefined;
  const senderOpenId = sender?.sender_id?.open_id;
  if (!senderOpenId) return undefined;

  const chatType = msg.chat_type === "p2p" ? "p2p" : "group";
  const rawText = extractText(msg.message_type, msg.content);
  if (rawText === undefined) return undefined;

  const mentionsBot = (msg.mentions ?? []).some(
    (m) => (bot.openId && m.id?.open_id === bot.openId) || (bot.name && m.name === bot.name),
  );

  return {
    chatId: msg.chat_id,
    chatType,
    messageId: msg.message_id,
    rootId: msg.root_id || undefined,
    senderOpenId,
    text: stripMentions(rawText, msg.mentions),
    mentionsBot,
  };
}
