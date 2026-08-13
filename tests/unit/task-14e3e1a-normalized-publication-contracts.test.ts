import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type * as PublicAssetContracts from "../../packages/application/src/assets/index.js";
import {
  bindPrivateNormalizedAssetPublicationRequest,
  bindPrivateNormalizedAssetRequestChildren,
  canonicalPrivateNormalizedAssetPublicationRequest,
  fingerprintPrivateNormalizedAssetPublicationRequest,
  projectSafeNormalizedAssetPublicationResult,
  replayPrivateNormalizedAssetPublicationRequest,
  snapshotPrivateCanonicalAssetTechnicalMetadata,
  type PrivateNormalizedAssetPublicationRequestInput
} from "../../packages/application/src/assets/private-normalized-asset-publication.js";
import { toAssetMutationIdempotencyKey } from "../../packages/application/src/assets/types.js";
// @ts-expect-error The executable repository checker is intentionally plain ESM.
import * as privateStorageBoundaries from "../../scripts/check-private-storage-boundaries.mjs";

// @ts-expect-error Normalized publication authority must remain adapter-private.
type LeakedNormalizedRequest = PublicAssetContracts.PrivateNormalizedAssetPublicationRequest;

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const imageJobId = "22222222-2222-4222-8222-222222222222";
const providerProfileId = "33333333-3333-4333-8333-333333333333";
const campaignId = "44444444-4444-4444-8444-444444444444";
const turnId = "55555555-5555-4555-8555-555555555555";
const requestId = "66666666-6666-4666-8666-666666666666";
const assetId = "77777777-7777-4777-8777-777777777777";
const contextId = "88888888-8888-4888-8888-888888888888";
const referenceId = "99999999-9999-4999-8999-999999999999";

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

function library(title: string) {
  return {
    title,
    caption: "",
    notes: "",
    tags: ["Moon", "forest", "moon"],
    origin: "generated" as const,
    reviewStatus: "eligible" as const,
    reuseScope: "campaign" as const,
    automaticReuseEnabled: true,
    contentCategories: ["fantasy", "fantasy"],
    favorite: false
  };
}

function requestInput(): PrivateNormalizedAssetPublicationRequestInput {
  const originalBytes = new Uint8Array([1, 2, 3, 4]);
  const thumbnailBytes = new Uint8Array([5, 6]);
  return {
    owner: { ownerUserId },
    idempotencyKey: toAssetMutationIdempotencyKey("e1a-request"),
    original: {
      bytes: originalBytes,
      mimeType: "image/png",
      byteLength: originalBytes.byteLength,
      contentHash: sha256(originalBytes),
      technicalMetadata: {
        state: "verified",
        pixelWidth: 1024,
        pixelHeight: 768,
        format: "png",
        pages: 1
      }
    },
    derivatives: [{
      slot: {
        derivativeKind: "thumbnail",
        transformVersion: 1,
        pixelWidth: 256,
        pixelHeight: 192
      },
      artifact: {
        bytes: thumbnailBytes,
        mimeType: "image/webp",
        byteLength: thumbnailBytes.byteLength,
        contentHash: sha256(thumbnailBytes),
        technicalMetadata: {
          state: "verified",
          pixelWidth: 256,
          pixelHeight: 192,
          format: "webp",
          pages: 1,
          orientation: null
        }
      }
    }],
    requestedLibrary: library("Generated scene"),
    sourceRecords: [],
    provenance: {
      kind: "illustration",
      imageJobId,
      variantIndex: 0,
      fictionPromptIdentity: "a".repeat(64),
      providerProfileId,
      providerType: "openai-compatible",
      model: "image-model",
      parameters: {
        size: "1024x768",
        aspectRatio: "4:3",
        quality: "high",
        outputFormat: "png"
      }
    },
    contextIntents: [{
      intentKey: "generated-context",
      targetType: "turn_illustration",
      variantIndex: 0,
      campaignId,
      turnId,
      fictionPromptIdentity: "a".repeat(64)
    }],
    referencePolicy: {
      mode: "attach",
      intents: [{
        intentKey: "primary-turn-reference",
        assetRole: "turn_illustration",
        campaignId,
        turnId
      }]
    }
  };
}

