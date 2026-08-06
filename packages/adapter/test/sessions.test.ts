import { parseConfig } from "@pinery/core";
import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "../src/lark/events.js";
import { buildSessionSummary, planSession, sessionKeyFor } from "../src/sessions.js";
import { Storage } from "../src/storage.js";

const cfg = parseConfig(
  `
lark: { app_id: x, app_secret: y }
repos: [{ name: r, url: "git@x:o/r.git" }]
limits: { session_max_turns: 10, session_idle_archive_min: 60 }
`,
  {} as NodeJS.ProcessEnv,
);

function msg(over: Partial<IncomingMessage>): IncomingMessage {
  return {
    chatId: "oc_1",
    chatType: "p2p",
    messageId: "om_1",
    senderOpenId: "ou_1",
    text: "q",
    mentionsBot: false,
    ...over,
  };
}

describe("sessionKeyFor", () => {
  it("p2p keys by chat", () => {
    expect(sessionKeyFor(msg({}))).toBe("p2p:oc_1");
  });
  it("group thread keys by root, main-flow message keys by itself", () => {
    expect(sessionKeyFor(msg({ chatType: "group", rootId: "om_root" }))).toBe("thread:om_root");
    expect(sessionKeyFor(msg({ chatType: "group" }))).toBe("thread:om_1");
  });
});

describe("planSession", () => {
  it("fresh when no session", () => {
    const s = new Storage(":memory:");
    const plan = planSession(s, cfg, msg({}));
    expect(plan.resume).toBeUndefined();
    expect(plan.context).toBeUndefined();
    s.close();
  });

  it("resumes active session with runner ref", () => {
    const s = new Storage(":memory:");
    s.upsertSession({
      sessionKey: "p2p:oc_1",
      chatId: "oc_1",
      chatType: "p2p",
      repo: "r",
      turns: 4,
      runnerRef: "/tmp/x.jsonl",
      summary: "sum",
    });
    const plan = planSession(s, cfg, msg({}));
    expect(plan.resume).toBe("/tmp/x.jsonl");
    expect(plan.priorTurns).toBe(4);
    s.close();
  });

  it("goes fresh with summary context when turns exceeded", () => {
    const s = new Storage(":memory:");
    s.upsertSession({
      sessionKey: "p2p:oc_1",
      chatId: "oc_1",
      chatType: "p2p",
      repo: "r",
      turns: 10,
      runnerRef: "/tmp/x.jsonl",
      summary: "上一轮问题:q\n上一轮结论:c",
    });
    const plan = planSession(s, cfg, msg({}));
    expect(plan.resume).toBeUndefined();
    expect(plan.context).toContain("上一轮结论");
    expect(plan.priorTurns).toBe(0);
    s.close();
  });

  it("goes fresh when idle beyond window", () => {
    const s = new Storage(":memory:");
    s.upsertSession({
      sessionKey: "p2p:oc_1",
      chatId: "oc_1",
      chatType: "p2p",
      repo: "r",
      turns: 2,
      runnerRef: "/tmp/x.jsonl",
      summary: "sum",
    });
    const future = Date.now() + 61 * 60_000;
    const plan = planSession(s, cfg, msg({}), future);
    expect(plan.resume).toBeUndefined();
    expect(plan.context).toBe("sum");
    s.close();
  });
});

describe("buildSessionSummary", () => {
  it("caps lengths", () => {
    const sum = buildSessionSummary("q".repeat(500), "c".repeat(900));
    expect(sum.length).toBeLessThan(1000);
    expect(sum).toContain("上一轮问题");
    expect(sum).toContain("上一轮结论");
  });
});
