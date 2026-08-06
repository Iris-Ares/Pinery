/**
 * 分层答案解析(PRD §2.1 场景 A):
 * agent 按答案模板输出「## 结论 / ## 依据 / ## 置信度与边界」三段 markdown,
 * 这里解析为结构化对象供卡片渲染;解析失败时整体回退为结论。
 */

export type ConfidenceLevel = "high" | "medium" | "low";

export interface LayeredAnswer {
  conclusion: string;
  evidence?: string;
  confidence?: string;
  confidenceLevel?: ConfidenceLevel;
}

const SECTION_MATCHERS: Array<{ key: keyof Pick<LayeredAnswer, "conclusion" | "evidence" | "confidence">; re: RegExp }> = [
  { key: "conclusion", re: /^(结论|conclusion|答案|answer)/i },
  { key: "evidence", re: /^(依据|证据|evidence|来源|sources?)/i },
  { key: "confidence", re: /^(置信|confidence|边界|caveats?|limitations?)/i },
];

function classifyHeading(heading: string): "conclusion" | "evidence" | "confidence" | undefined {
  const clean = heading.trim().replace(/[*_`#]/g, "").trim();
  for (const { key, re } of SECTION_MATCHERS) {
    if (re.test(clean)) return key;
  }
  return undefined;
}

export function detectConfidenceLevel(text: string): ConfidenceLevel | undefined {
  const head = text.slice(0, 80);
  if (/高|high/i.test(head)) return "high";
  if (/中|medium|moderate/i.test(head)) return "medium";
  if (/低|low/i.test(head)) return "low";
  return undefined;
}

export function parseLayeredAnswer(markdown: string): LayeredAnswer {
  const text = markdown.trim();
  if (!text) return { conclusion: "" };

  // 按 ## 级标题切段(容忍 #/###)
  const lines = text.split("\n");
  const sections: Array<{ heading?: string; body: string[] }> = [{ body: [] }];
  for (const line of lines) {
    const m = line.match(/^#{1,3}\s+(.+)$/);
    if (m) {
      sections.push({ heading: m[1], body: [] });
    } else {
      sections[sections.length - 1]!.body.push(line);
    }
  }

  const result: LayeredAnswer = { conclusion: "" };
  const preamble = sections[0]!.body.join("\n").trim();
  let matchedAny = false;

  for (const section of sections.slice(1)) {
    const kind = section.heading ? classifyHeading(section.heading) : undefined;
    const body = section.body.join("\n").trim();
    if (!kind) {
      // 未识别的段落并入结论,避免信息丢失
      if (body) result.conclusion = result.conclusion ? `${result.conclusion}\n\n**${section.heading}**\n${body}` : body;
      continue;
    }
    matchedAny = true;
    if (kind === "conclusion") result.conclusion = result.conclusion ? `${result.conclusion}\n\n${body}` : body;
    if (kind === "evidence") result.evidence = body;
    if (kind === "confidence") {
      result.confidence = body;
      result.confidenceLevel = detectConfidenceLevel(body);
    }
  }

  if (!matchedAny) {
    // 无模板结构:全文即结论
    return { conclusion: text };
  }
  if (preamble) {
    result.conclusion = result.conclusion ? `${preamble}\n\n${result.conclusion}` : preamble;
  }
  return result;
}