describe("Task 14e3e1a normalized publication contracts", () => {
  it("normalizes absent optionals to null and fingerprints semantic objects independently of key order", () => {
    const first = bindPrivateNormalizedAssetPublicationRequest(requestInput());
    const input = requestInput();
    const reordered = bindPrivateNormalizedAssetPublicationRequest({
      ...input,
      provenance: {
        parameters: {
          outputFormat: input.provenance.kind === "illustration" ? input.provenance.parameters.outputFormat : "",
          quality: input.provenance.kind === "illustration" ? input.provenance.parameters.quality : "",
          aspectRatio: input.provenance.kind === "illustration" ? input.provenance.parameters.aspectRatio : "",
          size: input.provenance.kind === "illustration" ? input.provenance.parameters.size : ""
        },
        model: input.provenance.kind === "illustration" ? input.provenance.model : "",
        providerType: input.provenance.kind === "illustration" ? input.provenance.providerType : "",
        providerProfileId: input.provenance.kind === "illustration" ? input.provenance.providerProfileId : providerProfileId,
        fictionPromptIdentity: input.provenance.kind === "illustration" ? input.provenance.fictionPromptIdentity : "a".repeat(64),
        variantIndex: input.provenance.kind === "illustration" ? input.provenance.variantIndex : 0,
        imageJobId: input.provenance.kind === "illustration" ? input.provenance.imageJobId : imageJobId,
        kind: "illustration"
      },
      original: {
        technicalMetadata: {
          orientation: null,
          pages: 1,
          format: "png",
          pixelHeight: 768,
          pixelWidth: 1024,
          state: "verified"
        },
        contentHash: input.original.contentHash,
        byteLength: input.original.byteLength,
        mimeType: input.original.mimeType,
        bytes: input.original.bytes
      }
    });

    expect(first.original.technicalMetadata.orientation).toBeNull();
    expect(first.requestedLibrary.archivedAt).toBeNull();
    expect(first.contextIntents[0]).toMatchObject({
      sourceContextId: null,
      worldId: null,
      worldVersionId: null
    });
    expect(canonicalPrivateNormalizedAssetPublicationRequest(first)).not.toContain("undefined");
    expect(fingerprintPrivateNormalizedAssetPublicationRequest(first, sha256))
      .toBe(fingerprintPrivateNormalizedAssetPublicationRequest(reordered, sha256));
  });

  it("sorts grouped source snapshots and freezes a deterministic canonical-library initializer", () => {
    const input = requestInput();
    const sourceB = {
      sourceKind: "campaign_zip" as const,
      sourceAssetId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      sourceRecordId: "record-b",
      requestedLibrary: library("Library B"),
      bindingIntentKeys: ["primary-turn-reference", "generated-context"]
    };
    const sourceA = {
      ...sourceB,
      sourceAssetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sourceRecordId: "record-a",
      requestedLibrary: library("Library A")
    };
    const request = bindPrivateNormalizedAssetPublicationRequest({
      ...input,
      provenance: {
        kind: "import",
        importKind: "campaign_zip",
        importOperationId: "12121212-1212-4212-8212-121212121212"
      },
      sourceRecords: [sourceB, sourceA]
    });

    expect(request.sourceRecords.map((source) => source.sourceAssetId)).toEqual([
      sourceA.sourceAssetId,
      sourceB.sourceAssetId
    ]);
    expect(request.sourceRecords[0]?.bindingIntentKeys).toEqual(["generated-context", "primary-turn-reference"]);
    expect(request.canonicalLibraryInitialization).toEqual({
      sourceAssetId: sourceA.sourceAssetId,
      sourceRecordId: "record-a",
      library: expect.objectContaining({ title: "Library A" })
    });
    expect(request.sourceRecords.map((source) => source.requestedLibrary.title)).toEqual([
      "Library A",
      "Library B"
    ]);
  });

  it("uses locale-independent ordinal ordering for canonical source selection", () => {
    const input = requestInput();
    const request = bindPrivateNormalizedAssetPublicationRequest({
      ...input,
      provenance: {
        kind: "import",
        importKind: "campaign_zip",
        importOperationId: "12121212-1212-4212-8212-121212121212"
      },
      sourceRecords: [{
        sourceKind: "campaign_zip",
        sourceAssetId: "a-source",
        requestedLibrary: library("Locale-sensitive second"),
        bindingIntentKeys: []
      }, {
        sourceKind: "campaign_zip",
        sourceAssetId: "Z-source",
        requestedLibrary: library("Ordinal first"),
        bindingIntentKeys: []
      }]
    });

    expect(request.sourceRecords.map((source) => source.sourceAssetId)).toEqual([
      "Z-source",
      "a-source"
    ]);
    expect(request.canonicalLibraryInitialization.library.title).toBe("Ordinal first");
  });

  it("preserves source-owned category and binding-key case while normalizing reusable tags", () => {
    const input = requestInput();
    const request = bindPrivateNormalizedAssetPublicationRequest({
      ...input,
      requestedLibrary: {
        ...input.requestedLibrary,
        tags: ["Moon", "moon", "Forest"],
        contentCategories: ["ConceptArt", "fantasy", "ConceptArt"]
      },
      sourceRecords: [{
        sourceKind: "campaign_zip",
        sourceAssetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        requestedLibrary: library("Source library"),
        bindingIntentKeys: ["primary-turn-reference", "generated-context"]
      }]
    });

    expect(request.requestedLibrary.tags).toEqual(["forest", "moon"]);
    expect(request.requestedLibrary.contentCategories).toEqual(["ConceptArt", "fantasy"]);
    expect(request.sourceRecords[0]?.bindingIntentKeys).toEqual([
      "generated-context",
      "primary-turn-reference"
    ]);
  });

  it("normalizes reusable tags without consulting the host locale", () => {
    const originalLocaleLowerCase = String.prototype.toLocaleLowerCase;
    String.prototype.toLocaleLowerCase = () => {
      throw new Error("host locale consulted");
    };
    try {
      const input = requestInput();
      const request = bindPrivateNormalizedAssetPublicationRequest({
        ...input,
        requestedLibrary: {
          ...input.requestedLibrary,
          tags: ["I"]
        }
      });
      expect(request.requestedLibrary.tags).toEqual(["i"]);
    } finally {
      String.prototype.toLocaleLowerCase = originalLocaleLowerCase;
    }
  });

  it("keeps request replay separate from canonical results and rejects a changed same-key command", () => {
    const request = bindPrivateNormalizedAssetPublicationRequest(requestInput());
    const requestFingerprint = fingerprintPrivateNormalizedAssetPublicationRequest(request, sha256);
    const stored = {
      requestFingerprint,
      result: {
        assetId,
        mimeType: "image/png",
        byteLength: 4,
        contentHash: request.original.contentHash,
        pixelWidth: 1024,
        pixelHeight: 768,
        derivatives: [],
        canonicalPublicationResult: { derivativeIds: ["first-request-only"] },
        storagePath: "/private/assets/original.png"
      }
    };

    expect(replayPrivateNormalizedAssetPublicationRequest(request, stored, sha256)).toEqual({
      assetId,
      mimeType: "image/png",
      byteLength: 4,
      contentHash: request.original.contentHash,
      pixelWidth: 1024,
      pixelHeight: 768,
      derivatives: []
    });

    const changed = bindPrivateNormalizedAssetPublicationRequest({
      ...requestInput(),
      requestedLibrary: library("Changed request library snapshot")
    });
    expect(() => replayPrivateNormalizedAssetPublicationRequest(changed, stored, sha256))
      .toThrow("asset_publication_idempotency_mismatch");
  });

  it("projects an allowlisted result without bytes, paths, claims, bearers, responses, or request authority", () => {
    const projected = projectSafeNormalizedAssetPublicationResult({
      requestId,
      ownerUserId,
      assetId,
      mimeType: "image/png",
      byteLength: 4,
      contentHash: "b".repeat(64),
      pixelWidth: 10,
      pixelHeight: 20,
      derivatives: [{
        derivativeId: "abababab-abab-4bab-8bab-abababababab",
        derivativeKind: "thumbnail",
        transformVersion: 1,
        pixelWidth: 5,
        pixelHeight: 10
      }],
      bytes: new Uint8Array([1]),
      storagePath: "/private/value",
      claim: { leaseId: "secret" },
      bearer: "secret",
      rawResponse: { authorization: "secret" }
    });

    expect(Object.keys(projected).sort()).toEqual([
      "assetId",
      "byteLength",
      "contentHash",
      "derivatives",
      "mimeType",
      "pixelHeight",
      "pixelWidth"
    ]);
    expect(Object.keys(projected.derivatives[0]!).sort()).toEqual([
      "derivativeId",
      "derivativeKind",
      "pixelHeight",
      "pixelWidth",
      "transformVersion"
    ]);
  });

  it("rejects a malformed canonical asset ID before projecting a stored request result", () => {
    expect(() => projectSafeNormalizedAssetPublicationResult({
      assetId: "not-a-uuid",
      mimeType: "image/png",
      byteLength: 4,
      contentHash: "b".repeat(64),
      pixelWidth: 10,
      pixelHeight: 20,
      derivatives: []
    })).toThrow("asset_publication_result_invalid");
  });

  it("rejects a malformed derivative ID before projecting a stored request result", () => {
    expect(() => projectSafeNormalizedAssetPublicationResult({
      assetId,
      mimeType: "image/png",
      byteLength: 4,
      contentHash: "b".repeat(64),
      pixelWidth: 10,
      pixelHeight: 20,
      derivatives: [{
        derivativeId: "not-a-uuid",
        derivativeKind: "thumbnail",
        transformVersion: 1,
        pixelWidth: 5,
        pixelHeight: 10
      }]
    })).toThrow("asset_publication_result_invalid");
  });

  it("rejects non-allowlisted illustration parameters before they enter a request fingerprint", () => {
    const input = requestInput();
    if (input.provenance.kind !== "illustration") throw new Error("invalid test fixture");
    const provenance = input.provenance;
    expect(() => bindPrivateNormalizedAssetPublicationRequest({
      ...input,
      provenance: {
        ...provenance,
        parameters: {
          ...provenance.parameters,
          token: "must-not-persist"
        }
      } as unknown as PrivateNormalizedAssetPublicationRequestInput["provenance"]
    })).toThrow("asset_publication_provenance_invalid");
  });

  it("represents incomplete legacy technical metadata without claiming it was verified", () => {
    const incomplete = snapshotPrivateCanonicalAssetTechnicalMetadata({
      state: "legacy_incomplete",
      pixelWidth: null,
      pixelHeight: 400,
      format: "png",
      pages: null,
      orientation: null
    });

    expect(incomplete).toEqual({
      state: "legacy_incomplete",
      pixelWidth: null,
      pixelHeight: 400,
      format: "png",
      pages: null,
      orientation: null
    });
    expect(() => snapshotPrivateCanonicalAssetTechnicalMetadata({
      ...incomplete,
      state: "verified"
    } as unknown as Parameters<typeof snapshotPrivateCanonicalAssetTechnicalMetadata>[0]))
      .toThrow("asset_publication_technical_metadata_invalid");
  });

  it("binds deferred children only when every request intent is resolved exactly once", () => {
    const request = bindPrivateNormalizedAssetPublicationRequest(requestInput());
    const attachment = {
      requestId,
      ownerUserId,
      assetId,
      requestFingerprint: fingerprintPrivateNormalizedAssetPublicationRequest(request, sha256)
    };
    const bound = bindPrivateNormalizedAssetRequestChildren(request, attachment, {
      contexts: [{ intentKey: "generated-context", contextId }],
      references: [{ intentKey: "primary-turn-reference", referenceId }]
    });

    expect(bound).toEqual({
      ...attachment,
      contexts: [{ intentKey: "generated-context", contextId }],
      references: [{ intentKey: "primary-turn-reference", referenceId }]
    });
    expect(Object.isFrozen(bound)).toBe(true);
    expect(() => bindPrivateNormalizedAssetRequestChildren(request, attachment, {
      contexts: [],
      references: [{ intentKey: "primary-turn-reference", referenceId }]
    })).toThrow("asset_publication_request_children_mismatch");
    expect(() => bindPrivateNormalizedAssetRequestChildren(request, attachment, {
      contexts: [{ intentKey: "generated-context", contextId }],
      references: []
    })).toThrow("asset_publication_request_children_mismatch");
  });

  it("keeps the new normalized authority out of public application barrels", () => {
    expect(privateStorageBoundaries.checkPrivateStorageBoundaries(
      "services/runtime/src/example.ts",
      `import type { PrivateNormalizedAssetPublicationRequest }
         from "../../../packages/application/src/assets/index.js";`,
    )).toEqual([
      expect.stringContaining("private storage contracts must use their defining module")
    ]);
  });
});

void (null as unknown as LeakedNormalizedRequest);
