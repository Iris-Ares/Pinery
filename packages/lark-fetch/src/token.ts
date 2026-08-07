/**
 * tenant_access_token 自管(官方 SDK 在 workerd 不可用,自建最小实现):
 * - 有效期最长 2 小时;官方约定剩余 <30 分钟时接口会发新 token(新旧并存),
 *   因此本地在剩余 30 分钟前主动刷新;
 * - 401/无效 token 由调用方 invalidate() 后单次强刷重试;
 * - 单实例内存缓存 —— Agent DO 单线程天然免并发竞态。
 */

export type LarkDomain = "feishu" | "lark";

export function larkApiBase(domain: LarkDomain | undefined): string {
  return domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
}

export interface TenantTokenManagerOptions {
  appId: string;
  appSecret: string;
  domain?: LarkDomain;
  /** API 基地址覆盖(飞书私有化部署/本地端到端;缺省按 domain 推导) */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** 时钟注入(测试用) */
  now?: () => number;
}

/** 提前刷新窗口:剩余有效期低于该值即换新 */
const REFRESH_AHEAD_MS = 30 * 60_000;

export class LarkApiError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "LarkApiError";
  }
}

export class TenantTokenManager {
  private token?: string;
  private expiresAt = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: TenantTokenManagerOptions) {
    // workerd 下全局 fetch 以属性形式调用会丢 this 绑定(Illegal invocation),显式绑回
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = opts.now ?? Date.now;
  }

  /** 取可用 token(命中缓存或刷新) */
  async get(): Promise<string> {
    if (this.token && this.now() < this.expiresAt - REFRESH_AHEAD_MS) return this.token;
    const base = this.opts.baseUrl?.replace(/\/+$/, "") ?? larkApiBase(this.opts.domain);
    const res = await this.fetchImpl(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: this.opts.appId, app_secret: this.opts.appSecret }),
    });
    const body = (await res.json()) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
    if (!res.ok || body.code !== 0 || !body.tenant_access_token) {
      throw new LarkApiError(body.code ?? -1, `获取 tenant_access_token 失败:${body.msg ?? res.statusText}`, res.status);
    }
    this.token = body.tenant_access_token;
    this.expiresAt = this.now() + (body.expire ?? 7200) * 1000;
    return this.token;
  }

  /** token 被上游判无效时调用,下次 get() 强制刷新 */
  invalidate(): void {
    this.token = undefined;
    this.expiresAt = 0;
  }
}
