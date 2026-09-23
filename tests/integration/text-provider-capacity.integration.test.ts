import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createTextProviderCapacityRepository } from "../../packages/database/src/text-provider-capacity-repository.js";

describe("shared text provider capacity", () => {
  let first: DatabasePool, second: DatabasePool;
  beforeAll(async () => {
    first = createDatabasePool(process.env.TEST_DATABASE_URL!, 1);
    second = createDatabasePool(process.env.TEST_DATABASE_URL!, 1);
    const migrationPool = createDatabasePool(process.env.TEST_DATABASE_URL!, 2);
    try { await migrateDatabase(migrationPool, resolve("database/migrations")); }
    finally { await migrationPool.end(); }
  }, 60000);
  afterAll(async () => { await first?.end(); await second?.end(); });
  it("serializes claims across independent pools and never holds a connection while a permit is in use", async () => {
    const a = createTextProviderCapacityRepository(first), b = createTextProviderCapacityRepository(second);
    const leases = await Promise.all(Array.from({ length: 10 }, (_, index) => (index % 2 ? a : b).tryAcquire(2, 30000)));
    expect(leases.filter(Boolean)).toHaveLength(2);
    await first.query("SELECT 1"); await second.query("SELECT 1");
    expect(await b.tryAcquire(2, 30000)).toBeNull();
    await b.release(randomUUID());
    expect(await a.tryAcquire(2, 30000)).toBeNull();
    for (const lease of leases) if (lease) await a.release(lease);
    const fresh = await b.tryAcquire(2, 30000); expect(fresh).not.toBeNull();
    await a.release(fresh!); await a.release(fresh!);
  });
  it("recovers an abandoned lease after expiry without letting its old release remove a replacement", async () => {
    const a = createTextProviderCapacityRepository(first), b = createTextProviderCapacityRepository(second);
    const old = (await a.tryAcquire(1, 30000))!;
    await first.query("UPDATE text_provider_capacity_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [old]);
    const replacement = await b.tryAcquire(1, 30000); expect(replacement).not.toBeNull();
    await a.release(old);
    expect(await a.tryAcquire(1, 30000)).toBeNull();
    await b.release(replacement!);
  });
});
