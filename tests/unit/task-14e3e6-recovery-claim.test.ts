import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DurableFilesystemRecoveryClaim,
  DurableFilesystemRecoveryRecord,
  PrivateStorageDescriptor,
  ReservedFilesystemOperation,
} from "../../packages/application/src/assets/private-storage-lifecycle.js";
import { createSecureFilesystemAdapter } from "../../services/runtime/src/secure-filesystem-adapter.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function descriptor(root: string, relativePath: string, bytes: Uint8Array): Promise<PrivateStorageDescriptor> {
  const value = await stat(join(root, relativePath), { bigint: true });
  return Object.freeze({
    relativePath,
    identity: Object.freeze({
      deviceId: value.dev.toString(),
      fileId: value.ino.toString(),
      changeToken: `${value.mtimeNs}:${value.ctimeNs}`,
    }),
    contentHash: hash(bytes),
    byteLength: bytes.byteLength,
  });
}

describe("Task 14e3e6 recovery fencing", () => {
  it("uses the newest heartbeat claim for the terminal cleanup after physical deletion", async () => {
    const archiveRoot = await mkdtemp(join(tmpdir(), "iqn-e6-claim-archive-"));
    const assetRoot = await mkdtemp(join(tmpdir(), "iqn-e6-claim-assets-"));
    roots.push(archiveRoot, assetRoot);
    const relativePath = "assets/recovery/current-claim.pending";
    const bytes = Buffer.from("current recovery claim");
    await mkdir(join(assetRoot, "assets/recovery"), { recursive: true });
    await writeFile(join(assetRoot, relativePath), bytes);
    const physical = await descriptor(assetRoot, relativePath, bytes);
    const operation = {
      resourceKind: "asset",
      ownerUserId: "owner-1",
      assetId: "asset-1",
      operationId: "operation-1",
      purpose: "asset_original",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } as ReservedFilesystemOperation;
    const initial = {
      operationId: operation.operationId,
      leaseId: "lease-1",
      leaseOwner: "recovery-1",
      workVersion: 3,
      leaseExpiresAt: new Date(Date.now() + 5_000).toISOString(),
    } as DurableFilesystemRecoveryClaim;
    const renewed = {
      ...initial,
      leaseExpiresAt: new Date(Date.now() + 10_000).toISOString(),
    } as DurableFilesystemRecoveryClaim;
    const recovery = { action: "cleanup", operation, claim: initial } as DurableFilesystemRecoveryRecord;
    const completeCleanup = vi.fn(async (_operation, claim: DurableFilesystemRecoveryClaim) => {
      expect(claim).toBe(renewed);
      return { outcome: "cleaned" as const };
    });
    const adapter = await createSecureFilesystemAdapter({
      archiveRoot,
      assetRoot,
      platform: "linux",
      journal: {
        reserve: async () => { throw new Error("unexpected"); },
        attach: async () => { throw new Error("unexpected"); },
        finalizeAfterCommit: async () => ({ outcome: "stale" as const }),
        markCleanup: async () => ({ outcome: "cleanup_pending" as const }),
        completeCleanup,
        heartbeatRecoveryClaim: async () => null,
        recover: async () => [],
      },
      prewrite: {
        recordPrewriteTarget: async () => undefined,
        recordPrewriteNode: async () => undefined,
        preparePrewriteCleanup: async (_database, current) => {
          expect(current.claim).toBe(renewed);
          return Object.freeze({
            outcome: "cleanup_required" as const,
            operation,
            claim: renewed,
            relativePath,
            identity: physical.identity,
          }) as never;
        },
      },
      publicationCleanup: { preparePublicationCleanup: async () => ({ outcome: "already_cleaned" as const }) },
      transactions: { async run(work) { return work({}); } },
    });
    try {
      let recoveryReads = 0;
      await expect(adapter.recoverFilesystemOperation(recovery, () => (++recoveryReads === 1 ? recovery : { ...recovery, claim: renewed })))
        .resolves.toEqual({ outcome: "cleaned" });
      expect(completeCleanup).toHaveBeenCalledTimes(1);
    } finally {
      await adapter.close();
    }
  });
});
