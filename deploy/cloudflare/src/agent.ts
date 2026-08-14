import { gate, RateLimiter } from "@pinery/adapter/gateway";
import {
	CANCEL_RE,
	type InvestigationDeps,
	runInvestigationPipeline,
} from "@pinery/adapter/investigation";
import {
	deniedCard,
	errorCard,
	helpCard,
	projectChoiceCard,
	statusCard,
	type Card,
} from "@pinery/adapter/lark/cards";
import type { IncomingMessage } from "@pinery/adapter/lark/events";
import {
	replyInThreadFor,
	sessionKeyFor,
} from "@pinery/adapter/sessions";
import { Storage } from "@pinery/adapter/storage";
import {
	filterSecrets,
	repoDisplayName,
	type PineryConfig,
	type RepoConfig,
	runnerModelConfig,
} from "@pinery/core";
import { LarkFetchClient } from "@pinery/lark-fetch";
import { WorkersPiRunner } from "@pinery/runner-pi/workers";
import { CfComputerWorkspaceProvider } from "@pinery/workspace-cf-computer";
import { Agent } from "agents";
import {
	envStrings,
	loadWorkerConfig,
	type PineryWorkerEnv,
} from "./config.js";
import { DirectWorkspaceClient } from "./direct-client.js";
import { doSqliteDriver } from "./do-sqlite.js";
import { WorkersLarkMessenger } from "./lark-messenger.js";
import {
	buildRuntimeQueryPrompt,
	parseRuntimeQueryInput,
	type RuntimeQueryInput,
	type RuntimeQuerySummary,
	summarizeRuntimeQuery,
} from "./runtime-query.js";
import {
	RUNTIME_SMOKE_PROMPT,
	type RuntimeSmokeSummary,
	summarizeRuntimeSmoke,
} from "./runtime-smoke.js";

/**
 * PineryAgent:CF 形态的会话宿主(每 session_key 一个实例,DO 单线程 =
 * 同会话天然串行,替代 Orchestrator 的内存队列)。
 *
 * handleEvent 只做轻活(幂等去重/取消/gate/入列,<100ms 返回,保住飞书 3s ack
 * 预算);调查在 Fiber 里逐条 drain(keepAlive 保活,驱逐后 onFiberRecovered
 * 收敛错误卡片,不留「永远调查中」)。
 */

interface HandleEventInput {
	eventId: string;
	msg: IncomingMessage;
}

interface Assembled {
	cfg: PineryConfig;
	deps: InvestigationDeps;
	storage: Storage;
	limiter: RateLimiter;
	lark: WorkersLarkMessenger;
}

export interface RuntimeSmokeResult extends RuntimeSmokeSummary {
	provider: string;
	model: string;
}

export interface RuntimeQueryResult extends RuntimeQuerySummary {
	provider: string;
	model: string;
	repo: string;
}

/** events 幂等行保留时长(飞书最长重试间隔 6h,24h 足够覆盖) */
const EVENT_TTL_MS = 24 * 3600_000;

export class PineryAgent extends Agent<PineryWorkerEnv, Record<string, never>> {
	private assembled?: Assembled;
	/** 运行中任务登记(取消经此 abort;单会话 DO 内最多一项) */
	private readonly running = new Map<string, AbortController>();
	/** drain fiber 活跃标志(内存态;驱逐后由 onFiberRecovered 收敛) */
	private draining = false;

