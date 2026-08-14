import { describe, expect, it } from "vitest";
import { openSqlite } from "../src/sqlite-driver.js";
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

  it("adds resume binding columns to an existing pre-migration sessions table", () => {
    const driver = openSqlite(":memory:");
    driver.exec(`
      CREATE TABLE sessions (
        session_key TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        chat_type TEXT NOT NULL,
        repo TEXT NOT NULL,
        runner_ref TEXT,
        summary TEXT,
        state TEXT NOT NULL DEFAULT 'active',
        turns INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    const s = new Storage(driver);
    s.upsertSession({
      sessionKey: "k",
      chatId: "c",
      chatType: "group",
      repo: "r",
      runnerRef: "piw:1",
      runnerKind: "pi-workers",
      workspaceHandle: "s-r-c",
      workspaceReadOnly: true,
      turns: 1,
    });
    expect(s.getSession("k")).toMatchObject({
      runner_kind: "pi-workers",
      workspace_handle: "s-r-c",
      workspace_read_only: 1,
    });
    s.close();
  });

  it("archives sessions", () => {
    const s = new Storage(":memory:");
    s.upsertSession({ sessionKey: "k", chatId: "c", chatType: "p2p", repo: "r", turns: 0 });
    s.archiveSession("k");
    expect(s.getSession("k")?.state).toBe("archived");
    s.close();
  });

  it("persists runner snapshots with their sandbox/worktree binding", () => {
    const s = new Storage(":memory:");
    const runnerRef = s.saveRunnerSession({
      runnerKind: "pi-workers",
      repo: "order",
      workspaceHandle: "s-order-chat",
      workspaceDir: "/workspace",
      workspaceBranch: "pinery/task-1",
      workspaceReadOnly: false,
      stateJson: '{"version":1}',
    });
    expect(runnerRef).toMatch(/^piw:/);
    expect(s.getRunnerSession(runnerRef)).toMatchObject({
      runner_kind: "pi-workers",
      repo: "order",
      workspace_handle: "s-order-chat",
      workspace_branch: "pinery/task-1",
      workspace_read_only: 0,
      state_json: '{"version":1}',
    });

    expect(
      s.saveRunnerSession({
        runnerRef,
        runnerKind: "pi-workers",
        repo: "order",
        workspaceHandle: "s-order-chat",
        workspaceDir: "/workspace",
        workspaceReadOnly: true,
        stateJson: '{"version":1,"messages":[]}',
      }),
    ).toBe(runnerRef);
    expect(s.getRunnerSession(runnerRef)?.workspace_read_only).toBe(1);
    s.close();
  });

  it("remembers bot message anchors only in their original chat", () => {
    const s = new Storage(":memory:");
    s.rememberBotMessage("om_bot", "oc_group", "group:oc_group");
    expect(s.isBotMessage("om_bot", "oc_group")).toBe(true);
    expect(s.isBotMessage("om_bot", "oc_other")).toBe(false);
    expect(s.isBotMessage(undefined, "oc_group")).toBe(false);
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
