import { describe, expect, it } from "vitest";
import {
  importProgressQuerySchema,
  importProgressResponseSchema,
  importProgressNotFoundResponseSchema
} from "../../packages/contracts/src/imports.js";
import {
  bindImportProgressLookup,
  bindCampaignArchiveExportScope,
  bindPortableImportCommitIngress,
  bindWorldJsonExportScope,
  mapCampaignArchivePreviewHttpResult,
  mapHandlelessPortablePreviewHttpResult,
  mapImportProgressHttpResult,
  mapPortableImportCommitHttpResult,
  resolveArchivePreviewExpiryDisposition,
  toPortableImportIdempotencyKey,
  type PortableImportCommitIngressRequest
} from "../../packages/application/src/imports/index.js";
import { toServerStableReplayKey } from "../../packages/application/src/imports/http-compatibility.js";
import {
  bindAssetMetadataHttpIngress,
  bindTurnAssetSelectionHttpIngress,
  bindWorldAssetSelectionHttpIngress,
  toAssetServerStableReplayKey
} from "../../packages/application/src/assets/http-compatibility.js";
import {
  toPortableImportedRecordId,
  toPortableImportResultRetrieval,
  toPortablePreviewHandle,
  toPortableStagedInput,
  type PortableImportCommitView,
  type PortableImportPreviewCommand,
  type PortableImportPreviewProjectionByKind,
  type PortableImportPreviewView
} from "../../packages/application/src/imports/index.js";
import type {
  FinalizedAssetDeliveryResolverPort,
  PrivateFinalizedAssetDeliveryResolution
} from "../../packages/application/src/assets/private-finalized-delivery.js";
import type * as PublicAssetContracts from "../../packages/application/src/assets/index.js";
import type * as PublicImportContracts from "../../packages/application/src/imports/index.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const worldId = "22222222-2222-4222-8222-222222222222";
const worldVersionId = "33333333-3333-4333-8333-333333333333";
const campaignId = "44444444-4444-4444-8444-444444444444";
const assetId = "55555555-5555-4555-8555-555555555555";

// @ts-expect-error Private delivery resolution stays out of the public asset barrel.
type LeakedPrivateDeliveryResolution = PublicAssetContracts.PrivateFinalizedAssetDeliveryResolution;
// @ts-expect-error Database locator redemption stays out of the public asset barrel.
type LeakedDatabaseLocator = PublicAssetContracts.DatabaseIssuedStorageLocator;
// @ts-expect-error Only trusted server adapters may mint stable replay keys.
type LeakedStableReplayKeyIssuer = PublicImportContracts.toServerStableReplayKey;
// @ts-expect-error Only trusted server adapters may mint asset stable replay keys.
type LeakedAssetStableReplayKeyIssuer = PublicAssetContracts.toAssetServerStableReplayKey;

const campaignDestination = { kind: "embedded", operation: "create_world" } as const;
const existingDestination = { kind: "existing_world_version", worldId, worldVersionId } as const;
const createWorldDestination = { kind: "create_world" } as const;

function ingressRequest<Destination extends PortableImportPreviewCommand["destination"]>(
  kind: PortableImportPreviewCommand["kind"],
  destination: Destination,
  previewHandle?: ReturnType<typeof toPortablePreviewHandle<Destination>>,
): PortableImportCommitIngressRequest<Destination> {
  return {
    owner: { ownerUserId },
    kind,
    destination,
    serverStableReplayKey: toServerStableReplayKey(`server-replay-${kind}`),
    ...(previewHandle === undefined ? {} : { previewHandle })
  };
}

