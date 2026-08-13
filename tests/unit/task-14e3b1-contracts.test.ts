import { describe, expect, it, vi } from "vitest";
import type * as PublicAssetContracts from "../../packages/application/src/assets/index.js";
import type * as PublicImportContracts from "../../packages/application/src/imports/index.js";
import {
  type AssetPublicationCandidate,
  type AttachedFilesystemOperation,
  type PrivateStorageDescriptor,
  type ReservedFilesystemOperation
} from "../../packages/application/src/assets/private-storage-lifecycle.js";
import { bindPrivateFilesystemCandidateAttachment } from "../../packages/application/src/assets/private-filesystem-repository.js";
import type { PrivateLegacyAnchoredReadCapability } from "../../packages/application/src/assets/private-finalized-delivery.js";
import {
  bindPrivateAtomicExportIssuance,
  bindPrivateAtomicStagedIssuance,
  type PortableExportScope,
  type PrivateAtomicPortableIssuancePort
} from "../../packages/application/src/imports/private-portable-authority.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const assetId = "22222222-2222-4222-8222-222222222222";
const campaignId = "33333333-3333-4333-8333-333333333333";
const worldId = "44444444-4444-4444-8444-444444444444";
const worldVersionId = "55555555-5555-4555-8555-555555555555";

// @ts-expect-error Adapter-private legacy anchored reads must not cross the public asset barrel.
type LeakedLegacyAnchoredRead = PublicAssetContracts.PrivateLegacyAnchoredReadCapability;
// @ts-expect-error Adapter-private portable issuance must not cross the public import barrel.
type LeakedPortableIssuance = PublicImportContracts.PrivatePortableExportIssuance;

const descriptor: PrivateStorageDescriptor = {
  relativePath: "private/archive.zip",
  identity: { deviceId: "device-1", fileId: "file-1", changeToken: "change-1" },
  contentHash: "a".repeat(64),
  byteLength: 7
};

function portableReservation(
  purpose: "portable_staging" | "portable_export",
  overrides: Partial<ReservedFilesystemOperation> = {},
): ReservedFilesystemOperation {
  return {
    resourceKind: "portable",
    ownerUserId,
    operationScopeId: `scope-${purpose}`,
    operationId: `operation-${purpose}`,
    purpose,
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...overrides
  } as ReservedFilesystemOperation;
}

const candidate = "candidate-secret" as AssetPublicationCandidate;

function portableAttachment(purpose: "portable_staging" | "portable_export") {
  const reservation = portableReservation(purpose);
  return bindPrivateFilesystemCandidateAttachment(
    reservation,
    candidate,
    descriptor,
    {
      operationId: reservation.operationId,
      leaseId: `lease-${purpose}`,
      leaseOwner: "b4-contract",
      workVersion: 1,
      leaseExpiresAt: "2099-01-01T00:00:00.000Z"
    } as never,
  );
}

describe("Task 14e3b1 private authority contracts", () => {
  it("binds staged issuance to one exact reservation, owner, purpose, candidate, and immutable descriptor snapshot", () => {
    const attachment = portableAttachment("portable_staging");
    const issuance = bindPrivateAtomicStagedIssuance({ ownerUserId }, attachment);

    expect(issuance).toMatchObject({
      owner: { ownerUserId },
      attachment: {
        operation: {
          operationId: "operation-portable_staging",
          operationScopeId: "scope-portable_staging",
          resourceKind: "portable",
          purpose: "portable_staging"
        },
        candidate,
        descriptor
      }
    });
    expect(issuance).not.toBe(attachment);
    expect(Object.isFrozen(issuance)).toBe(true);
    expect(Object.isFrozen(issuance.attachment.descriptor)).toBe(true);
    expect(Object.isFrozen(issuance.attachment.descriptor.identity)).toBe(true);
  });

  it("rejects foreign owner, wrong resource or purpose, malformed descriptor, and stale reservation authority", () => {
    const staging = portableAttachment("portable_staging");
    expect(() => bindPrivateAtomicStagedIssuance({ ownerUserId: "foreign-owner" }, staging))
      .toThrow("filesystem_scope_invalid");

    const wrongPurpose = portableAttachment("portable_export");
    expect(() => bindPrivateAtomicStagedIssuance({ ownerUserId }, wrongPurpose))
      .toThrow("filesystem_purpose_invalid");

    const assetScoped = {
      ...staging,
      operation: { ...staging.operation, resourceKind: "asset", assetId }
    } as typeof staging;
    expect(() => bindPrivateAtomicStagedIssuance({ ownerUserId }, assetScoped))
      .toThrow("filesystem_scope_invalid");

    expect(() => bindPrivateFilesystemCandidateAttachment(
      portableReservation("portable_staging"),
      candidate,
      { ...descriptor, contentHash: "raw-content" },
      staging.claim,
    )).toThrow("filesystem_descriptor_invalid");
    expect(() => bindPrivateFilesystemCandidateAttachment(
      portableReservation("portable_staging", { expiresAt: "2000-01-01T00:00:00.000Z" }),
      candidate,
      descriptor,
      staging.claim,
    )).toThrow("filesystem_operation_expired");
  });

  it("binds export issuance to the complete campaign or world export scope", () => {
    const scope: PortableExportScope = {
      ownerUserId,
      exportKind: "campaign_zip",
      campaignId,
      worldId,
      worldVersionId
    };
    const attachment = portableAttachment("portable_export");
    const issuance = bindPrivateAtomicExportIssuance(scope, "application/zip", attachment);

    expect(issuance.exportScope).toEqual(scope);
    expect(issuance.attachment.operation.purpose).toBe("portable_export");
    expect(Object.isFrozen(issuance.exportScope)).toBe(true);

    expect(() => bindPrivateAtomicExportIssuance({ ...scope, ownerUserId: "foreign-owner" }, "application/zip", attachment))
      .toThrow("filesystem_scope_invalid");
    expect(() => bindPrivateAtomicExportIssuance({ ...scope, campaignId: null }, "application/zip", attachment))
      .toThrow("portable_export_scope_invalid");
    expect(() => bindPrivateAtomicExportIssuance({ ...scope, exportKind: "world_json" }, "application/json", attachment))
      .toThrow("portable_export_scope_invalid");
    expect(() => bindPrivateAtomicExportIssuance(
      { ...scope, exportKind: "unsupported_export" } as never,
      "application/zip",
      attachment,
    )).toThrow("portable_export_scope_invalid");
    expect(() => bindPrivateAtomicExportIssuance(scope, "application/json", attachment))
      .toThrow("portable_export_content_type_invalid");
  });

  it("does not permit owner-only staged or export issuance signatures", () => {
    const port = null as unknown as PrivateAtomicPortableIssuancePort;
    const legacyRead = "private-legacy-read" as PrivateLegacyAnchoredReadCapability;
    expect(legacyRead).toBe("private-legacy-read");

    if (false) {
      // @ts-expect-error Staged issuance requires a transaction and one atomic issuance object.
      void port.issueStagedInput({ ownerUserId }, descriptor);
      // @ts-expect-error Export issuance requires a transaction and one atomic export issuance object.
      void port.issueExportRetrieval({ ownerUserId }, descriptor);
    }
  });
});
