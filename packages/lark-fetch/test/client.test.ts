import { describe, expect, it } from "vitest";
import { LarkFetchClient } from "../src/client.js";
import { TenantTokenManager } from "../src/token.js";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** 可编程 fake fetch:按序返回脚本化响应并记录请求 */
function fakeFetch(script: Array<{ status?: number; body: unknown }>) {
  const calls: Recorded[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const step = script.shift();
    if (!step) throw new Error("fake fetch script exhausted");
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return new Response(JSON.stringify(step.body), {
      status: step.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { impl, calls };
}

const TOKEN_OK = { code: 0, msg: "ok", tenant_access_token: "t-1", expire: 7200 };

describe("TenantTokenManager", () => {
  it("caches until the 30min refresh window, then refreshes", async () => {
    let nowMs = 0;
    const { impl, calls } = fakeFetch([
      { body: TOKEN_OK },
      { body: { ...TOKEN_OK, tenant_access_token: "t-2" } },
    ]);
    const mgr = new TenantTokenManager({ appId: "a", appSecret: "s", fetchImpl: impl, now: () => nowMs });
    expect(await mgr.get()).toBe("t-1");
    expect(await mgr.get()).toBe("t-1"); // 缓存命中,不再请求
    expect(calls.length).toBe(1);
    nowMs = (7200 - 29 * 60) * 1000; // 剩 29 分钟 → 进入刷新窗口
    expect(await mgr.get()).toBe("t-2");
    expect(calls.length).toBe(2);
    expect(calls[0]?.url).toContain("/open-apis/auth/v3/tenant_access_token/internal");
    expect(calls[0]?.body).toEqual({ app_id: "a", app_secret: "s" });
  });

  it("throws LarkApiError on non-zero code", async () => {
    const { impl } = fakeFetch([{ body: { code: 10003, msg: "invalid app_secret" } }]);
    const mgr = new TenantTokenManager({ appId: "a", appSecret: "bad", fetchImpl: impl });
    await expect(mgr.get()).rejects.toThrow(/invalid app_secret/);
  });

  it("uses larksuite domain when configured", async () => {
    const { impl, calls } = fakeFetch([{ body: TOKEN_OK }]);
    await new TenantTokenManager({ appId: "a", appSecret: "s", domain: "lark", fetchImpl: impl }).get();
    expect(calls[0]?.url).toContain("https://open.larksuite.com/");
  });
});

describe("LarkFetchClient", () => {
  it("validates app credentials without exposing the tenant token", async () => {
    const { impl, calls } = fakeFetch([{ body: TOKEN_OK }]);
    const client = new LarkFetchClient({ appId: "a", appSecret: "s", fetchImpl: impl });

    await expect(client.authenticate()).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/open-apis/auth/v3/tenant_access_token/internal");
  });

  it("sends, replies and patches cards with bearer token", async () => {
    const { impl, calls } = fakeFetch([
      { body: TOKEN_OK },
      { body: { code: 0, data: { message_id: "om_send" } } },
      { body: { code: 0, data: { message_id: "om_reply" } } },
      { body: { code: 0, data: {} } },
    ]);
    const client = new LarkFetchClient({ appId: "a", appSecret: "s", fetchImpl: impl });

    expect(await client.sendCard("oc_1", '{"card":1}')).toBe("om_send");
    expect(await client.replyCard("om_root", '{"card":2}', true)).toBe("om_reply");
    await client.patchCard("om_send", '{"card":3}');

    const [, send, reply, patch] = calls;
    expect(send?.url).toContain("/open-apis/im/v1/messages?receive_id_type=chat_id");
    expect(send?.body).toEqual({ receive_id: "oc_1", msg_type: "interactive", content: '{"card":1}' });
    expect(send?.headers["authorization"]).toBe("Bearer t-1");
    expect(reply?.url).toContain("/open-apis/im/v1/messages/om_root/reply");
    expect(reply?.body).toMatchObject({ reply_in_thread: true, msg_type: "interactive" });
    expect(patch?.method).toBe("PATCH");
    expect(patch?.url).toContain("/open-apis/im/v1/messages/om_send");
    expect(patch?.body).toEqual({ content: '{"card":3}' });
  });

  it("refreshes token and retries once on token-invalid code", async () => {
    const { impl, calls } = fakeFetch([
      { body: TOKEN_OK },
      { body: { code: 99991663, msg: "token invalid" } }, // 第一次业务请求:token 失效
      { body: { ...TOKEN_OK, tenant_access_token: "t-2" } }, // 强刷
      { body: { code: 0, data: { message_id: "om_ok" } } }, // 重试成功
    ]);
    const client = new LarkFetchClient({ appId: "a", appSecret: "s", fetchImpl: impl });
    expect(await client.sendCard("oc_1", "{}")).toBe("om_ok");
    expect(calls.length).toBe(4);
    expect(calls[3]?.headers["authorization"]).toBe("Bearer t-2");
  });

  it("does not retry twice: surfaces error when token stays invalid", async () => {
    const { impl } = fakeFetch([
      { body: TOKEN_OK },
      { body: { code: 99991663, msg: "token invalid" } },
      { body: TOKEN_OK },
      { body: { code: 99991663, msg: "token invalid" } },
    ]);
    const client = new LarkFetchClient({ appId: "a", appSecret: "s", fetchImpl: impl });
    await expect(client.sendCard("oc_1", "{}")).rejects.toThrow(/token invalid/);
  });

  it("surfaces business errors with code and message", async () => {
    const { impl } = fakeFetch([
      { body: TOKEN_OK },
      { status: 400, body: { code: 230001, msg: "param invalid" } },
    ]);
    const client = new LarkFetchClient({ appId: "a", appSecret: "s", fetchImpl: impl });
    await expect(client.patchCard("om_x", "{}")).rejects.toThrow(/param invalid/);
  });

  it("reads bot info from flat payload", async () => {
    const { impl } = fakeFetch([
      { body: TOKEN_OK },
      { body: { code: 0, bot: { open_id: "ou_bot", app_name: "Pinery" } } },
    ]);
    const client = new LarkFetchClient({ appId: "a", appSecret: "s", fetchImpl: impl });
    expect(await client.botInfo()).toEqual({ openId: "ou_bot", name: "Pinery" });
  });
});
