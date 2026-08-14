import type { RunnerResult } from "@pinery/core";
import { describe, expect, it } from "vitest";
import {
	buildRuntimeQueryPrompt,
	parseRuntimeQueryInput,
	summarizeRuntimeQuery,
} from "./cloudflare/src/runtime-query.js";
import { summarizeRuntimeSmoke } from "./cloudflare/src/runtime-smoke.js";

const commit = "0123456789abcdef0123456789abcdef01234567";

function result(overrides: Partial<RunnerResult> = {}): RunnerResult {
	return {
		ok: true,
		answer: `PINERY_SMOKE commit=${commit}`,
		turns: 2,
		toolCalls: 1,
		filesTouched: ["/workspace/.pinery-snapshot.json"],
		...overrides,
	};
}

describe("summarizeRuntimeSmoke", () => {
	it("passes only when the real read result contains the expected commit", () => {
		expect(
			summarizeRuntimeSmoke(result(), commit, ["read"], 1200),
		).toMatchObject({
			ok: true,
			runnerOk: true,
			expectedCommit: commit,
			observedCommit: commit,
			readManifest: true,
			toolCalls: 1,
			toolNames: ["read"],
		});
	});

	it("rejects a model-only answer that did not read the manifest", () => {
		expect(
			summarizeRuntimeSmoke(
				result({ toolCalls: 0, filesTouched: [] }),
				commit,
				[],
				50,
			),
		).toMatchObject({
			ok: false,
			readManifest: false,
		});
	});

	it("rejects a different commit even after a tool call", () => {
		const other = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		expect(
			summarizeRuntimeSmoke(
				result({ answer: `PINERY_SMOKE commit=${other}` }),
				commit,
				["read"],
				80,
			),
		).toMatchObject({
			ok: false,
			observedCommit: other,
		});
	});
});

describe("runtime query", () => {
	it("normalizes a bounded question and wraps it in the read-only contract", () => {
		const input = parseRuntimeQueryInput({
			question: "  请求如何通过适配器处理?  ",
		});
		expect(input).toEqual({ question: "请求如何通过适配器处理?" });
		expect(buildRuntimeQueryPrompt(input.question)).toContain(
			"必须实际使用搜索或读文件工具",
		);
	});

	it.each([
		[null],
		[[]],
		[{}],
		[{ question: "" }],
		[{ question: "x".repeat(2_001) }],
		[{ question: "bad\0question" }],
	])("rejects invalid input %#", (input) => {
		expect(() => parseRuntimeQueryInput(input)).toThrow();
	});

	it("requires a real tool call before accepting an answer", () => {
		expect(
			summarizeRuntimeQuery(
				result({ answer: "实现位于 src/adapter.ts。", toolCalls: 1 }),
				["grep"],
				1,
				900,
				10_000,
			),
		).toMatchObject({
			ok: true,
			runnerOk: true,
			toolCalls: 1,
			successfulToolCalls: 1,
			toolNames: ["grep"],
		});

		expect(
			summarizeRuntimeQuery(
				result({ answer: "凭记忆回答", toolCalls: 0 }),
				[],
				0,
				20,
				10_000,
			),
		).toMatchObject({ ok: false, toolCalls: 0 });

		expect(
			summarizeRuntimeQuery(
				result({ answer: "工具都失败了", toolCalls: 3 }),
				["read", "grep", "find"],
				0,
				100,
				10_000,
			),
		).toMatchObject({
			ok: false,
			toolCalls: 3,
			successfulToolCalls: 0,
		});
	});
});
