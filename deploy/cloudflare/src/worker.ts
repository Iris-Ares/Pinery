import { DurableObject } from "cloudflare:workers";
import {
	type DurableObjectStorageLike,
	type EagerMount,
	getWorkspace,
	type WorkspaceHandle,
	withWorkspace,
} from "@cloudflare/computer";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import { createGitClient } from "@cloudflare/computer/git";
import { filterSecrets } from "@pinery/core";
import { LarkFetchClient } from "@pinery/lark-fetch";
import {
	ERROR_STATUS,
	normalizeWorkspacePath,
	PROTOCOL_VERSION,
	splitRepoCredentials,
	type WireErrorCode,
	type WireRequest,
	WORKSPACE_ROOT,
} from "@pinery/workspace-cf-computer/protocol";
import { getAgentByName } from "agents";
import type { PineryAgent } from "./agent.js";
import { loadWorkerConfig } from "./config.js";
import { handleLarkEvents } from "./lark-route.js";
import {
	type GitOpFailure,
	handleRpc,
	readMarker,
	WireError,
	writeMarker,
} from "./rpc.js";
import {
	parseRuntimeQueryInput,
	RUNTIME_QUERY_MAX_BODY_BYTES,
} from "./runtime-query.js";
import { handleSourceUpload, isSourceUploadPath } from "./source-upload.js";

export { PineryAgent } from "./agent.js";

/**
 * Pinery Cloudflare Worker。
 *
 * 每个工作区 = 一个 Durable Object:SQLite VFS 持久,DO 休眠即封存、
 * 请求到达自动唤醒(与 Pinery 的 thread 封存/唤醒模型同构)。
 * 线协议执行点在 rpc.ts(HTTP 路由与 CF 形态的 DirectWorkspaceClient 共用);
 * 本文件只剩路由、鉴权与 DO 类导出。
 * 对外 HTTP 入口鉴权用共享密钥(wrangler secret put PINERY_TOKEN)。
 *
 * ⚠️ @cloudflare/computer 目前是 PREVIEW,API 可能变动,已 pin 到 0.1.1。
 */

interface Env {
	// 不参数化:PineryWorkspace 由 mixin 生成,参数化会造成类型自引用
	WORKSPACE: DurableObjectNamespace;
	AGENT: DurableObjectNamespace<PineryAgent>;
	LOADER: unknown;
	PINERY_SOURCES?: R2Bucket;
	PINERY_TOKEN: string;
	PINERY_CONFIG?: string;
	PINERY_SOURCE_PREFIX?: string;
	PINERY_SOURCE_READY?: string;
	PINERY_SOURCE_REPO?: string;
	PINERY_SOURCE_WORKSPACE?: string;
	[key: string]: unknown;
}

function sourcePrefix(input: string | undefined): string | undefined {
	if (!input?.trim()) return undefined;
	const normalized = input.trim().replace(/^\/+|\/+$/g, "");
	if (
		!normalized ||
		normalized.split("/").some((part) => !part || part === "." || part === "..")
	) {
		throw new Error("PINERY_SOURCE_PREFIX 非法");
	}
	return `${normalized}/`;
}

function sourceRepoUrl(input: string | undefined): string | undefined {
	if (!input?.trim()) return undefined;
	const url = new URL(input.trim());
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error(
			"PINERY_SOURCE_REPO 必须是无凭据、无 query/fragment 的 HTTPS URL",
		);
	}
	return url.toString();
}

const snapshotLockMount: EagerMount = {
	kind: "pinery-source-snapshot",
	mode: "read-only",
	strategy: "eager",
	async materialize(): Promise<void> {
		// 快照已由可恢复的 R2 分批水合路径写入;这个 mount 只负责给
		// 已有树打 mount provenance 并在数据层启用 EROFS,不重复复制文件。
	},
};

interface SourceHydrateRequest {
	cursor?: string;
	limit?: number;
	ref?: string;
}

interface SourceHydrateResult {
	done: boolean;
	cursor?: string;
	objects: number;
	bytes: number;
}

/**
 * 基类:把 DurableObject 的 protected 成员(ctx/env)以公开只读访问器暴露,
 * 供 withWorkspace 的 options 工厂读取(工厂在类体外,拿不到 protected)。
 */
