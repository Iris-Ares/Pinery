import { describe, expect, it } from "vitest";
import {
  answerCard,
  cardJson,
  errorCard,
  helpCard,
  progressCard,
  projectChoiceCard,
  toolLine,
} from "../src/lark/cards.js";

describe("cards", () => {
  it("progress card shows recent tool lines and elapsed", () => {
    const card = progressCard({
      lines: [toolLine("bash", "rg refund src"), toolLine("read", "src/refund.ts")],
      elapsedSec: 12,
      turns: 3,
    });
    const json = cardJson(card);
    expect(card.schema).toBe("2.0");
    expect(card.header.template).toBe("blue");
    expect(json).toContain("rg refund src");
    expect(json).toContain("12s");
    expect(json).toContain("第 3 轮");
  });

  it("progress card caps visible lines at 6", () => {
    const lines = Array.from({ length: 10 }, (_, i) => toolLine("bash", `cmd-${i}`));
    const json = cardJson(progressCard({ lines, elapsedSec: 1 }));
    expect(json).not.toContain("cmd-0");
    expect(json).toContain("cmd-9");
  });

  it("answer card renders layers with confidence color", () => {
    const card = answerCard(
      "下单超时会退款吗?",
      {
        conclusion: "会自动退款。",
        evidence: "- `src/jobs/refund.ts:42` 定时任务",
        confidence: "高。未验证灰度配置。",
        confidenceLevel: "high",
      },
      { repo: "order", headShort: "abc1234", durationMs: 61_000, turns: 5, model: "deepseek/deepseek-chat" },
    );
    const json = cardJson(card);
    expect(card.header.template).toBe("green");
    expect(json).toContain("会自动退款");
    expect(json).toContain("collapsible_panel");
    expect(json).toContain("refund.ts:42");
    expect(json).toContain("order@abc1234");
    expect(json).toContain("61s");
  });

  it("answer card marks redaction and truncation in meta", () => {
    const json = cardJson(
      answerCard(
        "q",
        { conclusion: "c" },
        { repo: "r", durationMs: 1000, turns: 1, redacted: true, truncated: true },
      ),
    );
    expect(json).toContain("脱敏");
    expect(json).toContain("已截断");
  });

  it("long question is trimmed in title", () => {
    const card = answerCard("很长的问题".repeat(20), { conclusion: "c" }, { repo: "r", durationMs: 0, turns: 0 });
    expect(card.header.title.content.length).toBeLessThanOrEqual(45);
  });

  it("error and help cards build", () => {
    expect(cardJson(errorCard("boom", "hint"))).toContain("boom");
    const help = cardJson(helpCard({ repo: "order", levelName: "L0 观察" }));
    expect(help).toContain("order");
    expect(help).not.toContain("你的级别");
    expect(help).not.toContain("workspace");
    expect(help).not.toContain("工作区");
  });

  it("project choice card asks for intent without exposing repository bindings", () => {
    const json = cardJson(projectChoiceCard(["订单", "库存"], "请选择项目"));
    expect(json).toContain("你指的是哪个项目");
    expect(json).toContain("订单");
    expect(json).toContain("库存");
    expect(json).not.toContain("绑定");
    expect(json).not.toContain("workspace");
  });
});
