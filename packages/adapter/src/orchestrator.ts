import {
  filterSecrets,
  repoCheckoutDir,
  repoDisplayName,
  type PineryConfig,
  type RepoConfig,
  type AgentRunner,
  type WorkspaceProvider,
} from "@pinery/core";
import { RateLimiter, gate } from "./gateway.js";
import { CANCEL_RE, runInvestigationPipeline } from "./investigation.js";
import {
  deniedCard,
  errorCard,
  helpCard,
  projectChoiceCard,
  statusCard,
  type Card,
} from "./lark/cards.js";
import type { IncomingMessage } from "./lark/events.js";
import type { LarkMessenger } from "./lark/messenger.js";
import { headInfo } from "./repo-sync.js";
import { sessionKeyFor } from "./sessions.js";
import type { Storage } from "./storage.js";

// 接口本体已迁至 lark/messenger.ts(CF 形态复用);原位 re-export 保持兼容
export type { LarkMessenger } from "./lark/messenger.js";

export interface OrchestratorDeps {
  cfg: PineryConfig;
  storage: Storage;
  runner: AgentRunner;
  lark: LarkMessenger;
  /** 工作区后端(缺省 local);云沙箱后端按 WorkspaceProvider 接口替换 */
  workspaces?: WorkspaceProvider;
  log?: (line: string) => void;
}

/**
 * 编排器(PRD §3.1 会话路由,本地常驻进程宿主):
 * - 同 session_key 串行(Promise 链队列),全局并发受 limits.max_concurrent_tasks 约束
 * - 调查流水线本体在 investigation.ts(与 CF 形态的 Agent DO 共用)
 */
export class Orchestrator {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly running = new Map<string, AbortController>();
  private readonly routeRepos = new Map<string, string>();
  private readonly limiter: RateLimiter;
  private queued = 0;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly deps: OrchestratorDeps) {
    this.limiter = new RateLimiter(deps.cfg.limits.rate_per_user_per_min);
  }

  get queueLength(): number {
    return this.queued;
  }

  /** 事件入口(长连接 handler 直接调用;内部自行排队,立即返回) */
  handle(msg: IncomingMessage): void {
    try {
      this.route(msg);
    } catch (e) {
      // 绝不让异常冒泡回长连接 listener —— 一条消息处理失败不能拖垮整个连接。
      // 存储在 route() 一开始就要读(判断活跃会话),库不可用时会在这里抛。
      const detail = filterSecrets(e instanceof Error ? e.message : String(e)).text;
      this.log(`[orchestrator] 消息处理失败:${detail}`);
      void this.safeReply(
        msg,
        errorCard(`调查未能启动:存储不可用(${detail})`, "请让管理员检查数据目录权限与磁盘空间。"),
        msg.chatType === "group",
      );
    }
  }

  private route(msg: IncomingMessage): void {
    const { cfg, storage } = this.deps;
    const sessionKey = sessionKeyFor(msg);
    const row = storage.getSession(sessionKey);
    // 活跃会话 = 存储里未过期的 active 行,或该 key 上有排队/进行中的任务
    //(首问尚未答完时的话题内追问也要延续,不能因 session 行未落库而被忽略)
    const hasActiveSession =
      this.queues.has(sessionKey) ||
      (!!row && row.state === "active" && Date.now() - row.updated_at <= cfg.limits.session_idle_archive_min * 60_000);

    // 取消命令:直接中断该会话正在跑的任务
    if (CANCEL_RE.test(msg.text.trim()) && this.running.has(sessionKey)) {
      this.running.get(sessionKey)!.abort();
      return;
    }

    const decision = gate(msg, {
      cfg,
      limiter: this.limiter,
      hasActiveSession,
      activeRepo: hasActiveSession ? (row?.repo ?? this.routeRepos.get(sessionKey)) : undefined,
    });
    const inThread = msg.chatType === "group";

    switch (decision.action) {
      case "ignore":
        return;
      case "denied":
        void this.safeReply(msg, deniedCard(decision.reply), inThread);
        return;
      case "rate_limited":
        void this.safeReply(msg, deniedCard(decision.reply), inThread);
        return;
      case "clarify":
        void this.safeReply(
          msg,
          projectChoiceCard(decision.projects, decision.reply),
          inThread,
        );
        return;
      case "help":
        void this.safeReply(
          msg,
          helpCard({
            repo: decision.repo ? repoDisplayName(decision.repo) : undefined,
            levelName: decision.levelName,
          }),
          inThread,
        );
        return;
      case "status":
        void this.replyStatus(msg, decision.repo, inThread);
        return;
      case "investigate":
        this.routeRepos.set(sessionKey, decision.repo.name);
        this.enqueue(sessionKey, () => this.runInvestigation(msg, decision.repo, decision.question));
        return;
    }
  }

  // -------------------------------------------------------------------------

  private enqueue(sessionKey: string, fn: () => Promise<void>): void {
    this.queued++;
    const prev = this.queues.get(sessionKey) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        await this.acquireSlot();
        try {
          await fn();
        } finally {
          this.releaseSlot();
        }
      })
      .catch((e: unknown) => this.log(`[orchestrator] 任务异常:${e instanceof Error ? e.stack : String(e)}`))
      .finally(() => {
        this.queued--;
        if (this.queues.get(sessionKey) === next) this.queues.delete(sessionKey);
      });
    this.queues.set(sessionKey, next);
  }

  private async acquireSlot(): Promise<void> {
    if (this.active < this.deps.cfg.limits.max_concurrent_tasks) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
  }

  private releaseSlot(): void {
    this.active--;
    this.waiters.shift()?.();
  }

  // -------------------------------------------------------------------------

  private runInvestigation(msg: IncomingMessage, repo: RepoConfig, question: string): Promise<void> {
    // 本地形态注入 git 子进程版 headInfo;流水线本体与 CF 形态共用
    return runInvestigationPipeline({ ...this.deps, running: this.running, headInfo }, msg, repo, question);
  }

  private async replyStatus(msg: IncomingMessage, repo: RepoConfig, inThread: boolean): Promise<void> {
    const { cfg, storage } = this.deps;
    // 远程工作区后端下 checkout 不在本机,git 读 HEAD 无意义(与
    // investigation 的 workspace.operations 判定同款保护),省略该行元信息
    const remote = !!this.deps.workspaces && this.deps.workspaces.kind !== "local";
    const head = remote ? undefined : await headInfo(repoCheckoutDir(cfg, repo));
    const row = storage.getSession(sessionKeyFor(msg));
    await this.safeReply(
      msg,
      statusCard({
        repo: repoDisplayName(repo),
        headShort: head?.short,
        headTime: head?.time,
        model: `${cfg.model.provider}/${cfg.model.id}`,
        sessionTurns: row?.turns,
        sessionState: row?.state,
        queueLength: this.queued,
      }),
      inThread,
    );
  }

  private async safeReply(msg: IncomingMessage, card: Card, inThread: boolean): Promise<string | undefined> {
    try {
      return await this.deps.lark.replyCard(msg.messageId, card, inThread);
    } catch (e) {
      this.log(`[orchestrator] 回复失败:${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  }

  private log(line: string): void {
    this.deps.log?.(line);
  }
}
