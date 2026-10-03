import type { ActivityMaintenanceRepository } from "../../database/src/activity-repository.js";
import { logger } from "../../logger/src/index.js";

export function createActivityMaintenance(repository: ActivityMaintenanceRepository, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
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
        if (result.quarantined > 0) logger.warn({ event: "activity_publication_quarantined", errorCode: "invalid_snapshot", ...result });
        let pruned = 0;
        if (now() >= nextCleanup) {
          nextCleanup = now() + 60_000;
          pruned = await repository.pruneBatch(1000);
        }
        return result.published + result.quarantined + pruned > 0;
      } catch {
        nextPublication = now() + 5000;
        logger.error({ event: "activity_maintenance_error", errorCode: "activity-maintenance-failed" });
        return false;
      } finally { active = false; }
    }
  };
}
