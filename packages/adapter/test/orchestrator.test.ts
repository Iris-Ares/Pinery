import { parseConfig, type AgentRunner, type RunnerResult, type WorkspaceProvider } from "@pinery/core";
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

  // 回归(PR review P2):工作区获取失败必须收敛卡片与任务状态,
  // 否则进度卡片永远停在「调查中」
  it("patches an error card when workspace acquisition fails", async () => {
    const storage = new Storage(":memory:");
    const lark = new FakeLark();
    // 首次失败、之后恢复:既验证错误收敛,也验证没有残留状态卡住后续任务
    let attempts = 0;
    const flakyWorkspaces: WorkspaceProvider = {
      kind: "fake-remote",
      acquireSession: (repo, key) => {
        attempts++;
        if (attempts === 1) return Promise.reject(new Error("cloudflare endpoint unreachable"));
        return Promise.resolve({ handle: `remote:${key}`, repo: repo.name, dir: "/workspace", readOnly: true });
      },
      acquireTask: () => Promise.reject(new Error("not used")),
      release: () => Promise.resolve(),
    };
    const o = new Orchestrator({
      cfg,
      storage,
      runner: fakeRunner(() => okResult),
      lark,
      workspaces: flakyWorkspaces,
    });
    o.handle(msg());
    await drain(o);

    const failed = JSON.stringify(lark.patches.at(-1));
    expect(failed).toContain("项目代码准备失败");
    expect(failed).toContain("cloudflare endpoint unreachable");
    expect(failed).not.toContain("调查中");
    expect(storage.listQa()).toHaveLength(0);

    // 同一会话的下一条消息不被残留的 running 状态卡住
    o.handle(msg({ messageId: "om_next" }));
    await drain(o);
    expect(JSON.stringify(lark.patches.at(-1))).toContain("会退款");
    expect(storage.listQa()).toHaveLength(1);
    storage.close();
  });

  // 回归(PR review P2):中止优先于部分输出
  it("treats a user cancellation as aborted even when partial text exists", async () => {
    const storage = new Storage(":memory:");
    const lark = new FakeLark();
    const o = new Orchestrator({
      cfg,
      storage,
      runner: fakeRunner(() => ({ ...okResult, ok: false, aborted: "user" as const })),
      lark,
    });
    o.handle(msg());
    await drain(o);

    const final = JSON.stringify(lark.patches.at(-1));
    expect(final).toContain("取消");
    expect(final).not.toContain("会退款"); // 不得把片段呈现为答案
    expect(storage.listQa()).toHaveLength(0); // 不污染 golden set
    expect(storage.getSession("thread:om_q")).toBeUndefined(); // 不写入会话记忆
    storage.close();
  });

  it("marks timeout partial output as incomplete and keeps it out of the golden set", async () => {
    const storage = new Storage(":memory:");
    const lark = new FakeLark();
    const o = new Orchestrator({
      cfg,
      storage,
      runner: fakeRunner(() => ({ ...okResult, ok: false, aborted: "timeout" as const })),
      lark,
    });
    o.handle(msg());
    await drain(o);

    const final = JSON.stringify(lark.patches.at(-1));
    expect(final).toContain("超时");
    expect(final).toContain("不完整"); // 部分线索必须标注
    expect(final).not.toContain("AKIAIOSFODNN7EXAMPLE"); // 部分内容同样过 secret 过滤
    expect(storage.listQa()).toHaveLength(0);
    storage.close();
  });

  it("turn-limit abort does not present as a successful answer", async () => {
    const storage = new Storage(":memory:");
    const lark = new FakeLark();
    const o = new Orchestrator({
      cfg,
      storage,
      runner: fakeRunner(() => ({ ...okResult, ok: false, aborted: "turn-limit" as const })),
      lark,
    });
    o.handle(msg());
    await drain(o);
    expect(JSON.stringify(lark.patches.at(-1))).toContain("没有收敛");
    expect(storage.listQa()).toHaveLength(0);
    storage.close();
  });

  // 回归(PR review P2):runner 可能在 prompt 之前就 reject(pi 的 setup 阶段)
  it("patches an error card when the runner rejects during setup", async () => {
    const storage = new Storage(":memory:");
    const lark = new FakeLark();
    const o = new Orchestrator({
      cfg,
      storage,
      runner: { kind: "fake", run: () => Promise.reject(new Error("createAgentSession failed")) },
      lark,
    });
    o.handle(msg());
    await drain(o);

    const final = JSON.stringify(lark.patches.at(-1));
    expect(final).toContain("调查未能启动");
    expect(final).toContain("createAgentSession failed");
    expect(final).not.toContain("调查中");
    expect(storage.listQa()).toHaveLength(0);
    storage.close();
  });

  // 回归(PR review P2):流式中断会带回部分文本但没有 aborted 标记
  it("never presents a failed run as a successful answer", async () => {
    const storage = new Storage(":memory:");
    const lark = new FakeLark();
    const o = new Orchestrator({
      cfg,
      storage,
      runner: fakeRunner(() => ({
        ...okResult,
        ok: false,
        aborted: undefined,
        error: "stream disconnected",
      })),
      lark,
    });
    o.handle(msg());
    await drain(o);

    const final = JSON.stringify(lark.patches.at(-1));
    expect(final).toContain("调查未能完成");
    expect(final).toContain("stream disconnected");
    expect(final).toContain("不完整"); // 部分线索必须标注
    expect(final).not.toContain("AKIAIOSFODNN7EXAMPLE"); // 仍过 secret 过滤
    // 不污染 golden set 与会话记忆
    expect(storage.listQa()).toHaveLength(0);
    expect(storage.getSession("thread:om_q")).toBeUndefined();
    storage.close();
  });

  // 回归(PR review P2):存储不可用时也要给出可见反馈,
  // 且异常不能冒泡回长连接 listener(一条消息不能拖垮整个连接)
  it("reports an error card instead of throwing when storage is unavailable", async () => {
    const storage = new Storage(":memory:");
    storage.close(); // 模拟库不可用(已关闭/只读/磁盘满)
    const lark = new FakeLark();
    const o = new Orchestrator({ cfg, storage, runner: fakeRunner(() => okResult), lark });

    expect(() => o.handle(msg())).not.toThrow();
    await drain(o);

    const sent = JSON.stringify(lark.sent.at(-1)?.card);
    expect(sent).toContain("存储不可用");
    expect(sent).not.toContain("调查中");
  });

  it("an unbound chat can use the only project by default", async () => {
    const storage = new Storage(":memory:");
    const lark = new FakeLark();
    const o = new Orchestrator({ cfg, storage, runner: fakeRunner(() => okResult), lark });
    o.handle(msg({ chatId: "oc_unknown" }));
    await drain(o);
    expect(JSON.stringify(lark.sent[0]?.card)).toContain("调查中");
    expect(JSON.stringify(lark.patches.at(-1))).toContain("会退款");
    storage.close();
  });
});
