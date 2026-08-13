import {
  LEVEL_NAMES,
  repoDisplayName,
  resolveRepoIntent,
  resolveUserLevel,
  type PermissionLevel,
  type PineryConfig,
  type RepoConfig,
} from "@pinery/core";
import type { IncomingMessage } from "./lark/events.js";

/**
 * Gateway(PRD §3.1):意图门控 · 限流 · user×repo×level 鉴权。
 * 鉴权按飞书 user_id 硬判,发生在 agent 之前,与 agent 无关(PRD §5 权限升级缓解)。
 */

export type GateDecision =
  | { action: "ignore"; reason: string }
  | { action: "denied"; reply: string }
  | { action: "rate_limited"; reply: string }
  | { action: "clarify"; projects: string[]; reply: string }
  | { action: "help"; repo?: RepoConfig; levelName?: string }
  | { action: "status"; repo: RepoConfig }
  | { action: "investigate"; repo: RepoConfig; level: PermissionLevel; question: string };

/** 简单令牌桶:user → 时间窗内计数 */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private readonly perMinute: number) {}

  allow(userId: string, now = Date.now()): boolean {
    const windowStart = now - 60_000;
    const list = (this.hits.get(userId) ?? []).filter((t) => t > windowStart);
    if (list.length >= this.perMinute) {
      this.hits.set(userId, list);
      return false;
    }
    list.push(now);
    this.hits.set(userId, list);
    return true;
  }
}

export interface GateContext {
  cfg: PineryConfig;
  limiter: RateLimiter;
  /** 该消息对应 session key 是否已有活跃会话(话题内免 @ 延续的依据) */
  hasActiveSession: boolean;
  /** 活跃话题上次已选择的项目;用户明确点名其他项目时仍以明确意图优先 */
  activeRepo?: string;
}

const HELP_RE = /^(help|帮助|你能干什么|使用说明)[??!!。.]?$/i;
const STATUS_RE = /^(status|状态)[??!!。.]?$/i;

export function gate(msg: IncomingMessage, ctx: GateContext): GateDecision {
  const { cfg, limiter, hasActiveSession } = ctx;

  // 群聊:未 @ 且不在已有会话话题内 → 拒绝旁听(PRD §3.5)
  if (msg.chatType === "group" && !msg.mentionsBot && !hasActiveSession) {
    return { action: "ignore", reason: "group-not-addressed" };
  }

  const text = msg.text.trim();
  const resolution = resolveRepoIntent(cfg, {
    chatId: msg.chatId,
    text,
    activeRepo: ctx.activeRepo,
  });
  const available = resolution.candidates.filter(
    (candidate) =>
      resolveUserLevel(
        candidate,
        msg.senderOpenId,
        msg.chatType,
        candidate.chats.includes(msg.chatId),
      ) !== undefined,
  );

  if (!text || HELP_RE.test(text)) {
    const repo = resolution.repo;
    const level = repo
      ? resolveUserLevel(repo, msg.senderOpenId, msg.chatType, repo.chats.includes(msg.chatId))
      : undefined;
    return {
      action: "help",
      ...(repo && level !== undefined
        ? { repo, levelName: LEVEL_NAMES[level] }
        : {}),
    };
  }

  const repo = resolution.repo;
  if (!repo) {
    if (available.length === 0) {
      return { action: "denied", reply: "当前没有你可访问的项目,请联系管理员。" };
    }
    const projects = available.map(repoDisplayName);
    return {
      action: "clarify",
      projects,
      reply: `我还不能确定你指的是哪个项目。请在问题里带上项目名:${projects.join("、")}`,
    };
  }

  const level = resolveUserLevel(
    repo,
    msg.senderOpenId,
    msg.chatType,
    repo.chats.includes(msg.chatId),
  );
  if (level === undefined) {
    return { action: "denied", reply: "你暂时不能访问这个项目,请联系管理员。" };
  }
  if (STATUS_RE.test(text)) {
    return { action: "status", repo };
  }

  if (!limiter.allow(msg.senderOpenId)) {
    return { action: "rate_limited", reply: "提问太频繁了,请一分钟后再试。" };
  }

  // M1:全部按 L0 调查处理;L1+ 编码任务派发在 M2 开启(PRD §2.2)
  return { action: "investigate", repo, level, question: text };
}
