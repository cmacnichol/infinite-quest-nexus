/**
 * Reserves the newest whole suffix of a chronological source using the exact
 * serializer cost supplied by its caller. The caller owns the envelope: this
 * seam deliberately works for intent, deferred retrieval, and fact records.
 *
 * The serializer is monotone for an append-only JSON array and its enclosing
 * request/manifest: prepending another complete record cannot remove bytes
 * already emitted for the newer suffix. A binary search therefore preserves
 * the same suffix as exhaustive newest-first selection while bounding exact
 * writer/reviewer trials to ceil(log2(n)) plus boundary checks.
 */
export type ExactSuffixReservation<Entry> = Readonly<{
  entries: readonly Entry[];
  trialCount: number;
  elapsedMilliseconds: number;
  measuredTokens: number | null;
  firstOmittedEntry: Entry | null;
}>;

export function reserveNewestWholeSuffix<Entry>(input: Readonly<{
  entries: readonly Entry[];
  budgetTokens: number;
  measureTokens: (entries: readonly Entry[]) => number;
}>): ExactSuffixReservation<Entry> {
  const entries = [...input.entries];
  if (!Number.isFinite(input.budgetTokens) || input.budgetTokens < 0) {
    throw new Error("Exact suffix reservation requires a nonnegative finite budget.");
  }
  const started = performance.now();
  const measured = new Map<number, number>();
  const costAt = (start: number): number => {
    const cached = measured.get(start);
    if (cached !== undefined) return cached;
    const cost = input.measureTokens(entries.slice(start));
    if (!(Number.isFinite(cost) || cost === Number.POSITIVE_INFINITY) || cost < 0) {
      throw new Error("Exact suffix reservation requires a nonnegative serializer cost.");
    }
    measured.set(start, cost);
    return cost;
  };
  const fits = (start: number) => costAt(start) <= input.budgetTokens;

  let start = entries.length;
  if (fits(entries.length)) {
    if (entries.length > 0 && fits(0)) {
      start = 0;
    } else if (entries.length > 0) {
      // start=0 is known not to fit and start=n is known to fit. The first
      // fitting suffix boundary is the exact newest-first stop boundary.
      let nonFitting = 0;
      let fitting = entries.length;
      while (fitting - nonFitting > 1) {
        const candidate = Math.floor((nonFitting + fitting) / 2);
        if (fits(candidate)) fitting = candidate;
        else nonFitting = candidate;
      }
      start = fitting;
    }
  }
  const selected = entries.slice(start);
  return Object.freeze({
    entries: Object.freeze(selected),
    trialCount: measured.size,
    elapsedMilliseconds: performance.now() - started,
    measuredTokens: fits(start) ? costAt(start) : null,
    firstOmittedEntry: start > 0 ? entries[start - 1] ?? null : null
  });
}
