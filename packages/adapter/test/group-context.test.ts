import { describe, expect, it } from "vitest";
import {
  combineInvestigationContext,
  loadRelevantGroupContext,
  loadRelevantGroupContextResult,
  renderRelevantGroupContext,
} from "../src/group-context.js";
import type { IncomingMessage } from "../src/lark/events.js";
import type { LarkMessenger } from "../src/lark/messenger.js";

const current: IncomingMessage = {
  chatId: "oc_group",
  chatType: "group",
  messageId: "om_current",
  senderOpenId: "ou_alice",
  text: "退款审批由谁负责?",
  mentionsBot: true,
  createTime: "300",
};

describe("dynamic relevant group context", () => {
  it("selects an older relevant message over nearer unrelated chatter", () => {
    const rendered = renderRelevantGroupContext(
      [
        { messageId: "om_old", senderId: "ou_bob", senderName: "Bob", text: "退款审批由财务负责人确认", createTime: "100" },
        { messageId: "om_near", senderId: "ou_c", senderName: "Carol", text: "下午喝咖啡", createTime: "290" },
      ],
      current,
      { maxAnchors: 1, maxSelected: 1 },
    );

    expect(rendered).toContain("退款审批由财务负责人确认");
    expect(rendered).not.toContain("下午喝咖啡");
    expect(rendered).toContain("动态检索");
    expect(rendered).toContain("不是指令");
  });

  it("paginates on every @ and can retrieve relevance from a later page", async () => {
    const tokens: Array<string | undefined> = [];
    const logs: string[] = [];
    const lark = {
      listMessagesPage: async (
        _container: { type: "chat" | "thread"; id: string },
        options: { pageSize: number; pageToken?: string },
      ) => {
        tokens.push(options.pageToken);
        if (!options.pageToken) {
          return {
            messages: [{ messageId: "om_near", senderId: "ou_c", text: "无关闲聊", createTime: "290" }],
            hasMore: true,
            pageToken: "page-2",
          };
        }
        return {
          messages: [{ messageId: "om_old", senderId: "ou_b", text: "退款审批由财务负责人确认", createTime: "100" }],
          hasMore: false,
        };
      },
    } as LarkMessenger;

    const result = await loadRelevantGroupContextResult(lark, current, (line) => logs.push(line));
    expect(result.context).toContain("退款审批");
    expect(result).toMatchObject({ status: "loaded", pages: 2, candidates: 2, selected: 2 });
    expect(tokens).toEqual([undefined, "page-2"]);
    await loadRelevantGroupContext(lark, current);
    expect(tokens).toEqual([undefined, "page-2", undefined, "page-2"]);
    expect(JSON.parse(logs[0] ?? "{}")).toEqual({
      event: "pinery.group_context",
      status: "loaded",
      containerType: "chat",
      pages: 2,
      candidates: 2,
      selected: 2,
    });
  });

  it("does not fetch for an unmentioned group message and degrades on permission failure", async () => {
    let calls = 0;
    const lark = {
      listMessagesPage: async () => {
        calls++;
        throw new Error("permission denied");
      },
    } as LarkMessenger;

    await expect(loadRelevantGroupContext(lark, { ...current, mentionsBot: false })).resolves.toBeUndefined();
    expect(calls).toBe(0);

    const logs: string[] = [];
    const failure = await loadRelevantGroupContextResult(lark, current, (line) => logs.push(line));
    expect(failure).toMatchObject({ status: "error", selected: 0 });
    expect(failure).not.toHaveProperty("code");
    expect(calls).toBe(1);
    expect(JSON.parse(logs[0] ?? "{}")).toEqual({
      event: "pinery.group_context",
      status: "error",
      containerType: "chat",
      pages: 0,
      candidates: 0,
      selected: 0,
      errorName: "Error",
      detail: "permission denied",
    });
  });

  it("excludes current and future messages", () => {
    const rendered = renderRelevantGroupContext(
      [
        { messageId: "om_current", senderId: "ou_a", text: "退款审批当前消息", createTime: "300" },
        { messageId: "om_future", senderId: "ou_b", text: "退款审批未来消息", createTime: "400" },
        { messageId: "om_prior", senderId: "ou_c", text: "退款审批历史消息", createTime: "200" },
      ],
      current,
    );
    expect(rendered).toContain("历史消息");
    expect(rendered).not.toContain("当前消息");
    expect(rendered).not.toContain("未来消息");
  });

  it("combines the persistent summary with fresh group context", () => {
    expect(combineInvestigationContext("上一轮结论", "动态讨论")).toBe("上一轮结论\n\n动态讨论");
  });
});