describe("Task 14e3a HTTP compatibility contracts", () => {
  it.each([
    ["campaign_zip", campaignDestination, "durable_preview"],
    ["campaign_zip", existingDestination, "durable_preview"],
    ["legacy_story", existingDestination, "atomic_repreview"],
    ["story_text", existingDestination, "atomic_repreview"],
    ["infinite_worlds", createWorldDestination, "atomic_repreview"],
    ["cyoa", createWorldDestination, "atomic_repreview"],
    ["world_json", createWorldDestination, "atomic_repreview"],
    ["world_text", createWorldDestination, "atomic_repreview"]
  ] as const)("binds %s to server owner and the selected compatibility choreography", (kind, destination, expected) => {
    const ingress = kind === "campaign_zip"
      ? bindPortableImportCommitIngress(ingressRequest(
        kind,
        destination,
        toPortablePreviewHandle(`preview-${kind}`, destination),
      ))
      : bindPortableImportCommitIngress(ingressRequest(kind, destination));

    expect(ingress.owner).toEqual({ ownerUserId });
    expect(ingress.kind).toBe(kind);
    expect(ingress.destination).toEqual(destination);
    expect(ingress.choreography.kind).toBe(expected);
    expect(ingress.idempotency).toEqual({
      source: "server_stable_compatibility",
      key: `server-replay-${kind}`
    });
    expect(ingress).not.toHaveProperty("sourceInstallationId");
    expect(ingress).not.toHaveProperty("importedRecordId");
  });

  it("requires the server-issued campaign preview handle but prohibits one on atomic re-preview families", () => {
    expect(() => bindPortableImportCommitIngress(ingressRequest("campaign_zip", campaignDestination)))
      .toThrow("portable_preview_handle_required");
    expect(() => bindPortableImportCommitIngress(ingressRequest(
      "legacy_story",
      existingDestination,
      toPortablePreviewHandle("wrong-family-handle", existingDestination),
    ))).toThrow("portable_preview_handle_unexpected");
  });

  it("accepts a validated Idempotency-Key header and rejects ambiguous or unsafe key material", () => {
    const request = {
      ...ingressRequest("legacy_story", existingDestination),
      idempotencyHeader: "browser-action-42"
    };

    expect(bindPortableImportCommitIngress(request).idempotency).toEqual({
      source: "idempotency_header",
      key: "browser-action-42"
    });
    expect(() => toPortableImportIdempotencyKey(" leading-space")).toThrow("portable_import_idempotency_key_invalid");
    expect(() => toPortableImportIdempotencyKey("line\nbreak")).toThrow("portable_import_idempotency_key_invalid");
    expect(() => toPortableImportIdempotencyKey("x".repeat(201))).toThrow("portable_import_idempotency_key_invalid");
  });

  it("binds campaign and world exports to the server owner and full resource scope", () => {
    expect(bindCampaignArchiveExportScope({ ownerUserId }, { campaignId, worldId, worldVersionId })).toEqual({
      ownerUserId,
      campaignId,
      worldId,
      worldVersionId
    });
    expect(bindWorldJsonExportScope({ ownerUserId }, { worldId, worldVersionId })).toEqual({
      ownerUserId,
      worldId,
      worldVersionId
    });
    expect(() => bindCampaignArchiveExportScope(
      { ownerUserId },
      { campaignId, worldId: "", worldVersionId },
    )).toThrow("portable_export_scope_invalid");
  });

  it("binds legacy asset mutation bodies to server-resolved resource scope and stable idempotency", () => {
    const compatibility = { serverStableReplayKey: toAssetServerStableReplayKey("asset-stable-replay") };

    expect(bindAssetMetadataHttpIngress(
      { ownerUserId },
      assetId,
      { expectedRevision: 3, title: "Lantern" },
      compatibility,
    )).toEqual({
      scope: { ownerUserId, assetId },
      command: { expectedRevision: 3, title: "Lantern", idempotencyKey: "asset-stable-replay" },
      idempotencySource: "server_stable_compatibility"
    });
    expect(bindTurnAssetSelectionHttpIngress(
      { ownerUserId },
      { campaignId, turnId: "66666666-6666-4666-8666-666666666666" },
      { assetId: null },
      { ...compatibility, idempotencyHeader: "browser-turn-clear" },
    )).toEqual({
      scope: { ownerUserId, campaignId, turnId: "66666666-6666-4666-8666-666666666666" },
      command: { assetId: null, idempotencyKey: "browser-turn-clear" },
      idempotencySource: "idempotency_header"
    });
    expect(bindWorldAssetSelectionHttpIngress(
      { ownerUserId },
      { worldId },
      { assetId },
      compatibility,
    )).toEqual({
      scope: { ownerUserId, worldId },
      command: { assetId, idempotencyKey: "asset-stable-replay" },
      idempotencySource: "server_stable_compatibility"
    });
  });

  it("rejects unsafe asset idempotency headers and missing server-resolved turn scope", () => {
    const compatibility = { serverStableReplayKey: toAssetServerStableReplayKey("asset-stable-replay") };
    expect(() => bindTurnAssetSelectionHttpIngress(
      { ownerUserId },
      { campaignId: "", turnId: "66666666-6666-4666-8666-666666666666" },
      { assetId },
      compatibility,
    )).toThrow("asset_http_scope_invalid");
    expect(() => bindAssetMetadataHttpIngress(
      { ownerUserId },
      assetId,
      { expectedRevision: 3, title: "Lantern" },
      { ...compatibility, idempotencyHeader: "line\nbreak" },
    )).toThrow("asset_idempotency_key_invalid");
  });

  it("maps campaign preview handles and commit results without exposing private retrieval capabilities", () => {
    const projection: PortableImportPreviewProjectionByKind["campaign_zip"] = {
      valid: true,
      archiveType: "campaign",
      formatVersion: 1,
      contentFingerprint: "a".repeat(64),
      campaign: { title: "Campaign", sourceCampaignId: campaignId, acceptedTurnCount: 0, activeTurnNumber: 0, selectedCharacter: null },
      world: { title: "World", sourceWorldId: worldId, sourceWorldVersionId: worldVersionId, versionNumber: 1 },
      chronicle: { memoryCount: 0, summaryCount: 0 },
      assets: { originalCount: 0, totalBytes: 0 },
      destination: { kind: "embedded", operation: "create_world", worldId: null, worldVersionId: null },
      providerDataIncluded: false,
      warnings: []
    };
    const previewCommand = {
      ownerUserId,
      kind: "campaign_zip",
      stagedInput: toPortableStagedInput("campaign-archive-staged"),
      destination: campaignDestination
    } as const satisfies PortableImportPreviewCommand;
    const preview: PortableImportPreviewView<typeof previewCommand> = {
      previewHandle: toPortablePreviewHandle("p".repeat(40), campaignDestination),
      kind: "campaign_zip",
      destination: campaignDestination,
      expiresAt: "2026-08-08T13:00:00.000Z",
      cleanupOwner: "application",
      diagnostics: [],
      projection
    };
    const result = {
      importId: "66666666-6666-4666-8666-666666666666",
      worldId,
      worldVersionId,
      campaignId,
      duplicate: false,
      stats: { turnCount: 0, memoryCount: 0, summaryCount: 0, assetCount: 0, assetBytes: 0 }
    };
    const commit: PortableImportCommitView<"campaign_zip"> = {
      importedRecordId: toPortableImportedRecordId("imported-record"),
      retrieval: toPortableImportResultRetrieval("private-result-retrieval"),
      kind: "campaign_zip",
      duplicate: false,
      diagnostics: [],
      result
    };

    expect(mapCampaignArchivePreviewHttpResult(preview)).toEqual({
      ...projection,
      previewToken: "p".repeat(40),
      expiresAt: "2026-08-08T13:00:00.000Z"
    });
    expect(mapPortableImportCommitHttpResult(commit)).toEqual({ statusCode: 201, body: result });
    expect(mapPortableImportCommitHttpResult({ ...commit, duplicate: true, result: { ...result, duplicate: true } }))
      .toEqual({ statusCode: 200, body: { ...result, duplicate: true } });
  });

  it("preserves handle-less preview response shapes for compatibility families", () => {
    const projection: PortableImportPreviewProjectionByKind["legacy_story"] = {
      kind: "campaign",
      title: "Campaign",
      duplicate: false,
      existingCampaignId: null,
      valid: true,
      counts: { turns: 0, completeHistoryCharacters: 0, estimatedHistoryTokens: 0 },
      warnings: []
    };
    const previewCommand = {
      ownerUserId,
      kind: "legacy_story",
      stagedInput: toPortableStagedInput("legacy-story-staged"),
      destination: existingDestination
    } as const satisfies PortableImportPreviewCommand;
    const view: PortableImportPreviewView<typeof previewCommand> = {
      previewHandle: toPortablePreviewHandle("internal-preview", existingDestination),
      kind: "legacy_story",
      destination: existingDestination,
      expiresAt: "2026-08-08T13:00:00.000Z",
      cleanupOwner: "application",
      diagnostics: [],
      projection
    };

    expect(mapHandlelessPortablePreviewHttpResult(view)).toEqual(projection);
    expect(mapHandlelessPortablePreviewHttpResult(view)).not.toHaveProperty("previewHandle");
    expect(mapHandlelessPortablePreviewHttpResult(view)).not.toHaveProperty("previewToken");
  });

  it("retains /imports/progress as a bounded owner-scoped status lookup, not authority", () => {
    expect(importProgressQuerySchema.parse({ key: "cyoa.json:1234" })).toEqual({ key: "cyoa.json:1234" });
    expect(importProgressQuerySchema.safeParse({ key: "x".repeat(1025) }).success).toBe(false);
    expect(importProgressResponseSchema.parse({
      status: "processing",
      phase: "generating",
      progressPercent: 45,
      message: "Generating world"
    })).toEqual({ status: "processing", phase: "generating", progressPercent: 45, message: "Generating world" });
    expect(importProgressResponseSchema.safeParse({
      status: "processing",
      phase: "generating",
      progressPercent: 101,
      message: "Generating world",
      rawError: "secret"
    }).success).toBe(false);

    expect(bindImportProgressLookup({ ownerUserId }, "cyoa.json:1234")).toEqual({
      owner: { ownerUserId },
      key: "cyoa.json:1234",
      disposition: "owner_scoped_bounded_status",
      authority: "none"
    });
    expect(mapImportProgressHttpResult(null)).toEqual({
      statusCode: 404,
      body: { error: "No active import found for the provided key." }
    });
    expect(importProgressNotFoundResponseSchema.parse(mapImportProgressHttpResult(null).body)).toEqual({
      error: "No active import found for the provided key."
    });
  });
});

