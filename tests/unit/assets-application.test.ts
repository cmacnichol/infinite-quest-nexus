import { describe, expect, it, vi } from "vitest";
import {
  createAssetApplication,
  type AssetApplicationDependencies,
  type AssetDeliveryRequest,
  type AssetMetadataBackfillClaim,
  type AssetTransactionContext
} from "../../packages/application/src/assets/index.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const assetId = "22222222-2222-4222-8222-222222222222";
const campaignId = "33333333-3333-4333-8333-333333333333";

function dependencies(overrides: Partial<AssetApplicationDependencies> = {}): AssetApplicationDependencies {
  return {
    library: {
      listAssets: vi.fn(async () => ({ assets: [], nextCursor: null, total: 0 })),
      readAsset: vi.fn(async () => ({ assetId, mimeType: "image/png" as const, byteLength: 3 }))
    },
    selection: {
      selectTurnIllustration: vi.fn(async () => ({ assetId, selected: true })),
      selectWorldCover: vi.fn(async () => ({ assetId, selected: true }))
    },
    delivery: {
      describeAssetDelivery: vi.fn(async (_scope, request) => request.kind === "original"
        ? { assetId, kind: "original" as const, derivativeKind: null, mimeType: "image/png" as const, byteLength: 3, etag: "asset-content-hash" }
        : { assetId, kind: "derivative" as const, derivativeKind: request.derivativeKind, mimeType: "image/png" as const, byteLength: 3, etag: "asset-content-hash" })
    },
    metadata: {
      updateAssetMetadata: vi.fn(async () => ({ assetId, metadataRevision: 2 })),
      claimNextMetadataBackfill: vi.fn(async (): Promise<AssetMetadataBackfillClaim | null> => null),
      backfillMetadata: vi.fn(async () => ({ assetId, outcome: "updated" as const }))
    },
    ...overrides
  };
}

describe("asset application contracts", () => {
  it("requires an explicit non-empty owner scope before listing the asset library", async () => {
    const application = createAssetApplication(dependencies());

    await expect(application.listAssets({ ownerUserId: "" }, {}))
      .rejects.toMatchObject({ code: "owner_scope_required" });
  });

  it("forwards worker metadata writes through the caller-owned transaction and database-derived claim", async () => {
    const database = {} as AssetTransactionContext;
    const claim: AssetMetadataBackfillClaim = {
      ownerUserId,
      assetId,
      leaseId: "asset-backfill-lease",
      leaseExpiresAt: "2026-08-05T12:00:00.000Z"
    };
    const metadata = {
      updateAssetMetadata: vi.fn(async () => ({ assetId, metadataRevision: 2 })),
      claimNextMetadataBackfill: vi.fn(async () => claim),
      backfillMetadata: vi.fn(async () => ({ assetId, outcome: "updated" as const }))
    };
    const application = createAssetApplication(dependencies({ metadata }));

    await expect(application.claimNextMetadataBackfill({ workerId: "worker-a", leaseSeconds: 30 }))
      .resolves.toEqual(claim);
    await expect(application.backfillMetadata(database, claim)).resolves.toEqual({ assetId, outcome: "updated" });
    expect(metadata.backfillMetadata).toHaveBeenCalledWith(database, claim);
  });

  it("requires campaign and asset scope for a turn illustration selection", async () => {
    const selection = { selectTurnIllustration: vi.fn(async () => ({ assetId, selected: true })), selectWorldCover: vi.fn(async () => ({ assetId, selected: true })) };
    const application = createAssetApplication(dependencies({ selection }));

    await application.selectTurnIllustration(
      { ownerUserId, campaignId, turnId: "44444444-4444-4444-8444-444444444444" },
      { assetId, idempotencyKey: "turn-image-selection" }
    );

    expect(selection.selectTurnIllustration).toHaveBeenCalledWith(
      { ownerUserId, campaignId, turnId: "44444444-4444-4444-8444-444444444444" },
      { assetId, idempotencyKey: "turn-image-selection" }
    );
  });

  it("delegates an owner-scoped metadata update and original or derivative delivery descriptor", async () => {
    const metadata = {
      claimNextMetadataBackfill: vi.fn(async (): Promise<AssetMetadataBackfillClaim | null> => null),
      backfillMetadata: vi.fn(async () => ({ assetId, outcome: "updated" as const })),
      updateAssetMetadata: vi.fn(async () => ({ assetId, metadataRevision: 3 }))
    };
    const delivery = {
      describeAssetDelivery: vi.fn(async (_scope, request: AssetDeliveryRequest) => request.kind === "original"
        ? { assetId, kind: "original" as const, derivativeKind: null, mimeType: "image/png" as const, byteLength: 3, etag: "asset-content-hash" }
        : { assetId, kind: "derivative" as const, derivativeKind: request.derivativeKind, mimeType: "image/png" as const, byteLength: 3, etag: "asset-content-hash" })
    };
    const application = createAssetApplication(dependencies({ metadata, delivery }));
    const scope = { ownerUserId, assetId };

    await expect(application.updateAssetMetadata(scope, {
      expectedRevision: 2,
      title: "Lantern",
      idempotencyKey: "asset-metadata-2"
    })).resolves.toEqual({ assetId, metadataRevision: 3 });
    await expect(application.describeAssetDelivery(scope, { kind: "original" }))
      .resolves.toMatchObject({ kind: "original", derivativeKind: null });
    await expect(application.describeAssetDelivery(scope, { kind: "derivative", derivativeKind: "thumbnail" }))
      .resolves.toMatchObject({ kind: "derivative", derivativeKind: "thumbnail" });
    expect(metadata.updateAssetMetadata).toHaveBeenCalledWith(scope, {
      expectedRevision: 2,
      title: "Lantern",
      idempotencyKey: "asset-metadata-2"
    });
  });

  it("treats null as an explicit authorized selection clear and rejects an omitted asset selection", async () => {
    const selection = {
      selectTurnIllustration: vi.fn(async (_scope, command) => ({ assetId: command.assetId, selected: command.assetId !== null })),
      selectWorldCover: vi.fn(async (_scope, command) => ({ assetId: command.assetId, selected: command.assetId !== null }))
    };
    const application = createAssetApplication(dependencies({ selection }));
    const scope = { ownerUserId, campaignId, turnId: "44444444-4444-4444-8444-444444444444" };

    await expect(application.selectTurnIllustration(scope, { assetId: null, idempotencyKey: "turn-image-clear" }))
      .resolves.toEqual({ assetId: null, selected: false });
    expect(selection.selectTurnIllustration).toHaveBeenCalledWith(scope, { assetId: null, idempotencyKey: "turn-image-clear" });
    await expect(application.selectTurnIllustration(scope, { idempotencyKey: "missing-asset" } as never))
      .rejects.toMatchObject({ code: "asset_scope_required" });
    expect(selection.selectTurnIllustration).toHaveBeenCalledTimes(1);
  });
});
