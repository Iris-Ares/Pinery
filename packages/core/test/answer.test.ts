import { describe, expect, it } from "vitest";
import { parseLayeredAnswer } from "../src/answer.js";

describe("parseLayeredAnswer", () => {
  it("parses full template", () => {
    const md = [
      "## 结论",
      "会自动退款。超时 30 分钟后由定时任务触发。",
      "",
      "## 依据",
      "- `src/jobs/refund.ts:42` 定时扫描超时订单",
      "- `src/config.ts:7` REFUND_TIMEOUT_MINUTES = 30",
      "",
      "## 置信度与边界",
      "高。未验证灰度开关关闭时的行为。",
    ].join("\n");
    const a = parseLayeredAnswer(md);
    expect(a.conclusion).toContain("自动退款");
    expect(a.evidence).toContain("refund.ts:42");
    expect(a.confidence).toContain("未验证");
    expect(a.confidenceLevel).toBe("high");
  });

  it("supports english headings", () => {
    const a = parseLayeredAnswer("## Conclusion\nYes.\n## Evidence\n- a.ts\n## Confidence\nlow, partial scan");
    expect(a.conclusion).toBe("Yes.");
    expect(a.confidenceLevel).toBe("low");
  });

  it("falls back to whole text as conclusion", () => {
    const a = parseLayeredAnswer("就是一段没有模板的话。");
    expect(a.conclusion).toBe("就是一段没有模板的话。");
    expect(a.evidence).toBeUndefined();
  });

  it("keeps preamble and unknown sections", () => {
    const a = parseLayeredAnswer("开场白。\n## 结论\n对。\n## 其他\n补充说明。");
    expect(a.conclusion).toContain("开场白");
    expect(a.conclusion).toContain("补充说明");
  });

  it("handles empty input", () => {
    expect(parseLayeredAnswer("").conclusion).toBe("");
  });
});
