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

const ctx = (over: { hasActiveSession?: boolean } = {}) => ({
  cfg,
  limiter: new RateLimiter(100),
  hasActiveSession: over.hasActiveSession ?? false,
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

  it("continues thread without mention when session active", () => {
    const d = gate(msg({ mentionsBot: false, rootId: "om_root" }), ctx({ hasActiveSession: true }));
    expect(d.action).toBe("investigate");
  });

  it("denies unregistered group when mentioned", () => {
    const d = gate(msg({ chatId: "oc_other" }), ctx());
    expect(d.action).toBe("denied");
  });

  it("silently ignores unregistered group without mention", () => {
    expect(gate(msg({ chatId: "oc_other", mentionsBot: false }), ctx()).action).toBe("ignore");
  });

  it("p2p falls back to sole repo with L0", () => {
    const d = gate(msg({ chatId: "oc_dm", chatType: "p2p", mentionsBot: false }), ctx());
    expect(d.action).toBe("investigate");
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
