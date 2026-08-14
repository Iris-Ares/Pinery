import { describe, expect, it } from "vitest";
import {
  MAX_SNAPSHOT_CHUNK_BYTES,
  parseSourceSnapshotFileManifest,
  parseSourceSnapshotManifest,
  sha256Hex,
  verifiedSnapshotFileStream,
  type SourceSnapshotChunk,
} from "./cloudflare/src/source-snapshot.js";

function body(bytes: Uint8Array) {
  return {
    size: bytes.byteLength,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
}

async function descriptor(key: string, bytes: Uint8Array): Promise<SourceSnapshotChunk> {
  return { key, size: bytes.byteLength, sha256: await sha256Hex(bytes) };
}

describe("source snapshot v2", () => {
  it("requires a complete versioned root manifest", () => {
    expect(
      parseSourceSnapshotManifest({
        version: 2,
        repo: "https://github.com/o/r.git",
        commit: "a".repeat(40),
        fileCount: 1,
        totalBytes: 3,
        createdAt: "2026-08-14T00:00:00.000Z",
      }),
    ).toMatchObject({ version: 2, fileCount: 1, totalBytes: 3 });
    expect(() =>
      parseSourceSnapshotManifest({ version: 1 }),
    ).toThrow(/unsupported snapshot version/);
  });

  it("preserves executable mode and rejects incomplete chunk metadata", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const chunk = await descriptor("repo/commit/.pinery/chunks/a/00000000", bytes);
    const file = parseSourceSnapshotFileManifest({
      version: 2,
      path: "scripts/run.sh",
      mode: "100755",
      size: 3,
      oid: "b".repeat(40),
      chunks: [chunk],
    });
    expect(file.mode).toBe("100755");
    expect(() => parseSourceSnapshotFileManifest({ ...file, size: 4 })).toThrow(/chunk sizes/);
  });

  it("streams a file larger than one chunk and verifies each chunk", async () => {
    const first = new Uint8Array(MAX_SNAPSHOT_CHUNK_BYTES);
    first[0] = 7;
    first[first.length - 1] = 9;
    const second = new Uint8Array([10, 11]);
    const chunks = [
      await descriptor("repo/commit/.pinery/chunks/a/00000000", first),
      await descriptor("repo/commit/.pinery/chunks/a/00000001", second),
    ];
    const file = parseSourceSnapshotFileManifest({
      version: 2,
      path: "assets/large.bin",
      mode: "100644",
      size: first.byteLength + second.byteLength,
      oid: "c".repeat(40),
      chunks,
    });
    const objects = new Map([
      [chunks[0]!.key, first],
      [chunks[1]!.key, second],
    ]);
    const output = new Uint8Array(
      await new Response(
        verifiedSnapshotFileStream(file, async (key) => {
          const bytes = objects.get(key);
          return bytes ? body(bytes) : null;
        }),
      ).arrayBuffer(),
    );
    expect(output.byteLength).toBe(MAX_SNAPSHOT_CHUNK_BYTES + 2);
    expect(output[0]).toBe(7);
    expect(output.at(-3)).toBe(9);
    expect([...output.slice(-2)]).toEqual([10, 11]);
  });

  it("fails closed when a chunk is missing or corrupted", async () => {
    const expected = new Uint8Array([1, 2, 3]);
    const chunk = await descriptor("repo/commit/.pinery/chunks/a/00000000", expected);
    const file = parseSourceSnapshotFileManifest({
      version: 2,
      path: "src/index.ts",
      mode: "100644",
      size: 3,
      oid: "d".repeat(40),
      chunks: [chunk],
    });
    await expect(new Response(verifiedSnapshotFileStream(file, async () => null)).arrayBuffer()).rejects.toThrow(
      /missing/,
    );
    await expect(
      new Response(
        verifiedSnapshotFileStream(file, async () => body(new Uint8Array([1, 2, 4]))),
      ).arrayBuffer(),
    ).rejects.toThrow(/checksum mismatch/);
  });
});
