import { afterEach, describe, expect, it, vi } from "vitest";
import { startSynthesisReserveTimer, synthesisDelayMs } from "../src/budget.js";

afterEach(() => vi.useRealTimers());

describe("synthesis reserve", () => {
  it("starts before the hard timeout and can be disabled", () => {
    expect(synthesisDelayMs(120_000, 30_000)).toBe(90_000);
    expect(synthesisDelayMs(10_000, 30_000)).toBe(0);
    expect(synthesisDelayMs(10_000, 0)).toBeUndefined();
  });

  it("fires at the soft deadline without aborting the hard timer", () => {
    vi.useFakeTimers();
    const onReserve = vi.fn();
    const timer = startSynthesisReserveTimer(1_000, 250, onReserve);
    vi.advanceTimersByTime(749);
    expect(onReserve).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onReserve).toHaveBeenCalledOnce();
    if (timer) clearTimeout(timer);
  });
});
