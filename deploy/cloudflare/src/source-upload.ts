const SOURCE_ROUTE = "/v1/source/";
const MAX_SOURCE_OBJECT_BYTES = 10 * 1024 * 1024;

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

  const contentLength = request.headers.get("content-length");
  const size = contentLength === null ? undefined : Number(contentLength);
  if (size !== undefined && (!Number.isSafeInteger(size) || size < 0 || size > MAX_SOURCE_OBJECT_BYTES)) {
    return response({ ok: false, error: `单文件不得超过 ${MAX_SOURCE_OBJECT_BYTES} bytes` }, 413);
  }
  if (!request.body) return response({ ok: false, error: "缺少文件内容" }, 400);

  const contentType = request.headers.get("content-type") ?? "application/octet-stream";
  const object = await bucket.put(key, request.body, { httpMetadata: { contentType } });
  return response({ ok: true, key, size: object?.size ?? size ?? null }, 200);
}
