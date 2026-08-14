export const SNAPSHOT_VERSION = 2 as const;
export const MAX_SNAPSHOT_CHUNK_BYTES = 8 * 1024 * 1024;

export interface SourceSnapshotManifest {
	version: typeof SNAPSHOT_VERSION;
	repo: string;
	commit: string;
	fileCount: number;
	totalBytes: number;
	createdAt: string;
}

export interface SourceSnapshotChunk {
	key: string;
	size: number;
	sha256: string;
}

export interface SourceSnapshotFileManifest {
	version: typeof SNAPSHOT_VERSION;
	path: string;
	mode: "100644" | "100755";
	size: number;
	oid: string;
	chunks: SourceSnapshotChunk[];
}

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("snapshot manifest must be an object");
	}
	return value as Record<string, unknown>;
}

function safeInteger(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new Error(`${field} must be a non-negative safe integer`);
	}
	return value as number;
}

function safeSnapshotPath(value: unknown): string {
	if (typeof value !== "string" || !value || value.length > 4096) {
		throw new Error("snapshot file path is invalid");
	}
	if (
		value.startsWith("/") ||
		value.endsWith("/") ||
		value.includes("\\") ||
		value.includes("\0") ||
		value.split("/").some((part) => !part || part === "." || part === "..")
	) {
		throw new Error(`snapshot file path is unsafe: ${value}`);
	}
	return value;
}

function safeObjectKey(value: unknown): string {
	if (typeof value !== "string" || !value || value.length > 1024) {
		throw new Error("snapshot chunk key is invalid");
	}
	if (
		value.startsWith("/") ||
		value.endsWith("/") ||
		value.includes("\\") ||
		value.includes("\0") ||
		value.split("/").some((part) => !part || part === "." || part === "..")
	) {
		throw new Error(`snapshot chunk key is unsafe: ${value}`);
	}
	return value;
}

export function parseSourceSnapshotManifest(value: unknown): SourceSnapshotManifest {
	const input = record(value);
	if (input.version !== SNAPSHOT_VERSION) throw new Error(`unsupported snapshot version: ${String(input.version)}`);
	if (typeof input.repo !== "string" || !input.repo) throw new Error("snapshot repo is invalid");
	if (typeof input.commit !== "string" || !/^[0-9a-f]{40,64}$/i.test(input.commit)) {
		throw new Error("snapshot commit is invalid");
	}
	if (typeof input.createdAt !== "string" || !Number.isFinite(Date.parse(input.createdAt))) {
		throw new Error("snapshot createdAt is invalid");
	}
	return {
		version: SNAPSHOT_VERSION,
		repo: input.repo,
		commit: input.commit,
		fileCount: safeInteger(input.fileCount, "snapshot fileCount"),
		totalBytes: safeInteger(input.totalBytes, "snapshot totalBytes"),
		createdAt: input.createdAt,
	};
}

export function parseSourceSnapshotFileManifest(value: unknown): SourceSnapshotFileManifest {
	const input = record(value);
	if (input.version !== SNAPSHOT_VERSION) throw new Error(`unsupported snapshot file version: ${String(input.version)}`);
	const mode = input.mode;
	if (mode !== "100644" && mode !== "100755") throw new Error("snapshot file mode is invalid");
	if (typeof input.oid !== "string" || !/^[0-9a-f]{40,64}$/i.test(input.oid)) {
		throw new Error("snapshot file oid is invalid");
	}
	if (!Array.isArray(input.chunks)) throw new Error("snapshot file chunks are invalid");

	const seen = new Set<string>();
	const chunks = input.chunks.map((value, index): SourceSnapshotChunk => {
		const chunk = record(value);
		const key = safeObjectKey(chunk.key);
		if (seen.has(key)) throw new Error(`snapshot chunk key is duplicated: ${key}`);
		seen.add(key);
		const size = safeInteger(chunk.size, `snapshot chunk ${index} size`);
		if (size < 1 || size > MAX_SNAPSHOT_CHUNK_BYTES) {
			throw new Error(`snapshot chunk ${index} size is outside 1..${MAX_SNAPSHOT_CHUNK_BYTES}`);
		}
		if (typeof chunk.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(chunk.sha256)) {
			throw new Error(`snapshot chunk ${index} sha256 is invalid`);
		}
		return { key, size, sha256: chunk.sha256.toLowerCase() };
	});

	const size = safeInteger(input.size, "snapshot file size");
	if (chunks.reduce((sum, chunk) => sum + chunk.size, 0) !== size) {
		throw new Error("snapshot file size does not equal its chunk sizes");
	}
	if (size === 0 && chunks.length !== 0) throw new Error("empty snapshot file has chunks");
	return {
		version: SNAPSHOT_VERSION,
		path: safeSnapshotPath(input.path),
		mode,
		size,
		oid: input.oid.toLowerCase(),
		chunks,
	};
}

export async function sha256Hex(value: ArrayBuffer | Uint8Array): Promise<string> {
	const input = value instanceof Uint8Array ? value : new Uint8Array(value);
	const digest = await crypto.subtle.digest("SHA-256", input);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface SnapshotChunkBody {
	size: number;
	body: ReadableStream<Uint8Array>;
}

/** Stream one verified chunk at a time so a large file is never buffered whole. */
export function verifiedSnapshotFileStream(
	file: SourceSnapshotFileManifest,
	getChunk: (key: string) => Promise<SnapshotChunkBody | null>,
): ReadableStream<Uint8Array> {
	let index = 0;
	let bytes = 0;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const expected = file.chunks[index];
				if (!expected) {
					if (bytes !== file.size) throw new Error(`snapshot file size mismatch: ${file.path}`);
					controller.close();
					return;
				}
				const object = await getChunk(expected.key);
				if (!object) throw new Error(`snapshot chunk is missing: ${expected.key}`);
				if (object.size !== expected.size) throw new Error(`snapshot chunk size mismatch: ${expected.key}`);
				const chunk = new Uint8Array(await new Response(object.body).arrayBuffer());
				if (chunk.byteLength !== expected.size) throw new Error(`snapshot chunk body is incomplete: ${expected.key}`);
				if ((await sha256Hex(chunk)) !== expected.sha256) {
					throw new Error(`snapshot chunk checksum mismatch: ${expected.key}`);
				}
				bytes += chunk.byteLength;
				index += 1;
				controller.enqueue(chunk);
			} catch (error) {
				controller.error(error);
			}
		},
	});
}
