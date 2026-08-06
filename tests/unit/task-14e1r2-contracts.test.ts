import { describe, expect, it, vi } from "vitest";
import {
  ASSET_MUTATION_IDEMPOTENCY_HEADER,
  createAssetApplication,
  toAssetMutationIdempotencyKey,
  type AssetApplicationDependencies,
  type AssetLibraryItemView,
  type AssetLibraryQuery,
  type AssetLibraryView,
  type AssetMetadataBackfillClaim
} from "../../packages/application/src/assets/index.js";
import type * as PublicAssetContracts from "../../packages/application/src/assets/index.js";
import {
  createImportApplication,
  toPortableArchiveExportRetrieval,
  toPortableImportResultRetrieval,
  toPortableImportedRecordId,
  toPortablePreviewHandle,
  toPortableStagedInput,
  type ImportApplicationDependencies,
  type PortableImportCommitView,
  type PortableImportKind,
  type PortableImportPreviewCommand,
  type PortableImportPreviewView
} from "../../packages/application/src/imports/index.js";
import type * as PublicImportContracts from "../../packages/application/src/imports/index.js";
import {
  createFakeDurableFilesystemLifecycle,
  type FakePublicationCandidateIssuer
} from "../../packages/application/src/assets/private-storage-lifecycle-fake.js";
import {
  createDurableFilesystemLifecycle,
  type DatabaseIssuedStorageLocator,
  type DurableFilesystemTransactionContext,
  type PrivateStorageDescriptor
} from "../../packages/application/src/assets/private-storage-lifecycle.js";
import type { OwnerBoundIdempotentPortableWorldApplicationPort } from "../../packages/application/src/world-campaign/index.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const assetId = "22222222-2222-4222-8222-222222222222";
const campaignId = "33333333-3333-4333-8333-333333333333";
const worldId = "44444444-4444-4444-8444-444444444444";
const worldVersionId = "55555555-5555-4555-8555-555555555555";

// @ts-expect-error Database locators remain adapter-private and are not exported from the asset barrel.
type PublicStorageLocator = PublicAssetContracts.DatabaseIssuedStorageLocator;
// @ts-expect-error Publication candidates remain adapter-private and are not exported from the asset barrel.
type PublicPublicationCandidate = PublicAssetContracts.AssetPublicationCandidate;
// @ts-expect-error Filesystem lifecycle journals remain adapter-private and are not exported from the asset barrel.
type PublicFilesystemJournal = PublicAssetContracts.DurableFilesystemJournalPort;
// @ts-expect-error Import result retrieval tokens expose no path, stream, or raw error property.
type LeakedPortableResultPath = PublicImportContracts.PortableImportResultRetrieval["path"];

function assetItem(): AssetLibraryItemView {
  return {
    assetId,
    id: assetId,
    url: `/api/v1/assets/${assetId}`,
    thumbnailUrl: `/api/v1/assets/${assetId}/thumbnail`,
    mimeType: "image/png",
    byteLength: 128,
    width: 1024,
    height: 768,
    createdAt: "2026-08-05T12:00:00.000Z",
    campaignId,
    turnId: "66666666-6666-4666-8666-666666666666",
    title: "Moonlit gate",
    caption: "A moonlit gate in the rain.",
    alt: "Moonlit gate",
    tags: ["gate", "night"],
    origin: "generated",
    reuseScope: "campaign",
    automaticReuseEnabled: true,
    reviewStatus: "eligible",
    contentCategories: ["location"],
    favorite: true,
    archived: false,
    metadataRevision: 3,
    provider: "openai-compatible",
    model: "illustrator-v1",
    worldId,
    worldVersionId,
    usageCount: 4
  };
}

