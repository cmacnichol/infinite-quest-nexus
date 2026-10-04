export interface NativeLongTaskEntry {
  readonly durationMs: number;
  readonly startTime: number;
}

export interface InducedTaskInterval {
  readonly startTime: number;
  readonly endTime: number;
}

export const NATIVE_LONG_TASK_MIN_DURATION_MS = 50;
// Chromium's retained probe differed from the callback marker by about 0.1 ms.
// A one-millisecond allowance covers that timestamp rounding without accepting
// a materially shorter task as covering the induced busy interval.
export const LONG_TASK_TIMESTAMP_RESOLUTION_MS = 1;

export function isQualifyingNativeLongTask(entry: NativeLongTaskEntry): boolean {
  return Number.isFinite(entry.durationMs)
    && entry.durationMs >= NATIVE_LONG_TASK_MIN_DURATION_MS
    && Number.isFinite(entry.startTime)
    && entry.startTime >= 0;
}

export function nativeLongTaskCoversInterval(
  entry: NativeLongTaskEntry,
  interval: InducedTaskInterval,
  timestampResolutionMs = LONG_TASK_TIMESTAMP_RESOLUTION_MS
): boolean {
  if (!isQualifyingNativeLongTask(entry)
    || !Number.isFinite(interval.startTime)
    || !Number.isFinite(interval.endTime)
    || interval.startTime < 0
    || interval.endTime <= interval.startTime
    || !Number.isFinite(timestampResolutionMs)
    || timestampResolutionMs < 0) return false;

  const taskEndTime = entry.startTime + entry.durationMs;
  return entry.startTime <= interval.startTime + timestampResolutionMs
    && entry.startTime >= interval.startTime - timestampResolutionMs
    && taskEndTime >= interval.endTime - timestampResolutionMs;
}
