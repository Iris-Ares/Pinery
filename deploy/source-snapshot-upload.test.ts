import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  trackedFiles,
  uploadGitBlob,
  type Args,
} from "../scripts/upload-source-snapshot.js";

function git(repo: string, ...args: string[]): void {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

describe("source snapshot uploader", () => {
  it("reads committed Git blobs, chunks large files and preserves executable mode", async () => {
    const repo = mkdtempSync(join(tmpdir(), "pinery-source-upload-"));
    git(repo, "init", "-q");
    const large = new Uint8Array(12 * 1024 * 1024 + 2);
    large[0] = 1;
    large[large.length - 1] = 2;
    const path = join(repo, "run.bin");
    writeFileSync(path, large);
    chmodSync(path, 0o755);
    git(repo, "add", "run.bin");
    git(
      repo,
      "-c",
      "user.name=Pinery Test",
      "-c",
      "user.email=pinery@example.test",
      "commit",
      "-qm",
      "fixture",
    );

    const file = trackedFiles(repo).find((entry) => entry.path === "run.bin")!;
    expect(file.mode).toBe("100755");
    // The uploader must follow the committed blob OID, not a smudged or changed
    // working-tree file at the same path.
    writeFileSync(path, new Uint8Array([99]));
    const uploaded = new Map<string, Uint8Array>();
    const args: Args = {
      endpoint: "https://pinery.test",
      repo,
      prefix: "repo/commit/",
      repoUrl: "https://github.com/o/r.git",
      workspace: "s-test",
      concurrency: 1,
      skipUpload: false,
    };
    const manifest = await uploadGitBlob(
      args,
      "token",
      file,
      async (_endpoint, _token, key, body) => {
        uploaded.set(key, body.slice());
      },
    );
    expect(manifest.mode).toBe("100755");
    expect(manifest.chunks).toHaveLength(2);
    expect(manifest.chunks.map((chunk) => chunk.size)).toEqual([
      8 * 1024 * 1024,
      4 * 1024 * 1024 + 2,
    ]);
    const first = uploaded.get(manifest.chunks[0]!.key)!;
    const second = uploaded.get(manifest.chunks[1]!.key)!;
    expect(first[0]).toBe(1);
    expect(second.byteLength).toBe(4 * 1024 * 1024 + 2);
    expect(second[0]).toBe(0);
    expect(second.at(-1)).toBe(2);
  });
});
