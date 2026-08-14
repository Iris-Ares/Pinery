import {
  BodyTooLargeError,
  InvalidContentLengthError,
  boundedRequestBody,
} from "./bounded-body.js";

const SOURCE_ROUTE = "/v1/source/";
export const MAX_SOURCE_OBJECT_BYTES = 10 * 1024 * 1024;

export function isSourceUploadPath(pathname: string): boolean {
  return pathname.startsWith(SOURCE_ROUTE);
}

export function sourceObjectKey(pathname: string): string | undefined {
  if (!isSourceUploadPath(pathname)) return undefined;
  let key: string;
  try {
    key = decodeURIComponent(pathname.slice(SOURCE_ROUTE.length));
  } catch {
    return undefined;
  }
  if (
    !key ||
    key.length > 1024 ||
    key.startsWith("/") ||
    key.endsWith("/") ||
    key.includes("\\") ||
    key.includes("\0")
  ) {
    return undefined;
  }
  if (key.split("/").some((part) => !part || part === "." || part === "..")) return undefined;
  return key;
}

function response(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

export async function handleSourceUpload(request: Request, bucket: R2Bucket): Promise<Response> {
  const key = sourceObjectKey(new URL(request.url).pathname);
  if (!key) return response({ ok: false, error: "非法的 source object key" }, 400);

  let body: ReadableStream<Uint8Array> | null;
  try {
    body = boundedRequestBody(request, MAX_SOURCE_OBJECT_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return response({ ok: false, error: `单个 source object 不得超过 ${MAX_SOURCE_OBJECT_BYTES} bytes` }, 413);
    }
    if (error instanceof InvalidContentLengthError) {
      return response({ ok: false, error: "Content-Length 必须是非负整数" }, 400);
    }
    throw error;
  }
  if (!body) return response({ ok: false, error: "缺少文件内容" }, 400);

  const contentType = request.headers.get("content-type") ?? "application/octet-stream";
  try {
    const object = await bucket.put(key, body, { httpMetadata: { contentType } });
    return response({ ok: true, key, size: object?.size ?? null }, 200);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return response({ ok: false, error: `单个 source object 不得超过 ${MAX_SOURCE_OBJECT_BYTES} bytes` }, 413);
    }
    throw error;
  }
}