describe("Task 14e3a legacy retention and private delivery contracts", () => {
  it.each(["retain_until_secure_cleanup", "live_path_cleanup_compatibility"] as const)(
    "retains path-only legacy preview bytes after expiry for %s",
    (legacyDrainPolicy) => {
      expect(resolveArchivePreviewExpiryDisposition({
        storageSecurityState: "legacy_path_v1",
        secureStagedInputId: null,
        legacyDrainPolicy
      })).toEqual({
        kind: "legacy_retained",
        expiryDisposition: "retain_bytes",
        cleanupAuthority: "none"
      });
    },
  );

  it("allows only identity-bound preview expiry to request durable staged-input cleanup", () => {
    expect(resolveArchivePreviewExpiryDisposition({
      storageSecurityState: "identity_bound_v2",
      secureStagedInputId: "77777777-7777-4777-8777-777777777777",
      legacyDrainPolicy: "retain_until_secure_cleanup"
    })).toEqual({
      kind: "durable_staged_input",
      secureStagedInputId: "77777777-7777-4777-8777-777777777777",
      expiryDisposition: "cleanup_with_identity_fence",
      cleanupAuthority: "durable_staged_input"
    });
  });

  it("models finalized delivery as durable locator authority or retained legacy read-only fallback", () => {
    const durable = {
      kind: "durable_finalized",
      scope: { ownerUserId, assetId },
      request: { kind: "original" },
      descriptor: { assetId, kind: "original", derivativeKind: null, mimeType: "image/png", byteLength: 3, etag: "hash" },
      locator: "private-database-locator",
      cleanupAuthority: "durable_journal_only"
    } as unknown as PrivateFinalizedAssetDeliveryResolution;
    const legacy = {
      kind: "legacy_retained",
      scope: { ownerUserId, assetId },
      request: { kind: "derivative", derivativeKind: "thumbnail" },
      descriptor: { assetId, kind: "derivative", derivativeKind: "thumbnail", mimeType: "image/png", byteLength: 2, etag: "thumb-hash" },
      cleanupAuthority: "none"
    } satisfies PrivateFinalizedAssetDeliveryResolution;
    const resolver: FinalizedAssetDeliveryResolverPort = {
      resolveFinalizedAssetDelivery: async (_scope, request) => request.kind === "original" ? durable : legacy
    };

    expect(durable.kind).toBe("durable_finalized");
    expect(legacy).not.toHaveProperty("locator");
    expect(legacy).not.toHaveProperty("path");
    expect(legacy.cleanupAuthority).toBe("none");
    expect(resolver).toBeDefined();
  });
});
