import { parseConfig } from "@pinery/core";
import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "../src/lark/events.js";
import {
  buildSessionSummary,
  planSession,
  replyInThreadFor,
  sessionKeyFor,
} from "../src/sessions.js";
import { Storage } from "../src/storage.js";

const cfg = parseConfig(
  `
lark: { app_id: x, app_secret: y }
repos: [{ name: r, url: "git@x:o/r.git" }]
limits: { session_max_turns: 10, session_idle_archive_min: 60 }
`,
  {} as NodeJS.ProcessEnv,
);

const binding = {
  repo: "r",
  runnerKind: "pi-workers",
  workspaceHandle: "s-r-group",
  workspaceReadOnly: true,
} as const;

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
  it("shares the main group room and isolates explicit topics", () => {
    expect(sessionKeyFor(msg({ chatType: "group", rootId: "om_quote" }))).toBe("group:oc_1");
    expect(sessionKeyFor(msg({ chatType: "group" }))).toBe("group:oc_1");
    expect(sessionKeyFor(msg({ chatType: "group", threadId: "omt_topic" }))).toBe("thread:omt_topic");
  });
  it("does not open a topic unless the user is already in one", () => {
    expect(replyInThreadFor(msg({ chatType: "group" }))).toBe(false);
    expect(replyInThreadFor(msg({ chatType: "group", rootId: "om_quote" }))).toBe(false);
    expect(replyInThreadFor(msg({ chatType: "group", threadId: "omt_topic" }))).toBe(true);
  });
});

describe("planSession", () => {
  it("fresh when no session", () => {
    const s = new Storage(":memory:");
    const plan = planSession(s, cfg, msg({}), binding);
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
      runnerKind: binding.runnerKind,
      workspaceHandle: binding.workspaceHandle,
      workspaceReadOnly: true,
      summary: "sum",
    });
    const plan = planSession(s, cfg, msg({}), binding);
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
      runnerKind: binding.runnerKind,
      workspaceHandle: binding.workspaceHandle,
      workspaceReadOnly: true,
      summary: "上一轮问题:q\n上一轮结论:c",
    });
    const plan = planSession(s, cfg, msg({}), binding);
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
      runnerKind: binding.runnerKind,
      workspaceHandle: binding.workspaceHandle,
      workspaceReadOnly: true,
      summary: "sum",
    });
    const future = Date.now() + 61 * 60_000;
    const plan = planSession(s, cfg, msg({}), binding, future);
    expect(plan.resume).toBeUndefined();
    expect(plan.context).toBe("sum");
    s.close();
  });

  it("refuses resume when the sandbox/worktree binding changed", () => {
    const s = new Storage(":memory:");
    s.upsertSession({
      sessionKey: "p2p:oc_1",
      chatId: "oc_1",
      chatType: "p2p",
      repo: "r",
      turns: 2,
      runnerRef: "piw:old",
      runnerKind: binding.runnerKind,
      workspaceHandle: "s-r-old",
      workspaceReadOnly: true,
      summary: "sum",
    });
    const plan = planSession(s, cfg, msg({}), binding);
    expect(plan.resume).toBeUndefined();
    expect(plan.bindingChanged).toBe(true);
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
