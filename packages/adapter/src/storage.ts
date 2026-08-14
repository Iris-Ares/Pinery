import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openSqlite, type SqliteDriver } from "./sqlite-driver.js";

/**
 * SQLite 存储(PRD §3.1):conversation→session 映射、Bot 消息锚点、审计日志、
 * 问答留痕(golden set 地基)。
 * 运行时内置 sqlite(Bun→bun:sqlite / Node→node:sqlite),零原生编译依赖。
 */

export interface SessionRow {
  session_key: string;
  chat_id: string;
  chat_type: string;
  repo: string;
  runner_ref: string | null;
  runner_kind: string | null;
  workspace_handle: string | null;
  workspace_branch: string | null;
  workspace_read_only: number | null;
  summary: string | null;
  state: "active" | "archived";
  turns: number;
  created_at: number;
  updated_at: number;
}

export interface RunnerSessionRow {
  runner_ref: string;
  runner_kind: string;
  repo: string;
  workspace_handle: string;
  workspace_dir: string;
  workspace_branch: string | null;
  workspace_read_only: number;
  state_json: string;
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
  kind:
    | "task_start"
    | "tool_start"
    | "tool_end"
    | "policy_block"
    | "task_end"
    | "error"
    | "delivery"
    | "document_prepare"
    | "document_execute"
    | "document_cancel";
  tool?: string;
  detail?: string;
}

export type DocumentActionStatus =
  | "pending"
  | "executing"
  | "completed"
  | "cancelled"
  | "expired"
  | "failed";

export interface DocumentActionRow {
  id: string;
  code: string;
  session_key: string;
  chat_id: string;
  user_id: string;
  operation: "create" | "append" | "replace";
  target_token: string | null;
  target_url: string | null;
  payload_json: string;
  base_revision: number;
  status: DocumentActionStatus;
  expires_at: number;
  result_json: string | null;
  created_at: number;
  updated_at: number;
}

export class Storage {
  private db: SqliteDriver;

