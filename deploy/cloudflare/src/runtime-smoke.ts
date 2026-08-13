import type { RunnerResult } from "@pinery/core";

/**
 * 线上 Agent 冒烟使用固定问题,不接受调用方 prompt,避免把诊断入口变成
 * 持有 PINERY_TOKEN 即可任意消耗模型额度的第二套聊天 API。
 */
export const RUNTIME_SMOKE_PROMPT = [
  "这是 Pinery 的运行时健康检查。",
  "必须调用 read 工具读取 /workspace/.pinery-snapshot.json,不要读取其他文件,不要执行 bash。",
  "从文件内容提取 commit,最终只输出: PINERY_SMOKE commit=<完整的 40 位 commit SHA>。",
].join("\n");

export interface RuntimeSmokeSummary {
  ok: boolean;
  runnerOk: boolean;
  expectedCommit: string;
  observedCommit?: string;
  answerPreview?: string;
  readManifest: boolean;
  turns: number;
  toolCalls: number;
  toolNames: string[];
  filesTouched: string[];
  durationMs: number;
  error?: string;
}

export function summarizeRuntimeSmoke(
  result: RunnerResult,
  expectedCommit: string,
  toolNames: string[],
  durationMs: number,
): RuntimeSmokeSummary {
  const observedCommit = result.answer.match(/\b[0-9a-f]{40}\b/i)?.[0]?.toLowerCase();
  const readManifest = result.filesTouched.some((path) => path.replace(/\\/g, "/").endsWith("/.pinery-snapshot.json"));
  const ok =
    result.ok &&
    !result.aborted &&
    result.toolCalls > 0 &&
    readManifest &&
    observedCommit === expectedCommit.toLowerCase();

  return {
    ok,
    runnerOk: result.ok,
    expectedCommit,
    ...(observedCommit ? { observedCommit } : {}),
    ...(result.answer ? { answerPreview: result.answer.slice(0, 500) } : {}),
    readManifest,
    turns: result.turns,
    toolCalls: result.toolCalls,
    toolNames,
    filesTouched: result.filesTouched,
    durationMs,
    ...(!ok ? { error: result.error ?? "Agent 未完成固定的读文件 + commit 回显验收" } : {}),
  };
}
