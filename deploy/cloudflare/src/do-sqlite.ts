import type { SqliteDriver, SqliteStatement, SqliteValue } from "@pinery/adapter/sqlite-driver";

/**
 * DO SQLite → adapter SqliteDriver 适配:ctx.storage.sql 与 bun:sqlite /
 * node:sqlite 同为同步 API,`Storage` 类与三张表 DDL 因此原样跑在 Agent DO 里。
 * (WAL pragma 由 Storage 按「注入 driver」分支跳过 —— DO SQLite 无此概念。)
 */
export function doSqliteDriver(sql: SqlStorage): SqliteDriver {
  const statement = (query: string): SqliteStatement => ({
    get(...params: SqliteValue[]): unknown {
      const cursor = sql.exec(query, ...(params as unknown[]));
      for (const row of cursor) return row;
      return undefined;
    },
    all(...params: SqliteValue[]): unknown[] {
      return sql.exec(query, ...(params as unknown[])).toArray();
    },
    run(...params: SqliteValue[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
      const cursor = sql.exec(query, ...(params as unknown[]));
      cursor.toArray(); // 驱动语义:run 立即执行完毕
      // DO SQL 的 cursor 不带 lastInsertRowid;DO 单线程,紧随的查询语义安全
      // (Storage.logQa 以此返回 qa id)
      const row = sql.exec("SELECT last_insert_rowid() AS id").one() as { id: number };
      return { changes: cursor.rowsWritten, lastInsertRowid: row.id };
    },
  });

  return {
    runtime: "node", // 语义占位:调用方仅用于诊断展示
    exec(query: string): void {
      sql.exec(query);
    },
    prepare(query: string): SqliteStatement {
      return statement(query);
    },
    close(): void {
      // DO storage 生命周期由平台管理,无需关闭
    },
  };
}