	private assemble(): Assembled {
		if (this.assembled) return this.assembled;
		const cfg = loadWorkerConfig(this.env);
		const sql = this.ctx.storage.sql;
		sql.exec(
			"CREATE TABLE IF NOT EXISTS lark_events (event_id TEXT PRIMARY KEY, ts INTEGER NOT NULL)",
		);
		sql.exec(
			"CREATE TABLE IF NOT EXISTS pending_msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, msg TEXT NOT NULL, repo TEXT NOT NULL, question TEXT NOT NULL, created_at INTEGER NOT NULL)",
		);

		const storage = new Storage(doSqliteDriver(sql));
		const lark = new WorkersLarkMessenger(
			new LarkFetchClient({
				appId: cfg.lark.app_id,
				appSecret: cfg.lark.app_secret,
				domain: cfg.lark.endpoint,
				baseUrl: cfg.lark.api_base,
			}),
		);
		const o = cfg.workspace.options;
		const workspaces = new CfComputerWorkspaceProvider({
			client: new DirectWorkspaceClient(this.env.WORKSPACE),
			execBackend: o["exec_backend"] ?? "worker-shell",
			sharedSnapshotId: o["shared_snapshot_id"],
			cloneDepth: o["clone_depth"] ? Number(o["clone_depth"]) : 1,
			execTimeoutMs: o["exec_timeout_ms"]
				? Number(o["exec_timeout_ms"])
				: undefined,
			refreshIntervalMs:
				cfg.workspace.pull_interval_min > 0
					? cfg.workspace.pull_interval_min * 60_000
					: undefined,
		});
		const runner = new WorkersPiRunner({
			env: envStrings(this.env),
			sessionStore: {
				load: async (runnerRef) => {
					const row = storage.getRunnerSession(runnerRef);
					return row ? JSON.parse(row.state_json) : undefined;
				},
				save: async (runnerRef, snapshot) =>
					storage.saveRunnerSession({
						runnerRef,
						runnerKind: snapshot.binding.runnerKind,
						repo: snapshot.binding.repo,
						workspaceHandle: snapshot.binding.workspaceHandle,
						workspaceDir: snapshot.binding.workspaceDir,
						workspaceBranch: snapshot.binding.workspaceBranch ?? undefined,
						workspaceReadOnly: snapshot.binding.workspaceReadOnly,
						stateJson: JSON.stringify(snapshot),
					}),
			},
		});
		const log = (line: string) => console.log(line);

		this.assembled = {
			cfg,
			storage,
			lark,
			limiter: new RateLimiter(cfg.limits.rate_per_user_per_min),
			deps: {
				cfg,
				storage,
				runner,
				lark,
				workspaces,
				running: this.running,
				log,
			},
		};
		return this.assembled;
	}

