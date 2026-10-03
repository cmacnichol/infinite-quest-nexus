export interface ActivityMaintenanceRepository {
  publishBatch(limit: number): Promise<{ published: number; quarantined: number }>;
  pruneBatch(limit: number): Promise<number>;
}
export type ActivityMaintenanceSignal =
  | { event: "activity_publication_quarantined"; errorCode: "invalid_snapshot"; published: number; quarantined: number }
  | { event: "activity_maintenance_error"; errorCode: "activity-maintenance-failed" };

export function createActivityMaintenance(repository: ActivityMaintenanceRepository, options: { now?: () => number; observe?: (signal: ActivityMaintenanceSignal) => void } = {}) {
  const now = options.now ?? Date.now;
  const observe = (signal: ActivityMaintenanceSignal) => {
    try { options.observe?.(signal); } catch { /* Observability must not stop maintenance. */ }
  };
  let nextPublication = 0;
  let nextCleanup = 0;
  let active = false;
  return {
    async tick(): Promise<boolean> {
      if (active || now() < nextPublication) return false;
      active = true;
      nextPublication = now() + 1000;
      try {
        const result = await repository.publishBatch(100);
        if (result.quarantined > 0) observe({ event: "activity_publication_quarantined", errorCode: "invalid_snapshot", ...result });
        let pruned = 0;
        if (now() >= nextCleanup) {
          nextCleanup = now() + 60_000;
          pruned = await repository.pruneBatch(1000);
        }
        return result.published + result.quarantined + pruned > 0;
      } catch {
        nextPublication = now() + 5000;
        observe({ event: "activity_maintenance_error", errorCode: "activity-maintenance-failed" });
        return false;
      } finally { active = false; }
    }
  };
}
