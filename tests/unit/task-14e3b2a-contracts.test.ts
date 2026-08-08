import { describe, expect, it, vi } from "vitest";
import type * as PublicAssetContracts from "../../packages/application/src/assets/index.js";
import type * as PublicImportContracts from "../../packages/application/src/imports/index.js";
import {
  bindPrivateFilesystemCandidateAttachment,
  bindPrivateFilesystemDeliveryGrantRedemption,
  type PrivateFilesystemCandidatePersistencePort,
  type PrivateFilesystemDeliveryGrantPersistencePort
} from "../../packages/application/src/assets/private-filesystem-repository.js";
import type {
  AssetPublicationCandidate,
  AttachedFilesystemOperation,
  DurableFilesystemRecoveryClaim,
  PrivateFilesystemDeliveryGrant,
  PrivateFilesystemDeliveryGrantRequest,
  PrivateStorageDescriptor,
  ReservedFilesystemOperation
} from "../../packages/application/src/assets/private-storage-lifecycle.js";
import {
  bindPrivatePortableExportCleanupPreparation,
  bindPrivatePortableExportRehydration,
  bindPrivatePortableStagedCleanupPreparation,
  bindPrivatePortableStagedRehydration,
  type PrivatePortableRepositoryPort
} from "../../packages/application/src/imports/private-portable-repository.js";
import type { PortableExportScope } from "../../packages/application/src/imports/private-portable-authority.js";
import type {
  PortableArchiveExportRetrieval,
  PortableStagedInput
} from "../../packages/application/src/imports/types.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const candidate = "candidate-secret" as AssetPublicationCandidate;
const stagedInput = "staged-secret" as PortableStagedInput;
const exportRetrieval = "export-secret" as PortableArchiveExportRetrieval;

// @ts-expect-error Candidate persistence must remain adapter-private.
type LeakedCandidatePort = PublicAssetContracts.PrivateFilesystemCandidatePersistencePort;
// @ts-expect-error Delivery-grant persistence must remain adapter-private.
type LeakedDeliveryPort = PublicAssetContracts.PrivateFilesystemDeliveryGrantPersistencePort;
// @ts-expect-error Portable cleanup persistence must remain adapter-private.
type LeakedPortablePort = PublicImportContracts.PrivatePortableRepositoryPort;

const descriptor: PrivateStorageDescriptor = {
  relativePath: "private/archive.zip",
  identity: { deviceId: "device-1", fileId: "file-1", changeToken: "change-1" },
  contentHash: "a".repeat(64),
  byteLength: 7
};

function reservation(
  purpose: "portable_staging" | "portable_export",
): ReservedFilesystemOperation {
  return {
    resourceKind: "portable",
    ownerUserId,
    operationScopeId: `scope-${purpose}`,
    operationId: `operation-${purpose}`,
    purpose,
    expiresAt: "2099-01-01T00:00:00.000Z"
  } as ReservedFilesystemOperation;
}

function attached(
  purpose: "portable_staging" | "portable_export",
): AttachedFilesystemOperation {
  const { expiresAt: _expiresAt, ...operation } = reservation(purpose);
  return operation as unknown as AttachedFilesystemOperation;
}

