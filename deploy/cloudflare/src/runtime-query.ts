import { filterSecrets, type RunnerResult } from "@pinery/core";

export const RUNTIME_QUERY_MAX_CHARS = 2_000;
export const RUNTIME_QUERY_MAX_BODY_BYTES = 8_192;

export interface RuntimeQueryInput {
	question: string;
}

export interface RuntimeQuerySummary {
	ok: boolean;
	runnerOk: boolean;
	answer: string;
	turns: number;
	toolCalls: number;
	successfulToolCalls: number;
	toolNames: string[];
	filesTouched: string[];
	durationMs: number;
	usage?: {
		inputTokens: number;
		outputTokens: number;
		costUsd: number;
	};
	aborted?: string;
	error?: string;
}

export function parseRuntimeQueryInput(value: unknown): RuntimeQueryInput {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("请求体必须是包含 question 的 JSON 对象");
	}
	const question = (value as Record<string, unknown>).question;
	if (typeof question !== "string") throw new Error("question 必须是字符串");
	const normalized = question.trim();
	if (!normalized) throw new Error("question 不能为空");
	if (normalized.length > RUNTIME_QUERY_MAX_CHARS) {
		throw new Error(`question 最长 ${RUNTIME_QUERY_MAX_CHARS} 个字符`);
	}
	if (normalized.includes("\0")) throw new Error("question 包含非法空字符");
	return { question: normalized };
}

export function buildRuntimeQueryPrompt(question: string): string {
	return [
		"请只读调查当前工作区中的代码库,回答下面的用户问题。",
		"必须实际使用搜索或读文件工具核对实现;不要修改文件、不要访问网络、不要猜测。",
		"答案使用中文,给出结论、实现调用链,并引用关键文件路径与符号。无法从代码确认的内容要明确标为未确认。",
		"<用户问题>",
		question,
		"</用户问题>",
	].join("\n");
}

export function summarizeRuntimeQuery(
	result: RunnerResult,
	toolNames: string[],
	successfulToolCalls: number,
	durationMs: number,
	answerMaxChars: number,
): RuntimeQuerySummary {
	const answer = filterSecrets(result.answer)
		.text.trim()
		.slice(0, answerMaxChars);
	const safeError = result.error ? filterSecrets(result.error).text : undefined;
	const ok =
		result.ok &&
		!result.aborted &&
		result.toolCalls > 0 &&
		successfulToolCalls > 0 &&
		answer.length > 0;
	return {
		ok,
		runnerOk: result.ok,
		answer,
		turns: result.turns,
		toolCalls: result.toolCalls,
		successfulToolCalls,
		toolNames,
		filesTouched: result.filesTouched,
		durationMs,
		...(result.usage ? { usage: result.usage } : {}),
		...(result.aborted ? { aborted: result.aborted } : {}),
		...(!ok
			? {
					error: safeError ?? "Agent 未完成带至少一次成功工具调用的代码库调查",
				}
			: {}),
	};
}
