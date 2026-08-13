import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import {
  createDatabasePool,
  withTransaction,
  type DatabaseClient,
  type DatabasePool,
} from "../../packages/database/src/pool.js";
import {
  createPrivateAssetMaintenanceScheduler,
  type PrivateAssetMaintenanceProbeResult,
} from "../../packages/application/src/assets/private-asset-maintenance-scheduler.js";
import type { AssetFilesystemDiagnosticCode } from "../../packages/application/src/assets/types.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

type PoolObservation = Readonly<{
  reset(): void;
  snapshot(): Readonly<{ borrowed: number; released: number; checkedOut: number; maximumCheckedOut: number }>;
}>;

function observeBorrowRelease(pool: DatabasePool): PoolObservation {
  const mutablePool = pool as unknown as { connect(): Promise<DatabaseClient> };
  const originalConnect = mutablePool.connect.bind(mutablePool);
  let borrowed = 0;
  let released = 0;
  let checkedOut = 0;
  let maximumCheckedOut = 0;
  mutablePool.connect = async (): Promise<DatabaseClient> => {
    const client = await originalConnect();
    borrowed += 1;
    checkedOut += 1;
    maximumCheckedOut = Math.max(maximumCheckedOut, checkedOut);
    const mutableClient = client as unknown as { release(): void };
    const originalRelease = mutableClient.release.bind(mutableClient);
    let didRelease = false;
    mutableClient.release = (): void => {
      if (!didRelease) {
        didRelease = true;
        released += 1;
        checkedOut -= 1;
      }
      originalRelease();
    };
    return client;
  };
  return Object.freeze({
    reset(): void {
      borrowed = 0;
      released = 0;
      checkedOut = 0;
      maximumCheckedOut = 0;
    },
    snapshot: () => Object.freeze({ borrowed, released, checkedOut, maximumCheckedOut }),
  });
}

integration("Task 14e3e8 private parity pool and safe-result matrix", () => {
  let pool: DatabasePool;

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 2);
    await migrateDatabase(pool, "database/migrations");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("uses one supplied real pool with no checked-out client after success, fault, abort, and drain while projecting hostile details safely", async () => {
    const observation = observeBorrowRelease(pool);
    let allowDrain!: () => void;
    let enteredDrain!: () => void;
    const drainEntered = new Promise<void>((resolve) => { enteredDrain = resolve; });
    const scheduler = createPrivateAssetMaintenanceScheduler({
      metadataBackfill: async () => {
        await withTransaction(pool, async (client) => client.query("SELECT 1"));
        return Object.freeze({ outcome: "completed" as const });
      },
      assetFilesystemRecovery: async () => {
        await withTransaction(pool, async (client) => client.query("SELECT 1"));
        throw new Error("/private/asset/root/secret.png?bearer=raw-token");
      },
      portableExpiryRecovery: async () => {
        enteredDrain();
        await new Promise<void>((resolve) => { allowDrain = resolve; });
        await withTransaction(pool, async (client) => client.query("SELECT 1"));
        return Object.freeze({
          outcome: "recoverable" as const,
          diagnosticCodes: Object.freeze([
            "/private/path/descriptor?credential=secret",
            "filesystem_path_invalid",
          ]) as unknown as readonly AssetFilesystemDiagnosticCode[],
          path: "/private/path",
          descriptor: { relativePath: "assets/private/descriptor", deviceId: "device-secret" },
          bearer: "raw-token",
          credential: "raw-credential",
          url: "https://private.example.invalid/artifact?token=raw-token",
          error: new Error("raw-error"),
          privateHandle: { close: () => undefined },
        }) as unknown as PrivateAssetMaintenanceProbeResult;
      },
    });

    observation.reset();
    await expect(scheduler.tick({ workerId: "e8-pool", leaseSeconds: 30 }))
      .resolves.toMatchObject({ probe: "metadata_backfill", completed: 1, diagnosticCodes: [] });
    const fault = await scheduler.tick({ workerId: "e8-pool", leaseSeconds: 30 });
    expect(fault).toMatchObject({ probe: "asset_filesystem_recovery", failed: 1, diagnosticCodes: ["asset_metadata_unavailable"] });
    expect(JSON.stringify(fault)).not.toMatch(/secret|private|bearer|token/u);

    const controller = new AbortController();
    const draining = scheduler.tick({ workerId: "e8-pool", leaseSeconds: 30, signal: controller.signal });
    await drainEntered;
    controller.abort();
    await expect(scheduler.tick({ workerId: "e8-pool", leaseSeconds: 30 })).resolves.toMatchObject({ status: "aborted", attempted: 0 });
    const drain = scheduler.drain();
    allowDrain();
    const recovered = await draining;
    await drain;
    expect(recovered).toMatchObject({
      probe: "portable_expiry_recovery",
      recoverable: 1,
      diagnosticCodes: ["filesystem_path_invalid"],
    });
    expect(JSON.stringify(recovered)).not.toMatch(/private|descriptor|credential|secret|bearer|token|raw-error/u);
    expect(observation.snapshot()).toEqual({ borrowed: 3, released: 3, checkedOut: 0, maximumCheckedOut: 1 });
  });
});
