import { describe, expect, it } from "vitest";
import { extractText, normalizeMessage, type RawReceiveEvent } from "../src/lark/events.js";

const BOT = { openId: "ou_bot", name: "Pinery" };

function makeEvent(over: {
  text?: string;
  chatType?: string;
  rootId?: string;
  threadId?: string;
  parentId?: string;
  createTime?: string;
  mentions?: Array<{ key?: string; name?: string; openId?: string }>;
  senderType?: string;
  messageType?: string;
  content?: string;
}): RawReceiveEvent {
  return {
    sender: { sender_id: { open_id: "ou_alice" }, sender_type: over.senderType ?? "user" },
    message: {
      message_id: "om_1",
      chat_id: "oc_1",
      chat_type: over.chatType ?? "group",
      root_id: over.rootId,
      thread_id: over.threadId,
      parent_id: over.parentId,
      create_time: over.createTime,
      message_type: over.messageType ?? "text",
      content: over.content ?? JSON.stringify({ text: over.text ?? "hi" }),
      mentions: over.mentions?.map((m) => ({ key: m.key, name: m.name, id: { open_id: m.openId } })),
    },
  };
}

describe("normalizeMessage", () => {
  it("normalizes group mention and strips mention key", () => {
    const msg = normalizeMessage(
      makeEvent({
        text: "@_user_1 下单超时会退款吗?",
        mentions: [{ key: "@_user_1", name: "Pinery", openId: "ou_bot" }],
      }),
      BOT,
    );
    expect(msg?.mentionsBot).toBe(true);
    expect(msg?.text).toBe("下单超时会退款吗?");
    expect(msg?.chatType).toBe("group");
  });

  it("detects mention by name when openId missing", () => {
    const msg = normalizeMessage(
      makeEvent({ text: "@_user_1 hello", mentions: [{ key: "@_user_1", name: "Pinery" }] }),
      { name: "Pinery" },
    );
    expect(msg?.mentionsBot).toBe(true);
  });

  it("mention of someone else is not mentionsBot", () => {
    const msg = normalizeMessage(
      makeEvent({ text: "@_user_1 看下", mentions: [{ key: "@_user_1", name: "Alice", openId: "ou_x" }] }),
      BOT,
    );
    expect(msg?.mentionsBot).toBe(false);
  });

  it("keeps reply and explicit thread topology", () => {
    const msg = normalizeMessage(
      makeEvent({
        text: "追问",
        rootId: "om_root",
        threadId: "omt_topic",
        parentId: "om_parent",
        createTime: "123",
      }),
      BOT,
    );
    expect(msg?.rootId).toBe("om_root");
    expect(msg?.threadId).toBe("omt_topic");
    expect(msg?.parentId).toBe("om_parent");
    expect(msg?.createTime).toBe("123");
  });

  it("ignores bot/app senders (loop protection)", () => {
    expect(normalizeMessage(makeEvent({ senderType: "app" }), BOT)).toBeUndefined();
  });

  it("ignores unsupported message types", () => {
    expect(
      normalizeMessage(makeEvent({ messageType: "image", content: JSON.stringify({ image_key: "k" }) }), BOT),
    ).toBeUndefined();
  });

  it("extracts post message text", () => {
    const content = JSON.stringify({
      title: "t",
      content: [
        [{ tag: "text", text: "第一行 " }, { tag: "a", text: "链接", href: "https://x" }],
        [{ tag: "text", text: "第二行" }],
      ],
    });
    expect(extractText("post", content)).toBe("第一行 链接\n第二行");
  });
});
