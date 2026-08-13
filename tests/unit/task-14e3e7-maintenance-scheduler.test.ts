import { describe, expect, it } from "vitest";
import {
  createPrivateAssetMaintenanceScheduler,
  type PrivateAssetMaintenanceProbeResult,
} from "../../packages/application/src/assets/private-asset-maintenance-scheduler.js";

const request = Object.freeze({ workerId: "e7-test-worker", leaseSeconds: 30 });

function idle(): PrivateAssetMaintenanceProbeResult {
  return Object.freeze({ outcome: "idle" });
}

function completed(): PrivateAssetMaintenanceProbeResult {
  return Object.freeze({ outcome: "completed" });
}

describe("Task 14e3e7 private asset-maintenance scheduler", () => {
  it("rotates one probe per tick even when each probe is empty", async () => {
    const calls: string[] = [];
    const scheduler = createPrivateAssetMaintenanceScheduler({
      metadataBackfill: async () => { calls.push("metadata"); return idle(); },
      assetFilesystemRecovery: async () => { calls.push("asset"); return idle(); },
      portableExpiryRecovery: async () => { calls.push("portable"); return idle(); },
    });

    await expect(scheduler.tick(request)).resolves.toMatchObject({ probe: "metadata_backfill", attempted: 1, idle: 1 });
    await expect(scheduler.tick(request)).resolves.toMatchObject({ probe: "asset_filesystem_recovery", attempted: 1, idle: 1 });
    await expect(scheduler.tick(request)).resolves.toMatchObject({ probe: "portable_expiry_recovery", attempted: 1, idle: 1 });
    expect(calls).toEqual(["metadata", "asset", "portable"]);
  });

  it("advances past a fault without exposing its raw error", async () => {
    const calls: string[] = [];
    const scheduler = createPrivateAssetMaintenanceScheduler({
      metadataBackfill: async () => {
        calls.push("metadata");
        throw new Error("/private/asset/root/secret.png");
      },
      assetFilesystemRecovery: async () => { calls.push("asset"); return completed(); },
      portableExpiryRecovery: async () => { calls.push("portable"); return idle(); },
    });

    const fault = await scheduler.tick(request);
    expect(fault).toEqual({
      probe: "metadata_backfill",
      attempted: 1,
      idle: 0,
      completed: 0,
      recoverable: 0,
      failed: 1,
      quarantined: 0,
      leaseLost: 0,
      diagnosticCodes: ["asset_metadata_unavailable"],
    });
    expect(JSON.stringify(fault)).not.toContain("secret.png");
    await expect(scheduler.tick(request)).resolves.toMatchObject({
      probe: "asset_filesystem_recovery",
      completed: 1,
    });
    expect(calls).toEqual(["metadata", "asset"]);
  });

  it("filters an executor's malformed diagnostic projection to an allowlisted safe code", async () => {
    const scheduler = createPrivateAssetMaintenanceScheduler({
      metadataBackfill: async () => Object.freeze({
        outcome: "recoverable" as const,
        diagnosticCodes: Object.freeze(["/private/asset/root/raw-detail"]),
      }) as unknown as PrivateAssetMaintenanceProbeResult,
      assetFilesystemRecovery: async () => idle(),
      portableExpiryRecovery: async () => idle(),
    });

    await expect(scheduler.tick(request)).resolves.toMatchObject({
      recoverable: 1,
      diagnosticCodes: ["asset_metadata_unavailable"],
    });
  });

  it("permits only one active unit and drains that exact unit after abort", async () => {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const scheduler = createPrivateAssetMaintenanceScheduler({
      metadataBackfill: async () => {
        started();
        await new Promise<void>((done) => { release = done; });
        return completed();
      },
      assetFilesystemRecovery: async () => completed(),
      portableExpiryRecovery: async () => completed(),
    });
    const active = scheduler.tick(request);
    await started;
    await expect(scheduler.tick(request)).resolves.toEqual({
      probe: "none",
      attempted: 0,
      idle: 0,
      completed: 0,
      recoverable: 0,
      failed: 0,
      quarantined: 0,
      leaseLost: 0,
      diagnosticCodes: [],
      status: "busy",
    });
    scheduler.abort();
    await expect(scheduler.tick(request)).resolves.toMatchObject({ status: "aborted", attempted: 0 });
    let drained = false;
    const drain = scheduler.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await expect(active).resolves.toMatchObject({ probe: "metadata_backfill", completed: 1 });
    await drain;
    expect(drained).toBe(true);
  });

  it("treats an already-aborted signal as a no-claim boundary", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const scheduler = createPrivateAssetMaintenanceScheduler({
      metadataBackfill: async () => { calls += 1; return completed(); },
      assetFilesystemRecovery: async () => completed(),
      portableExpiryRecovery: async () => completed(),
    });

    await expect(scheduler.tick({ ...request, signal: controller.signal })).resolves.toMatchObject({
      status: "aborted",
      attempted: 0,
    });
    expect(calls).toBe(0);
  });
});
