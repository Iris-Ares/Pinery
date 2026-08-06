import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openSqlite, type SqliteDriver } from "./sqlite-driver.js";

/**
 * SQLite 存储(PRD §3.1):thread→session 映射、审计日志、问答留痕(golden set 地基)。
 * 运行时内置 sqlite(Bun→bun:sqlite / Node→node:sqlite),零原生编译依赖。
 */

export interface SessionRow {
  session_key: string;
  chat_id: string;
  chat_type: string;
  repo: string;
  runner_ref: string | null;
  summary: string | null;
  state: "active" | "archived";
  turns: number;
  created_at: number;
  updated_at: number;
}

export interface QaRow {
  id: number;
  ts: number;
  task_id: string | null;
  session_key: string | null;
  repo: string | null;
  user_id: string | null;
  chat_id: string | null;
  question: string;
  answer: string;
  confidence: string | null;
  duration_ms: number | null;
  turns: number | null;
  cost_usd: number | null;
  golden: number;
  note: string | null;
}

export interface AuditEntry {
  sessionKey?: string;
  taskId?: string;
  userId?: string;
  repo?: string;
  kind: "task_start" | "tool_start" | "tool_end" | "policy_block" | "task_end" | "error" | "delivery";
  tool?: string;
  detail?: string;
}

export class Storage {
  private db: SqliteDriver;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = openSqlite(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_key TEXT PRIMARY KEY,
        chat_id     TEXT NOT NULL,
        chat_type   TEXT NOT NULL,
        repo        TEXT NOT NULL,
        runner_ref  TEXT,
        summary     TEXT,
        state       TEXT NOT NULL DEFAULT 'active',
        turns       INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ts          INTEGER NOT NULL,
        session_key TEXT,
        task_id     TEXT,
        user_id     TEXT,
        repo        TEXT,
        kind        TEXT NOT NULL,
        tool        TEXT,
        detail      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_task ON audit_log(task_id);
      CREATE TABLE IF NOT EXISTS qa_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ts          INTEGER NOT NULL,
        task_id     TEXT,
        session_key TEXT,
        repo        TEXT,
        user_id     TEXT,
        chat_id     TEXT,
        question    TEXT NOT NULL,
        answer      TEXT NOT NULL,
        confidence  TEXT,
        duration_ms INTEGER,
        turns       INTEGER,
        cost_usd    REAL,
        golden      INTEGER NOT NULL DEFAULT 0,
        note        TEXT
      );
    `);
  }

  // -- sessions ------------------------------------------------------------

  getSession(sessionKey: string): SessionRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE session_key = ?")
      .get(sessionKey) as unknown as SessionRow | undefined;
    return row ?? undefined;
  }

  upsertSession(row: {
    sessionKey: string;
    chatId: string;
    chatType: string;
    repo: string;
    runnerRef?: string;
    summary?: string;
    turns: number;
    state?: "active" | "archived";
  }): void {
    const now = Date.now();
    this.db
      .prepare(`
        INSERT INTO sessions (session_key, chat_id, chat_type, repo, runner_ref, summary, state, turns, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_key) DO UPDATE SET
          runner_ref = excluded.runner_ref,
          summary    = excluded.summary,
          state      = excluded.state,
          turns      = excluded.turns,
          updated_at = excluded.updated_at
      `)
      .run(
        row.sessionKey,
        row.chatId,
        row.chatType,
        row.repo,
        row.runnerRef ?? null,
        row.summary ?? null,
        row.state ?? "active",
        row.turns,
        now,
        now,
      );
  }

  archiveSession(sessionKey: string): void {
    this.db
      .prepare("UPDATE sessions SET state = 'archived', updated_at = ? WHERE session_key = ?")
      .run(Date.now(), sessionKey);
  }

  // -- audit ---------------------------------------------------------------

  audit(entry: AuditEntry): void {
    this.db
      .prepare(
        "INSERT INTO audit_log (ts, session_key, task_id, user_id, repo, kind, tool, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        Date.now(),
        entry.sessionKey ?? null,
        entry.taskId ?? null,
        entry.userId ?? null,
        entry.repo ?? null,
        entry.kind,
        entry.tool ?? null,
        entry.detail?.slice(0, 2000) ?? null,
      );
  }

  auditForTask(taskId: string): Array<{ ts: number; kind: string; tool: string | null; detail: string | null }> {
    return this.db
      .prepare("SELECT ts, kind, tool, detail FROM audit_log WHERE task_id = ? ORDER BY id")
      .all(taskId) as unknown as Array<{ ts: number; kind: string; tool: string | null; detail: string | null }>;
  }

  // -- qa / golden set -----------------------------------------------------

  logQa(row: {
    taskId?: string;
    sessionKey?: string;
    repo?: string;
    userId?: string;
    chatId?: string;
    question: string;
    answer: string;
    confidence?: string;
    durationMs?: number;
    turns?: number;
    costUsd?: number;
  }): number {
    const res = this.db
      .prepare(`
        INSERT INTO qa_log (ts, task_id, session_key, repo, user_id, chat_id, question, answer, confidence, duration_ms, turns, cost_usd)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        Date.now(),
        row.taskId ?? null,
        row.sessionKey ?? null,
        row.repo ?? null,
        row.userId ?? null,
        row.chatId ?? null,
        row.question,
        row.answer,
        row.confidence ?? null,
        row.durationMs ?? null,
        row.turns ?? null,
        row.costUsd ?? null,
      );
    return Number(res.lastInsertRowid);
  }

  listQa(opts: { limit?: number; goldenOnly?: boolean } = {}): QaRow[] {
    const limit = opts.limit ?? 50;
    const where = opts.goldenOnly ? "WHERE golden = 1" : "";
    return this.db
      .prepare(`SELECT * FROM qa_log ${where} ORDER BY id DESC LIMIT ?`)
      .all(limit) as unknown as QaRow[];
  }

  markGolden(id: number, note?: string): boolean {
    const res = this.db
      .prepare("UPDATE qa_log SET golden = 1, note = COALESCE(?, note) WHERE id = ?")
      .run(note ?? null, id);
    return res.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
