import {
  filterSecrets,
  repoDisplayName,
  parseLayeredAnswer,
  repoCheckoutDir,
  runnerModelConfig,
  type AgentRunner,
  type LayeredAnswer,
  type PineryConfig,
  type ProvidedWorkspace,
  type RepoConfig,
  type WorkspaceProvider,
} from "@pinery/core";
import { answerCard, errorCard, progressCard, timeoutCard, toolLine, type Card } from "./lark/cards.js";
import { combineInvestigationContext, loadRelevantGroupContext } from "./group-context.js";
import type { IncomingMessage } from "./lark/events.js";
import type { LarkMessenger } from "./lark/messenger.js";
import { buildSessionSummary, planSession, replyInThreadFor, sessionKeyFor } from "./sessions.js";
import type { Storage } from "./storage.js";

/** 进度卡片最小 patch 间隔 */
const PATCH_INTERVAL_MS = 1500;

/** 会话内取消指令(两种宿主的路由层共用;仅在该会话有运行中任务时拦截) */
export const CANCEL_RE = /^(取消|cancel|stop)[??!!。.]?$/i;

/**
 * 一次调查的完整流水线依赖。
 * Orchestrator(本地常驻进程)与 PineryAgent(CF Durable Object)共用本流水线,
 * 串行化与并发闸由宿主负责(本地=Promise 链队列,DO=实例天然单线程)。
 */
export interface InvestigationDeps {
  cfg: PineryConfig;
  storage: Storage;
  runner: AgentRunner;
  lark: LarkMessenger;
  /** 工作区后端(缺省 local 共享 checkout) */
  workspaces?: WorkspaceProvider;
  /** 运行中任务登记表:取消命令经此 abort(宿主持有并共享给路由层) */
  running: Map<string, AbortController>;
  /**
   * 本地 checkout 的 HEAD 读取(git 子进程,repo-sync.headInfo)。
   * 远程工作区/无盘运行时不注入 —— 与 workspace.operations 判定一致,
   * 答案卡片省略 head 元信息。
   */
  headInfo?: (dir: string) => Promise<{ short: string; time: string } | undefined>;
  log?: (line: string) => void;
}

/**
 * 调查流水线(PRD §3.1 输出层,原 Orchestrator.runInvestigation):
 * ack 卡片 → 会话规划 → 工作区获取 → runner 执行(进度流节流 patch)→
 * 中止/失败/成功三路收敛 → 审计 + qa_log + 会话记忆落库。
 * 所有出站文本过 secret 过滤;每次工具调用落审计。
 */
