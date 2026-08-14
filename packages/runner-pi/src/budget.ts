export const SYNTHESIS_STEER_MESSAGE =
  "已进入结论收敛预留时间。立即停止新的工具探索，只使用已获得的证据生成最终答案；未确认之处明确标注。";

export function synthesisDelayMs(timeoutMs: number, reserveMs: number): number | undefined {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;
  if (!Number.isFinite(reserveMs) || reserveMs <= 0) return undefined;
  return Math.max(0, timeoutMs - reserveMs);
}

export function startSynthesisReserveTimer(
  timeoutMs: number,
  reserveMs: number,
  onReserve: () => void,
): ReturnType<typeof setTimeout> | undefined {
  const delay = synthesisDelayMs(timeoutMs, reserveMs);
  return delay === undefined ? undefined : setTimeout(onReserve, delay);
}
