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
  type PortableImportCommitIngressRequest,
  type ValidatedAtomicRepreviewPayload
} from "../../packages/application/src/imports/index.js";
import {
  bindOwnerBoundPortableStagedInput,
  bindValidatedAtomicRepreviewPayload,
  executeAtomicPortableImportCommit,
  toServerStableReplayKey,
  toValidatedPortableContentFingerprint
} from "../../packages/application/src/imports/http-compatibility.js";
import {
  bindAssetMetadataHttpIngress,
  bindTurnAssetSelectionHttpIngress,
  bindWorldAssetSelectionHttpIngress,
  mapLegacyTurnAssetSelectionHttpResult,
  mapLegacyWorldAssetSelectionHttpResult,
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
const providerProfileId = "88888888-8888-4888-8888-888888888888";

// @ts-expect-error Private delivery resolution stays out of the public asset barrel.
type LeakedPrivateDeliveryResolution = PublicAssetContracts.PrivateFinalizedAssetDeliveryResolution;
// @ts-expect-error Database locator redemption stays out of the public asset barrel.
type LeakedDatabaseLocator = PublicAssetContracts.DatabaseIssuedStorageLocator;
// @ts-expect-error Only trusted server adapters may mint stable replay keys.
type LeakedStableReplayKeyIssuer = PublicImportContracts.toServerStableReplayKey;
// @ts-expect-error Only trusted server adapters may mint asset stable replay keys.
type LeakedAssetStableReplayKeyIssuer = PublicAssetContracts.toAssetServerStableReplayKey;
// @ts-expect-error Only trusted adapters may bind validated atomic payloads.
type LeakedAtomicPayloadIssuer = PublicImportContracts.bindValidatedAtomicRepreviewPayload;

type RequireCyoaPayload<Payload extends ValidatedAtomicRepreviewPayload<"cyoa">> = Payload;
// @ts-expect-error A Legacy Story validated payload cannot satisfy the CYOA family contract.
type CrossFamilyAtomicPayload = RequireCyoaPayload<ValidatedAtomicRepreviewPayload<"legacy_story">>;
type RequireCreateWorldDestination<Destination extends Readonly<{ kind: "create_world" }>> = Destination;
// @ts-expect-error A Legacy Story existing-world destination cannot satisfy a create-world contract.
type CrossDestinationAtomicPayload = RequireCreateWorldDestination<ValidatedAtomicRepreviewPayload<"legacy_story">["destination"]>;

const campaignDestination = { kind: "embedded", operation: "create_world" } as const;
const existingDestination = { kind: "existing_world_version", worldId, worldVersionId } as const;
const createWorldDestination = { kind: "create_world" } as const;

function atomicPayload(kind: Exclude<PortableImportPreviewCommand["kind"], "campaign_zip">) {
  if (kind === "legacy_story") {
    return {
      sourceName: "legacy.story",
      story: { world: { title: "Legacy World" }, turns: [] },
      targetWorldVersionId: worldVersionId
    };
  }
  if (kind === "world_json") {
    return {
      sourceName: "world.json",
      worldExport: {
        format: "infinite-quest-world",
        formatVersion: 1,
        title: "Portable World",
        content: { world: { title: "Portable World" } }
      }
    };
  }
  const sourceKind = kind === "infinite_worlds" ? "world_json" : kind === "cyoa" ? "cyoa_json" : kind;
  return {
    sourceName: `${kind}.txt`,
    sourceText: kind === "cyoa" ? "{\"chapters\":{}}" : "validated source text",
    sourceKind,
    selectedCharacterIndex: 0,
    enrichFinalTurn: false,
    ...(kind === "story_text" ? { targetWorldVersionId: worldVersionId } : {}),
    ...(kind === "cyoa" || kind === "world_text" ? { providerProfileId } : {})
  };
}

function ingressRequest<Destination extends PortableImportPreviewCommand["destination"]>(
  kind: PortableImportPreviewCommand["kind"],
  destination: Destination,
  previewHandle?: ReturnType<typeof toPortablePreviewHandle<Destination>>,
): PortableImportCommitIngressRequest<Destination> {
  if (kind !== "campaign_zip") {
    const contentFingerprint = toValidatedPortableContentFingerprint("a".repeat(64));
    const stagedInputHandle = toPortableStagedInput(`staged-${kind}`);
    const validatedPayload = bindValidatedAtomicRepreviewPayload({
      owner: { ownerUserId },
      kind,
      destination,
      contentFingerprint,
      stagedInput: stagedInputHandle,
      payload: atomicPayload(kind)
    } as never);
    const stagedInput = bindOwnerBoundPortableStagedInput({
      owner: { ownerUserId },
      kind,
      destination,
      contentFingerprint,
      stagedInput: stagedInputHandle
    } as never);
    return {
      owner: { ownerUserId },
      kind,
      destination,
      validatedPayload,
      stagedInput,
      ...(previewHandle === undefined ? {} : { previewHandle })
    } as PortableImportCommitIngressRequest<Destination>;
  }
  return {
    owner: { ownerUserId },
    kind,
    destination,
    serverStableReplayKey: toServerStableReplayKey(`server-replay-${kind}`),
    ...(previewHandle === undefined ? {} : { previewHandle })
  } as unknown as PortableImportCommitIngressRequest<Destination>;
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
      key: kind === "campaign_zip"
        ? `server-replay-${kind}`
        : expect.stringMatching(/^pr\|11111111-1111-4111-8111-111111111111\|/u)
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

    expect(bindPortableImportCommitIngress(request as never).idempotency).toEqual({
      source: "idempotency_header",
      key: "browser-action-42"
    });
    expect(() => toPortableImportIdempotencyKey(" leading-space")).toThrow("portable_import_idempotency_key_invalid");
    expect(() => toPortableImportIdempotencyKey("line\nbreak")).toThrow("portable_import_idempotency_key_invalid");
    expect(() => toPortableImportIdempotencyKey("x".repeat(201))).toThrow("portable_import_idempotency_key_invalid");
  });

  it("executes atomic re-preview, mutation, and portable completion inside the caller transaction", async () => {
    const ingress = bindPortableImportCommitIngress(ingressRequest("cyoa", createWorldDestination));
    if (ingress.choreography.kind !== "atomic_repreview") throw new Error("expected atomic choreography");
    const events: string[] = [];
    const result = await executeAtomicPortableImportCommit(
      ingress,
      {
        run: async (work) => {
          events.push("transaction-open");
          const value = await work({ transactionId: "caller-transaction" });
          events.push("transaction-commit");
          return value;
        }
      },
      async (transaction, command) => {
        events.push("preview-domain-consume");
        expect(transaction).toEqual({ transactionId: "caller-transaction" });
        expect(command.kind).toBe("cyoa");
        expect(command.owner).toEqual({ ownerUserId });
        expect(command.destination).toEqual(createWorldDestination);
        expect(command.payload).toMatchObject({ sourceKind: "cyoa_json", providerProfileId });
        expect(command.stagedInput).toBe("staged-cyoa");
        return "committed";
      },
    );

    expect(result).toBe("committed");
    expect(events).toEqual(["transaction-open", "preview-domain-consume", "transaction-commit"]);
  });

  it("rechecks the bound ingress scope before opening the atomic transaction", async () => {
    const ingress = bindPortableImportCommitIngress(ingressRequest("legacy_story", existingDestination));
    const events: string[] = [];
    const transactionRunner = {
      run: async <Result>(work: (transaction: object) => Promise<Result>) => {
        events.push("transaction-open");
        return work({ transactionId: "must-not-open" });
      }
    };
    const core = async () => {
      events.push("core-called");
      return "committed";
    };

    await expect(executeAtomicPortableImportCommit(
      { ...ingress, kind: "story_text" } as never,
      transactionRunner,
      core,
    )).rejects.toThrow("portable_atomic_kind_mismatch");
    await expect(executeAtomicPortableImportCommit(
      { ...ingress, destination: createWorldDestination } as never,
      transactionRunner,
      core,
    )).rejects.toThrow("portable_atomic_destination_mismatch");
    await expect(executeAtomicPortableImportCommit(
      {
        ...ingress,
        idempotency: {
          source: "server_stable_compatibility",
          key: toPortableImportIdempotencyKey("substituted-stable-idempotency")
        }
      } as never,
      transactionRunner,
      core,
    )).rejects.toThrow("portable_atomic_replay_key_mismatch");

    expect(events).toEqual([]);
  });

  it("rejects cloned bindings and coordinated staged-input plus payload substitution", async () => {
    const ingress = bindPortableImportCommitIngress(ingressRequest("legacy_story", existingDestination));
    if (ingress.choreography.kind !== "atomic_repreview") throw new Error("expected atomic choreography");
    const events: string[] = [];
    const transactionRunner = {
      run: async <Result>(work: (transaction: object) => Promise<Result>) => {
        events.push("transaction-open");
        return work({ transactionId: "must-not-open" });
      }
    };
    const core = async () => {
      events.push("core-called");
      return "committed";
    };

    await expect(executeAtomicPortableImportCommit(
      {
        ...ingress,
        choreography: {
          ...ingress.choreography,
          validatedPayload: { ...ingress.choreography.validatedPayload }
        }
      } as never,
      transactionRunner,
      core,
    )).rejects.toThrow("portable_atomic_binding_invalid");

    const substitutedStagedInput = toPortableStagedInput("coordinated-substitution");
    await expect(executeAtomicPortableImportCommit(
      {
        ...ingress,
        choreography: {
          ...ingress.choreography,
          validatedPayload: {
            ...ingress.choreography.validatedPayload,
            stagedInput: substitutedStagedInput,
            payload: {
              ...ingress.choreography.validatedPayload.payload,
              sourceName: "forged.story"
            }
          },
          stagedInput: {
            ...ingress.choreography.stagedInput,
            stagedInput: substitutedStagedInput
          }
        }
      } as never,
      transactionRunner,
      core,
    )).rejects.toThrow("portable_atomic_binding_invalid");

    expect(events).toEqual([]);
  });

  it.each(["legacy_story", "story_text", "infinite_worlds", "cyoa", "world_json", "world_text"] as const)(
    "carries the exact validated %s payload and owner-bound staged identity",
    (kind) => {
      const destination = kind === "legacy_story" || kind === "story_text"
        ? existingDestination
        : createWorldDestination;
      const ingress = bindPortableImportCommitIngress(ingressRequest(kind, destination));
      if (ingress.choreography.kind !== "atomic_repreview") throw new Error("expected atomic choreography");

      expect(ingress.choreography.validatedPayload.kind).toBe(kind);
      expect(ingress.choreography.validatedPayload.owner).toEqual({ ownerUserId });
      expect(ingress.choreography.validatedPayload.destination).toEqual(destination);
      expect(ingress.choreography.stagedInput).toMatchObject({
        owner: { ownerUserId },
        kind,
        destination,
        stagedInput: `staged-${kind}`
      });
      expect(ingress.choreography.replayKey).toBe(ingress.choreography.validatedPayload.replayKey);
    },
  );

  it("rejects forged binding copies carrying owner, family, destination, staged-input, or replay substitutions", () => {
    const base = ingressRequest("legacy_story", existingDestination) as Extract<
      PortableImportCommitIngressRequest,
      { kind: "legacy_story" }
    >;
    const foreignOwner = "99999999-9999-4999-8999-999999999999";

    expect(() => bindPortableImportCommitIngress({
      ...base,
      validatedPayload: { ...base.validatedPayload, owner: { ownerUserId: foreignOwner } }
    } as never)).toThrow("portable_atomic_binding_invalid");
    expect(() => bindPortableImportCommitIngress({
      ...base,
      validatedPayload: { ...base.validatedPayload, kind: "story_text" }
    } as never)).toThrow("portable_atomic_binding_invalid");
    expect(() => bindPortableImportCommitIngress({
      ...base,
      validatedPayload: { ...base.validatedPayload, destination: createWorldDestination }
    } as never)).toThrow("portable_atomic_binding_invalid");
    expect(() => bindPortableImportCommitIngress({
      ...base,
      stagedInput: { ...base.stagedInput, contentFingerprint: "b".repeat(64) }
    } as never)).toThrow("portable_atomic_binding_invalid");
    expect(() => bindPortableImportCommitIngress({
      ...base,
      stagedInput: {
        ...base.stagedInput,
        stagedInput: toPortableStagedInput("substituted-staged-input")
      }
    } as never)).toThrow("portable_atomic_binding_invalid");
    expect(() => bindPortableImportCommitIngress({
      ...base,
      validatedPayload: { ...base.validatedPayload, replayKey: toServerStableReplayKey("tampered-replay") }
    } as never)).toThrow("portable_atomic_binding_invalid");
  });

  it("rejects format-confused or provider-incomplete validated payloads", () => {
    const contentFingerprint = toValidatedPortableContentFingerprint("c".repeat(64));
    expect(() => bindValidatedAtomicRepreviewPayload({
      owner: { ownerUserId },
      kind: "cyoa",
      destination: createWorldDestination,
      contentFingerprint,
      stagedInput: toPortableStagedInput("staged-cyoa-mismatch"),
      payload: { ...atomicPayload("cyoa"), sourceKind: "world_text" }
    })).toThrow("portable_atomic_payload_kind_mismatch");
    expect(() => bindValidatedAtomicRepreviewPayload({
      owner: { ownerUserId },
      kind: "world_text",
      destination: createWorldDestination,
      contentFingerprint,
      stagedInput: toPortableStagedInput("staged-world-text-provider"),
      payload: { ...atomicPayload("world_text"), providerProfileId: undefined }
    })).toThrow("portable_atomic_provider_required");
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

  it("maps selected and explicitly-cleared asset results to the legacy URL-only response", () => {
    expect(mapLegacyWorldAssetSelectionHttpResult({ assetId, selected: true })).toEqual({
      assetUrl: `/api/v1/assets/${assetId}`
    });
    expect(mapLegacyTurnAssetSelectionHttpResult({
      assetId: null,
      selected: false,
      privatePath: "/private/assets/should-not-escape.png"
    } as never)).toEqual({ assetUrl: "" });
    expect(() => mapLegacyTurnAssetSelectionHttpResult({ assetId, selected: false }))
      .toThrow("asset_selection_result_invalid");
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

    const campaignHttpPreview = mapCampaignArchivePreviewHttpResult({
      ...preview,
      projection: {
        ...projection,
        retrieval: "private-preview-retrieval",
        sourceInstallationId: "foreign-installation",
        campaign: { ...projection.campaign, privatePath: "/private/campaign.json" }
      }
    } as never);
    expect(campaignHttpPreview).toEqual({
      ...projection,
      previewToken: "p".repeat(40),
      expiresAt: "2026-08-08T13:00:00.000Z"
    });
    expect(campaignHttpPreview).not.toHaveProperty("retrieval");
    expect(campaignHttpPreview).not.toHaveProperty("sourceInstallationId");
    expect(campaignHttpPreview.campaign).not.toHaveProperty("privatePath");
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

    const poisonedView = {
      ...view,
      projection: {
        ...projection,
        retrieval: "private-preview-retrieval",
        sourceInstallationId: "foreign-installation",
        counts: { ...projection.counts, internalCounter: 99 }
      }
    } as never;
    const mapped = mapHandlelessPortablePreviewHttpResult("legacy_story", poisonedView);

    expect(mapped).toEqual(projection);
    expect(mapped).not.toHaveProperty("previewHandle");
    expect(mapped).not.toHaveProperty("previewToken");
    expect(mapped).not.toHaveProperty("retrieval");
    expect(mapped).not.toHaveProperty("sourceInstallationId");
    expect(mapped.counts).not.toHaveProperty("internalCounter");
  });

  it.each([
    ["infinite_worlds", {
      kind: "world_json", valid: true, title: "World", duplicate: false, existingWorldId: null,
      characters: [{ index: 0, name: "Ari" }], counts: { entities: 1, relationships: 0, triggers: 0 }, warnings: []
    }],
    ["world_json", {
      kind: "world_json", valid: false, duplicate: false, existingWorldId: null,
      characters: [], counts: { entities: 0, relationships: 0, triggers: 0 }, warnings: ["invalid"]
    }],
    ["cyoa", {
      kind: "cyoa_json", valid: true, requiresProvider: true, warnings: [],
      counts: { topLevelTitle: "Forks", layer1ChaptersCount: 2, characterTarget: "3-4" }
    }],
    ["world_text", {
      kind: "world_text", valid: true, requiresProvider: true, warnings: [],
      counts: { sourceCharacters: 20, sourceWords: 4 }
    }],
    ["story_text", {
      kind: "story_text", title: "Story", duplicate: false, existingCampaignId: null,
      targetWorldId: worldId, diagnostics: ["parsed"], characters: [{ id: "hero", name: "Hero" }],
      selectedCharacterId: "hero", valid: true,
      counts: { turns: 2, completeHistoryCharacters: 20, estimatedHistoryTokens: 5 }, warnings: []
    }]
  ] as const)("reconstructs the %s preview from its family allowlist", (kind, projection) => {
    const mapped = mapHandlelessPortablePreviewHttpResult(kind, {
      projection: {
        ...projection,
        retrieval: "private-preview-retrieval",
        sourceInstallationId: "foreign-installation",
        internalCounter: 77
      }
    } as never);

    expect(mapped).toEqual(projection);
    expect(mapped).not.toHaveProperty("retrieval");
    expect(mapped).not.toHaveProperty("sourceInstallationId");
    expect(mapped).not.toHaveProperty("internalCounter");
  });

  it.each([
    ["campaign_zip", {
      importId: "66666666-6666-4666-8666-666666666666", worldId, worldVersionId, campaignId,
      duplicate: false, stats: { turnCount: 2, memoryCount: 1, summaryCount: 1, assetCount: 1, assetBytes: 4 }
    }],
    ["legacy_story", {
      importId: "66666666-6666-4666-8666-666666666666", worldId, worldVersionId, campaignId,
      duplicate: false, stats: {
        turnCount: 2, memoryCount: 1, completeHistoryCharacters: 20, estimatedHistoryTokens: 5,
        importedSummary: true, sanitizedMemoryCount: 1
      }
    }],
    ["infinite_worlds", { kind: "world", importId: "66666666-6666-4666-8666-666666666666", worldId, worldVersionId, duplicate: false }],
    ["cyoa", { kind: "world", importId: "66666666-6666-4666-8666-666666666666", worldId, worldVersionId, duplicate: false }],
    ["world_json", { kind: "world", importId: "66666666-6666-4666-8666-666666666666", worldId, worldVersionId, duplicate: false }],
    ["world_text", { kind: "world", importId: "66666666-6666-4666-8666-666666666666", worldId, worldVersionId, duplicate: false }],
    ["story_text", {
      kind: "campaign", importId: "66666666-6666-4666-8666-666666666666", worldId, worldVersionId, campaignId,
      duplicate: false, stats: {
        turnCount: 2, memoryCount: 1, completeHistoryCharacters: 20, estimatedHistoryTokens: 5,
        importedSummary: true, sanitizedMemoryCount: 1
      }
    }]
  ] as const)("reconstructs the %s commit result without private capabilities", (kind, expected) => {
    const mapped = mapPortableImportCommitHttpResult({
      kind,
      duplicate: false,
      importedRecordId: "private-imported-record",
      retrieval: "private-result-retrieval",
      diagnostics: ["internal-diagnostic"],
      result: {
        ...expected,
        retrieval: "nested-private-retrieval",
        sourceInstallationId: "foreign-installation",
        internalCounter: 77
      }
    } as never);

    expect(mapped).toEqual({ statusCode: 201, body: expected });
    expect(mapped.body).not.toHaveProperty("retrieval");
    expect(mapped.body).not.toHaveProperty("sourceInstallationId");
    expect(mapped.body).not.toHaveProperty("internalCounter");
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
