#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

interface Args {
  endpoint: string;
  repo: string;
  prefix: string;
  repoUrl: string;
  workspace: string;
  concurrency: number;
  skipUpload: boolean;
}

interface TrackedFile {
  mode: string;
  path: string;
  size: number;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function usage(): never {
  fail(
    "usage: bun run source:upload -- --endpoint <worker-url> --repo <clean-worktree> " +
      "--prefix <repo/commit> --repo-url <https-url> --workspace <s-shared-id> " +
      "[--concurrency 12] [--skip-upload]; PINERY_TOKEN must be set",
  );
}

function parseArgs(argv: string[]): Args {
  const value = (name: string): string => {
    const index = argv.indexOf(`--${name}`);
    const result = index >= 0 ? argv[index + 1] : undefined;
    if (!result) usage();
    return result;
  };
  const endpoint = value("endpoint").replace(/\/+$/, "");
  const repo = resolve(value("repo"));
  const rawPrefix = value("prefix").replace(/^\/+|\/+$/g, "");
  const repoUrl = value("repo-url");
  const workspace = value("workspace");
  const concurrencyValue = argv.includes("--concurrency") ? value("concurrency") : "12";
  const concurrency = Number(concurrencyValue);

  if (!/^https:\/\//.test(endpoint)) fail("--endpoint must use https://");
  if (!rawPrefix || rawPrefix.split("/").some((part) => part === "." || part === "..")) fail("invalid --prefix");
  const parsedRepoUrl = new URL(repoUrl);
  if (parsedRepoUrl.protocol !== "https:" || parsedRepoUrl.username || parsedRepoUrl.password) {
    fail("--repo-url must be a credential-free https:// URL");
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    fail("--concurrency must be an integer between 1 and 32");
  }
  if (!/^s-[A-Za-z0-9._-]{1,126}$/.test(workspace)) fail("--workspace must be a safe id starting with s-");
  return { endpoint, repo, prefix: `${rawPrefix}/`, repoUrl, workspace, concurrency, skipUpload: argv.includes("--skip-upload") };
}

function git(repo: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) fail(result.stderr.trim() || `git ${args.join(" ")} failed`);
  return result.stdout;
}

function trackedFiles(repo: string): TrackedFile[] {
  const records = git(repo, ["ls-tree", "-rz", "-l", "--full-tree", "HEAD"]).split("\0").filter(Boolean);
  return records.map((record) => {
    const tab = record.indexOf("\t");
    if (tab < 0) fail(`unexpected git ls-tree record: ${record.slice(0, 120)}`);
    const metadata = record.slice(0, tab).split(/\s+/);
    const mode = metadata[0];
    const type = metadata[1];
    const size = Number(metadata[3]);
    const path = record.slice(tab + 1);
    if (!mode || type !== "blob" || !Number.isSafeInteger(size) || size < 0 || !path) {
      fail(`unsupported git entry: ${record.slice(0, 120)}`);
    }
    if (mode !== "100644" && mode !== "100755") fail(`unsupported git mode ${mode}: ${path}`);
    return { mode, path, size };
  });
}

async function upload(endpoint: string, token: string, key: string, body: Uint8Array): Promise<void> {
  const encodedKey = encodeURIComponent(key);
  for (let attempt = 1; attempt <= 4; attempt++) {
    const result = await fetch(`${endpoint}/v1/source/${encodedKey}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-length": String(body.byteLength),
        "content-type": "application/octet-stream",
      },
      body,
    });
    if (result.ok) return;
    const detail = (await result.text()).slice(0, 500);
    const retryable = result.status === 401 || result.status === 429 || result.status >= 500;
    if (attempt === 4 || !retryable) {
      fail(`upload ${key} failed: HTTP ${result.status} ${detail}`);
    }
    await new Promise((done) => setTimeout(done, 500 * 2 ** (attempt - 1)));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function hydrate(args: Args, token: string): Promise<void> {
  let cursor: string | undefined;
  let batches = 0;
  let objects = 0;
  let bytes = 0;
  for (;;) {
    let response: Response | undefined;
    for (let attempt = 1; attempt <= 4; attempt++) {
      response = await fetch(`${args.endpoint}/v1/source/hydrate/${encodeURIComponent(args.workspace)}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ ...(cursor ? { cursor } : {}), limit: 100, ref: "main" }),
      });
      if (response.ok) break;
      const retryable = response.status === 401 || response.status === 429 || response.status >= 500;
      if (attempt === 4 || !retryable) fail(`hydrate failed: HTTP ${response.status} ${(await response.text()).slice(0, 500)}`);
      await response.body?.cancel();
      await new Promise((done) => setTimeout(done, 500 * 2 ** (attempt - 1)));
    }
    if (!response?.ok) fail("hydrate failed without a response");

    const payload: unknown = await response.json();
    if (!isRecord(payload) || payload.ok !== true || !isRecord(payload.result)) fail("hydrate returned an invalid response");
    const result = payload.result;
    if (
      typeof result.done !== "boolean" ||
      typeof result.objects !== "number" ||
      typeof result.bytes !== "number" ||
      (result.cursor !== undefined && typeof result.cursor !== "string")
    ) {
      fail("hydrate result has an invalid shape");
    }
    batches += 1;
    objects += result.objects;
    bytes += result.bytes;
    console.log(`Hydrated batch ${batches}: ${objects} objects, ${bytes} bytes`);
    if (result.done) return;
    if (!result.cursor) fail("hydrate response is truncated but has no cursor");
    cursor = result.cursor;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.PINERY_TOKEN;
  if (!token) fail("PINERY_TOKEN is required");

  if (git(args.repo, ["status", "--porcelain=v1", "--untracked-files=no"]).trim()) {
    fail("source worktree has tracked changes; commit or use a clean checkout before snapshotting");
  }
  const commit = git(args.repo, ["rev-parse", "HEAD"]).trim();
  const files = trackedFiles(args.repo);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  let next = 0;
  let completed = 0;

  if (!args.skipUpload) {
    console.log(`Uploading ${files.length} tracked files (${totalBytes} bytes) from ${commit}`);
    const workers = Array.from({ length: Math.min(args.concurrency, files.length) }, async () => {
      while (true) {
        const index = next++;
        const file = files[index];
        if (!file) return;
        const absolutePath = resolve(args.repo, file.path);
        if (absolutePath !== args.repo && !absolutePath.startsWith(`${args.repo}/`)) fail(`path escaped repo: ${file.path}`);
        const content = await readFile(absolutePath);
        if (content.byteLength !== file.size) fail(`size changed while reading ${file.path}`);
        await upload(args.endpoint, token, `${args.prefix}${file.path}`, content);
        completed += 1;
        if (completed % 100 === 0 || completed === files.length) console.log(`Uploaded ${completed}/${files.length}`);
      }
    });
    await Promise.all(workers);

    const manifest = new TextEncoder().encode(
      `${JSON.stringify(
        {
          version: 1,
          repo: args.repoUrl,
          commit,
          fileCount: files.length,
          totalBytes,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
    await upload(args.endpoint, token, `${args.prefix}.pinery-snapshot.json`, manifest);
    console.log(`Snapshot ready: ${args.prefix} (${commit})`);
  } else {
    console.log(`Reusing uploaded snapshot: ${args.prefix} (${commit})`);
  }

  await hydrate(args, token);
  console.log(`Workspace hydrated: ${args.workspace}`);
}

void main();