	/**
	 * 受 Worker 的 PINERY_TOKEN 路由保护的线上诊断 RPC。它复用正式 Agent 的
	 * config、WorkersPiRunner 与只读工作区,并强制让模型读取快照 manifest。
	 */
	async runtimeSmoke(): Promise<RuntimeSmokeResult> {
		const startedAt = Date.now();
		const { cfg, deps } = this.assemble();
		const repo = cfg.repos[0];
		const expectedCommit =
			this.env.PINERY_SOURCE_PREFIX?.trim().split("/").at(-1) ?? "";
		const base = { provider: cfg.model.provider, model: cfg.model.id };
		if (!repo || !expectedCommit) {
			return {
				...base,
				ok: false,
				runnerOk: false,
				expectedCommit,
				readManifest: false,
				turns: 0,
				toolCalls: 0,
				toolNames: [],
				filesTouched: [],
				durationMs: Date.now() - startedAt,
				error: "运行时冒烟需要 repos[0] 与 PINERY_SOURCE_PREFIX",
			};
		}

		const toolNames: string[] = [];
		let workspace:
			| Awaited<
					ReturnType<NonNullable<typeof deps.workspaces>["acquireSession"]>
			  >
			| undefined;
		try {
			workspace = await deps.workspaces?.acquireSession(
				repo,
				"pinery-runtime-smoke",
			);
			if (!workspace) throw new Error("Cloudflare 工作区 provider 未装配");
			const result = await deps.runner.run(
				{
					id: crypto.randomUUID(),
					kind: "investigate",
					prompt: RUNTIME_SMOKE_PROMPT,
				},
				workspace,
				{
					level: 0,
					maxTurns: 4,
					timeoutMs: 120_000,
					model: runnerModelConfig(cfg),
					onEvent: (event) => {
						if (event.type === "tool_start") toolNames.push(event.tool);
					},
				},
			);
			const summary = summarizeRuntimeSmoke(
				result,
				expectedCommit,
				toolNames,
				Date.now() - startedAt,
			);
			const safeError = summary.error
				? filterSecrets(summary.error).text
				: undefined;
			const safeAnswer = summary.answerPreview
				? filterSecrets(summary.answerPreview).text
				: undefined;
			const report = {
				...base,
				...summary,
				...(safeAnswer ? { answerPreview: safeAnswer } : {}),
				...(safeError ? { error: safeError } : {}),
			};
			console.log(
				JSON.stringify({
					event: "pinery.runtime_smoke",
					ok: report.ok,
					provider: report.provider,
					model: report.model,
					turns: report.turns,
					toolCalls: report.toolCalls,
					toolNames: report.toolNames,
					durationMs: report.durationMs,
					error: report.error,
				}),
			);
			return report;
		} catch (error) {
			const detail = filterSecrets(
				error instanceof Error ? error.message : String(error),
			).text;
			const report: RuntimeSmokeResult = {
				...base,
				ok: false,
				runnerOk: false,
				expectedCommit,
				readManifest: false,
				turns: 0,
				toolCalls: 0,
				toolNames,
				filesTouched: [],
				durationMs: Date.now() - startedAt,
				error: detail,
			};
			console.log(
				JSON.stringify({
					event: "pinery.runtime_smoke",
					...report,
					filesTouched: undefined,
				}),
			);
			return report;
		} finally {
			if (workspace) await deps.workspaces?.release(workspace).catch(() => {});
		}
	}

	/**
	 * 受 PINERY_TOKEN 保护的请求级只读验收入口。问题长度、轮数与执行时长均
	 * 有硬上限;工作区必须为 readOnly,响应统一经过 secret 过滤。
	 */
	async runtimeQuery(rawInput: RuntimeQueryInput): Promise<RuntimeQueryResult> {
		const { question } = parseRuntimeQueryInput(rawInput);
		const startedAt = Date.now();
		const { cfg, deps } = this.assemble();
		const repo = cfg.repos[0];
		if (!repo) throw new Error("运行时查询需要至少配置一个 repo");

		const base = {
			provider: cfg.model.provider,
			model: cfg.model.id,
			repo: repo.name,
		};
		const toolNames: string[] = [];
		let successfulToolCalls = 0;
		let workspace:
			| Awaited<
					ReturnType<NonNullable<typeof deps.workspaces>["acquireSession"]>
			  >
			| undefined;
		try {
			workspace = await deps.workspaces?.acquireSession(
				repo,
				"pinery-runtime-query",
			);
			if (!workspace) throw new Error("Cloudflare 工作区 provider 未装配");
			if (!workspace.readOnly) throw new Error("运行时查询拒绝使用可写工作区");

			const result = await deps.runner.run(
				{
					id: crypto.randomUUID(),
					kind: "investigate",
					prompt: buildRuntimeQueryPrompt(question),
				},
				workspace,
				{
					level: 0,
					maxTurns: Math.max(1, Math.min(cfg.limits.session_max_turns, 8)),
					timeoutMs: Math.max(
						1_000,
						Math.min(cfg.limits.task_timeout_min * 60_000, 120_000),
					),
					model: runnerModelConfig(cfg),
					onEvent: (event) => {
						if (event.type === "tool_start") toolNames.push(event.tool);
						if (event.type === "tool_end" && event.ok) successfulToolCalls++;
					},
				},
			);
			const report = summarizeRuntimeQuery(
				result,
				toolNames,
				successfulToolCalls,
				Date.now() - startedAt,
				cfg.limits.answer_max_chars,
			);
			console.log(
				JSON.stringify({
					event: "pinery.runtime_query",
					ok: report.ok,
					provider: base.provider,
					model: base.model,
					repo: base.repo,
					turns: report.turns,
					toolCalls: report.toolCalls,
					successfulToolCalls: report.successfulToolCalls,
					toolNames: report.toolNames,
					durationMs: report.durationMs,
					error: report.error,
				}),
			);
			return { ...base, ...report };
		} catch (error) {
			const detail = filterSecrets(
				error instanceof Error ? error.message : String(error),
			).text;
			return {
				...base,
				ok: false,
				runnerOk: false,
				answer: "",
				turns: 0,
				toolCalls: 0,
				successfulToolCalls,
				toolNames,
				filesTouched: [],
				durationMs: Date.now() - startedAt,
				error: detail,
			};
		} finally {
			if (workspace) await deps.workspaces?.release(workspace).catch(() => {});
		}
	}

