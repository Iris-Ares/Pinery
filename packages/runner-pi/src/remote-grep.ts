import { Type } from "typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

/**
 * 远程 grep 工具。
 *
 * 为什么需要它:pi 内置 grep **总是在本地 spawn ripgrep**,注入的
 * GrepOperations 只用于取上下文行(isDirectory / readFile)。远程工作区
 * (CF Computer 等)如果沿用它,rg 会去搜宿主机的本地目录 —— 搜不到、
 * 甚至搜错东西。因此远程后端提供 `grepSearch` 时,用本工具整体替换。
 *
 * 服务端搜索还有额外好处:匹配在远端完成,只回传命中行,不搬运整个仓库。
 */

export interface RemoteGrepMatch {
  /** 相对工作区根的路径 */
  path: string;
  /** 1-based 行号 */
  line: number;
  text: string;
}

export interface RemoteGrepQuery {
  pattern: string;
  /** 搜索起点(相对工作区根);缺省为根 */
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  limit: number;
}

export type RemoteGrepSearch = (query: RemoteGrepQuery) => Promise<RemoteGrepMatch[]>;

const GREP_MAX_LINE = 500;
const DEFAULT_LIMIT = 100;

const schema = Type.Object({
  pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
  path: Type.Optional(Type.String({ description: "Directory or file to search (default: workspace root)" })),
  glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts'" })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
  literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string (default: false)" })),
  limit: Type.Optional(Type.Number({ description: `Maximum matches to return (default: ${DEFAULT_LIMIT})` })),
});

export function createRemoteGrepToolDefinition(search: RemoteGrepSearch): ToolDefinition<typeof schema, unknown> {
  return {
    name: "grep",
    label: "grep",
    description: `Search file contents for a pattern in the remote workspace. Returns matching lines with file paths and line numbers. Output is truncated to ${DEFAULT_LIMIT} matches; long lines are truncated to ${GREP_MAX_LINE} chars.`,
    promptSnippet: "Search file contents for patterns",
    parameters: schema,
    async execute(_toolCallId, params) {
      const limit = Math.max(1, params.limit ?? DEFAULT_LIMIT);
      const matches = await search({
        pattern: params.pattern,
        path: params.path,
        glob: params.glob,
        ignoreCase: params.ignoreCase,
        literal: params.literal,
        limit,
      });

      const shown = matches.slice(0, limit);
      if (shown.length === 0) {
        return { content: [{ type: "text", text: "No matches found." }], details: { matches: 0 } };
      }

      const lines = shown.map((m) => {
        const text = m.text.length > GREP_MAX_LINE ? `${m.text.slice(0, GREP_MAX_LINE)}…` : m.text;
        return `${m.path}:${m.line}: ${text.replace(/\r?\n$/, "")}`;
      });
      if (matches.length > limit) {
        lines.push(`… 结果超过 ${limit} 条已截断,请缩小搜索范围`);
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { matches: shown.length, truncated: matches.length > limit },
      };
    },
  };
}
