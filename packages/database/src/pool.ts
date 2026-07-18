import pg from "pg";

const { Pool } = pg;

export type DatabasePool = InstanceType<typeof Pool>;
export type DatabaseClient = pg.PoolClient;

export function createDatabasePool(databaseUrl: string, maxConnections = 12): DatabasePool {
  return new Pool({
    connectionString: databaseUrl,
    max: maxConnections,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: "infinite-quest-nexus"
  });
}

export async function withTransaction<T>(pool: DatabasePool, work: (client: DatabaseClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function initialOwnerId(client: DatabaseClient | DatabasePool): Promise<string> {
  const result = await client.query<{ id: string }>(
    "SELECT id FROM users WHERE system_key = 'initial-owner' AND status = 'active'"
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("The initial-owner user has not been bootstrapped. Run migrations first.");
  return id;
}
