import { describe, expect, it, vi } from "vitest";
import type * as PublicImportContracts from "../../packages/application/src/imports/index.js";
import type {
  AttachedFilesystemOperation,
  DurableFilesystemOperationId,
  DurableFilesystemRecoveryClaim,
  DurableFilesystemRecoveryRecord,
  PrivateStorageDescriptor
} from "../../packages/application/src/assets/private-storage-lifecycle.js";
import {
  bindPrivatePortableExportCleanupPreparation,
  bindPrivatePortableStagedCleanupPreparation,
  type PrivatePortableExportCleanupIdentity,
  type PrivatePortableRepositoryPort,
  type PrivatePortableStagedCleanupIdentity
} from "../../packages/application/src/imports/private-portable-repository.js";
import type { PortableExportScope } from "../../packages/application/src/imports/private-portable-authority.js";
import type {
  PortableArchiveExportRetrieval,
  PortableStagedInput
} from "../../packages/application/src/imports/types.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const stagedInput = "staged-secret" as PortableStagedInput;
const exportRetrieval = "export-secret" as PortableArchiveExportRetrieval;
const operationId = "22222222-2222-4222-8222-222222222222" as DurableFilesystemOperationId;

// @ts-expect-error Portable cleanup persistence remains adapter-private.
type LeakedPortablePort = PublicImportContracts.PrivatePortableRepositoryPort;

const descriptor: PrivateStorageDescriptor = {
  relativePath: "private/archive.zip",
  identity: { deviceId: "device-1", fileId: "file-1", changeToken: "change-1" },
  contentHash: "a".repeat(64),
  byteLength: 7
};

function attached(
  purpose: "portable_staging" | "portable_export",
): AttachedFilesystemOperation {
  return {
    resourceKind: "portable",
    ownerUserId,
    operationScopeId: `scope-${purpose}`,
    operationId,
    purpose
  } as AttachedFilesystemOperation;
}

function claim(overrides: Partial<DurableFilesystemRecoveryClaim> = {}): DurableFilesystemRecoveryClaim {
  return {
    operationId,
    workVersion: 5,
    leaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    leaseOwner: "portable-cleanup-worker",
    leaseExpiresAt: "2026-08-08T12:01:00.000Z",
    ...overrides
  } as DurableFilesystemRecoveryClaim;
}

const exportScope: PortableExportScope = {
  ownerUserId,
  exportKind: "campaign_zip",
  campaignId: "33333333-3333-4333-8333-333333333333",
  worldId: "44444444-4444-4444-8444-444444444444",
  worldVersionId: "55555555-5555-4555-8555-555555555555"
};

describe("Task 14e3b2c private portable cleanup contracts", () => {
  it("binds cleanup authority to durable row identity without inheriting a raw bearer", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime("2026-08-08T12:00:00.000Z");
      const stagedIdentity: PrivatePortableStagedCleanupIdentity = {
        portableKind: "staged_input",
        stagedInputId: "66666666-6666-4666-8666-666666666666",
        ownerUserId,
        filesystemOperationId: operationId
      };
      const staged = bindPrivatePortableStagedCleanupPreparation(
        stagedIdentity,
        attached("portable_staging"),
        claim(),
        [descriptor],
      );

      expect(staged).toMatchObject({
        outcome: "cleanup_required",
        identity: stagedIdentity,
        claim: { operationId, workVersion: 5 },
        descriptors: [descriptor]
      });
      expect(staged.identity).not.toHaveProperty("stagedInput");
      expect(staged).not.toHaveProperty("stagedInput");
      expect(Object.isFrozen(staged.identity)).toBe(true);
      expect(Object.isFrozen(staged.descriptors)).toBe(true);

      expect(() => bindPrivatePortableStagedCleanupPreparation(
        { ...stagedIdentity, filesystemOperationId: "foreign-operation" as DurableFilesystemOperationId },
        attached("portable_staging"),
        claim(),
        [descriptor],
      )).toThrow("portable_cleanup_identity_mismatch");
    } finally {
      vi.useRealTimers();
    }
  });

  it("binds export cleanup authority to the complete immutable export scope", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime("2026-08-08T12:00:00.000Z");
      const exportIdentity: PrivatePortableExportCleanupIdentity = {
        portableKind: "export_artifact",
        artifactId: "77777777-7777-4777-8777-777777777777",
        ownerUserId,
        filesystemOperationId: operationId,
        exportScope
      };
      const preparation = bindPrivatePortableExportCleanupPreparation(
        exportIdentity,
        attached("portable_export"),
        claim(),
        [descriptor],
      );

      expect(preparation).toMatchObject({
        outcome: "cleanup_required",
        identity: exportIdentity,
        operation: { purpose: "portable_export" },
        descriptors: [descriptor]
      });
      expect(preparation.identity).not.toHaveProperty("retrieval");
      expect(Object.isFrozen(preparation.identity.exportScope)).toBe(true);

      expect(() => bindPrivatePortableExportCleanupPreparation(
        { ...exportIdentity, exportScope: { ...exportScope, worldVersionId: "" } },
        attached("portable_export"),
        claim(),
        [descriptor],
      )).toThrow("portable_export_scope_invalid");
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires caller transactions for preparation and exact recovery records for bearer-free recovery", () => {
    const port = null as unknown as PrivatePortableRepositoryPort;
    const database = {};
    const stagedRehydration = null as never;
    const exportRehydration = null as never;
    const recovery = {
      action: "cleanup",
      operation: attached("portable_staging"),
      claim: claim()
    } as DurableFilesystemRecoveryRecord;

    if (false) {
      void port.prepareStagedCleanup(database, stagedRehydration);
      void port.prepareExportCleanup(database, exportRehydration);
      void port.prepareRecoveryCleanup(database, recovery);

      // @ts-expect-error Cleanup preparation cannot run without a caller-owned transaction.
      void port.prepareStagedCleanup(stagedRehydration);
      // @ts-expect-error Cleanup preparation cannot run without a caller-owned transaction.
      void port.prepareExportCleanup(exportRehydration);
      // @ts-expect-error Recovery consumes a journal recovery record, never owner plus raw bearer.
      void port.prepareRecoveryCleanup(database, { ownerUserId }, stagedInput);
      // @ts-expect-error Recovery consumes a journal recovery record, never scope plus raw bearer.
      void port.prepareRecoveryCleanup(database, exportScope, exportRetrieval);
    }

    expect(recovery.action).toBe("cleanup");
  });
});
