import { open, readdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { RemoteToolOperations, RepositoryContextOperations } from "./toolset.js";

const ROOT_INSTRUCTIONS_MAX_BYTES = 96 * 1024;
const SKILL_HEADER_MAX_BYTES = 8 * 1024;
const MAX_NESTED_INSTRUCTIONS = 64;
const MAX_SKILLS = 48;
const LOCAL_SCAN_IGNORES = new Set([".git", "node_modules"]);

export interface RepositorySkillSummary {
	name: string;
	description?: string;
	path: string;
}

export interface RepositoryGuidance {
	rootInstructions?: { content: string; truncated: boolean };
	nestedInstructionPaths: string[];
	skills: RepositorySkillSummary[];
	warnings: string[];
}

interface GuidanceSource {
	readText(
		absolutePath: string,
		maxBytes: number,
	): Promise<{ text: string; truncated: boolean }>;
	find(pattern: string, cwd: string, limit: number): Promise<string[]>;
}

export async function loadRepositoryGuidance(
	workspaceDir: string,
	operations?: RemoteToolOperations,
): Promise<RepositoryGuidance> {
	const root = resolve(workspaceDir);
	const source = operations?.repositoryContext
		? remoteSource(operations.repositoryContext)
		: localSource();
	const warnings: string[] = [];

	const [rootInstructions, foundAgents, foundSkills] = await Promise.all([
		readOptional(source, join(root, "AGENTS.md"), ROOT_INSTRUCTIONS_MAX_BYTES),
		source
			.find("**/AGENTS.md", root, MAX_NESTED_INSTRUCTIONS + 2)
			.catch(() => []),
		source.find(".agents/skills/*/SKILL.md", root, MAX_SKILLS + 1).catch(() => []),
	]);

	const nestedInstructionPaths = normalizePaths(root, foundAgents)
		.filter((path) => path !== "AGENTS.md")
		.sort();
	if (nestedInstructionPaths.length > MAX_NESTED_INSTRUCTIONS) {
		nestedInstructionPaths.length = MAX_NESTED_INSTRUCTIONS;
		warnings.push(
			`嵌套 AGENTS.md 超过 ${MAX_NESTED_INSTRUCTIONS} 个,目录仅展示前 ${MAX_NESTED_INSTRUCTIONS} 个`,
		);
	}

	const skillPaths = normalizePaths(root, foundSkills).slice(0, MAX_SKILLS);
	if (foundSkills.length > MAX_SKILLS) {
		warnings.push(`仓库 Skills 超过 ${MAX_SKILLS} 个,目录仅展示前 ${MAX_SKILLS} 个`);
	}
	const skills = await loadSkillSummaries(source, root, skillPaths);

	if (rootInstructions?.truncated) {
		warnings.push("根 AGENTS.md 超过预加载上限,执行任务前必须用 read 工具继续读到文件末尾");
	}

	return {
		...(rootInstructions
			? {
					rootInstructions: {
						content: rootInstructions.text,
						truncated: rootInstructions.truncated,
					},
				}
			: {}),
		nestedInstructionPaths,
		skills,
		warnings,
	};
}

function remoteSource(operations: RepositoryContextOperations): GuidanceSource {
	return {
		readText: operations.readText,
		find: operations.find,
	};
}

function localSource(): GuidanceSource {
	return {
		readText: readLocalText,
		find: findLocal,
	};
}

async function readLocalText(
	absolutePath: string,
	maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
	const handle = await open(absolutePath, "r");
	try {
		const info = await handle.stat();
		const bytesToRead = Math.min(info.size, maxBytes);
		const buffer = Buffer.alloc(bytesToRead);
		const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
		return {
			text: buffer.subarray(0, bytesRead).toString("utf8"),
			truncated: info.size > bytesRead,
		};
	} finally {
		await handle.close();
	}
}

async function findLocal(
	pattern: string,
	cwd: string,
	limit: number,
): Promise<string[]> {
	if (pattern === ".agents/skills/*/SKILL.md") {
		const root = join(cwd, ".agents", "skills");
		const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(root, entry.name, "SKILL.md"))
			.sort()
			.slice(0, limit);
	}

	if (pattern !== "**/AGENTS.md") return [];
	const found: string[] = [];
	const pending = [cwd];
	while (pending.length > 0 && found.length < limit) {
		const dir = pending.shift();
		if (!dir) break;
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (found.length >= limit) break;
			if (entry.isDirectory()) {
				if (!LOCAL_SCAN_IGNORES.has(entry.name)) pending.push(join(dir, entry.name));
			} else if (entry.isFile() && entry.name === "AGENTS.md") {
				found.push(join(dir, entry.name));
			}
		}
	}
	return found;
}

async function readOptional(
	source: GuidanceSource,
	path: string,
	maxBytes: number,
): Promise<{ text: string; truncated: boolean } | undefined> {
	try {
		return await source.readText(path, maxBytes);
	} catch {
		return undefined;
	}
}

function normalizePaths(root: string, paths: string[]): string[] {
	const unique = new Set<string>();
	for (const path of paths) {
		const absolute = resolve(path.startsWith("/") ? path : join(root, path));
		const rel = relative(root, absolute);
		if (!rel || rel.startsWith("..") || rel.split(sep).includes("..")) {
			if (!rel && basename(absolute) === "AGENTS.md") unique.add("AGENTS.md");
			continue;
		}
		unique.add(rel.split(sep).join("/"));
	}
	return [...unique];
}

async function loadSkillSummaries(
	source: GuidanceSource,
	root: string,
	paths: string[],
): Promise<RepositorySkillSummary[]> {
	const summaries: RepositorySkillSummary[] = [];
	for (let start = 0; start < paths.length; start += 8) {
		const batch = paths.slice(start, start + 8);
		const loaded = await Promise.all(
			batch.map(async (path) => {
				const fallbackName = basename(dirname(path));
				const header = await readOptional(
					source,
					join(root, path),
					SKILL_HEADER_MAX_BYTES,
				);
				const metadata = header ? parseSkillMetadata(header.text) : {};
				return {
					name: metadata.name || fallbackName,
					...(metadata.description ? { description: metadata.description } : {}),
					path,
				};
			}),
		);
		summaries.push(...loaded);
	}
	return summaries.sort((a, b) => a.name.localeCompare(b.name));
}

function parseSkillMetadata(text: string): { name?: string; description?: string } {
	const match = /^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/.exec(text);
	if (!match) return {};
	const lines = match[1]?.split("\n") ?? [];
	return {
		name: yamlScalar(lines, "name"),
		description: yamlScalar(lines, "description"),
	};
}

function yamlScalar(lines: string[], key: string): string | undefined {
	const index = lines.findIndex((line) => line.startsWith(`${key}:`));
	if (index < 0) return undefined;
	const raw = lines[index]!.slice(key.length + 1).trim();
	if (raw === "|" || raw === ">" || raw === "|-" || raw === ">-") {
		const continuation: string[] = [];
		for (let i = index + 1; i < lines.length; i++) {
			const line = lines[i]!;
			if (line && !/^\s/.test(line)) break;
			continuation.push(line.trim());
		}
		return clipMetadata(continuation.join(" "));
	}
	return clipMetadata(raw.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2"));
}

function clipMetadata(input: string): string | undefined {
	const normalized = input.replace(/\s+/g, " ").trim();
	if (!normalized) return undefined;
	return normalized.length > 400 ? `${normalized.slice(0, 397)}...` : normalized;
}