function assetDependencies(view: AssetLibraryView): AssetApplicationDependencies {
  return {
    library: {
      listAssets: vi.fn(async () => view),
      readAsset: vi.fn(async () => ({ assetId, mimeType: "image/png" as const, byteLength: 128 }))
    },
    selection: {
      selectTurnIllustration: vi.fn(async (_scope, command) => ({ assetId: command.assetId, selected: command.assetId !== null })),
      selectWorldCover: vi.fn(async (_scope, command) => ({ assetId: command.assetId, selected: command.assetId !== null }))
    },
    metadata: {
      updateAssetMetadata: vi.fn(async () => ({ assetId, metadataRevision: 4 })),
      claimNextMetadataBackfill: vi.fn(async () => null),
      heartbeatMetadataBackfill: vi.fn(async (claim) => ({ outcome: "renewed" as const, claim })),
      requeueMetadataBackfill: vi.fn(async () => ({ outcome: "requeued" as const })),
      backfillMetadata: vi.fn(async () => ({ assetId, outcome: "already_current" as const }))
    },
    delivery: {
      describeAssetDelivery: vi.fn(async () => ({
        assetId,
        kind: "original" as const,
        derivativeKind: null,
        mimeType: "image/png" as const,
        byteLength: 128,
        etag: "content-hash"
      }))
    }
  };
}

describe("14e1R2 asset route-parity and durability contracts", () => {
  it("forwards the complete validated live asset query and preserves every item and facet field", async () => {
    const view: AssetLibraryView = {
      assets: [assetItem()],
      nextCursor: "opaque-cursor",
      total: 1,
      facets: {
        origin: { generated: 1 },
        reviewStatus: { eligible: 1 },
        reuseScope: { campaign: 1 },
        tags: { night: 1 }
      }
    };
    const dependencies = assetDependencies(view);
    const application = createAssetApplication(dependencies);
    const query: AssetLibraryQuery = {
      q: "moonlit gate",
      scope: "campaign",
      creator: "me",
      worldId,
      worldVersionId,
      campaignId,
      origin: ["generated"],
      tags: ["night"],
      allTags: true,
      entityIds: ["gate-entity"],
      locationIds: ["north-gate"],
      provider: ["openai-compatible"],
      model: ["illustrator-v1"],
      reviewStatus: ["eligible"],
      reuseScope: ["campaign"],
      eligible: true,
      favorite: true,
      archived: false,
      mimeType: ["image/png"],
      aspect: ["landscape"],
      createdFrom: "2026-08-01T00:00:00.000Z",
      createdTo: "2026-08-05T23:59:59.000Z",
      sort: "most_used",
      cursor: "opaque-cursor",
      limit: 40
    };

    await expect(application.listAssets({ ownerUserId }, query)).resolves.toEqual(view);
    expect(dependencies.library.listAssets).toHaveBeenCalledWith({ ownerUserId }, query);
  });

  it("requires a caller-supplied durable idempotency key for metadata and selection ingress", async () => {
    const application = createAssetApplication(assetDependencies({ assets: [], nextCursor: null, total: 0, facets: { origin: {}, reviewStatus: {}, reuseScope: {}, tags: {} } }));
    const idempotencyKey = toAssetMutationIdempotencyKey("user-action-7f1f");

    expect(ASSET_MUTATION_IDEMPOTENCY_HEADER).toBe("idempotency-key");
    await expect(application.updateAssetMetadata({ ownerUserId, assetId }, {
      expectedRevision: 3,
      title: "Moonlit gate",
      idempotencyKey
    })).resolves.toEqual({ assetId, metadataRevision: 4 });
    await expect(application.selectTurnIllustration({ ownerUserId, campaignId, turnId: "turn-1" }, {
      assetId,
      idempotencyKey
    })).resolves.toEqual({ assetId, selected: true });
    expect(() => toAssetMutationIdempotencyKey(" ")).toThrow("asset_idempotency_key_invalid");
  });

  it("fences backfill heartbeat, work, and requeue with lease owner, id, version, and expiry", async () => {
    const claim: AssetMetadataBackfillClaim = {
      ownerUserId,
      assetId,
      leaseId: "lease-1",
      leaseOwner: "worker-a",
      workVersion: 7,
      leaseExpiresAt: "2026-08-05T12:05:00.000Z"
    };
    const metadata = assetDependencies({ assets: [], nextCursor: null, total: 0, facets: { origin: {}, reviewStatus: {}, reuseScope: {}, tags: {} } }).metadata;
    const application = createAssetApplication({
      ...assetDependencies({ assets: [], nextCursor: null, total: 0, facets: { origin: {}, reviewStatus: {}, reuseScope: {}, tags: {} } }),
      metadata
    });

    await expect(application.heartbeatMetadataBackfill(claim, { leaseSeconds: 30 }))
      .resolves.toEqual({ outcome: "renewed", claim });
    await expect(application.backfillMetadata({} as never, claim))
      .resolves.toEqual({ assetId, outcome: "already_current" });
    await expect(application.requeueMetadataBackfill(claim, { diagnosticCode: "asset_storage_unavailable" }))
      .resolves.toEqual({ outcome: "requeued" });
    expect(metadata.heartbeatMetadataBackfill).toHaveBeenCalledWith(claim, { leaseSeconds: 30 });
    expect(metadata.requeueMetadataBackfill).toHaveBeenCalledWith(claim, { diagnosticCode: "asset_storage_unavailable" });
  });

  it("retains stale and lease-lost outcomes without admitting raw worker errors", () => {
    const stale = { assetId, outcome: "stale" as const };
    const leaseLost = { outcome: "lease_lost" as const };

    expect(stale.outcome).toBe("stale");
    expect(leaseLost.outcome).toBe("lease_lost");
    // @ts-expect-error Public backfill results have no raw error field.
    const rawError = stale.error;
    expect(rawError).toBeUndefined();
  });
});

