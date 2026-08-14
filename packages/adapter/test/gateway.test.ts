import { parseConfig } from "@pinery/core";
import { describe, expect, it } from "vitest";
import { RateLimiter, gate } from "../src/gateway.js";
import type { IncomingMessage } from "../src/lark/events.js";

const cfg = parseConfig(
  `
lark: { app_id: cli_x, app_secret: s }
repos:
  - name: order
    url: git@github.com:org/order.git
    chats: [oc_group]
    permissions:
      - { user: ou_eng, level: 2 }
`,
  {} as NodeJS.ProcessEnv,
);

function msg(over: Partial<IncomingMessage>): IncomingMessage {
  return {
    chatId: "oc_group",
    chatType: "group",
    messageId: "om_1",
    senderOpenId: "ou_pm",
    text: "下单超时会退款吗?",
    mentionsBot: true,
    ...over,
  };
}

const ctx = (over: { hasActiveSession?: boolean; activeRepo?: string; config?: typeof cfg } = {}) => ({
  cfg: over.config ?? cfg,
  limiter: new RateLimiter(100),
  hasActiveSession: over.hasActiveSession ?? false,
  activeRepo: over.activeRepo,
});

describe("gate", () => {
  it("routes group mention to investigate with L0", () => {
    const d = gate(msg({}), ctx());
    expect(d.action).toBe("investigate");
    if (d.action === "investigate") {
      expect(d.repo.name).toBe("order");
      expect(d.level).toBe(0);
      expect(d.question).toContain("退款");
    }
  });

  it("ignores group chatter without mention or session", () => {
    expect(gate(msg({ mentionsBot: false }), ctx()).action).toBe("ignore");
  });

  it("continues without mention only when directly replying to the bot", () => {
    const d = gate(
      msg({ mentionsBot: false, parentId: "om_bot" }),
      { ...ctx({ hasActiveSession: true }), repliesToBot: true },
    );
    expect(d.action).toBe("investigate");
  });

  it("does not consume unrelated chatter just because the group session is active", () => {
    expect(gate(msg({ mentionsBot: false }), ctx({ hasActiveSession: true })).action).toBe("ignore");
  });

  it("allows an unregistered group to use the only project", () => {
    const d = gate(msg({ chatId: "oc_other" }), ctx());
    expect(d.action).toBe("investigate");
  });

  it("silently ignores unregistered group without mention", () => {
    expect(gate(msg({ chatId: "oc_other", mentionsBot: false }), ctx()).action).toBe("ignore");
  });

  it("p2p falls back to sole repo with L0", () => {
    const d = gate(msg({ chatId: "oc_dm", chatType: "p2p", mentionsBot: false }), ctx());
    expect(d.action).toBe("investigate");
  });

  it("asks which project when intent is ambiguous", () => {
    const multi = parseConfig(
      `
lark: { app_id: cli_x, app_secret: s }
repos:
  - { name: order, aliases: [订单], url: "https://example.com/order.git" }
  - { name: stock, aliases: [库存], url: "https://example.com/stock.git" }
model: { provider: openrouter, id: test/model }
`,
      {} as NodeJS.ProcessEnv,
    );
    const d = gate(msg({ chatId: "oc_other", text: "这个功能怎么实现?" }), ctx({ config: multi }));
    expect(d.action).toBe("clarify");
    if (d.action === "clarify") expect(d.projects).toEqual(["订单", "库存"]);
  });

  it("routes by explicit alias before the active project", () => {
    const multi = parseConfig(
      `
lark: { app_id: cli_x, app_secret: s }
repos:
  - { name: order, aliases: [订单], url: "https://example.com/order.git" }
  - { name: stock, aliases: [库存], url: "https://example.com/stock.git" }
model: { provider: openrouter, id: test/model }
`,
      {} as NodeJS.ProcessEnv,
    );
    const d = gate(
      msg({ chatId: "oc_other", text: "库存:继续调查", rootId: "om_root" }),
      ctx({ config: multi, hasActiveSession: true, activeRepo: "order" }),
    );
    expect(d.action).toBe("investigate");
    if (d.action === "investigate") expect(d.repo.name).toBe("stock");
  });

  it("can opt into restricted group access", () => {
    const restricted = parseConfig(
      `
lark: { app_id: cli_x, app_secret: s }
repos:
  - { name: order, url: "https://example.com/order.git", group_open: false }
model: { provider: openrouter, id: test/model }
`,
      {} as NodeJS.ProcessEnv,
    );
    const d = gate(msg({ chatId: "oc_other" }), ctx({ config: restricted }));
    expect(d.action).toBe("denied");
  });

  it("explicit permission user keeps configured level", () => {
    const d = gate(msg({ senderOpenId: "ou_eng" }), ctx());
    if (d.action === "investigate") expect(d.level).toBe(2);
    else expect.fail(`expect investigate, got ${d.action}`);
  });

  it("help and status intents", () => {
    expect(gate(msg({ text: "help" }), ctx()).action).toBe("help");
    expect(gate(msg({ text: "帮助" }), ctx()).action).toBe("help");
    expect(gate(msg({ text: "状态" }), ctx()).action).toBe("status");
    expect(gate(msg({ text: "" }), ctx()).action).toBe("help");
  });

  it("rate limits per user", () => {
    const limiter = new RateLimiter(2);
    const c = { cfg, limiter, hasActiveSession: false };
    expect(gate(msg({}), c).action).toBe("investigate");
    expect(gate(msg({}), c).action).toBe("investigate");
    expect(gate(msg({}), c).action).toBe("rate_limited");
    // help/status 不计入限流
    expect(gate(msg({ text: "help" }), c).action).toBe("help");
  });
});

describe("RateLimiter", () => {
  it("recovers after window", () => {
    const rl = new RateLimiter(1);
    const t0 = 1_000_000;
    expect(rl.allow("u", t0)).toBe(true);
    expect(rl.allow("u", t0 + 1000)).toBe(false);
    expect(rl.allow("u", t0 + 61_000)).toBe(true);
  });
});
