import { describe, expect, it, vi } from "vitest";
import type * as PublicAssetContracts from "../../packages/application/src/assets/index.js";
import type * as PublicImportContracts from "../../packages/application/src/imports/index.js";
import {
  bindPrivateFilesystemCandidateAuthority,
  bindPrivateFilesystemDeliveryGrantRequest,
  type AssetPublicationCandidate,
  type AttachedFilesystemOperation,
  type PrivateFilesystemDeliveryGrant,
  type PrivateStorageDescriptor,
  type ReservedFilesystemOperation
} from "../../packages/application/src/assets/private-storage-lifecycle.js";
import type { PrivateLegacyAnchoredReadCapability } from "../../packages/application/src/assets/private-finalized-delivery.js";
import {
  bindPrivatePortableExportIssuance,
  bindPrivatePortableStagedIssuance,
  type PortableExportScope,
  type PrivatePortableCapabilityIssuancePort
} from "../../packages/application/src/imports/private-portable-authority.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const assetId = "22222222-2222-4222-8222-222222222222";
const campaignId = "33333333-3333-4333-8333-333333333333";
const worldId = "44444444-4444-4444-8444-444444444444";
const worldVersionId = "55555555-5555-4555-8555-555555555555";

// @ts-expect-error Adapter-private delivery grants must not cross the public asset barrel.
type LeakedDeliveryGrant = PublicAssetContracts.PrivateFilesystemDeliveryGrant;
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

describe("Task 14e3b1 private authority contracts", () => {
  it("binds staged issuance to one exact reservation, owner, purpose, candidate, and immutable descriptor snapshot", () => {
    const reservation = portableReservation("portable_staging");
    const authority = bindPrivateFilesystemCandidateAuthority(reservation, candidate, descriptor);
    const issuance = bindPrivatePortableStagedIssuance({ ownerUserId }, authority);

    expect(issuance).toMatchObject({
      owner: { ownerUserId },
      reservation: {
        operationId: "operation-portable_staging",
        operationScopeId: "scope-portable_staging",
        resourceKind: "portable",
        purpose: "portable_staging"
      },
      candidate,
      descriptor
    });
    expect(issuance).not.toBe(authority);
    expect(Object.isFrozen(issuance)).toBe(true);
    expect(Object.isFrozen(issuance.descriptor)).toBe(true);
    expect(Object.isFrozen(issuance.descriptor.identity)).toBe(true);
  });

  it("rejects foreign owner, wrong resource or purpose, malformed descriptor, and stale reservation authority", () => {
    const staging = bindPrivateFilesystemCandidateAuthority(
      portableReservation("portable_staging"),
      candidate,
      descriptor,
    );
    expect(() => bindPrivatePortableStagedIssuance({ ownerUserId: "foreign-owner" }, staging))
      .toThrow("filesystem_scope_invalid");

    const wrongPurpose = bindPrivateFilesystemCandidateAuthority(
      portableReservation("portable_export"),
      candidate,
      descriptor,
    );
    expect(() => bindPrivatePortableStagedIssuance({ ownerUserId }, wrongPurpose))
      .toThrow("filesystem_purpose_invalid");

    const assetScoped = bindPrivateFilesystemCandidateAuthority(
      portableReservation("portable_staging", { resourceKind: "asset", assetId } as Partial<ReservedFilesystemOperation>),
      candidate,
      descriptor,
    );
    expect(() => bindPrivatePortableStagedIssuance({ ownerUserId }, assetScoped))
      .toThrow("filesystem_scope_invalid");

    expect(() => bindPrivateFilesystemCandidateAuthority(
      portableReservation("portable_staging"),
      candidate,
      { ...descriptor, contentHash: "raw-content" },
    )).toThrow("filesystem_descriptor_invalid");
    expect(() => bindPrivateFilesystemCandidateAuthority(
      portableReservation("portable_staging", { expiresAt: "2000-01-01T00:00:00.000Z" }),
      candidate,
      descriptor,
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
    const authority = bindPrivateFilesystemCandidateAuthority(
      portableReservation("portable_export"),
      candidate,
      descriptor,
    );
    const issuance = bindPrivatePortableExportIssuance(scope, authority);

    expect(issuance.exportScope).toEqual(scope);
    expect(issuance.reservation.purpose).toBe("portable_export");
    expect(Object.isFrozen(issuance.exportScope)).toBe(true);

    expect(() => bindPrivatePortableExportIssuance({ ...scope, ownerUserId: "foreign-owner" }, authority))
      .toThrow("filesystem_scope_invalid");
    expect(() => bindPrivatePortableExportIssuance({ ...scope, campaignId: null }, authority))
      .toThrow("portable_export_scope_invalid");
    expect(() => bindPrivatePortableExportIssuance({ ...scope, exportKind: "world_json" }, authority))
      .toThrow("portable_export_scope_invalid");
    expect(() => bindPrivatePortableExportIssuance(
      { ...scope, exportKind: "unsupported_export" } as never,
      authority,
    )).toThrow("portable_export_scope_invalid");
  });

  it("requires finalized lifecycle and limits private delivery grants to 60 seconds", () => {
    const operation = {
      ...portableReservation("portable_export"),
      operationId: "finalized-export-operation"
    } as unknown as AttachedFilesystemOperation;

    vi.useFakeTimers();
    try {
      vi.setSystemTime("2026-08-08T12:00:00.000Z");
      const request = bindPrivateFilesystemDeliveryGrantRequest(
        operation,
        "finalized",
        candidate,
        descriptor,
        "2026-08-08T12:01:00.000Z",
      );
      expect(request).toMatchObject({ lifecycle: "finalized", operation, candidate, descriptor });
      expect(Object.isFrozen(request)).toBe(true);

      expect(() => bindPrivateFilesystemDeliveryGrantRequest(
        operation,
        "attached" as "finalized",
        candidate,
        descriptor,
        "2026-08-08T12:01:00.000Z",
      )).toThrow("filesystem_lifecycle_invalid");
      expect(() => bindPrivateFilesystemDeliveryGrantRequest(
        operation,
        "finalized",
        candidate,
        descriptor,
        "2000-01-01T00:00:00.000Z",
      )).toThrow("filesystem_delivery_grant_expired");
      expect(() => bindPrivateFilesystemDeliveryGrantRequest(
        operation,
        "finalized",
        candidate,
        descriptor,
        "2026-08-08T12:01:00.001Z",
      )).toThrow("filesystem_delivery_grant_lifetime_invalid");
      expect(() => bindPrivateFilesystemDeliveryGrantRequest(
        operation,
        "finalized",
        candidate,
        descriptor,
        "2099-01-01T00:00:00.000Z",
      )).toThrow("filesystem_delivery_grant_lifetime_invalid");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not permit owner-only staged or export issuance signatures", () => {
    const port = null as unknown as PrivatePortableCapabilityIssuancePort;
    const grant = "private-delivery-grant" as PrivateFilesystemDeliveryGrant;
    const legacyRead = "private-legacy-read" as PrivateLegacyAnchoredReadCapability;
    expect(grant).toBe("private-delivery-grant");
    expect(legacyRead).toBe("private-legacy-read");

    if (false) {
      // @ts-expect-error Staged issuance requires one validated authority object, not owner plus descriptor.
      void port.issueStagedInput({ ownerUserId }, descriptor);
      // @ts-expect-error Export issuance requires full export scope and validated authority, not owner plus descriptor.
      void port.issueExportRetrieval({ ownerUserId }, descriptor);
    }
  });
});
