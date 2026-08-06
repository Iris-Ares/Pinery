import { randomUUID } from "node:crypto";
import {
  filterSecrets,
  parseLayeredAnswer,
  repoCheckoutDir,
  runnerModelConfig,
  type LayeredAnswer,
  type PineryConfig,
  type ProvidedWorkspace,
  type RepoConfig,
  type AgentRunner,
  type WorkspaceProvider,
} from "@pinery/core";
import { RateLimiter, gate } from "./gateway.js";
import {
  answerCard,
  deniedCard,
  errorCard,
  helpCard,
  progressCard,
  statusCard,
  timeoutCard,
  toolLine,
  type Card,
} from "./lark/cards.js";
import type { IncomingMessage } from "./lark/events.js";
import { headInfo } from "./repo-sync.js";
import { buildSessionSummary, planSession, sessionKeyFor } from "./sessions.js";
import type { Storage } from "./storage.js";

/** 出站通道抽象(测试可注入 fake;生产实现为 LarkService) */
export interface LarkMessenger {
  sendCard(chatId: string, card: Card): Promise<string | undefined>;
  replyCard(messageId: string, card: Card, inThread: boolean): Promise<string | undefined>;
  patchCard(messageId: string, card: Card): Promise<void>;
}

export interface OrchestratorDeps {
  cfg: PineryConfig;
  storage: Storage;
  runner: AgentRunner;
  lark: LarkMessenger;
  /** 工作区后端(缺省 local);云沙箱后端按 WorkspaceProvider 接口替换 */
  workspaces?: WorkspaceProvider;
  log?: (line: string) => void;
}

const CANCEL_RE = /^(取消|cancel|stop)[??!!。.]?$/i;
/** 进度卡片最小 patch 间隔 */
const PATCH_INTERVAL_MS = 1500;

/**
 * 编排器(PRD §3.1 会话路由 + 输出层):
 * - 同 session_key 串行,全局并发受 limits.max_concurrent_tasks 约束
 * - ack 卡片 → 进度流 patch → 分层答案卡片,一张卡走完整个生命周期
 * - 所有出站文本过 secret 过滤;每次工具调用落审计;每问必存 qa_log(golden set 地基)
 */
export class Orchestrator {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly running = new Map<string, AbortController>();
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

    const decision = gate(msg, { cfg, limiter: this.limiter, hasActiveSession });
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
      case "help":
        void this.safeReply(msg, helpCard({ repo: decision.repo?.name, levelName: decision.levelName }), inThread);
        return;
      case "status":
        void this.replyStatus(msg, decision.repo, inThread);
        return;
      case "investigate":
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

