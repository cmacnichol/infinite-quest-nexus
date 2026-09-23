import { randomUUID } from "node:crypto";
import { type DatabasePool, withTransaction } from "./pool.js";

/** Short transactions coordinate API and worker processes without reserving a connection during provider work. */
export function createTextProviderCapacityRepository(pool: DatabasePool) {
  return {
    async tryAcquire(limit: number, leaseMs: number): Promise<string | null> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000
        || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 86_400_000) {
        throw new RangeError("Invalid text provider capacity or lease duration");
      }
      return withTransaction(pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('infinite-quest:text-provider-capacity', 0))");
        await client.query("DELETE FROM text_provider_capacity_leases WHERE expires_at <= clock_timestamp()");
        const count = await client.query<{ count: number }>("SELECT count(*)::integer AS count FROM text_provider_capacity_leases");
        if (count.rows[0]!.count >= limit) return null;
        const id = randomUUID();
        await client.query(
          "INSERT INTO text_provider_capacity_leases(id, expires_at) VALUES ($1, clock_timestamp() + $2 * interval '1 millisecond')",
          [id, leaseMs]
        );
        return id;
      });
    },
    async release(id: string): Promise<void> {
      await pool.query("DELETE FROM text_provider_capacity_leases WHERE id = $1", [id]);
    }
  };
}
