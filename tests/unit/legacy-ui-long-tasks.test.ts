import { describe, expect, it } from "vitest";
import {
  isQualifyingNativeLongTask,
  nativeLongTaskCoversInterval
} from "../e2e/helpers/legacy-ui-long-tasks.js";

describe("legacy UI native long-task evidence", () => {
  it("matches a real task whose start precedes the callback marker within timestamp resolution", () => {
    const entry = { startTime: 3.5, durationMs: 70 };
    const interval = { startTime: 3.6, endTime: 73.6 };

    expect(isQualifyingNativeLongTask(entry)).toBe(true);
    expect(nativeLongTaskCoversInterval(entry, interval)).toBe(true);
  });

  it("rejects short tasks, unrelated intervals, and invalid timings", () => {
    const interval = { startTime: 100, endTime: 170 };

    expect(nativeLongTaskCoversInterval({ startTime: 100, durationMs: 49 }, interval)).toBe(false);
    expect(nativeLongTaskCoversInterval({ startTime: 20, durationMs: 70 }, interval)).toBe(false);
    expect(nativeLongTaskCoversInterval({ startTime: 100, durationMs: 55 }, interval)).toBe(false);
    expect(nativeLongTaskCoversInterval({ startTime: Number.NaN, durationMs: 70 }, interval)).toBe(false);
    expect(nativeLongTaskCoversInterval({ startTime: 100, durationMs: 70 }, { startTime: 170, endTime: 169 })).toBe(false);
  });
});
