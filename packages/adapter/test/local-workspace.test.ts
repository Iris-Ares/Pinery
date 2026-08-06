import { describe, expect, it } from "vitest";
import { parseConfig, type RepoConfig } from "@pinery/core";
import { LocalWorkspaceProvider } from "../src/workspace/local.js";

/**
 * 回归(PR review 六轮 P2):pull 会原地改写共享 checkout。若与调查并发,
 * 一次跨越刷新周期的调查会读到分属不同 commit 的文件,而卡片上的 HEAD 只显示
 * pull 之后的版本——矛盾的证据会被归因到代码本身而不是「快照被换掉了」。
 */
const cfg = parseConfig(
  `
lark: { app_id: x, app_secret: y }
repos:
  - name: order
    url: "https://example.com/order.git"
    chats: [oc_g]
`,
  {} as NodeJS.ProcessEnv,
);
const repo = cfg.repos[0] as RepoConfig;

describe("LocalWorkspaceProvider refresh gating", () => {
  it("runs the refresh immediately when nobody is reading", async () => {
    const p = new LocalWorkspaceProvider(cfg);
    const ran = await p.withIdleCheckout("order", async () => "pulled");
    expect(ran).toBe("pulled");
  });

  it("defers the refresh until the last investigation releases", async () => {
    const p = new LocalWorkspaceProvider(cfg);
    const ws1 = await p.acquireSession(repo, "s1");
    const ws2 = await p.acquireSession(repo, "s2");

    const order: string[] = [];
    const pull = p.withIdleCheckout("order", async () => {
      order.push("pull");
      return "pulled";
    });

    // 两个会话都还在读:pull 必须等待
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([]);

    await p.release(ws1);
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([]); // 还有一个读者

    order.push("release-last");
    await p.release(ws2);
    await expect(pull).resolves.toBe("pulled");
    expect(order).toEqual(["release-last", "pull"]);
  });

  it("skips the round instead of blocking when readers stay busy", async () => {
    const p = new LocalWorkspaceProvider(cfg);
    await p.acquireSession(repo, "long-running");
    let ran = false;
    const result = await p.withIdleCheckout(
      "order",
      async () => {
        ran = true;
        return "pulled";
      },
      30, // 短等待窗口
    );
    expect(result).toBeUndefined();
    expect(ran).toBe(false); // 周期性刷新错过一轮没有代价,拖住调查却有
  });

  it("counts readers per repo", async () => {
    const p = new LocalWorkspaceProvider(cfg);
    await p.acquireSession(repo, "s1");
    // 另一个仓库不受影响
    const other = await p.withIdleCheckout("billing", async () => "pulled");
    expect(other).toBe("pulled");
  });
});
