import { createActivityMaintenance } from "../../../packages/application/src/activity.js";
import { createPostgresActivityRepository } from "../../../packages/database/src/activity-repository.js";
import { createPostgresActivityMaintenanceRepository } from "../../../packages/database/src/activity-maintenance-repository.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";

export function createActivityComposition(pool: DatabasePool) {
  return { reader: createPostgresActivityRepository(pool), maintenance: createActivityMaintenance(createPostgresActivityMaintenanceRepository(pool)) };
}
