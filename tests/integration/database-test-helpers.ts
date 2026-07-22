import { setTimeout as delay } from "node:timers/promises";
import type { DatabasePool } from "../../packages/database/src/pool.js";

const DATABASE_IDLE_TIMEOUT_MS = 5_000;
const DATABASE_IDLE_POLL_INTERVAL_MS = 50;

function databaseIdentifier(databaseName: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(databaseName)) {
    throw new Error(`Unsafe test database name: ${databaseName}`);
  }
  return `"${databaseName}"`;
}

export async function dropTestDatabaseWhenIdle(
  adminPool: DatabasePool,
  databaseName: string,
  timeoutMs = DATABASE_IDLE_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let activeConnections = 0;

  do {
    const result = await adminPool.query<{ active_connections: string }>(
      "SELECT count(*)::text AS active_connections FROM pg_stat_activity WHERE datname = $1",
      [databaseName]
    );
    activeConnections = Number.parseInt(result.rows[0]?.active_connections ?? "0", 10);
    if (activeConnections === 0) {
      await adminPool.query(`DROP DATABASE IF EXISTS ${databaseIdentifier(databaseName)}`);
      return;
    }
    await delay(DATABASE_IDLE_POLL_INTERVAL_MS);
  } while (Date.now() < deadline);

  throw new Error(
    `Timed out waiting for ${activeConnections} connection(s) to close before dropping test database ${databaseName}`
  );
}