class WorkspaceBase extends DurableObject<Env> {
	/**
	 * 运行时就是 DurableObjectStorage;显式收敛是因为 computer@0.1.1 的
	 * `DurableObjectStorageLike` 用泛型 Row 声明 sql.exec,与 workers-types v5 的
	 * `Record<string, SqlStorageValue>` 存在型变冲突(纯类型层面,形状一致)。
	 */
	get storage(): DurableObjectStorageLike {
		return this.ctx.storage as unknown as DurableObjectStorageLike;
	}
	get execCtx(): DurableObjectState {
		return this.ctx;
	}
	get loaderBinding(): unknown {
		return this.env.LOADER;
	}
	get sourcePrefix(): string | undefined {
		return sourcePrefix(this.env.PINERY_SOURCE_PREFIX);
	}
	get sourceRepoUrl(): string | undefined {
		return sourceRepoUrl(this.env.PINERY_SOURCE_REPO);
	}
	get sourceWorkspaceName(): string | undefined {
		return this.env.PINERY_SOURCE_WORKSPACE?.trim() || undefined;
	}
	get sourceMounts(): Record<string, EagerMount> | undefined {
		const workspaceName = this.sourceWorkspaceName;
		if (!workspaceName || this.env.PINERY_SOURCE_READY !== workspaceName)
			return undefined;
		const expectedId = this.env.WORKSPACE.idFromName(workspaceName).toString();
		return this.ctx.id.toString() === expectedId
			? { [WORKSPACE_ROOT]: snapshotLockMount }
			: undefined;
	}
	get workspaceDoId(): string {
		return this.ctx.id.toString();
	}
}

