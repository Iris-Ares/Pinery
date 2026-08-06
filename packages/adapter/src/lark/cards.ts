import type { ConfidenceLevel, LayeredAnswer } from "@pinery/core";

/**
 * 飞书卡片构建(schema 2.0)。分层答案卡片(PRD §2.1 场景 A):
 * 结论 / 可折叠依据 / 置信度与边界,外加可点验元信息 footer。
 *
 * 所有传入文本必须已过 secret 过滤——卡片层不再兜底。
 */

type CardElement = Record<string, unknown>;

export interface Card {
  schema: "2.0";
  config: { update_multi: boolean };
  header: { title: { tag: "plain_text"; content: string }; template: string };
  body: { direction: "vertical"; elements: CardElement[] };
}

function md(content: string): CardElement {
  return { tag: "markdown", content };
}

function hr(): CardElement {
  return { tag: "hr" };
}

function collapsible(title: string, content: string, expanded: boolean): CardElement {
  return {
    tag: "collapsible_panel",
    expanded,
    header: { title: { tag: "markdown", content: title } },
    elements: [md(content)],
  };
}

function baseCard(title: string, template: string, elements: CardElement[]): Card {
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: title }, template },
    body: { direction: "vertical", elements },
  };
}

export function cardJson(card: Card): string {
  return JSON.stringify(card);
}

// ---------------------------------------------------------------------------

export interface ProgressState {
  title?: string;
  /** 最近的工具活动行(已截断/脱敏) */
  lines: string[];
  elapsedSec: number;
  turns?: number;
}

const TOOL_ICONS: Record<string, string> = {
  bash: "⌘",
  read: "📄",
  grep: "🔎",
  find: "🗂",
  ls: "🗂",
  edit: "✏️",
  write: "✏️",
  policy: "🛡",
};

export function toolLine(tool: string, detail: string): string {
  const icon = TOOL_ICONS[tool] ?? "·";
  return `${icon} \`${tool}\` ${detail}`;
}

export function progressCard(state: ProgressState): Card {
  const shown = state.lines.slice(-6);
  const body: CardElement[] = [];
  if (shown.length > 0) {
    body.push(md(shown.join("\n")));
  } else {
    body.push(md("正在理解问题、定位相关模块…"));
  }
  body.push(
    md(
      `<font color='grey'>已进行 ${state.elapsedSec}s${state.turns ? ` · 第 ${state.turns} 轮` : ""}</font>`,
    ),
  );
  return baseCard(state.title ?? "🔍 调查中", "blue", body);
}

// ---------------------------------------------------------------------------

export interface AnswerMeta {
  repo: string;
  headShort?: string;
  durationMs: number;
  turns: number;
  model?: string;
  costUsd?: number;
  redacted?: boolean;
  truncated?: boolean;
}

const CONFIDENCE_TEMPLATE: Record<ConfidenceLevel, string> = {
  high: "green",
  medium: "yellow",
  low: "orange",
};

export function answerCard(question: string, answer: LayeredAnswer, meta: AnswerMeta): Card {
  const template = answer.confidenceLevel ? CONFIDENCE_TEMPLATE[answer.confidenceLevel] : "blue";
  const elements: CardElement[] = [];

  elements.push(md(answer.conclusion || "(无结论输出)"));

  if (answer.evidence) {
    elements.push(collapsible("**📎 依据(点验入口)**", answer.evidence, false));
  }
  if (answer.confidence) {
    elements.push(md(`**置信度与边界** ${answer.confidence}`));
  }

  const metaBits = [
    `repo:${meta.repo}${meta.headShort ? `@${meta.headShort}` : ""}`,
    `${Math.round(meta.durationMs / 1000)}s`,
    `${meta.turns} 轮`,
  ];
  if (meta.model) metaBits.push(meta.model);
  if (meta.costUsd !== undefined && meta.costUsd > 0) metaBits.push(`$${meta.costUsd.toFixed(4)}`);
  if (meta.redacted) metaBits.push("⚠️ 输出含敏感内容已脱敏");
  if (meta.truncated) metaBits.push("已截断");

  elements.push(hr());
  elements.push(md(`<font color='grey'>${metaBits.join(" · ")}</font>`));

  const title = question.length > 40 ? `${question.slice(0, 37)}…` : question;
  return baseCard(`✅ ${title}`, template, elements);
}

// ---------------------------------------------------------------------------

export function errorCard(message: string, hint?: string): Card {
  const elements: CardElement[] = [md(message)];
  if (hint) elements.push(md(`<font color='grey'>${hint}</font>`));
  return baseCard("❌ 调查失败", "red", elements);
}

export function timeoutCard(minutes: number): Card {
  return baseCard("⏱ 已超时停止", "orange", [
    md(`调查超过 ${minutes} 分钟被停止。可以把问题拆小一点再问一次。`),
  ]);
}

export function deniedCard(reason: string): Card {
  return baseCard("🔒 没有权限", "grey", [md(reason)]);
}

export function helpCard(info: { repo?: string; levelName?: string }): Card {
  const lines = [
    "**我是 Pinery,长在飞书里的工程同事。**",
    "",
    "- 直接提问,例如:「下单超时会自动退款吗?」",
    "- 群里 @ 我提问,回复会收敛到话题;话题内追问无需再 @",
    "- `status` 查看当前仓库与会话状态",
    "",
    info.repo ? `当前仓库:\`${info.repo}\`${info.levelName ? " · 你的级别:" + info.levelName : ""}` : "当前会话未绑定仓库,请联系管理员在 pinery.yaml 登记本群。",
  ];
  return baseCard("🌲 Pinery", "turquoise", [md(lines.join("\n"))]);
}

export interface StatusInfo {
  repo: string;
  headShort?: string;
  headTime?: string;
  model: string;
  sessionTurns?: number;
  sessionState?: string;
  queueLength: number;
}

export function statusCard(info: StatusInfo): Card {
  const lines = [
    `**仓库** \`${info.repo}\`${info.headShort ? ` @ \`${info.headShort}\`${info.headTime ? `(${info.headTime})` : ""}` : ""}`,
    `**模型** ${info.model}`,
    `**会话** ${info.sessionState === "active" ? `进行中,已 ${info.sessionTurns ?? 0} 轮` : "无活跃会话"}`,
    `**队列** ${info.queueLength} 个任务排队中`,
  ];
  return baseCard("📊 状态", "blue", [md(lines.join("\n"))]);
}