  private async runInvestigation(msg: IncomingMessage, repo: RepoConfig, question: string): Promise<void> {
    const { cfg, storage, runner, lark } = this.deps;
    const sessionKey = sessionKeyFor(msg);
    const taskId = randomUUID();
    const startedAt = Date.now();
    const inThread = msg.chatType === "group";

    const ackId = await this.safeReply(msg, progressCard({ lines: [], elapsedSec: 0 }), inThread);
    if (!ackId) {
      this.log(`[orchestrator] ack 卡片发送失败,放弃任务 ${taskId}`);
      return;
    }

    // ack 之后的一切都必须能收敛卡片:这里的 SQLite 读写(会话规划、审计)
    // 在库满/只读/已关闭时会抛,不接住就只剩队列日志,卡片停在「调查中」。
    let plan: ReturnType<typeof planSession>;
    const abort = new AbortController();
    try {
      plan = planSession(storage, cfg, msg);
      this.running.set(sessionKey, abort);
      storage.audit({
        sessionKey,
        taskId,
        userId: msg.senderOpenId,
        repo: repo.name,
        kind: "task_start",
        detail: question.slice(0, 500),
      });
    } catch (e) {
      this.running.delete(sessionKey);
      const detail = filterSecrets(e instanceof Error ? e.message : String(e)).text;
      this.log(`[orchestrator] 前置持久化失败:${detail}`);
      await lark
        .patchCard(ackId, errorCard(`调查未能启动:存储不可用(${detail})`, "请让管理员检查数据目录权限与磁盘空间。"))
        .catch(() => {});
      return;
    }

    // 进度流:事件驱动 + 节流 patch
    const lines: string[] = [];
    let turns = 0;
    let lastPatch = 0;
    let patchTimer: NodeJS.Timeout | undefined;
    const pushProgress = (line?: string) => {
      if (line) lines.push(line);
      const now = Date.now();
      const flush = () => {
        lastPatch = Date.now();
        patchTimer = undefined;
        void lark
          .patchCard(ackId, progressCard({ lines, elapsedSec: Math.round((Date.now() - startedAt) / 1000), turns }))
          .catch(() => {});
      };
      if (now - lastPatch >= PATCH_INTERVAL_MS) flush();
      else if (!patchTimer) patchTimer = setTimeout(flush, PATCH_INTERVAL_MS - (now - lastPatch));
    };

    const model = runnerModelConfig(cfg);

    // 工作区经 provider 取得:本地实现返回共享 checkout,云沙箱后端返回远程工作区
    // + operations 委托(docs/sandbox-evaluation.md §4.2)。
    // 获取本身可能失败(远端不可达、clone 失败),必须收敛卡片与任务状态,
    // 否则进度卡片会永远停在「调查中」。
    let workspace: ProvidedWorkspace;
    try {
      workspace = this.deps.workspaces
        ? await this.deps.workspaces.acquireSession(repo, sessionKey)
        : { handle: `session:${sessionKey}`, repo: repo.name, dir: repoCheckoutDir(cfg, repo), readOnly: true };
    } catch (e) {
      if (patchTimer) clearTimeout(patchTimer);
      this.running.delete(sessionKey);
      const detail = filterSecrets(e instanceof Error ? e.message : String(e)).text;
      await lark
        .patchCard(ackId, errorCard(`工作区准备失败:${detail}`, "请让管理员运行 pinery doctor 检查仓库与工作区配置。"))
        .catch(() => {});
      storage.audit({ sessionKey, taskId, repo: repo.name, kind: "error", detail: `workspace: ${detail}` });
      return;
    }

    const checkoutDir = workspace.dir;
    let result: Awaited<ReturnType<AgentRunner["run"]>>;
    try {
      result = await runner.run(
        {
          id: taskId,
          kind: "investigate",
          prompt: question,
          context: plan.context,
          resume: plan.resume,
        },
        workspace,
        {
          // M1:一切按 L0 只读运行;L1+ 编码任务在 M2 开启
          level: 0,
          maxTurns: cfg.limits.session_max_turns,
          timeoutMs: cfg.limits.task_timeout_min * 60_000,
          signal: abort.signal,
          model,
          onEvent: (e) => {
            switch (e.type) {
              case "turn":
                turns = e.n;
                pushProgress();
                break;
              case "tool_start": {
                const detail = filterSecrets(e.detail).text;
                storage.audit({ sessionKey, taskId, repo: repo.name, kind: "tool_start", tool: e.tool, detail });
                pushProgress(toolLine(e.tool, detail));
                break;
              }
              case "tool_end":
                storage.audit({ sessionKey, taskId, repo: repo.name, kind: "tool_end", tool: e.tool, detail: e.ok ? "ok" : "error" });
                break;
              case "policy_block":
                storage.audit({ sessionKey, taskId, repo: repo.name, kind: "policy_block", tool: e.tool, detail: e.reason });
                pushProgress(toolLine("policy", `已拦截:${filterSecrets(e.reason).text}`));
                break;
              default:
                break;
            }
          },
        },
      );
    } catch (e) {
      // runner 可能在 prompt 之前就 reject(pi 的 resourceLoader/session/
      // createAgentSession 等 setup 阶段,或第三方 runner 实现)。不收敛的话
      // 异常只会到达队列日志,卡片永远停在「调查中」。
      const detail = filterSecrets(e instanceof Error ? e.message : String(e)).text;
      await lark
        .patchCard(
          ackId,
          errorCard(`调查未能启动:${detail}`, "多为模型凭据或运行环境问题,请让管理员运行 pinery doctor 检查。"),
        )
        .catch(() => {});
      storage.audit({ sessionKey, taskId, repo: repo.name, kind: "error", detail: `runner: ${detail}` });
      return;
    } finally {
      if (patchTimer) clearTimeout(patchTimer);
      this.running.delete(sessionKey);
      // 会话工作区常驻(本地实现为 no-op);远程后端在此归还连接/容器
      await this.deps.workspaces?.release(workspace).catch(() => {});
    }

    const durationMs = Date.now() - startedAt;

    // 中止优先于部分输出:模型可能已吐出片段文本,但取消/超时/轮数超限的结果
    // 不是答案 —— 既不能呈现为成功,也不能污染 golden set 与会话记忆。
    if (result.aborted === "user") {
      await lark.patchCard(ackId, errorCard("已按你的要求取消本次调查。")).catch(() => {});
      storage.audit({ sessionKey, taskId, repo: repo.name, kind: "error", detail: "aborted: user" });
      return;
    }
    if (result.aborted === "timeout" || result.aborted === "turn-limit") {
      const partial = filterSecrets(parseLayeredAnswer(result.answer).conclusion).text.trim();
      const card =
        result.aborted === "timeout"
          ? timeoutCard(cfg.limits.task_timeout_min)
          : errorCard(`调查在 ${cfg.limits.session_max_turns} 轮内没有收敛,已停止。`, "把问题拆小一点再问一次会更容易得到确定答案。");
      if (partial) {
        // 部分结果可能有参考价值,但必须显式标注不完整
        card.body.elements.push(
          { tag: "hr" },
          { tag: "markdown", content: `**中止前的部分线索(不完整,勿直接采信)**\n${partial.slice(0, 800)}` },
        );
      }
      await lark.patchCard(ackId, card).catch(() => {});
      storage.audit({ sessionKey, taskId, repo: repo.name, kind: "error", detail: `aborted: ${result.aborted}` });
      return;
    }

    // 失败一律不走成功路径:流式中断等情况会带回部分文本而没有 aborted 标记,
    // 那不是答案 —— 展示可以,但必须标注不完整,且不进 golden set 与会话记忆。
    if (!result.ok) {
      const card = errorCard(
        `调查未能完成:${filterSecrets(result.error ?? "未知错误").text}`,
        "可以稍后重试;若持续失败请让管理员运行 pinery doctor 检查配置。",
      );
      const partial = filterSecrets(parseLayeredAnswer(result.answer).conclusion).text.trim();
      if (partial) {
        card.body.elements.push(
          { tag: "hr" },
          { tag: "markdown", content: `**中断前的部分线索(不完整,勿直接采信)**\n${partial.slice(0, 800)}` },
        );
      }
      await lark.patchCard(ackId, card).catch(() => {});
      storage.audit({ sessionKey, taskId, repo: repo.name, kind: "error", detail: result.error ?? "unknown" });
      return;
    }

    // 分层解析 + 出站过滤 + 截断
    const layered = this.sanitizeAnswer(parseLayeredAnswer(result.answer));
    // 远程工作区(operations 委托)的 dir 是远端路径,本地 git 读不到,跳过
    const head = workspace.operations ? undefined : await headInfo(checkoutDir);
    const truncated = this.truncateAnswer(layered, cfg.limits.answer_max_chars);

    await lark
      .patchCard(
        ackId,
        answerCard(question, layered, {
          repo: repo.name,
          headShort: head?.short,
          durationMs,
          turns: result.turns,
          model: cfg.model.id,
          costUsd: result.usage?.costUsd,
          redacted: layered.redacted,
          truncated,
        }),
      )
      .catch((e: unknown) => this.log(`[orchestrator] 答案卡片更新失败:${String(e)}`));

    storage.audit({
      sessionKey,
      taskId,
      repo: repo.name,
      kind: "task_end",
      detail: `ok=${result.ok} turns=${result.turns} tools=${result.toolCalls} files=${result.filesTouched.length}${result.aborted ? ` aborted=${result.aborted}` : ""}`,
    });

    // 每问必存(golden set 从 M1 第一天积累,PRD §6)
    storage.logQa({
      taskId,
      sessionKey,
      repo: repo.name,
      userId: msg.senderOpenId,
      chatId: msg.chatId,
      question,
      answer: filterSecrets(result.answer).text,
      confidence: layered.confidenceLevel,
      durationMs,
      turns: result.turns,
      costUsd: result.usage?.costUsd,
    });

    // 会话记忆:summary 同过 secret 过滤(PRD §3.4 硬保护)
    storage.upsertSession({
      sessionKey,
      chatId: msg.chatId,
      chatType: msg.chatType,
      repo: repo.name,
      runnerRef: result.sessionRef,
      summary: filterSecrets(buildSessionSummary(question, layered.conclusion)).text,
      turns: plan.priorTurns + result.turns,
    });
  }

