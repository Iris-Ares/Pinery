import { parseConfig, type AgentRunner, type RunnerResult } from "@pinery/core";
import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "../src/lark/events.js";
import { Orchestrator, type LarkMessenger } from "../src/orchestrator.js";
import type { Card } from "../src/lark/cards.js";
import { Storage } from "../src/storage.js";

/** 端到端(fake runner + fake 飞书通道):消息进 → ack → 进度 → 答案卡片 + 落库 */

const cfg = parseConfig(
  `
lark: { app_id: x, app_secret: y }
repos:
  - name: order
    url: "git@x:o/order.git"
    chats: [oc_g]
limits: { rate_per_user_per_min: 100, max_concurrent_tasks: 2, task_timeout_min: 1 }
`,
  {} as NodeJS.ProcessEnv,
);

class FakeLark implements LarkMessenger {
  sent: Array<{ kind: "send" | "reply"; card: Card; inThread?: boolean }> = [];
  patches: Card[] = [];
  private seq = 0;

  sendCard(_chatId: string, card: Card): Promise<string> {
    this.sent.push({ kind: "send", card });
    return Promise.resolve(`om_out_${++this.seq}`);
  }
  replyCard(_messageId: string, card: Card, inThread: boolean): Promise<string> {
    this.sent.push({ kind: "reply", card, inThread });
    return Promise.resolve(`om_out_${++this.seq}`);
  }
  patchCard(_messageId: string, card: Card): Promise<void> {
    this.patches.push(card);
    return Promise.resolve();
  }
}

function fakeRunner(fn: () => Promise<RunnerResult> | RunnerResult): AgentRunner {
  return { kind: "fake", run: async () => fn() };
}

const okResult: RunnerResult = {
  ok: true,
  answer: "## 结论\n会退款,密钥是 AKIAIOSFODNN7EXAMPLE。\n## 依据\n- `src/a.ts:1` x\n## 置信度与边界\n高。",
  sessionRef: "/tmp/s.jsonl",
  turns: 4,
  toolCalls: 7,
  filesTouched: ["src/a.ts"],
  usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.001 },
};

function msg(over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    chatId: "oc_g",
    chatType: "group",
    messageId: "om_q",
    senderOpenId: "ou_pm",
    text: "下单超时会退款吗?",
    mentionsBot: true,
    ...over,
  };
}

async function drain(o: Orchestrator): Promise<void> {
  // 排队任务是异步链;轮询直到清空
  for (let i = 0; i < 200 && o.queueLength > 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("Orchestrator", () => {
  it("full investigate flow: ack → answer card, secret filtered, qa logged, session saved", async () => {
    const storage = new Storage(":memory:");
    const lark = new FakeLark();
    const o = new Orchestrator({ cfg, storage, runner: fakeRunner(() => okResult), lark });

    o.handle(msg());
    await drain(o);

    // ack 卡片以话题形式回复
    expect(lark.sent[0]?.kind).toBe("reply");
    expect(lark.sent[0]?.inThread).toBe(true);

    // 最终 patch 是答案卡片,且 secret 已脱敏
    const final = JSON.stringify(lark.patches.at(-1));
    expect(final).toContain("会退款");
    expect(final).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(final).toContain("已脱敏");

    // qa 落库
    const qa = storage.listQa();
    expect(qa).toHaveLength(1);
    expect(qa[0]?.question).toContain("退款");
    expect(qa[0]?.answer).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(qa[0]?.confidence).toBe("high");

    // 会话映射(群聊话题:主流消息 id 作为 root)
    const session = storage.getSession("thread:om_q");
    expect(session?.runner_ref).toBe("/tmp/s.jsonl");
    expect(session?.turns).toBe(4);
    expect(session?.summary).toContain("上一轮结论");

    // 审计
    expect(storage.auditForTask(qa[0]!.task_id!).length).toBeGreaterThanOrEqual(2);
    storage.close();
  });

  it("runner error patches error card and skips qa log", async () => {
    const storage = new Storage(":memory:");
    const lark = new FakeLark();
    const o = new Orchestrator({
      cfg,
      storage,
      runner: fakeRunner(() => ({
        ok: false,
        answer: "",
        turns: 0,
        toolCalls: 0,
        filesTouched: [],
        error: "API key invalid",
      })),
      lark,
    });
    o.handle(msg());
    await drain(o);
    const final = JSON.stringify(lark.patches.at(-1));
    expect(final).toContain("调查失败");
    expect(storage.listQa()).toHaveLength(0);
    storage.close();
  });

  it("timeout result patches timeout card", async () => {
    const storage = new Storage(":memory:");
    const lark = new FakeLark();
    const o = new Orchestrator({
      cfg,
      storage,
      runner: fakeRunner(() => ({
        ok: false,
        answer: "",
        turns: 2,
        toolCalls: 3,
        filesTouched: [],
        aborted: "timeout",
      })),
      lark,
    });
    o.handle(msg());
    await drain(o);
    expect(JSON.stringify(lark.patches.at(-1))).toContain("超时");
    storage.close();
  });

  it("serializes same session and keeps help/denied instant", async () => {
    const storage = new Storage(":memory:");
    const lark = new FakeLark();
    const order: string[] = [];
    const runner = fakeRunner(async () => {
      order.push("start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("end");
      return okResult;
    });
    const o = new Orchestrator({ cfg, storage, runner, lark });

    o.handle(msg({ messageId: "om_1" }));
    o.handle(msg({ messageId: "om_2", rootId: "om_1", mentionsBot: false, text: "追问" }));
    o.handle(msg({ messageId: "om_3", text: "help" }));
    await drain(o);

    // 同 thread 两个任务严格串行
    expect(order).toEqual(["start", "end", "start", "end"]);
    // help 立即回复(不进队列):sent 里有三条 reply(2 个 ack + 1 个 help)
    expect(lark.sent.filter((s) => s.kind === "reply")).toHaveLength(3);
    storage.close();
  });

  it("second question in same thread resumes with runner ref", async () => {
    const storage = new Storage(":memory:");
    const lark = new FakeLark();
    const resumes: Array<string | undefined> = [];
    const runner: AgentRunner = {
      kind: "fake",
      run: async (task) => {
        resumes.push(task.resume);
        return okResult;
      },
    };
    const o = new Orchestrator({ cfg, storage, runner, lark });
    o.handle(msg({ messageId: "om_1" }));
    await drain(o);
    o.handle(msg({ messageId: "om_2", rootId: "om_1", mentionsBot: false, text: "那部分退款呢?" }));
    await drain(o);
    expect(resumes).toEqual([undefined, "/tmp/s.jsonl"]);
    storage.close();
  });

  it("unauthorized chat gets denied card", async () => {
    const storage = new Storage(":memory:");
    const lark = new FakeLark();
    const o = new Orchestrator({ cfg, storage, runner: fakeRunner(() => okResult), lark });
    o.handle(msg({ chatId: "oc_unknown" }));
    await drain(o);
    expect(JSON.stringify(lark.sent[0]?.card)).toContain("没有权限");
    storage.close();
  });
});