	/**
	 * 事件入口(webhook 路由 RPC 调用):幂等去重 → 取消 → gate → 入列。
	 * 只做轻活;真正的调查在 drain fiber 里执行。
	 */
	async handleEvent(
		input: HandleEventInput,
	): Promise<{ accepted: boolean; reason?: string }> {
		const { cfg, storage, limiter } = this.assemble();
		const { eventId, msg } = input;
		const sql = this.ctx.storage.sql;

		// 幂等:飞书 at-least-once(15s/5m/1h/6h 重试),同 event_id 只处理一次
		const inserted = sql.exec(
			"INSERT OR IGNORE INTO lark_events (event_id, ts) VALUES (?, ?)",
			eventId,
			Date.now(),
		);
		if (inserted.rowsWritten === 0)
			return { accepted: false, reason: "duplicate" };
		sql.exec("DELETE FROM lark_events WHERE ts < ?", Date.now() - EVENT_TTL_MS);

		const sessionKey = sessionKeyFor(msg);

		// 取消命令:仅在该会话有运行中任务时拦截(与 Orchestrator.route 同语义)
		if (CANCEL_RE.test(msg.text.trim()) && this.running.has(sessionKey)) {
			this.running.get(sessionKey)!.abort();
			return { accepted: true, reason: "cancelled" };
		}

		const row = storage.getSession(sessionKey);
		const hasActiveSession =
			this.draining ||
			this.pendingCount() > 0 ||
			(!!row &&
				row.state === "active" &&
				Date.now() - row.updated_at <=
					cfg.limits.session_idle_archive_min * 60_000);
		const pendingRepo = sql
			.exec<{ repo: string }>(
				"SELECT repo FROM pending_msgs ORDER BY id LIMIT 1",
			)
			.toArray()[0]?.repo;

		const decision = gate(msg, {
			cfg,
			limiter,
			hasActiveSession,
			activeRepo: hasActiveSession ? (row?.repo ?? pendingRepo) : undefined,
			repliesToBot: storage.isBotMessage(msg.parentId, msg.chatId),
		});

		switch (decision.action) {
			case "ignore":
				return { accepted: false, reason: decision.reason };
			case "denied":
			case "rate_limited":
				await this.replyAndRemember(msg, deniedCard(decision.reply)).catch(
					() => {},
				);
				return { accepted: true, reason: decision.action };
			case "clarify":
				await this.replyAndRemember(
					msg,
					projectChoiceCard(decision.projects, decision.reply),
				).catch(() => {});
				return { accepted: true, reason: "clarify" };
			case "help":
				await this.replyAndRemember(
					msg,
					helpCard({
						repo: decision.repo
							? repoDisplayName(decision.repo)
							: undefined,
						levelName: decision.levelName,
					}),
				).catch(() => {});
				return { accepted: true, reason: "help" };
			case "status":
				await this.replyStatus(msg, decision.repo);
				return { accepted: true, reason: "status" };
			case "investigate": {
				sql.exec(
					"INSERT INTO pending_msgs (msg, repo, question, created_at) VALUES (?, ?, ?, ?)",
					JSON.stringify(msg),
					decision.repo.name,
					decision.question,
					Date.now(),
				);
				this.ensureDrain();
				return { accepted: true, reason: "queued" };
			}
		}
	}

