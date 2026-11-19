import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { providerRoutingPolicySchema } from "../../packages/contracts/src/text-execution-plan.js";
import { createDatabasePool, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const advanced = { order: ["fixture-route"], sort: { by: "price", partition: "none" },
  preferred_min_throughput: { p50: 100, p90: 50 }, max_price: { completion: "0.125", audio: "0.25" } };

integration("provider routing SQL contract upgrade", () => {
  let pool: DatabasePool;
  let historicalDirectory: string;
  beforeAll(async () => {
    pool = createDatabasePool(process.env.TEST_DATABASE_URL!, 2);
    historicalDirectory = await mkdtemp(join(tmpdir(), "iq-routing-migrations-"));
    for (const name of ["0133_baseline.sql", "0134_cast_review_decisions.sql"]) {
      await copyFile(resolve("database/migrations", name), join(historicalDirectory, name));
    }
    await migrateDatabase(pool, historicalDirectory);
    expect((await pool.query("SELECT valid_provider_routing_policy($1::jsonb) AS valid", [JSON.stringify(advanced)])).rows).toEqual([{ valid: false }]);
    await migrateDatabase(pool, resolve("database/migrations"));
  });
  afterAll(async () => {
    await pool?.end();
    if (historicalDirectory) await rm(historicalDirectory, { recursive: true, force: true });
  });

  it("upgrades an existing installation once without editing the baseline", async () => {
    expect((await pool.query("SELECT valid_provider_routing_policy($1::jsonb) AS valid", [JSON.stringify(advanced)])).rows).toEqual([{ valid: true }]);
    await migrateDatabase(pool, resolve("database/migrations"));
    expect((await pool.query("SELECT count(*)::int AS count FROM schema_migrations WHERE name='0135_provider_routing_formats'")).rows).toEqual([{ count: 1 }]);
    expect((await pool.query("SELECT valid_provider_routing_policy(NULL) AS valid")).rows).toEqual([{ valid: false }]);
  });

  const accepted = [
    {}, advanced, { order: [], sort: "latency" }, { order: ["route"], sort: "throughput" },
    ...["price", "latency", "throughput", "exacto"].flatMap(by => [{ sort: by }, { sort: { by, partition: "model" } }, { sort: { by, partition: "none" } }]),
    { sort: {} }, { sort: { partition: "none" } }, { preferred_min_throughput: {}, preferred_max_latency: {} },
    { preferred_min_throughput: { p50: 0, p75: 1, p90: 50, p99: 1e101 }, preferred_max_latency: 1e101 },
    { max_price: {} }, { max_price: { prompt: 0, completion: 1e101, image: "1e-400", request: ".25", audio: "0.000000000000000001" } },
    { max_price: { prompt: Number.MAX_VALUE, completion: "1.7976931348623157e308" } },
    { max_price: { prompt: "1e-200000", completion: "0e99999999999999999999" } },
    { only: ["x".repeat(501)], ignore: [], quantizations: ["fp16"], order: Array(64).fill("route") },
    { allow_fallbacks: false, require_parameters: true, enforce_distillable_text: false, zdr: true, data_collection: "deny" }
  ];
  const rejected = [
    null, [], "price", { unknown: null }, { order: null }, { sort: null }, { sort: 1 },
    { sort: "random" }, { sort: { by: null } }, { sort: { by: "random" } }, { sort: { partition: null } },
    { sort: { partition: "unknown" } }, { sort: { extra: true } },
    { order: [1] }, { order: Array(65).fill("route") }, { only: [" "] }, { ignore: [null] },
    { allow_fallbacks: null }, { require_parameters: "true" }, { data_collection: null }, { data_collection: 1 },
    { preferred_min_throughput: -1 }, { preferred_max_latency: null }, { preferred_max_latency: "2" },
    { preferred_max_latency: { p95: 2 } }, { preferred_min_throughput: { p90: null } }, { preferred_max_latency: { p50: -1 } },
    { max_price: null }, { max_price: { extra: 1 } }, { max_price: { prompt: null } },
    ...["", "-1", "NaN", "Infinity", "1e309", "1e99999999999999999999", "0x10", "1".repeat(129)].map(prompt => ({ max_price: { prompt } }))
  ];
  it.each([...accepted.map(value => ({ value, valid: true })), ...rejected.map(value => ({ value, valid: false }))])(
    "agrees with the shared contract for $value (valid=$valid)", async ({ value, valid }) => {
      expect(providerRoutingPolicySchema.safeParse(value).success).toBe(valid);
      expect((await pool.query("SELECT valid_provider_routing_policy($1::jsonb) AS valid", [JSON.stringify(value)])).rows).toEqual([{ valid }]);
    }
  );
});
