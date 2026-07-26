import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import {
  createDatabasePool,
  initialOwnerId,
  type DatabasePool
} from "../../packages/database/src/pool.js";
import {
  acquireAdmission,
  AdmissionControlUnavailableError,
  releaseAdmission,
  type AdmissionPolicy
} from "../../services/api/src/admission-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("PostgreSQL API admission control", () => {
  let pool: DatabasePool;

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 3);
    await migrateDatabase(pool, resolve("database/migrations"));
  });

  afterEach(async () => {
    await pool.query("TRUNCATE api_admission_leases, api_admission_buckets");
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it("coordinates rate and concurrency limits through PostgreSQL", async () => {
    const secondPool = createDatabasePool(databaseUrl!, 2);
    try {
      const ownerUserId = await initialOwnerId(pool);
      const policy: AdmissionPolicy = {
        key: "provider",
        windowSeconds: 60,
        maxRequests: 2,
        maxConcurrent: 1,
        leaseSeconds: 30
      };
      const first = await acquireAdmission(
        pool,
        ownerUserId,
        "request-1",
        policy,
        new Date("2026-07-23T12:00:00Z")
      );
      expect(first).toMatchObject({ allowed: true, remaining: 1 });

      const concurrent = await acquireAdmission(
        secondPool,
        ownerUserId,
        "request-2",
        policy,
        new Date("2026-07-23T12:00:01Z")
      );
      expect(concurrent).toMatchObject({
        allowed: false,
        retryAfterSeconds: 29
      });

      if (first.allowed && first.leaseId) await releaseAdmission(pool, first.leaseId);
      const second = await acquireAdmission(
        secondPool,
        ownerUserId,
        "request-2",
        policy,
        new Date("2026-07-23T12:00:02Z")
      );
      expect(second).toMatchObject({ allowed: true, remaining: 0 });

      if (second.allowed && second.leaseId) await releaseAdmission(secondPool, second.leaseId);
      const exhausted = await acquireAdmission(
        pool,
        ownerUserId,
        "request-3",
        policy,
        new Date("2026-07-23T12:00:03Z")
      );
      expect(exhausted).toMatchObject({
        allowed: false,
        retryAfterSeconds: 57
      });
    } finally {
      await secondPool.end();
    }
  });

  it("serializes simultaneous concurrency checks across API replicas", async () => {
    const secondPool = createDatabasePool(databaseUrl!, 2);
    try {
      const ownerUserId = await initialOwnerId(pool);
      const policy: AdmissionPolicy = {
        key: "provider",
        windowSeconds: 60,
        maxRequests: 2,
        maxConcurrent: 1,
        leaseSeconds: 30
      };
      const decisions = await Promise.all([
        acquireAdmission(
          pool,
          ownerUserId,
          "simultaneous-request-1",
          policy,
          new Date("2026-07-23T12:00:00Z")
        ),
        acquireAdmission(
          secondPool,
          ownerUserId,
          "simultaneous-request-2",
          policy,
          new Date("2026-07-23T12:00:00Z")
        )
      ]);

      expect(decisions.filter((decision) => decision.allowed)).toHaveLength(1);
      expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(1);
      await expect(pool.query(
        `SELECT
           (SELECT accepted_count FROM api_admission_buckets) AS accepted_count,
           (SELECT count(*)::int FROM api_admission_leases) AS lease_count`
      )).resolves.toMatchObject({
        rows: [{ accepted_count: 1, lease_count: 1 }]
      });
    } finally {
      await secondPool.end();
    }
  });

  it("returns the existing lease for a duplicate request without consuming quota twice", async () => {
    const secondPool = createDatabasePool(databaseUrl!, 2);
    try {
      const ownerUserId = await initialOwnerId(pool);
      const policy: AdmissionPolicy = {
        key: "import",
        windowSeconds: 60,
        maxRequests: 3,
        maxConcurrent: 1,
        leaseSeconds: 30
      };
      const first = await acquireAdmission(
        pool,
        ownerUserId,
        "duplicate-request",
        policy,
        new Date("2026-07-23T12:00:00Z")
      );
      const duplicate = await acquireAdmission(
        secondPool,
        ownerUserId,
        "duplicate-request",
        policy,
        new Date("2026-07-23T12:00:01Z")
      );

      expect(first).toMatchObject({ allowed: true, remaining: 2 });
      expect(duplicate).toEqual(first);
      await expect(pool.query(
        `SELECT
           (SELECT count(*)::int FROM api_admission_buckets) AS bucket_count,
           (SELECT accepted_count FROM api_admission_buckets) AS accepted_count,
           (SELECT count(*)::int FROM api_admission_leases) AS lease_count`
      )).resolves.toMatchObject({
        rows: [{ bucket_count: 1, accepted_count: 1, lease_count: 1 }]
      });
    } finally {
      await secondPool.end();
    }
  });

  it("releases leases idempotently", async () => {
    const ownerUserId = await initialOwnerId(pool);
    const acquired = await acquireAdmission(pool, ownerUserId, "release-request", {
      key: "provider",
      windowSeconds: 60,
      maxRequests: 2,
      maxConcurrent: 1,
      leaseSeconds: 30
    }, new Date("2026-07-23T12:00:00Z"));
    expect(acquired).toMatchObject({ allowed: true, leaseId: expect.any(String) });
    if (!acquired.allowed || !acquired.leaseId) throw new Error("Expected a leased admission.");

    await expect(releaseAdmission(pool, acquired.leaseId)).resolves.toBeUndefined();
    await expect(releaseAdmission(pool, acquired.leaseId)).resolves.toBeUndefined();
    await expect(pool.query("SELECT count(*)::int AS count FROM api_admission_leases"))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("recovers concurrency capacity when a lease expires", async () => {
    const ownerUserId = await initialOwnerId(pool);
    const policy: AdmissionPolicy = {
      key: "provider",
      windowSeconds: 60,
      maxRequests: 2,
      maxConcurrent: 1,
      leaseSeconds: 30
    };
    const first = await acquireAdmission(
      pool,
      ownerUserId,
      "expired-request",
      policy,
      new Date("2026-07-23T12:00:00Z")
    );
    const recovered = await acquireAdmission(
      pool,
      ownerUserId,
      "replacement-request",
      policy,
      new Date("2026-07-23T12:00:30Z")
    );

    expect(first).toMatchObject({ allowed: true, remaining: 1 });
    expect(recovered).toMatchObject({ allowed: true, remaining: 0 });
    await expect(pool.query<{ request_id: string }>(
      "SELECT request_id FROM api_admission_leases ORDER BY request_id"
    )).resolves.toMatchObject({ rows: [{ request_id: "replacement-request" }] });
  });

  it("starts a fresh fixed-window bucket at the window boundary", async () => {
    const ownerUserId = await initialOwnerId(pool);
    const policy: AdmissionPolicy = {
      key: "generation",
      windowSeconds: 60,
      maxRequests: 1,
      maxConcurrent: null,
      leaseSeconds: 30
    };
    const first = await acquireAdmission(
      pool,
      ownerUserId,
      "window-request-1",
      policy,
      new Date("2026-07-23T12:00:59.999Z")
    );
    const exhausted = await acquireAdmission(
      pool,
      ownerUserId,
      "window-request-2",
      policy,
      new Date("2026-07-23T12:00:59.999Z")
    );
    const nextWindow = await acquireAdmission(
      pool,
      ownerUserId,
      "window-request-3",
      policy,
      new Date("2026-07-23T12:01:00Z")
    );

    expect(first).toMatchObject({ allowed: true, remaining: 0 });
    expect(exhausted).toMatchObject({
      allowed: false,
      retryAfterSeconds: 1
    });
    expect(nextWindow).toMatchObject({ allowed: true, remaining: 0 });
  });

  it("supports rate-only generation policies without creating leases", async () => {
    const ownerUserId = await initialOwnerId(pool);
    const decision = await acquireAdmission(pool, ownerUserId, "generation-request", {
      key: "generation",
      windowSeconds: 90,
      maxRequests: 4,
      maxConcurrent: null,
      leaseSeconds: 30
    }, new Date("2026-07-23T12:00:00Z"));

    expect(decision).toEqual({
      allowed: true,
      leaseId: null,
      remaining: 3,
      expiresAt: new Date("2026-07-23T12:01:30Z")
    });
    await expect(pool.query("SELECT count(*)::int AS count FROM api_admission_leases"))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("fails closed with a safe typed error when admission storage is unavailable", async () => {
    const ownerUserId = await initialOwnerId(pool);
    const unavailablePool = createDatabasePool(databaseUrl!, 1);
    await unavailablePool.end();

    const acquireError = await acquireAdmission(unavailablePool, ownerUserId, "unavailable", {
      key: "provider",
      windowSeconds: 60,
      maxRequests: 2,
      maxConcurrent: 1,
      leaseSeconds: 30
    }).catch((error: unknown) => error);
    expect(acquireError).toBeInstanceOf(AdmissionControlUnavailableError);
    expect(acquireError).toMatchObject({
      statusCode: 503,
      code: "ADMISSION_CONTROL_UNAVAILABLE",
      expose: true,
      message: "Admission control is temporarily unavailable."
    });

    const releaseError = await releaseAdmission(pool, "not-a-uuid").catch((error: unknown) => error);
    expect(releaseError).toBeInstanceOf(AdmissionControlUnavailableError);
    expect(releaseError).toMatchObject({
      statusCode: 503,
      code: "ADMISSION_CONTROL_UNAVAILABLE",
      expose: true,
      message: "Admission control is temporarily unavailable."
    });
  });
});
