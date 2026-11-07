import type { CastBackfillProgress, CastDiscoveryStatus } from "@infinite-quest/contracts";

export function watchCastScan(options: {
  scan: CastBackfillProgress | null;
  current(): boolean;
  suspended(): boolean;
  readDiscovery(): Promise<CastDiscoveryStatus>;
  readScan(id: string): Promise<CastBackfillProgress>;
  showAutomatic(tracking: CastDiscoveryStatus): void;
  showConnection(unavailable: boolean): void;
  refresh(id: string): Promise<void>;
}) {
  const { scan } = options;
  // Poll in place so background updates preserve range inputs and pending actions.
  // Each request finishes before another starts. Navigation invalidates late responses.
  async function poll() {
    if (!options.current()) return;
    try {
      if (options.suspended()) return;
      const active = scan && ["queued", "running", "paused", "failed"].includes(scan.status);
      const [tracking, progress] = await Promise.allSettled([
        options.readDiscovery(), active ? options.readScan(scan.id) : Promise.resolve(scan)
      ]);
      if (!options.current() || options.suspended()) return;
      if (tracking.status === "fulfilled") options.showAutomatic(tracking.value);
      options.showConnection(tracking.status === "rejected" || progress.status === "rejected");
      if (progress.status === "fulfilled" && scan && progress.value && (
        progress.value.status !== scan.status || progress.value.completeTurns !== scan.completeTurns ||
        progress.value.failedTurns !== scan.failedTurns || progress.value.pendingReviewCount !== scan.pendingReviewCount
      )) await options.refresh(scan.id);
    } finally {
      if (options.current()) setTimeout(poll, 4000);
    }
  }
  setTimeout(poll, 4000);
}