export async function runInvestigationPipeline(
  deps: InvestigationDeps,
  msg: IncomingMessage,
  repo: RepoConfig,
  question: string,
): Promise<void> {
  const { cfg, storage, runner, lark } = deps;
  const log = (line: string) => deps.log?.(line);
  const sessionKey = sessionKeyFor(msg);
  const taskId = globalThis.crypto.randomUUID();
  const startedAt = Date.now();
  const inThread = replyInThreadFor(msg);

  const ackId = await safeReply(deps, msg, progressCard({ lines: [], elapsedSec: 0 }), inThread);
  if (!ackId) {
    log(`[investigation] ack 卡片发送失败,放弃任务 ${taskId}`);
    return;
  }

  // ack 之后的一切都必须能收敛卡片:这里的存储读写(审计、运行登记)
  // 在库满/只读/已关闭时会抛,不接住就只剩队列日志,卡片停在「调查中」。
  const abort = new AbortController();
  try {
    deps.running.set(sessionKey, abort);
    storage.audit({
      sessionKey,
      taskId,
      userId: msg.senderOpenId,
      repo: repo.name,
      kind: "task_start",
      detail: question.slice(0, 500),
    });
  } catch (e) {
    deps.running.delete(sessionKey);
    const detail = filterSecrets(e instanceof Error ? e.message : String(e)).text;
    log(`[investigation] 前置持久化失败:${detail}`);
    await lark
      .patchCard(ackId, errorCard(`调查未能启动:存储不可用(${detail})`, "请让管理员检查数据目录权限与磁盘空间。"))
      .catch(() => {});
    return;
  }

  // 进度流:事件驱动 + 节流 patch
  const lines: string[] = [];
  let turns = 0;
  let lastPatch = 0;
  let patchTimer: ReturnType<typeof setTimeout> | undefined;
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
  let groupContext: string | undefined;
  try {
    [workspace, groupContext] = await Promise.all([
      deps.workspaces
        ? deps.workspaces.acquireSession(repo, sessionKey)
        : Promise.resolve({
            handle: `session:${sessionKey}`,
            repo: repo.name,
            dir: repoCheckoutDir(cfg, repo),
            readOnly: true,
          }),
      loadRelevantGroupContext(lark, msg, log),
    ]);
  } catch (e) {
    if (patchTimer) clearTimeout(patchTimer);
    deps.running.delete(sessionKey);
    const detail = filterSecrets(e instanceof Error ? e.message : String(e)).text;
    await lark
      .patchCard(ackId, errorCard(`项目代码准备失败:${detail}`, "请让管理员运行 pinery doctor 检查项目配置。"))
      .catch(() => {});
    storage.audit({ sessionKey, taskId, repo: repo.name, kind: "error", detail: `workspace: ${detail}` });
    return;
  }

  let plan: ReturnType<typeof planSession>;
  try {
    plan = planSession(storage, cfg, msg, {
      repo: repo.name,
      runnerKind: runner.kind,
      workspaceHandle: workspace.handle,
      workspaceBranch: workspace.branch,
      workspaceReadOnly: workspace.readOnly,
    });
    if (plan.bindingChanged) {
      log(
        `[investigation] 会话 ${sessionKey} 的 sandbox/worktree 绑定已变化，拒绝旧 resume 并安全 fresh`,
      );
    }
  } catch (e) {
    deps.running.delete(sessionKey);
    await deps.workspaces?.release(workspace).catch(() => {});
    const detail = filterSecrets(e instanceof Error ? e.message : String(e)).text;
    await lark
      .patchCard(ackId, errorCard(`调查未能启动:会话状态不可用(${detail})`, "请让管理员检查持久化存储。"))
      .catch(() => {});
    storage.audit({ sessionKey, taskId, repo: repo.name, kind: "error", detail: `session: ${detail}` });
    return;
  }

  const taskContext = combineInvestigationContext(plan.context, groupContext);

  const checkoutDir = workspace.dir;
  let result: Awaited<ReturnType<AgentRunner["run"]>>;
  try {
    result = await runner.run(
      {
        id: taskId,
        kind: "investigate",
        prompt: question,
        context: taskContext,
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
    deps.running.delete(sessionKey);
    // 会话工作区常驻(本地实现为 no-op);远程后端在此归还连接/容器
    await deps.workspaces?.release(workspace).catch(() => {});
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
  const layered = sanitizeAnswer(parseLayeredAnswer(result.answer));
  // 远程工作区(operations 委托)的 dir 是远端路径,本地 git 读不到,跳过;
  // 无盘宿主(CF)不注入 headInfo,同样省略
  const head = workspace.operations ? undefined : await deps.headInfo?.(checkoutDir);
  const truncated = truncateAnswer(layered, cfg.limits.answer_max_chars);

  await lark
    .patchCard(
      ackId,
      answerCard(question, layered, {
        repo: repoDisplayName(repo),
        headShort: head?.short,
        durationMs,
        turns: result.turns,
        model: cfg.model.id,
        costUsd: result.usage?.costUsd,
        redacted: layered.redacted,
        truncated,
      }),
    )
    .catch((e: unknown) => log(`[investigation] 答案卡片更新失败:${String(e)}`));

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
    runnerKind: runner.kind,
    workspaceHandle: workspace.handle,
    workspaceBranch: workspace.branch,
    workspaceReadOnly: workspace.readOnly,
    summary: filterSecrets(buildSessionSummary(question, layered.conclusion)).text,
    turns: plan.priorTurns + result.turns,
  });
}

async function safeReply(
  deps: InvestigationDeps,
  msg: IncomingMessage,
  card: Card,
  inThread: boolean,
): Promise<string | undefined> {
  try {
    const messageId = await deps.lark.replyCard(msg.messageId, card, inThread);
    if (messageId) deps.storage.rememberBotMessage(messageId, msg.chatId, sessionKeyFor(msg));
    return messageId;
  } catch (e) {
    deps.log?.(`[investigation] 回复失败:${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

function sanitizeAnswer(a: LayeredAnswer): LayeredAnswer & { redacted: boolean } {
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
function truncateAnswer(a: LayeredAnswer, maxChars: number): boolean {
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
