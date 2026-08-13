import { describe, expect, it } from "vitest";
import type * as PublicAssetContracts from "../../packages/application/src/assets/index.js";
import type {
  FinalizedAssetDeliveryResolverPort,
  PrivateFinalizedAssetDeliveryGrant,
  PrivateFinalizedAssetDeliveryResolution,
  PrivateLegacyAnchoredReadCapability,
  PrivateLegacyReadDescriptor
} from "../../packages/application/src/assets/private-finalized-delivery.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const assetId = "22222222-2222-4222-8222-222222222222";

// @ts-expect-error Finalized delivery grants remain adapter-private.
type LeakedFinalizedGrant = PublicAssetContracts.PrivateFinalizedAssetDeliveryGrant;
// @ts-expect-error Legacy anchored reads remain adapter-private.
type LeakedLegacyRead = PublicAssetContracts.PrivateLegacyAnchoredReadCapability;
// @ts-expect-error The finalized delivery repository port remains adapter-private.
type LeakedFinalizedResolver = PublicAssetContracts.FinalizedAssetDeliveryResolverPort;

describe("Task 14e3b3 finalized delivery contracts", () => {
  it("models durable delivery as an opaque one-time grant without locator or cleanup authority", () => {
    const grant = "opaque-finalized-grant" as PrivateFinalizedAssetDeliveryGrant;
    const resolution = {
      kind: "durable_finalized",
      scope: { ownerUserId, assetId },
      request: { kind: "original" },
      descriptor: {
        assetId,
        kind: "original",
        derivativeKind: null,
        mimeType: "image/png",
        byteLength: 7,
        etag: "a".repeat(64)
      },
      grant,
      cleanupAuthority: "none"
    } satisfies PrivateFinalizedAssetDeliveryResolution;

    expect(resolution.grant).toBe(grant);
    expect(resolution).not.toHaveProperty("locator");
    expect(resolution).not.toHaveProperty("candidate");
    expect(resolution).not.toHaveProperty("path");
    expect(resolution).not.toHaveProperty("cleanupClaim");
    expect(resolution.cleanupAuthority).toBe("none");
  });

  it("models legacy delivery as an opaque one-time anchored read with no cleanup authority", () => {
    const anchoredRead = "opaque-legacy-read" as PrivateLegacyAnchoredReadCapability;
    const resolution = {
      kind: "legacy_retained",
      scope: { ownerUserId, assetId },
      request: { kind: "derivative", derivativeKind: "thumbnail" },
      descriptor: {
        assetId,
        kind: "derivative",
        derivativeKind: "thumbnail",
        mimeType: "image/webp",
        byteLength: 5,
        etag: "b".repeat(64)
      },
      anchoredRead,
      cleanupAuthority: "none"
    } satisfies PrivateFinalizedAssetDeliveryResolution;

    expect(resolution.anchoredRead).toBe(anchoredRead);
    expect(resolution).not.toHaveProperty("locator");
    expect(resolution).not.toHaveProperty("path");
    expect(resolution.cleanupAuthority).toBe("none");
  });

  it("requires exact scope and delivery intent again when either capability is redeemed", async () => {
    const grant = "opaque-finalized-grant" as PrivateFinalizedAssetDeliveryGrant;
    const anchoredRead = "opaque-legacy-read" as PrivateLegacyAnchoredReadCapability;
    const legacyDescriptor: PrivateLegacyReadDescriptor = {
      relativePath: "legacy/original.png",
      contentHash: "c".repeat(64),
      byteLength: 11
    };
    const port: FinalizedAssetDeliveryResolverPort = {
      resolveFinalizedAssetDelivery: async () => null,
      redeemFinalizedDeliveryGrant: async (scope, request, presentedGrant) =>
        scope.ownerUserId === ownerUserId
          && scope.assetId === assetId
          && request.kind === "original"
          && presentedGrant === grant
          ? {
              relativePath: "finalized/original.png",
              identity: { deviceId: "device", fileId: "file", changeToken: "change" },
              contentHash: "d".repeat(64),
              byteLength: 13
            }
          : null,
      redeemLegacyAnchoredRead: async (scope, request, presentedCapability) =>
        scope.ownerUserId === ownerUserId
          && scope.assetId === assetId
          && request.kind === "original"
          && presentedCapability === anchoredRead
          ? legacyDescriptor
          : null
    };

    await expect(port.redeemFinalizedDeliveryGrant(
      { ownerUserId, assetId },
      { kind: "original" },
      grant,
    )).resolves.toMatchObject({ relativePath: "finalized/original.png" });
    await expect(port.redeemLegacyAnchoredRead(
      { ownerUserId, assetId },
      { kind: "original" },
      anchoredRead,
    )).resolves.toEqual(legacyDescriptor);

    if (false) {
      // @ts-expect-error A raw candidate is not a finalized-delivery grant.
      void port.redeemFinalizedDeliveryGrant({ ownerUserId, assetId }, { kind: "original" }, "candidate");
      // @ts-expect-error A finalized grant is not a legacy anchored-read capability.
      void port.redeemLegacyAnchoredRead({ ownerUserId, assetId }, { kind: "original" }, grant);
    }
  });
});
