import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import {
  createDatabasePool,
  initialOwnerId,
  type DatabasePool
} from "../../packages/database/src/pool.js";
import { runPlayLoopBenchmark } from "../../scripts/benchmark-play-loop.mjs";
import { dropTestDatabaseWhenIdle } from "./database-test-helpers.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

type RouteMetric = {
  errorRate: number;
  payloadBytesP50: number;
  payloadBytesP95: number;
  p50Ms: number;
  p95Ms: number;
  queryCount: number;
  queryCounts: number[];
  sampleCount: number;
};

integration("play-loop read performance", () => {
  it("profiles bounded hot routes with deterministic query budgets and realistic fixture cardinalities", async () => {
    const result = await runPlayLoopBenchmark({
      databaseUrl: databaseUrl!,
      warmups: 1,
      samples: 3
    }) as {
      benchmark: string;
      fixture: {
        campaigns: Record<string, { turns: number; generationJobs: number; imageJobs: number; chronicleMemories: number }>;
      };
      boundedReadEvidence: {
        requestedLimit: number;
        firstPageTurns: number;
        middlePageTurns: number;
        lastPageTurns: number;
        firstPageHasCursor: boolean;
        lastPageHasCursor: boolean;
        syncInitialTurns: number;
        syncInitialMode: string;
      };
      plans: Array<{ name: string; actualRows: number; executionTimeMs: number; nodeTypes: string[] }>;
      postgresVersion: string;
      routes: Record<string, RouteMetric>;
      warmups: number;
    };

    expect(result.benchmark).toBe("play-loop-reads-v1");
    expect(result.postgresVersion).toMatch(/^PostgreSQL /u);
    expect(result.warmups).toBe(1);
    expect(result.fixture.campaigns).toMatchObject({
      small: { turns: 12, generationJobs: 4, imageJobs: 3, chronicleMemories: 12 },
      medium: { turns: 200, generationJobs: 40, imageJobs: 20, chronicleMemories: 200 },
      long: { turns: 2_000, generationJobs: 400, imageJobs: 100, chronicleMemories: 2_000 }
    });

    expect(result.boundedReadEvidence).toEqual({
      requestedLimit: 50,
      firstPageTurns: 50,
      middlePageTurns: 50,
      lastPageTurns: 50,
      firstPageHasCursor: true,
      lastPageHasCursor: false,
      syncInitialTurns: 50,
      syncInitialMode: "replace"
    });

    const expectedQueryCounts: Record<string, number> = {
      "campaign-list": 3,
      dashboard: 4,
      "sync-replace": 8,
      "sync-unchanged": 3,
      "history-first": 5,
      "history-middle": 5,
      "history-last": 5,
      "generation-poll": 1,
      "generation-result": 2,
      "initial-hydration": 11
    };
    expect(Object.keys(result.routes).sort()).toEqual(Object.keys(expectedQueryCounts).sort());
    for (const [name, expectedQueryCount] of Object.entries(expectedQueryCounts)) {
      const metric = result.routes[name];
      expect(metric, name).toBeDefined();
      expect(metric?.sampleCount, name).toBe(3);
      expect(metric?.errorRate, name).toBe(0);
      expect(metric?.queryCount, name).toBe(expectedQueryCount);
      expect(metric?.queryCounts, name).toEqual([expectedQueryCount]);
      expect(metric?.p50Ms, name).toBeGreaterThanOrEqual(0);
      expect(metric?.p95Ms, name).toBeGreaterThanOrEqual(metric?.p50Ms ?? 0);
      expect(metric?.payloadBytesP50, name).toBeGreaterThan(0);
      expect(metric?.payloadBytesP95, name).toBeGreaterThanOrEqual(metric?.payloadBytesP50 ?? 0);
    }

    expect(result.plans.map((plan) => plan.name).sort()).toEqual([
      "campaign-list",
      "history-fingerprint",
      "history-page",
      "sync-status"
    ]);
    for (const plan of result.plans) {
      expect(plan.executionTimeMs, plan.name).toBeGreaterThanOrEqual(0);
      expect(plan.actualRows, plan.name).toBeGreaterThanOrEqual(0);
      expect(plan.nodeTypes.length, plan.name).toBeGreaterThan(0);
    }
  }, 120_000);
});

integration("initial owner cache database isolation", () => {
  let adminPool: DatabasePool;
  const databaseNames: string[] = [];
  const pools: DatabasePool[] = [];

  beforeAll(() => {
    adminPool = createDatabasePool(databaseUrl!, 1);
  });

  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
    for (const databaseName of databaseNames) {
      await dropTestDatabaseWhenIdle(adminPool, databaseName);
    }
    await adminPool.end();
  });

  it("evicts a failed lookup and never reuses an owner UUID across real databases", async () => {
    const createIsolatedPool = async (label: string) => {
      const databaseName = `owner_cache_${label}_${randomUUID().replaceAll("-", "")}`;
      if (!/^owner_cache_[a-z]+_[0-9a-f]{32}$/u.test(databaseName)) {
        throw new Error("Refusing to create an unsafe owner-cache test database name.");
      }
      databaseNames.push(databaseName);
      await adminPool.query(`CREATE DATABASE "${databaseName}"`);
      const isolatedUrl = new URL(databaseUrl!);
      isolatedUrl.pathname = `/${databaseName}`;
      const pool = createDatabasePool(isolatedUrl.toString(), 2);
      pools.push(pool);
      return pool;
    };
    const firstPool = await createIsolatedPool("first");
    const secondPool = await createIsolatedPool("second");

    await Promise.all([
      migrateDatabase(firstPool, resolve("database/migrations")),
      migrateDatabase(secondPool, resolve("database/migrations"))
    ]);
    await firstPool.query("DELETE FROM users WHERE system_key = 'initial-owner'");
    await expect(initialOwnerId(firstPool)).rejects.toThrow(
      "The initial-owner user has not been bootstrapped. Run migrations first."
    );
    await firstPool.query(
      "INSERT INTO users (system_key, display_name) VALUES ('initial-owner', 'Initial Owner')"
    );

    const firstOwner = await initialOwnerId(firstPool);
    const secondOwner = await initialOwnerId(secondPool);
    expect(firstOwner).not.toBe(secondOwner);
    await expect(initialOwnerId(firstPool)).resolves.toBe(firstOwner);
    await expect(initialOwnerId(secondPool)).resolves.toBe(secondOwner);

    const transactionClient = await firstPool.connect();
    try {
      await expect(initialOwnerId(transactionClient)).resolves.toBe(firstOwner);
      await expect(initialOwnerId(transactionClient)).resolves.toBe(firstOwner);
    } finally {
      transactionClient.release();
    }
  }, 120_000);
});
