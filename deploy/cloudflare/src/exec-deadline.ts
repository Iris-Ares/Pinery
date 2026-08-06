/**
 * Server-side execution deadline, kept free of `cloudflare:workers` imports so
 * it can be unit-tested outside the Workers runtime.
 *
 * The client's timeoutMs is a request, not a guarantee. Without a server-side
 * bound, a non-terminating command (`tail -f`) keeps running after the adapter
 * aborts its HTTP request — the wait ends, the remote process does not.
 */

export const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
export const MAX_EXEC_TIMEOUT_MS = 300_000;

/** Clamp the requested timeout: an absent one still gets a bound, a huge one is capped. */
export function execDeadline(requested: number | undefined): number {
  const wanted = requested && requested > 0 ? requested : DEFAULT_EXEC_TIMEOUT_MS;
  return Math.min(wanted, MAX_EXEC_TIMEOUT_MS);
}

export interface ExecRun {
  result(): Promise<{ stdout?: string; stderr?: string; exitCode?: number | null }>;
  kill(signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP"): Promise<void>;
}

/**
 * Await a run, killing it when the deadline passes. This backs up the runtime's
 * own timeoutMs: a backend that ignores the option must not turn into an
 * unbounded await, and an expired run must be terminated rather than abandoned.
 */
export async function withDeadline(
  run: ExecRun,
  timeoutMs: number,
  onTimeout: (ms: number) => Error,
): Promise<Awaited<ReturnType<ExecRun["result"]>>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([run.result(), expiry]);
  } catch (e) {
    await run.kill("SIGKILL").catch(() => {});
    throw e;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