	/** 逐条执行 pending 调查(Fiber:keepAlive + 驱逐可恢复) */
	private ensureDrain(): void {
		if (this.draining) return;
		this.draining = true;
		void this.runFiber(`drain-${Date.now()}`, async () => {
			try {
				await this.drainPending();
			} finally {
				this.draining = false;
			}
		}).catch((e) => {
			this.draining = false;
			console.log(
				`[pinery-agent] drain fiber 异常:${e instanceof Error ? e.stack : String(e)}`,
			);
		});
	}

	private async drainPending(): Promise<void> {
		const { cfg, deps } = this.assemble();
		const sql = this.ctx.storage.sql;
		for (;;) {
			const row = sql
				.exec<{ id: number; msg: string; repo: string; question: string }>(
					"SELECT id, msg, repo, question FROM pending_msgs ORDER BY id LIMIT 1",
				)
				.toArray()[0];
			if (!row) return;
			try {
				const msg = JSON.parse(row.msg) as IncomingMessage;
				const repo = cfg.repos.find((r) => r.name === row.repo);
				if (repo) await runInvestigationPipeline(deps, msg, repo, row.question);
			} catch (e) {
				console.log(
					`[pinery-agent] 调查异常:${e instanceof Error ? e.stack : String(e)}`,
				);
			} finally {
				sql.exec("DELETE FROM pending_msgs WHERE id = ?", row.id);
			}
		}
	}

	/**
	 * DO 驱逐/重启后仍有未完成 fiber:pipeline 不是断点可续的,把彼时排队的
	 * 提问收敛为明确的错误卡片(而不是让进度卡永远停在「调查中」),清空队列。
	 */
	override async onFiberRecovered(): Promise<void> {
		const sql = this.ctx.storage.sql;
		const rows = sql
			.exec<{ id: number; msg: string }>(
				"SELECT id, msg FROM pending_msgs ORDER BY id",
			)
			.toArray();
		for (const row of rows) {
			try {
				const msg = JSON.parse(row.msg) as IncomingMessage;
				await this.replyAndRemember(
					msg,
					errorCard(
						"调查在运行环境重启中被中断,请重新提问。",
						"会话记忆仍在,重新提问即可延续。",
					),
				).catch(() => {});
			} finally {
				sql.exec("DELETE FROM pending_msgs WHERE id = ?", row.id);
			}
		}
	}

	private pendingCount(): number {
		const row = this.ctx.storage.sql
			.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pending_msgs")
			.one();
		return row?.n ?? 0;
	}

	private async replyStatus(msg: IncomingMessage, repo: RepoConfig): Promise<void> {
		const { cfg, storage } = this.assemble();
		const row = storage.getSession(sessionKeyFor(msg));
		// CF 形态:工作区在远端 DO,HEAD 元信息省略(与本地远程后端同款裁剪)
		await this.replyAndRemember(
			msg,
			statusCard({
				repo: repoDisplayName(repo),
				model: `${cfg.model.provider}/${cfg.model.id}`,
				sessionTurns: row?.turns,
				sessionState: row?.state,
				queueLength: this.pendingCount(),
			}),
		).catch(() => {});
	}

	private async replyAndRemember(
		msg: IncomingMessage,
		card: Card,
	): Promise<string | undefined> {
		const { lark, storage } = this.assemble();
		const messageId = await lark.replyCard(
			msg.messageId,
			card,
			replyInThreadFor(msg),
		);
		if (messageId) {
			storage.rememberBotMessage(messageId, msg.chatId, sessionKeyFor(msg));
		}
		return messageId;
	}
}