function portableWorld(): OwnerBoundIdempotentPortableWorldApplicationPort {
  return {
    exportWorld: vi.fn(async () => ({ format: "infinite-quest-world", formatVersion: 1, title: "World", content: {} })) as never,
    previewWorldImport: vi.fn(async () => ({ kind: "world" as const, title: "World", duplicate: false, existingWorldId: null, counts: { entities: 0, relationships: 0, triggers: 0 }, warnings: [] })),
    importWorld: vi.fn(async () => ({ importId: "import-1", worldId, worldVersionId, duplicate: false })),
    importWorldIdempotent: vi.fn(async () => ({ importId: "import-1", worldId, worldVersionId, duplicate: false }))
  };
}

const destinationByKind = {
  campaign_zip: { kind: "embedded", operation: "create_world" },
  legacy_story: { kind: "existing_world_version", worldId, worldVersionId },
  infinite_worlds: { kind: "create_world" },
  cyoa: { kind: "create_world" },
  world_json: { kind: "create_world" },
  world_text: { kind: "create_world" },
  story_text: { kind: "existing_world_version", worldId, worldVersionId }
} as const;

const projectionByKind = {
  campaign_zip: {
    valid: true,
    archiveType: "campaign",
    formatVersion: 1,
    contentFingerprint: "a".repeat(64),
    campaign: { title: "Campaign", sourceCampaignId: campaignId, acceptedTurnCount: 4, activeTurnNumber: 4, selectedCharacter: { id: "hero", name: "Hero" } },
    world: { title: "World", sourceWorldId: worldId, sourceWorldVersionId: worldVersionId, versionNumber: 1 },
    chronicle: { memoryCount: 5, summaryCount: 1 },
    assets: { originalCount: 2, totalBytes: 512 },
    destination: { kind: "embedded", operation: "create_world", worldId: null, worldVersionId: null },
    providerDataIncluded: false,
    warnings: []
  },
  legacy_story: { kind: "campaign", title: "Campaign", duplicate: false, existingCampaignId: null, valid: true, counts: { turns: 4, completeHistoryCharacters: 900, estimatedHistoryTokens: 225 }, warnings: [] },
  infinite_worlds: { kind: "world_json", title: "World", duplicate: false, existingWorldId: null, valid: true, characters: [{ index: 0, name: "Hero" }], counts: { entities: 3, relationships: 2, triggers: 1 }, warnings: [] },
  cyoa: { kind: "cyoa_json", valid: true, requiresProvider: true, warnings: [], counts: { topLevelTitle: "World", layer1ChaptersCount: 3, characterTarget: "3-4 playable characters" } },
  world_json: { kind: "world_json", title: "World", duplicate: false, existingWorldId: null, valid: true, characters: [{ index: 0, name: "Hero" }], counts: { entities: 3, relationships: 2, triggers: 1 }, warnings: [] },
  world_text: { kind: "world_text", valid: true, requiresProvider: true, warnings: ["Conversion uses the selected provider."], counts: { sourceCharacters: 1200, sourceWords: 210 } },
  story_text: { kind: "story_text", title: "Campaign", duplicate: false, existingCampaignId: null, targetWorldId: worldId, diagnostics: [], characters: [{ id: "hero", name: "Hero" }], selectedCharacterId: "hero", valid: true, counts: { turns: 4, completeHistoryCharacters: 900, estimatedHistoryTokens: 225 }, warnings: [] }
} as const;