export class PineryWorkspace extends withWorkspace(WorkspaceBase, (self) => ({
	storage: self.storage,
	...(self.sourceMounts ? { mounts: self.sourceMounts } : {}),
	git: createGitClient(),
	defaultGitIdentity: { name: "Pinery", email: "pinery@localhost" },
	backends: [
		new WorkerShellBackend({
			loader: self.loaderBinding as never,
			workspace: { binding: "WORKSPACE", id: self.workspaceDoId },
			ctx: self.execCtx as never,
		}),
	],
})) {
	// clone/pull 是 DO 自有 RPC 方法:computer 0.1.1 跨 RPC 边界的 git stub 只暴露
	// cli(argv),而 argv 形式的凭据只能进 URL(会被 isomorphic-git 写进 .git/config,
	// agent 读得到)。本地 getWorkspace(this) 直通 Workspace 对象,typed API 的
	// headers 凭据语义(不落盘)得以保留。错误以值返回:自定义 Error 跨 RPC 丢原型。

	async gitCloneOp(req: {
		url: string;
		ref?: string;
		depth?: number;
	}): Promise<GitOpFailure | Record<string, never>> {
		using ws = await getWorkspace(this);
		// isomorphic-git 无 SSH 传输:URL 必须是 HTTPS(provider 侧也会校验)
		if (!/^https:\/\//i.test(req.url)) {
			return {
				error: {
					code: "bad_request",
					message: `CF 路径只支持 HTTPS 仓库地址(收到:${req.url})`,
				},
			};
		}
		// 幂等:多个调用方可能同时请求初始化同一工作区。DO 天然串行,
		// 所以「检查 marker + clone」在这里是原子的;已是同一仓库就直接返回,
		// 避免第二次 clone 在第一次的调查读取过程中改写 WORKSPACE_ROOT。
		const existing = await readMarker(ws);
		const { url, headers } = splitRepoCredentials(req.url);
		if (existing?.url === url) return {};
		if (this.sourcePrefix) {
			if (!this.sourceRepoUrl) {
				return {
					error: {
						code: "bad_request",
						message: "R2 快照已启用,但缺少 PINERY_SOURCE_REPO",
					},
				};
			}
			if (url !== this.sourceRepoUrl) {
				return {
					error: { code: "bad_request", message: "R2 快照与请求的仓库不匹配" },
				};
			}
			try {
				const manifest = await ws.fs.stat(
					`${WORKSPACE_ROOT}/.pinery-snapshot.json`,
				);
				if (!manifest.isFile) throw new Error("not a file");
			} catch {
				return {
					error: { code: "not_found", message: "R2 快照尚未水合到共享工作区" },
				};
			}
			// 标记写在工作区外,供 provider 复用原有 info/refresh 协议,
			// 不把凭据或状态混入代码树。
			await writeMarker(ws, { url, ref: req.ref, syncedAt: Date.now() });
			return {};
		}
		// 凭据走 Authorization 头,**不进 URL**:isomorphic-git 会把 clone 用的
		// 地址写进 WORKSPACE_ROOT/.git/config 的 remote origin,而那是 agent
		// 读得到的文件(cat .git/config)。
		await ws.git.clone({
			url,
			dir: WORKSPACE_ROOT,
			...(headers ? { headers } : {}),
			...(req.ref ? { ref: req.ref } : {}),
			...(req.depth !== undefined ? { depth: req.depth } : {}),
		});
		// 只记脱敏地址:凭据留在请求里,不写入任何持久介质
		await writeMarker(ws, { url, ref: req.ref, syncedAt: Date.now() });
		return {};
	}

	async gitPullOp(req: {
		ref?: string;
		url?: string;
	}): Promise<GitOpFailure | { updated: boolean; detail?: string }> {
		using ws = await getWorkspace(this);
		// 会话工作区的 VFS 是持久的:不刷新就会一直基于初次克隆回答
		const marker = await readMarker(ws);
		if (!marker)
			return {
				error: { code: "not_found", message: "工作区尚未初始化,请先 gitClone" },
			};
		if (this.sourcePrefix) {
			const requested = req.url
				? splitRepoCredentials(req.url).url
				: marker.url;
			if (!this.sourceRepoUrl || requested !== this.sourceRepoUrl) {
				return {
					error: { code: "bad_request", message: "R2 快照与请求的仓库不匹配" },
				};
			}
			await writeMarker(ws, { ...marker, syncedAt: Date.now() });
			return {
				updated: false,
				detail: `使用固定 R2 快照 ${this.sourcePrefix}`,
			};
		}
		// remote origin 存的是脱敏地址,私有仓库的 pull 因此拿不到凭据 ——
		// 由请求方在每次调用时带上来源地址,这里同样只取认证头
		const auth = req.url ? splitRepoCredentials(req.url) : undefined;
		try {
			await ws.git.pull({
				dir: WORKSPACE_ROOT,
				...((req.ref ?? marker.ref)
					? { ref: (req.ref ?? marker.ref) as string }
					: {}),
				...(auth?.headers ? { headers: auth.headers } : {}),
				singleBranch: true,
				fastForwardOnly: true, // 只读工作区不产生合并提交
			});
			await writeMarker(ws, { ...marker, syncedAt: Date.now() });
			return { updated: true };
		} catch (e) {
			// 浅克隆下的 pull 可能失败(非 ff、历史不足);标记已尝试,避免每次提问都重试
			await writeMarker(ws, { ...marker, syncedAt: Date.now() });
			return { updated: false, detail: (e as Error).message };
		}
	}

	async hydrateSourceBatch(
		req: SourceHydrateRequest,
	): Promise<GitOpFailure | SourceHydrateResult> {
		if (
			this.sourceWorkspaceName &&
			this.env.PINERY_SOURCE_READY === this.sourceWorkspaceName
		) {
			return {
				error: { code: "bad_request", message: "共享快照已锁定为只读" },
			};
		}
		const prefix = this.sourcePrefix;
		const repoUrl = this.sourceRepoUrl;
		const bucket = this.env.PINERY_SOURCES;
		if (!prefix || !repoUrl || !bucket) {
			return { error: { code: "bad_request", message: "R2 快照配置不完整" } };
		}
		const limit = req.limit ?? 100;
		if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
			return {
				error: { code: "bad_request", message: "hydrate limit 必须在 1..100" },
			};
		}

		using ws = await getWorkspace(this);
		const page = await bucket.list({ prefix, cursor: req.cursor, limit });
		let bytes = 0;
		for (let offset = 0; offset < page.objects.length; offset += 4) {
			const batch = page.objects.slice(offset, offset + 4);
			await Promise.all(
				batch.map(async (entry) => {
					const relative = entry.key.slice(prefix.length);
					const path = normalizeWorkspacePath(relative);
					if (!relative || !path)
						throw new Error(`R2 快照对象路径非法:${entry.key}`);
					const object = await bucket.get(entry.key);
					if (!object)
						throw new Error(`R2 快照对象在水合期间消失:${entry.key}`);
					const parent = path.slice(0, path.lastIndexOf("/"));
					if (parent) await ws.fs.mkdir(parent, { recursive: true });
					await ws.fs.writeFile(path, object.body);
					bytes += entry.size;
				}),
			);
		}

		if (!page.truncated) {
			const raw = await ws.fs.readFile(
				`${WORKSPACE_ROOT}/.pinery-snapshot.json`,
				"utf8",
			);
			const manifest = JSON.parse(raw) as unknown;
			if (
				typeof manifest !== "object" ||
				manifest === null ||
				!("repo" in manifest) ||
				(manifest as { repo?: unknown }).repo !== repoUrl ||
				!("commit" in manifest) ||
				typeof (manifest as { commit?: unknown }).commit !== "string"
			) {
				throw new Error("快照清单缺失或与 PINERY_SOURCE_REPO 不匹配");
			}
			await writeMarker(ws, {
				url: repoUrl,
				ref: req.ref,
				syncedAt: Date.now(),
			});
		}

		return {
			done: !page.truncated,
			...(page.truncated ? { cursor: page.cursor } : {}),
			objects: page.objects.length,
			bytes,
		};
	}
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function fail(code: WireErrorCode, message: string): Response {
	return json({ ok: false, error: { code, message } }, ERROR_STATUS[code]);
}

