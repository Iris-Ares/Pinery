export class BodyTooLargeError extends Error {
	constructor(readonly maxBytes: number) {
		super(`request body exceeds ${maxBytes} bytes`);
		this.name = "BodyTooLargeError";
	}
}

export class InvalidContentLengthError extends Error {
	constructor() {
		super("Content-Length must be a non-negative integer");
		this.name = "InvalidContentLengthError";
	}
}

/**
 * Reject an obviously oversized request before consuming it, then enforce the
 * same limit while streaming. Content-Length is only a hint and is never trusted
 * as the actual byte count.
 */
export function boundedRequestBody(request: Request, maxBytes: number): ReadableStream<Uint8Array> | null {
	const rawLength = request.headers.get("content-length");
	if (rawLength !== null) {
		if (!/^\d+$/.test(rawLength)) throw new InvalidContentLengthError();
		const declared = Number(rawLength);
		if (!Number.isSafeInteger(declared)) throw new InvalidContentLengthError();
		if (declared > maxBytes) throw new BodyTooLargeError(maxBytes);
	}
	if (!request.body) return null;

	const reader = request.body.getReader();
	let bytesRead = 0;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = await reader.read();
				if (next.done) {
					controller.close();
					return;
				}
				bytesRead += next.value.byteLength;
				if (bytesRead > maxBytes) {
					await reader.cancel("request body limit exceeded").catch(() => undefined);
					controller.error(new BodyTooLargeError(maxBytes));
					return;
				}
				controller.enqueue(next.value);
			} catch (error) {
				controller.error(error);
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
}

export async function readBoundedRequestText(request: Request, maxBytes: number): Promise<string> {
	const body = boundedRequestBody(request, maxBytes);
	if (!body) return "";
	return new Response(body).text();
}