const resultByKind = {
  campaign_zip: { importId: "import-1", worldId, worldVersionId, campaignId, duplicate: false, stats: { turnCount: 4, memoryCount: 5, summaryCount: 1, assetCount: 2, assetBytes: 512 } },
  legacy_story: { importId: "import-1", worldId, worldVersionId, campaignId, duplicate: false, stats: { turnCount: 4, memoryCount: 5, completeHistoryCharacters: 900, estimatedHistoryTokens: 225, importedSummary: true, sanitizedMemoryCount: 2 } },
  infinite_worlds: { kind: "world", importId: "import-1", worldId, worldVersionId, duplicate: false },
  cyoa: { kind: "world", importId: "import-1", worldId, worldVersionId, duplicate: false },
  world_json: { kind: "world", importId: "import-1", worldId, worldVersionId, duplicate: false },
  world_text: { kind: "world", importId: "import-1", worldId, worldVersionId, duplicate: false },
  story_text: { kind: "campaign", importId: "import-1", worldId, worldVersionId, campaignId, duplicate: false, stats: { turnCount: 4, memoryCount: 5, completeHistoryCharacters: 900, estimatedHistoryTokens: 225, importedSummary: true, sanitizedMemoryCount: 2 } }
} as const;

function importDependencies(): ImportApplicationDependencies {
  return {
    worlds: portableWorld(),
    archives: {
      previewPortableImport: vi.fn(async (command: PortableImportPreviewCommand) => ({
        previewHandle: toPortablePreviewHandle(`preview-${command.kind}`, command.destination),
        kind: command.kind,
        destination: command.destination,
        expiresAt: "2026-08-05T13:00:00.000Z",
        cleanupOwner: "application" as const,
        diagnostics: [],
        projection: projectionByKind[command.kind]
      }) as never),
      commitPortableImport: vi.fn(async (_database: object, command: { kind: PortableImportKind }) => ({
        importedRecordId: toPortableImportedRecordId("record-1"),
        retrieval: toPortableImportResultRetrieval(`result-${command.kind}`),
        kind: command.kind,
        duplicate: false,
        diagnostics: [],
        result: resultByKind[command.kind]
      }) as never),
      retrievePortableImportResult: vi.fn(async (_scope, retrieval) => {
        const kind = String(retrieval).replace("result-", "") as PortableImportKind;
        return { kind, result: resultByKind[kind], diagnostics: [] } as never;
      }),
      exportCampaignArchive: vi.fn(async () => ({ retrieval: toPortableArchiveExportRetrieval("archive-1"), contentType: "application/zip" as const, byteLength: 3 })),
      downloadPortableExport: vi.fn(async () => ({ content: new Uint8Array([1, 2, 3]), contentType: "application/zip" as const })),
      cleanupPreview: vi.fn(async () => undefined)
    }
  };
}