/** 常量时间比较,避免 token 逐字符时序泄漏 */
function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

function authorized(request: Request, expected: string | undefined): boolean {
	if (!expected) return false;
	const auth = request.headers.get("authorization") ?? "";
	const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
	return safeEqual(token, expected);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/health")
			return json({ ok: true, protocol: PROTOCOL_VERSION });

		if (url.pathname === "/v1/lark/check" && request.method === "POST") {
			if (!authorized(request, env.PINERY_TOKEN))
				return fail("unauthorized", "鉴权失败");
			try {
				const cfg = loadWorkerConfig(env as never);
				const client = new LarkFetchClient({
					appId: cfg.lark.app_id,
					appSecret: cfg.lark.app_secret,
					domain: cfg.lark.endpoint,
					baseUrl: cfg.lark.api_base,
				});
				await client.authenticate();
				const bot = await client.botInfo();
				return json({
					ok: true,
					result: {
						authenticated: true,
						botIdentityResolved: Boolean(bot.openId),
					},
				});
			} catch (error) {
				const detail = filterSecrets(
					error instanceof Error ? error.message : String(error),
				).text;
				console.error(
					JSON.stringify({ event: "pinery.lark.check_failed", error: detail }),
				);
				return json(
					{
						ok: false,
						error: {
							code: "lark_check_failed",
							message: "飞书应用鉴权失败;请检查应用配置与权限",
						},
					},
					502,
				);
			}
		}

		// CF 形态:飞书 webhook 事件入口(验签/解密在路由内,不走 Bearer 鉴权)
		if (url.pathname === "/lark/events" && request.method === "POST") {
			return handleLarkEvents(request, env as never);
		}

		if (url.pathname === "/v1/agent/query" && request.method === "POST") {
			if (!authorized(request, env.PINERY_TOKEN))
				return fail("unauthorized", "鉴权失败");
			const declaredLength = Number(
				request.headers.get("content-length") ?? "0",
			);
			if (
				!Number.isFinite(declaredLength) ||
				declaredLength < 0 ||
				declaredLength > RUNTIME_QUERY_MAX_BODY_BYTES
			) {
				return fail(
					"bad_request",
					`请求体不能超过 ${RUNTIME_QUERY_MAX_BODY_BYTES} bytes`,
				);
			}

			let input: ReturnType<typeof parseRuntimeQueryInput>;
			try {
				const raw = await request.text();
				if (
					new TextEncoder().encode(raw).byteLength >
					RUNTIME_QUERY_MAX_BODY_BYTES
				) {
					return fail(
						"bad_request",
						`请求体不能超过 ${RUNTIME_QUERY_MAX_BODY_BYTES} bytes`,
					);
				}
				input = parseRuntimeQueryInput(JSON.parse(raw) as unknown);
			} catch (error) {
				return fail(
					"bad_request",
					error instanceof Error ? error.message : "请求体不是合法 JSON",
				);
			}

			try {
				const agent = await getAgentByName(env.AGENT, "runtime-query");
				const result = await agent.runtimeQuery(input);
				return json({ ok: result.ok, result }, result.ok ? 200 : 502);
			} catch (error) {
				return fail("internal", `Agent 查询失败:${(error as Error).message}`);
			}
		}

		if (url.pathname === "/v1/agent/smoke" && request.method === "POST") {
			if (!authorized(request, env.PINERY_TOKEN))
				return fail("unauthorized", "鉴权失败");
			try {
				const agent = await getAgentByName(env.AGENT, "runtime-smoke");
				const result = await agent.runtimeSmoke();
				return json({ ok: result.ok, result }, result.ok ? 200 : 502);
			} catch (error) {
				return fail("internal", `Agent 冒烟失败:${(error as Error).message}`);
			}
		}

		const hydrateMatch = url.pathname.match(/^\/v1\/source\/hydrate\/([^/]+)$/);
		if (hydrateMatch && request.method === "POST") {
			if (!authorized(request, env.PINERY_TOKEN))
				return fail("unauthorized", "鉴权失败");
			const workspaceId = decodeURIComponent(hydrateMatch[1] as string);
			if (!/^[A-Za-z0-9._-]{1,128}$/.test(workspaceId))
				return fail("bad_request", "非法 workspaceId");
			if (
				!env.PINERY_SOURCE_WORKSPACE ||
				workspaceId !== env.PINERY_SOURCE_WORKSPACE
			) {
				return fail(
					"bad_request",
					"hydrate workspace 必须与 PINERY_SOURCE_WORKSPACE 一致",
				);
			}

			let body: SourceHydrateRequest;
			try {
				const raw = (await request.json()) as unknown;
				if (typeof raw !== "object" || raw === null || Array.isArray(raw))
					throw new Error("not an object");
				const record = raw as Record<string, unknown>;
				if (
					record.cursor !== undefined &&
					(typeof record.cursor !== "string" || record.cursor.length > 2048)
				) {
					return fail("bad_request", "非法 hydrate cursor");
				}
				if (record.limit !== undefined && typeof record.limit !== "number")
					return fail("bad_request", "非法 hydrate limit");
				if (
					record.ref !== undefined &&
					(typeof record.ref !== "string" || record.ref.length > 255)
				) {
					return fail("bad_request", "非法 hydrate ref");
				}
				body = {
					...(typeof record.cursor === "string"
						? { cursor: record.cursor }
						: {}),
					...(typeof record.limit === "number" ? { limit: record.limit } : {}),
					...(typeof record.ref === "string" ? { ref: record.ref } : {}),
				};
			} catch {
				return fail("bad_request", "hydrate 请求体不是合法 JSON 对象");
			}

			const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
			try {
				const hydrator = stub as unknown as {
					hydrateSourceBatch: (
						req: SourceHydrateRequest,
					) => Promise<GitOpFailure | SourceHydrateResult>;
				};
				const result = await hydrator.hydrateSourceBatch(body);
				if ("error" in result)
					return fail(result.error.code, result.error.message);
				return json({ ok: true, result });
			} catch (e) {
				return fail("internal", `水合 R2 快照失败:${(e as Error).message}`);
			}
		}

		if (isSourceUploadPath(url.pathname) && request.method === "PUT") {
			if (!authorized(request, env.PINERY_TOKEN))
				return fail("unauthorized", "鉴权失败");
			if (!env.PINERY_SOURCES)
				return fail("internal", "未绑定 PINERY_SOURCES R2 bucket");
			return handleSourceUpload(request, env.PINERY_SOURCES);
		}

		const match = url.pathname.match(/^\/v1\/ws\/([^/]+)\/rpc$/);
		if (!match || request.method !== "POST") {
			return fail(
				"not_found",
				"未知路由;协议入口为 POST /v1/ws/:workspaceId/rpc",
			);
		}

		if (!authorized(request, env.PINERY_TOKEN)) {
			return fail("unauthorized", "鉴权失败");
		}

		const workspaceId = decodeURIComponent(match[1] as string);
		if (!/^[A-Za-z0-9._-]{1,128}$/.test(workspaceId)) {
			return fail("bad_request", "非法 workspaceId");
		}

		let body: WireRequest;
		try {
			body = (await request.json()) as WireRequest;
		} catch {
			return fail("bad_request", "请求体不是合法 JSON");
		}
		if (!body || typeof body.op !== "string")
			return fail("bad_request", "缺少 op 字段");

		const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
		try {
			const result = await handleRpc(
				stub as unknown as WorkspaceHandle,
				workspaceId,
				body,
			);
			return json({ ok: true, result });
		} catch (e) {
			if (e instanceof WireError) return fail(e.code, e.message);
			return fail("internal", `执行 ${body.op} 失败:${(e as Error).message}`);
		}
	},
} satisfies ExportedHandler<Env>;
