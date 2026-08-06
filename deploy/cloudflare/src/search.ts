import type { WireGrepMatch, WireRequest } from "@pinery/workspace-cf-computer/protocol";

/**
 * Search primitives for the Worker, kept free of `cloudflare:workers` imports so
 * they can be unit-tested outside the Workers runtime.
 *
 * Computer's VFS grep is substring-only (`text.includes(needle)`). That happens
 * to implement the grep tool's `literal: true` mode exactly, and cannot
 * implement the regex mode the tool offers by default — so regex is evaluated
 * here, over the same VFS.
 */

/** Bounds on the regex scan (the VFS grep streams; this reads whole files). */
export const GREP_MAX_FILES = 2_000;
export const GREP_MAX_BYTES_PER_FILE = 1_000_000;

/** Minimal shape of the workspace filesystem used by the regex scan. */
export interface GrepFilesystem {
  stat: (path: string) => Promise<{ isFile: boolean }>;
  find: (directory: string, pattern?: string) => Promise<Array<{ path: string; type: "file" | "dir" }>>;
  readFile: (path: string, encoding: "utf8") => Promise<string>;
}

export class InvalidPatternError extends Error {}

/** Minimal glob: supports `*.ext` and `**​/*.ext` (grep's file filter). */
export function matchGlob(path: string, glob: string): boolean {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, " ")
    .replace(/\*/g, "[^/]*")
    .replace(/ /g, ".*");
  return new RegExp(`(^|/)${escaped}$`).test(path);
}

/**
 * Regex mode for the grep tool. Delegating a regex to the VFS grep would
 * silently return literal-match results, making the tool's documented default
 * mode wrong on this backend.
 */
export async function regexGrep(
  fs: GrepFilesystem,
  root: string,
  req: Pick<Extract<WireRequest, { op: "grep" }>, "pattern" | "glob" | "ignoreCase" | "limit">,
): Promise<WireGrepMatch[]> {
  let re: RegExp;
  try {
    re = new RegExp(req.pattern, req.ignoreCase ? "i" : "");
  } catch (e) {
    throw new InvalidPatternError((e as Error).message);
  }

  const limit = req.limit ?? 100;
  const stat = await fs.stat(root).catch(() => undefined);
  const files = stat?.isFile ? [root] : (await fs.find(root)).filter((e) => e.type === "file").map((e) => e.path);
  // Filter by glob before reading, not after matching
  const candidates = (req.glob ? files.filter((p) => matchGlob(p, req.glob as string)) : files).slice(
    0,
    GREP_MAX_FILES,
  );

  const out: WireGrepMatch[] = [];
  for (const path of candidates) {
    let content: string;
    try {
      content = await fs.readFile(path, "utf8");
    } catch {
      continue; // unreadable or binary — skip, as ripgrep would
    }
    if (content.length > GREP_MAX_BYTES_PER_FILE) content = content.slice(0, GREP_MAX_BYTES_PER_FILE);
    let line = 0;
    for (const text of content.split("\n")) {
      line += 1;
      if (re.test(text)) {
        out.push({ path, line, text });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}