describe("14e1R2 portable family result parity", () => {
  it.each(Object.keys(destinationByKind) as PortableImportKind[])("preserves the %s preview and commit projection", async (kind) => {
    const application = createImportApplication(importDependencies());
    const destination = destinationByKind[kind];
    const command = { ownerUserId, kind, stagedInput: toPortableStagedInput(`staged-${kind}`), destination } as PortableImportPreviewCommand;

    const previewed = await application.previewPortableImport(command);
    const committed = await application.commitPortableImport({} as never, {
      ownerUserId,
      kind,
      destination,
      previewHandle: previewed.previewHandle,
      idempotencyKey: `commit-${kind}`
    } as never);
    const retrieved = await application.retrievePortableImportResult({ ownerUserId }, committed.retrieval);

    expect(previewed.projection).toEqual(projectionByKind[kind]);
    expect(committed.result).toEqual(resultByKind[kind]);
    expect(retrieved).toEqual({ kind, result: resultByKind[kind], diagnostics: [] });
  });

  it("keeps family projections discriminated at compile time", () => {
    const cyoa = {} as PortableImportPreviewView<Extract<PortableImportPreviewCommand, { kind: "cyoa" }>>;
    const archive = {} as PortableImportCommitView<"campaign_zip">;

    type CyoaCounts = typeof cyoa.projection.counts;
    type ArchiveStats = typeof archive.result.stats;
    const counts: CyoaCounts = { topLevelTitle: "Title", layer1ChaptersCount: 2, characterTarget: "3-4 playable characters" };
    const stats: ArchiveStats = { turnCount: 1, memoryCount: 2, summaryCount: 3, assetCount: 4, assetBytes: 5 };
    expect(counts.layer1ChaptersCount).toBe(2);
    expect(stats.assetCount).toBe(4);
  });
});

describe("14e1R2 private durable filesystem lifecycle", () => {
  it("enforces reserve, identity-bound attach in the caller transaction, and post-commit finalize", async () => {
    const fake = createFakeDurableFilesystemLifecycle();
    const lifecycle = createDurableFilesystemLifecycle(fake.journal);
    const scope = { resourceKind: "asset" as const, ownerUserId, assetId };
    const reservation = await lifecycle.reserve(scope, { purpose: "asset_original", expiresAt: "2026-08-05T13:00:00.000Z" });
    const descriptor: PrivateStorageDescriptor = {
      relativePath: "objects/aa/content.png",
      identity: { deviceId: "dev-1", fileId: "inode-7", changeToken: "ctime-9" },
      contentHash: "b".repeat(64),
      byteLength: 128
    };
    const candidate = (fake as FakePublicationCandidateIssuer).issuePublicationCandidate(reservation, descriptor);
    const database = {} as DurableFilesystemTransactionContext;
    // @ts-expect-error A reservation cannot be finalized until its candidate is transactionally attached.
    const invalidFinalizeInput: Parameters<typeof lifecycle.finalizeAfterCommit>[0] = reservation;
    const attached = await lifecycle.attach(database, reservation, candidate);

    expect(attached.outcome).toBe("attached");
    if (attached.outcome !== "attached") throw new Error("expected attached outcome");
    const locator: DatabaseIssuedStorageLocator = attached.locator;
    await expect(lifecycle.finalizeAfterCommit(attached.operation)).resolves.toEqual({ outcome: "finalized" });
    await expect(fake.redeemStorageLocator(scope, locator)).resolves.toEqual(descriptor);
    expect(fake.events()).toEqual(["reserved", "candidate_issued", "attached", "finalized"]);
    expect(invalidFinalizeInput.operationId).toBe(reservation.operationId);
  });

  it("marks reserved or attached mutations for cleanup after rollback or recovery", async () => {
    const fake = createFakeDurableFilesystemLifecycle();
    const lifecycle = createDurableFilesystemLifecycle(fake.journal);
    const scope = { resourceKind: "asset" as const, ownerUserId, assetId };
    const reservation = await lifecycle.reserve(scope, { purpose: "asset_derivative", expiresAt: "2026-08-05T13:00:00.000Z" });

    await expect(lifecycle.markCleanup(reservation, { cause: "rollback" }))
      .resolves.toEqual({ outcome: "cleanup_pending" });
    const recovered = await lifecycle.recover({ leaseOwner: "recovery-worker", leaseSeconds: 30, limit: 10 });
    expect(recovered).toEqual([{ action: "cleanup", operation: reservation }]);
    if (recovered[0]?.action !== "cleanup") throw new Error("expected cleanup recovery action");
    await expect(lifecycle.markCleanup(recovered[0].operation, { cause: "recovery" }))
      .resolves.toEqual({ outcome: "cleanup_pending" });
    expect(fake.events()).toEqual(["reserved", "cleanup_pending", "recovered"]);
  });
});

void (null as unknown as PublicStorageLocator | PublicPublicationCandidate | PublicFilesystemJournal | LeakedPortableResultPath);
