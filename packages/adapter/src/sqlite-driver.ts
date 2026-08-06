import { createRequire } from "node:module";

/**
 * SQLite 双驱动:Bun 用 bun:sqlite,Node 用 node:sqlite(Bun 未实现 node:sqlite)。
 * 两者的 prepare/get/all/run 语义一致(run 均返回 { changes, lastInsertRowid }),
 * 这里只做最小公共面抽象,零第三方原生依赖。
 */

export type SqliteValue = string | number | bigint | null;

export interface SqliteStatement {
  get(...params: SqliteValue[]): unknown;
  all(...params: SqliteValue[]): unknown[];
  run(...params: SqliteValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

export interface SqliteDriver {
  readonly runtime: "bun" | "node";
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const require_ = createRequire(import.meta.url);

interface NativeDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export function openSqlite(path: string): SqliteDriver {
  if (process.versions.bun) {
    const { Database } = require_("bun:sqlite") as { Database: new (p: string, o?: object) => NativeDb };
    const db = new Database(path, { create: true });
    return wrap("bun", db);
  }
  const { DatabaseSync } = require_("node:sqlite") as { DatabaseSync: new (p: string) => NativeDb };
  return wrap("node", new DatabaseSync(path));
}

function wrap(runtime: "bun" | "node", db: NativeDb): SqliteDriver {
  return {
    runtime,
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql),
    close: () => db.close(),
  };
}
