import type { PineryConfig } from "@pinery/core";
import type { IncomingMessage } from "./lark/events.js";
import type { SessionRow, Storage } from "./storage.js";

/**
 * 会话路由(PRD §3.1/§3.4):
 * session_key = 单聊 chat_id | 群聊话题 root_id;同 key 串行。
 * 紧邻追问 resume;空闲超限/轮数超限 → fresh + 注入「上一轮问题与结论」摘要(§8-Q6)。
 */

export function sessionKeyFor(msg: IncomingMessage): string {
  if (msg.chatType === "p2p") return `p2p:${msg.chatId}`;
  // 话题内消息挂 root;话题首条(主流 @)以自身 message_id 作为未来话题根
  return `thread:${msg.rootId ?? msg.messageId}`;
}

export interface SessionPlan {
  sessionKey: string;
  /** 续跑凭据(存在则 resume 同一 runner 会话) */
  resume?: string;
  /** fresh 时注入的上一轮摘要 */
  context?: string;
  /** 之前累计轮数(展示用) */
  priorTurns: number;
}

export function planSession(
  storage: Storage,
  cfg: PineryConfig,
  msg: IncomingMessage,
  now = Date.now(),
): SessionPlan {
  const sessionKey = sessionKeyFor(msg);
  const row = storage.getSession(sessionKey);
  if (!row) return { sessionKey, priorTurns: 0 };

  const idleMs = cfg.limits.session_idle_archive_min * 60_000;
  const idle = now - row.updated_at > idleMs;
  const overTurns = row.turns >= cfg.limits.session_max_turns;

  if (row.state === "active" && !idle && !overTurns && row.runner_ref) {
    return { sessionKey, resume: row.runner_ref, priorTurns: row.turns };
  }

  // fresh + 两段式摘要注入(蒸馏机制推迟,PRD §8-Q6)
  return {
    sessionKey,
    context: row.summary ?? undefined,
    priorTurns: 0,
  };
}

/** 生成「上一轮问题与结论」两段式摘要(调用方负责 secret 过滤后入库) */
export function buildSessionSummary(question: string, conclusion: string): string {
  const q = question.length > 300 ? `${question.slice(0, 297)}…` : question;
  const c = conclusion.length > 600 ? `${conclusion.slice(0, 597)}…` : conclusion;
  return `上一轮问题:${q}\n上一轮结论:${c}`;
}

export function isSessionActive(row: SessionRow | undefined, cfg: PineryConfig, now = Date.now()): boolean {
  if (!row || row.state !== "active") return false;
  return now - row.updated_at <= cfg.limits.session_idle_archive_min * 60_000;
}
