import { writeFileSync } from "node:fs";
import { loadConfig, resolvePaths } from "@pinery/core";
import { Storage } from "../storage.js";

/**
 * golden set 工具(PRD §6:M1 第一天开始积累,每问必存;
 * 这里提供人工标注入口:list / mark / export)。
 */

export function runGoldenList(opts: { config: string; goldenOnly?: boolean; limit?: number }): void {
  const storage = openStorage(opts.config);
  const rows = storage.listQa({ goldenOnly: opts.goldenOnly, limit: opts.limit ?? 20 });
  if (rows.length === 0) {
    console.log("暂无记录。");
    return;
  }
  for (const r of rows) {
    const flag = r.golden ? "★" : " ";
    const q = r.question.replace(/\s+/g, " ").slice(0, 60);
    const conf = r.confidence ? ` [${r.confidence}]` : "";
    console.log(`${flag} #${r.id} ${new Date(r.ts).toISOString().slice(0, 16)} ${q}${conf}`);
  }
  storage.close();
}

export function runGoldenMark(opts: { config: string; id: number; note?: string }): number {
  const storage = openStorage(opts.config);
  const ok = storage.markGolden(opts.id, opts.note);
  storage.close();
  if (!ok) {
    console.error(`#${opts.id} 不存在`);
    return 1;
  }
  console.log(`已标注 #${opts.id} 为 golden${opts.note ? `(${opts.note})` : ""}`);
  return 0;
}

export function runGoldenExport(opts: { config: string; out?: string; all?: boolean }): void {
  const storage = openStorage(opts.config);
  const rows = storage.listQa({ goldenOnly: !opts.all, limit: 100000 });
  const jsonl = rows
    .reverse()
    .map((r) =>
      JSON.stringify({
        id: r.id,
        ts: r.ts,
        repo: r.repo,
        question: r.question,
        answer: r.answer,
        confidence: r.confidence,
        golden: r.golden === 1,
        note: r.note,
      }),
    )
    .join("\n");
  storage.close();
  if (opts.out) {
    writeFileSync(opts.out, `${jsonl}\n`, "utf8");
    console.log(`已导出 ${rows.length} 条到 ${opts.out}`);
  } else {
    console.log(jsonl);
  }
}

function openStorage(configPath: string): Storage {
  const cfg = loadConfig(configPath);
  return new Storage(resolvePaths(cfg).storageDb);
}