  /**
   * @param source 文件路径(本地形态:bun:sqlite / node:sqlite,启用 WAL)
   *   或已就绪的 SqliteDriver(CF 形态:DO SQLite 适配器,无 WAL 概念)
   */
  constructor(source: string | SqliteDriver) {
    if (typeof source === "string") {
      if (source !== ":memory:") mkdirSync(dirname(source), { recursive: true });
      this.db = openSqlite(source);
      this.db.exec("PRAGMA journal_mode = WAL");
    } else {
      this.db = source;
    }
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _pinery_schema_migrations (
        id         INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);
    const sessionsExisted = !!this.db
      .prepare("SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = 'sessions'")
      .get();
    const migration = this.db
      .prepare("SELECT COALESCE(MAX(id), 0) AS version FROM _pinery_schema_migrations")
      .get() as { version?: number } | undefined;
    const version = migration?.version ?? 0;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_key TEXT PRIMARY KEY,
        chat_id     TEXT NOT NULL,
        chat_type   TEXT NOT NULL,
        repo        TEXT NOT NULL,
        runner_ref  TEXT,
        runner_kind TEXT,
        workspace_handle TEXT,
        workspace_branch TEXT,
        workspace_read_only INTEGER,
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
      CREATE TABLE IF NOT EXISTS bot_messages (
        message_id  TEXT PRIMARY KEY,
        chat_id     TEXT NOT NULL,
        session_key TEXT NOT NULL,
        ts          INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bot_messages_ts ON bot_messages(ts);
      CREATE TABLE IF NOT EXISTS runner_sessions (
        runner_ref          TEXT PRIMARY KEY,
        runner_kind         TEXT NOT NULL,
        repo                TEXT NOT NULL,
        workspace_handle    TEXT NOT NULL,
        workspace_dir       TEXT NOT NULL,
        workspace_branch    TEXT,
        workspace_read_only INTEGER NOT NULL,
        state_json          TEXT NOT NULL,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS document_actions (
        id            TEXT PRIMARY KEY,
        code          TEXT NOT NULL UNIQUE,
        session_key   TEXT NOT NULL,
        chat_id       TEXT NOT NULL,
        user_id       TEXT NOT NULL,
        operation     TEXT NOT NULL,
        target_token  TEXT,
        target_url    TEXT,
        payload_json  TEXT NOT NULL,
        base_revision INTEGER NOT NULL,
        status        TEXT NOT NULL,
        expires_at    INTEGER NOT NULL,
        result_json   TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_document_actions_expiry ON document_actions(status, expires_at);
    `);

    // DO SQLite 不支持 PRAGMA user_version；用普通迁移表记录版本。全新库的
    // CREATE TABLE 已是最新版，旧库才执行一次 ALTER TABLE。
    if (version < 2) {
      if (sessionsExisted) {
        this.db.exec(`
          ALTER TABLE sessions ADD COLUMN runner_kind TEXT;
          ALTER TABLE sessions ADD COLUMN workspace_handle TEXT;
          ALTER TABLE sessions ADD COLUMN workspace_branch TEXT;
          ALTER TABLE sessions ADD COLUMN workspace_read_only INTEGER;
        `);
      }
      this.db
        .prepare("INSERT INTO _pinery_schema_migrations (id, applied_at) VALUES (?, ?)")
        .run(2, Date.now());
    }
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
    runnerKind?: string;
    workspaceHandle?: string;
    workspaceBranch?: string;
    workspaceReadOnly?: boolean;
    summary?: string;
    turns: number;
    state?: "active" | "archived";
  }): void {
    const now = Date.now();
    const previousRunnerRef = this.getSession(row.sessionKey)?.runner_ref;
    this.db
      .prepare(`
        INSERT INTO sessions (
          session_key, chat_id, chat_type, repo, runner_ref, runner_kind,
          workspace_handle, workspace_branch, workspace_read_only,
          summary, state, turns, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_key) DO UPDATE SET
          chat_id     = excluded.chat_id,
          chat_type   = excluded.chat_type,
          repo        = excluded.repo,
          runner_ref = excluded.runner_ref,
          runner_kind = excluded.runner_kind,
          workspace_handle = excluded.workspace_handle,
          workspace_branch = excluded.workspace_branch,
          workspace_read_only = excluded.workspace_read_only,
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
        row.runnerKind ?? null,
        row.workspaceHandle ?? null,
        row.workspaceBranch ?? null,
        row.workspaceReadOnly === undefined ? null : row.workspaceReadOnly ? 1 : 0,
        row.summary ?? null,
        row.state ?? "active",
        row.turns,
        now,
        now,
      );
    if (previousRunnerRef && previousRunnerRef !== row.runnerRef) {
      this.db.prepare("DELETE FROM runner_sessions WHERE runner_ref = ?").run(previousRunnerRef);
    }
  }

  // -- runner session snapshots ------------------------------------------

  getRunnerSession(runnerRef: string): RunnerSessionRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM runner_sessions WHERE runner_ref = ?")
      .get(runnerRef) as unknown as RunnerSessionRow | undefined;
    return row ?? undefined;
  }

  saveRunnerSession(row: {
    runnerRef?: string;
    runnerKind: string;
    repo: string;
    workspaceHandle: string;
    workspaceDir: string;
    workspaceBranch?: string;
    workspaceReadOnly: boolean;
    stateJson: string;
  }): string {
    const now = Date.now();
    const runnerRef = row.runnerRef ?? `piw:${globalThis.crypto.randomUUID()}`;
    this.db
      .prepare(`
        INSERT INTO runner_sessions (
          runner_ref, runner_kind, repo, workspace_handle, workspace_dir,
          workspace_branch, workspace_read_only, state_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(runner_ref) DO UPDATE SET
          runner_kind = excluded.runner_kind,
          repo = excluded.repo,
          workspace_handle = excluded.workspace_handle,
          workspace_dir = excluded.workspace_dir,
          workspace_branch = excluded.workspace_branch,
          workspace_read_only = excluded.workspace_read_only,
          state_json = excluded.state_json,
          updated_at = excluded.updated_at
      `)
      .run(
        runnerRef,
        row.runnerKind,
        row.repo,
        row.workspaceHandle,
        row.workspaceDir,
        row.workspaceBranch ?? null,
        row.workspaceReadOnly ? 1 : 0,
        row.stateJson,
        now,
        now,
      );
    return runnerRef;
  }

  archiveSession(sessionKey: string): void {
    this.db
      .prepare("UPDATE sessions SET state = 'archived', updated_at = ? WHERE session_key = ?")
      .run(Date.now(), sessionKey);
  }

  // -- bot message anchors -------------------------------------------------

  rememberBotMessage(messageId: string, chatId: string, sessionKey: string): void {
    const now = Date.now();
    this.db
      .prepare("INSERT OR REPLACE INTO bot_messages (message_id, chat_id, session_key, ts) VALUES (?, ?, ?, ?)")
      .run(messageId, chatId, sessionKey, now);
    // 引用回复通常紧邻发生；保留 7 天足够支持重启后的自然追问，同时限制增长。
    this.db.prepare("DELETE FROM bot_messages WHERE ts < ?").run(now - 7 * 24 * 3600_000);
  }

  isBotMessage(messageId: string | undefined, chatId: string): boolean {
    if (!messageId) return false;
    const row = this.db
      .prepare("SELECT 1 AS found FROM bot_messages WHERE message_id = ? AND chat_id = ?")
      .get(messageId, chatId) as { found?: number } | undefined;
    return row?.found === 1;
  }

  // -- controlled document actions ---------------------------------------

  createDocumentAction(row: {
    id: string;
    code: string;
    sessionKey: string;
    chatId: string;
    userId: string;
    operation: DocumentActionRow["operation"];
    targetToken?: string;
    targetUrl?: string;
    payloadJson: string;
    baseRevision: number;
    expiresAt: number;
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO document_actions (
          id, code, session_key, chat_id, user_id, operation, target_token,
          target_url, payload_json, base_revision, status, expires_at,
          result_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?)`,
      )
      .run(
        row.id,
        row.code,
        row.sessionKey,
        row.chatId,
        row.userId,
        row.operation,
        row.targetToken ?? null,
        row.targetUrl ?? null,
        row.payloadJson,
        row.baseRevision,
        row.expiresAt,
        now,
        now,
      );
  }

  getDocumentActionByCode(code: string): DocumentActionRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM document_actions WHERE code = ?")
      .get(code) as unknown as DocumentActionRow | undefined;
    return row ?? undefined;
  }

  claimDocumentAction(id: string, now = Date.now()): boolean {
    const result = this.db
      .prepare(
        "UPDATE document_actions SET status = 'executing', updated_at = ? WHERE id = ? AND status = 'pending' AND expires_at >= ?",
      )
      .run(now, id, now);
    return Number(result.changes) === 1;
  }

  cancelDocumentAction(id: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE document_actions SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(Date.now(), id);
    return Number(result.changes) === 1;
  }

  finishDocumentAction(id: string, status: "completed" | "failed" | "expired", result?: unknown): void {
    this.db
      .prepare(
        "UPDATE document_actions SET status = ?, result_json = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'executing')",
      )
      .run(status, result === undefined ? null : JSON.stringify(result), Date.now(), id);
  }

  expireDocumentActions(now = Date.now()): number {
    const result = this.db
      .prepare(
        "UPDATE document_actions SET status = 'expired', updated_at = ? WHERE status = 'pending' AND expires_at < ?",
      )
      .run(now, now);
    return Number(result.changes);
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
