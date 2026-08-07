import { LarkApiError, TenantTokenManager, larkApiBase, type LarkDomain } from "./token.js";

/**
 * 飞书 IM REST 最小客户端(裸 fetch;Pinery 出站面仅 4 个接口):
 * 发卡片 / 回复(可开话题) / 更新卡片 / 机器人身份。
 * content 一律收序列化后的 JSON 字符串,不耦合上层卡片类型。
 * token 无效(99991661/99991663 或 HTTP 401)时强刷重试一次。
 */

export interface LarkFetchClientOptions {
  appId: string;
  appSecret: string;
  domain?: LarkDomain;
  /** API 基地址覆盖(飞书私有化部署/本地端到端;缺省按 domain 推导) */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface ApiResponse<T> {
  code?: number;
  msg?: string;
  data?: T;
}

const TOKEN_INVALID_CODES = new Set([99991661, 99991663]);

export class LarkFetchClient {
  private readonly tokens: TenantTokenManager;
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;

  constructor(opts: LarkFetchClientOptions) {
    this.tokens = new TenantTokenManager(opts);
    // workerd 下全局 fetch 以属性形式调用会丢 this 绑定(Illegal invocation),显式绑回
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.base = opts.baseUrl?.replace(/\/+$/, "") ?? larkApiBase(opts.domain);
  }

  /** 发送交互卡片,返回 message_id */
  async sendCard(chatId: string, contentJson: string): Promise<string | undefined> {
    const data = await this.request<{ message_id?: string }>(
      "POST",
      "/open-apis/im/v1/messages?receive_id_type=chat_id",
      { receive_id: chatId, msg_type: "interactive", content: contentJson },
    );
    return data?.message_id;
  }

  /** 回复消息(inThread=true 开话题/回话题),返回 message_id */
  async replyCard(messageId: string, contentJson: string, inThread: boolean): Promise<string | undefined> {
    const data = await this.request<{ message_id?: string }>(
      "POST",
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
      { msg_type: "interactive", content: contentJson, reply_in_thread: inThread },
    );
    return data?.message_id;
  }

  /** 更新已发出的卡片(进度流 → 答案共用一张卡;≤30KB、5 QPS/条) */
  async patchCard(messageId: string, contentJson: string): Promise<void> {
    await this.request("PATCH", `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      content: contentJson,
    });
  }

  /** 应用机器人身份(识别 @ 提及与防回环) */
  async botInfo(): Promise<{ openId?: string; name?: string }> {
    try {
      const data = await this.request<{ bot?: { open_id?: string; app_name?: string } }>(
        "GET",
        "/open-apis/bot/v3/info",
      );
      // 部分租户返回体不带 data 包裹,兜底直读
      const bot = data?.bot;
      return { openId: bot?.open_id, name: bot?.app_name };
    } catch {
      return {};
    }
  }

  private async request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T | undefined> {
    const token = await this.tokens.get();
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let parsed: ApiResponse<T> & T;
    try {
      parsed = (await res.json()) as ApiResponse<T> & T;
    } catch {
      throw new LarkApiError(-1, `飞书接口非 JSON 响应(HTTP ${res.status})`, res.status);
    }
    const tokenInvalid = res.status === 401 || TOKEN_INVALID_CODES.has(parsed.code ?? 0);
    if (tokenInvalid && !retried) {
      this.tokens.invalidate();
      return this.request<T>(method, path, body, true);
    }
    if (!res.ok || (parsed.code !== undefined && parsed.code !== 0)) {
      throw new LarkApiError(parsed.code ?? -1, `飞书接口失败 ${method} ${path}:${parsed.msg ?? res.statusText}`, res.status);
    }
    // bot/v3/info 等旧接口把载荷平铺在顶层而非 data 内
    return (parsed.data ?? (parsed as T)) as T;
  }
}
