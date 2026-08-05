import { describe, expect, it, vi } from "vitest";
import {
  createAssetApplication,
  type AssetApplicationDependencies,
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
    metadata: {
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
      { ownerUserId, campaignId, turnId: "44444444-4444-4444-8444-444444444444", assetId },
      { idempotencyKey: "turn-image-selection" }
    );

    expect(selection.selectTurnIllustration).toHaveBeenCalledWith(
      { ownerUserId, campaignId, turnId: "44444444-4444-4444-8444-444444444444", assetId },
      { idempotencyKey: "turn-image-selection" }
    );
  });
});
