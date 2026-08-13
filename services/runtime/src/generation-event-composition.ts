import type { RuntimeConfig } from "../../../packages/database/src/config.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import {
  createPostgresGenerationEventSource,
  type PostgresGenerationEventSource
} from "../../../packages/database/src/postgres-generation-events.js";

export type RuntimeGenerationEventSource = PostgresGenerationEventSource;

export function createRuntimeGenerationEventSource(
  config: RuntimeConfig,
  pool: DatabasePool
): RuntimeGenerationEventSource {
  return createPostgresGenerationEventSource(pool, config.databaseUrl);
}
