import { describe, expect, it } from "vitest";
import { Storage } from "../src/storage.js";

describe("Storage", () => {
  it("upserts and reads sessions", () => {
    const s = new Storage(":memory:");
    s.upsertSession({ sessionKey: "p2p:oc_1", chatId: "oc_1", chatType: "p2p", repo: "order", turns: 3 });
    const row = s.getSession("p2p:oc_1");
    expect(row?.repo).toBe("order");
    expect(row?.turns).toBe(3);
    expect(row?.state).toBe("active");

    s.upsertSession({
      sessionKey: "p2p:oc_1",
      chatId: "oc_1",
      chatType: "p2p",
      repo: "order",
      turns: 5,
      runnerRef: "/tmp/s.jsonl",
      summary: "上一轮…",
    });
    const updated = s.getSession("p2p:oc_1");
    expect(updated?.turns).toBe(5);
    expect(updated?.runner_ref).toBe("/tmp/s.jsonl");
    s.close();
  });

  it("archives sessions", () => {
    const s = new Storage(":memory:");
    s.upsertSession({ sessionKey: "k", chatId: "c", chatType: "p2p", repo: "r", turns: 0 });
    s.archiveSession("k");
    expect(s.getSession("k")?.state).toBe("archived");
    s.close();
  });

  it("writes audit entries per task", () => {
    const s = new Storage(":memory:");
    s.audit({ taskId: "t1", kind: "task_start", detail: "q" });
    s.audit({ taskId: "t1", kind: "tool_start", tool: "bash", detail: "rg foo" });
    s.audit({ taskId: "t2", kind: "task_start" });
    expect(s.auditForTask("t1")).toHaveLength(2);
    expect(s.auditForTask("t1")[1]?.tool).toBe("bash");
    s.close();
  });

  it("logs QA and marks golden", () => {
    const s = new Storage(":memory:");
    const id = s.logQa({ question: "会退款吗?", answer: "会。", confidence: "high", repo: "order" });
    expect(s.listQa()).toHaveLength(1);
    expect(s.listQa({ goldenOnly: true })).toHaveLength(0);
    expect(s.markGolden(id, "已核实")).toBe(true);
    const golden = s.listQa({ goldenOnly: true });
    expect(golden).toHaveLength(1);
    expect(golden[0]?.note).toBe("已核实");
    expect(s.markGolden(999)).toBe(false);
    s.close();
  });
});