function claim(operationId: string, overrides: Partial<DurableFilesystemRecoveryClaim> = {}) {
  return {
    operationId,
    workVersion: 4,
    leaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    leaseOwner: "private-repository-worker",
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

describe("Task 14e3b2a private repository contracts", () => {
  it("binds candidate attachment to the exact unexpired operation lease claim and descriptor", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime("2026-08-08T12:00:00.000Z");
      const operation = reservation("portable_staging");
      const attachment = bindPrivateFilesystemCandidateAttachment(
        operation,
        candidate,
        descriptor,
        claim(operation.operationId),
      );

      expect(attachment).toMatchObject({ operation, candidate, descriptor });
      expect(attachment.claim).toMatchObject({
        operationId: operation.operationId,
        workVersion: 4,
        leaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        leaseOwner: "private-repository-worker"
      });
      expect(Object.isFrozen(attachment)).toBe(true);
      expect(Object.isFrozen(attachment.operation)).toBe(true);
      expect(Object.isFrozen(attachment.descriptor.identity)).toBe(true);

      expect(() => bindPrivateFilesystemCandidateAttachment(
        operation,
        candidate,
        descriptor,
        claim("substituted-operation"),
      )).toThrow("filesystem_recovery_claim_mismatch");
      expect(() => bindPrivateFilesystemCandidateAttachment(
        operation,
        candidate,
        descriptor,
        claim(operation.operationId, { leaseExpiresAt: "2026-08-08T12:00:00.000Z" }),
      )).toThrow("filesystem_recovery_claim_expired");
      expect(() => bindPrivateFilesystemCandidateAttachment(
        operation,
        candidate,
        descriptor,
        claim(operation.operationId, { leaseOwner: "" }),
      )).toThrow("filesystem_recovery_claim_invalid");
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires persistence and one-time delivery redemption to consume bound authority", () => {
    const candidates = null as unknown as PrivateFilesystemCandidatePersistencePort;
    const grants = null as unknown as PrivateFilesystemDeliveryGrantPersistencePort;
    const request = {
      operation: attached("portable_export"),
      lifecycle: "finalized",
      candidate,
      descriptor,
      expiresAt: "2099-01-01T00:00:00.000Z"
    } as PrivateFilesystemDeliveryGrantRequest;
    const grant = "delivery-secret" as PrivateFilesystemDeliveryGrant;

    if (false) {
      // @ts-expect-error Candidate persistence requires the exact attachment, including a fresh claim.
      void candidates.persistCandidate(reservation("portable_staging"), candidate, descriptor);
      // @ts-expect-error Candidate attachment cannot use a bare reservation and candidate.
      void candidates.attachCandidate({}, reservation("portable_staging"), candidate);
      // @ts-expect-error Grant redemption consumes a bound request plus the one-time bearer.
      void grants.redeemDeliveryGrant({ ownerUserId }, grant);
    }

    const redemption = bindPrivateFilesystemDeliveryGrantRedemption(request, grant);
    expect(redemption).toEqual({ request, grant });
    expect(Object.isFrozen(redemption)).toBe(true);
  });

  it("carries the same fresh claim, exact staged identity, and descriptors through cleanup acknowledgement", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime("2026-08-08T12:00:00.000Z");
      const operation = attached("portable_staging");
      const freshClaim = claim(operation.operationId);
      const rehydrated = bindPrivatePortableStagedRehydration(
        { ownerUserId, stagedInput },
        operation,
        freshClaim,
        descriptor,
      );
      const preparation = bindPrivatePortableStagedCleanupPreparation(
        rehydrated,
        [descriptor],
      );

      expect(rehydrated).toMatchObject({
        identity: { ownerUserId, stagedInput },
        operation,
        claim: freshClaim,
        descriptor
      });
      expect(preparation.claim).toEqual(rehydrated.claim);
      expect(preparation.identity).toEqual(rehydrated.identity);
      expect(preparation.descriptors).toEqual([descriptor]);
      expect(Object.isFrozen(preparation.descriptors)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires the full export scope for rehydration, recovery, cleanup, and acknowledgement", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime("2026-08-08T12:00:00.000Z");
      const operation = attached("portable_export");
      const rehydrated = bindPrivatePortableExportRehydration(
        { exportScope, retrieval: exportRetrieval },
        operation,
        claim(operation.operationId),
        descriptor,
      );
      const preparation = bindPrivatePortableExportCleanupPreparation(
        rehydrated,
        [descriptor],
      );
      const port = null as unknown as PrivatePortableRepositoryPort;

      expect(rehydrated.identity.exportScope).toEqual(exportScope);
      expect(preparation.identity).toEqual(rehydrated.identity);
      expect(preparation.claim).toEqual(rehydrated.claim);
      expect(Object.isFrozen(rehydrated.identity.exportScope)).toBe(true);

      expect(() => bindPrivatePortableExportRehydration(
        {
          exportScope: { ...exportScope, worldVersionId: "" },
          retrieval: exportRetrieval
        },
        operation,
        claim(operation.operationId),
        descriptor,
      )).toThrow("portable_export_scope_invalid");
      expect(() => bindPrivatePortableExportRehydration(
        { exportScope: { ...exportScope, ownerUserId: "foreign-owner" }, retrieval: exportRetrieval },
        operation,
        claim(operation.operationId),
        descriptor,
      )).toThrow("filesystem_scope_invalid");

      if (false) {
        // @ts-expect-error Export retrieval cannot use owner scope in place of PortableExportScope.
        void port.rehydrateExportArtifact({ ownerUserId }, exportRetrieval, {
          leaseOwner: "worker", leaseSeconds: 30
        });
        // @ts-expect-error Cleanup preparation consumes exact rehydrated export identity, not owner plus bearer.
        void port.prepareExportCleanup({ ownerUserId }, exportRetrieval);
        // @ts-expect-error Cleanup acknowledgement consumes the branded preparation result.
        void port.acknowledgeExportCleanup({}, exportScope, exportRetrieval);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
