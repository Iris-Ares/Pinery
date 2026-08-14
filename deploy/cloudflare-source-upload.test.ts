import { describe, expect, it } from "vitest";
import {
  handleSourceUpload,
  MAX_SOURCE_OBJECT_BYTES,
  sourceObjectKey,
} from "./cloudflare/src/source-upload.js";

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function uploadRequest(body: ReadableStream<Uint8Array>, contentLength?: string): Request {
  return new Request("https://pinery.test/v1/source/repo%2Fcommit%2Fobject", {
    method: "PUT",
    headers: contentLength === undefined ? {} : { "content-length": contentLength },
    body,
    // Node requires duplex for a streaming request body; Workers ignores it.
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function recordingBucket() {
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    async put(key: string, value: ReadableStream<Uint8Array>) {
      const bytes = new Uint8Array(await new Response(value).arrayBuffer());
      objects.set(key, bytes);
      return { size: bytes.byteLength };
    },
  } as unknown as R2Bucket;
  return { bucket, objects };
}

describe("sourceObjectKey", () => {
  it("accepts an encoded snapshot object key", () => {
    expect(sourceObjectKey("/v1/source/example%2Fabc123%2Fsrc%2Fmain.ts")).toBe(
      "example/abc123/src/main.ts",
    );
  });

  it("rejects traversal and ambiguous separators", () => {
    expect(sourceObjectKey("/v1/source/example%2F..%2Fsecret")).toBeUndefined();
    expect(sourceObjectKey("/v1/source/example%2Fabc%5Csecret")).toBeUndefined();
    expect(sourceObjectKey("/v1/source/example//README.md")).toBeUndefined();
  });

  it("rejects malformed or missing keys", () => {
    expect(sourceObjectKey("/v1/source/%E0%A4%A")).toBeUndefined();
    expect(sourceObjectKey("/v1/source/")).toBeUndefined();
    expect(sourceObjectKey("/health")).toBeUndefined();
  });
});

describe("handleSourceUpload request limits", () => {
  it("streams a request without Content-Length and stores it", async () => {
    const { bucket, objects } = recordingBucket();
    const response = await handleSourceUpload(
      uploadRequest(streamOf(new TextEncoder().encode("hello"))),
      bucket,
    );
    expect(response.status).toBe(200);
    expect(objects.get("repo/commit/object")).toEqual(new TextEncoder().encode("hello"));
  });

  it("rejects malformed Content-Length", async () => {
    const { bucket, objects } = recordingBucket();
    const response = await handleSourceUpload(uploadRequest(streamOf(new Uint8Array([1])), "1x"), bucket);
    expect(response.status).toBe(400);
    expect(objects.size).toBe(0);
  });

  it("rejects a declared oversized body before storage", async () => {
    const { bucket, objects } = recordingBucket();
    const response = await handleSourceUpload(
      uploadRequest(streamOf(new Uint8Array([1])), String(MAX_SOURCE_OBJECT_BYTES + 1)),
      bucket,
    );
    expect(response.status).toBe(413);
    expect(objects.size).toBe(0);
  });

  it("counts streamed bytes and rejects an understated oversized body atomically", async () => {
    const { bucket, objects } = recordingBucket();
    const response = await handleSourceUpload(
      uploadRequest(
        streamOf(new Uint8Array(MAX_SOURCE_OBJECT_BYTES), new Uint8Array([1])),
        "1",
      ),
      bucket,
    );
    expect(response.status).toBe(413);
    expect(objects.size).toBe(0);
  });
});