  private sanitizeAnswer(a: LayeredAnswer): LayeredAnswer & { redacted: boolean } {
    const c = filterSecrets(a.conclusion);
    const e = a.evidence !== undefined ? filterSecrets(a.evidence) : undefined;
    const f = a.confidence !== undefined ? filterSecrets(a.confidence) : undefined;
    return {
      conclusion: c.text,
      evidence: e?.text,
      confidence: f?.text,
      confidenceLevel: a.confidenceLevel,
      redacted: c.redacted || !!e?.redacted || !!f?.redacted,
    };
  }

  /** 卡片体积控制:结论与依据分别按比例截断 */
  private truncateAnswer(a: LayeredAnswer, maxChars: number): boolean {
    let truncated = false;
    const cap = (s: string, n: number) => {
      if (s.length <= n) return s;
      truncated = true;
      return `${s.slice(0, n - 1)}…`;
    };
    a.conclusion = cap(a.conclusion, Math.floor(maxChars * 0.5));
    if (a.evidence) a.evidence = cap(a.evidence, Math.floor(maxChars * 0.4));
    if (a.confidence) a.confidence = cap(a.confidence, Math.floor(maxChars * 0.1));
    return truncated;
  }

  private async replyStatus(msg: IncomingMessage, repo: RepoConfig, inThread: boolean): Promise<void> {
    const { cfg, storage } = this.deps;
    const dir = repoCheckoutDir(cfg, repo);
    const head = await headInfo(dir);
    const row = storage.getSession(sessionKeyFor(msg));
    await this.safeReply(
      msg,
      statusCard({
        repo: repo.name,
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
