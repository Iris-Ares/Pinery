import {
  LEVEL_NAMES,
  repoForChat,
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
}

const HELP_RE = /^(help|帮助|你能干什么|使用说明)[??!!。.]?$/i;
const STATUS_RE = /^(status|状态)[??!!。.]?$/i;

export function gate(msg: IncomingMessage, ctx: GateContext): GateDecision {
  const { cfg, limiter, hasActiveSession } = ctx;

  // 群聊:未 @ 且不在已有会话话题内 → 拒绝旁听(PRD §3.5)
  if (msg.chatType === "group" && !msg.mentionsBot && !hasActiveSession) {
    return { action: "ignore", reason: "group-not-addressed" };
  }

  const repo = repoForChat(cfg, msg.chatId, msg.chatType);
  if (!repo) {
    if (msg.chatType === "group" && !msg.mentionsBot) {
      return { action: "ignore", reason: "unregistered-chat" };
    }
    return {
      action: "denied",
      reply: "本会话未绑定任何仓库。请管理员在 pinery.yaml 的 repos[].chats 中登记本群后重启 Pinery。",
    };
  }

  const chatRegistered = repo.chats.includes(msg.chatId);
  const level = resolveUserLevel(repo, msg.senderOpenId, msg.chatType, chatRegistered);
  if (level === undefined) {
    return { action: "denied", reply: "你在该仓库上没有已授权的能力级别,请联系仓库管理员。" };
  }

  const text = msg.text.trim();
  if (!text || HELP_RE.test(text)) {
    return { action: "help", repo, levelName: LEVEL_NAMES[level] };
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
