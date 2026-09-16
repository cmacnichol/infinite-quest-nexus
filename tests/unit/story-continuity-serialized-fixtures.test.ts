import { describe, expect, it } from "vitest";
import fixtures from "../fixtures/story-continuity-contracts.v1.json" with { type: "json" };
import { campaignRuntimeStateContentSchema, characterProfileSchema, generationRequestSchema, storyTurnOutputSchema, worldContentSchema, z } from "../../packages/contracts/src/index.js";
import { generationContextSnapshotSchema, generationEvidenceManifestSchema, legacyGenerationBaseIdentitySchema, readStoryEvidenceFromSource, storyEvidenceSchema } from "../../packages/application/src/memory/generation-context.js";
import { continuityReviewSchema, createStoryContinuityCheckpointV3Schema, readStoryContinuityCheckpoint } from "../../packages/contracts/src/story-continuity-review.js";
import { readStoryMemoryQueryVariant, serializeStoryMemoryQueryVariant } from "../../packages/contracts/src/story-memory-policy.js";
import type { GenerationValidatedMainDraftCheckpoint } from "../../packages/database/src/generation-execution-repository.js";

describe("published serialized continuity examples", () => {
  it("uses actual complete source schemas, including explicit empty corrections", () => {
    expect(campaignRuntimeStateContentSchema.parse(fixtures.sources.state)).toEqual(fixtures.sources.state);
    expect(campaignRuntimeStateContentSchema.parse(fixtures.sources.facts)).toEqual(fixtures.sources.facts);
    expect(characterProfileSchema.parse(fixtures.sources.character)).toEqual(fixtures.sources.character);
    expect(worldContentSchema.parse(fixtures.sources.world)).toEqual(fixtures.sources.world);
    expect(generationRequestSchema.parse(fixtures.sources.direction)).toEqual(fixtures.sources.direction);
    expect(storyTurnOutputSchema.parse(fixtures.sources.turn)).toEqual(fixtures.sources.turn);
    for (const { sourceKey, evidence } of fixtures.cases) {
      expect(readStoryEvidenceFromSource(evidence, Reflect.get(fixtures.sources, sourceKey))).toEqual(evidence);
    }
    expect(fixtures.cases.slice(0, 2).map(({ evidence }) => evidence.content)).toEqual(["[]", ""]);
    expect(generationEvidenceManifestSchema.parse(fixtures.manifest)).toEqual(fixtures.manifest);
    expect(generationContextSnapshotSchema.parse(fixtures.snapshot)).toEqual(fixtures.snapshot);
  });

  it("rejects each independently serialized negative evidence record", () => {
    for (const { reason, value } of fixtures.negativeEvidence) expect(storyEvidenceSchema.safeParse(value).success, reason).toBe(false);
  });

  it("round trips references, repeated-query diagnostics and cache identities", () => {
    for (const review of fixtures.reviews) expect(continuityReviewSchema.parse(review)).toEqual(review);
    for (const variant of fixtures.queryVariants) {
      const read = readStoryMemoryQueryVariant(variant);
      expect(JSON.parse(serializeStoryMemoryQueryVariant(read.variant))).toEqual(variant);
    }
    expect(fixtures.queryVariants[0]?.familyId).toBe(fixtures.queryVariants[1]?.familyId);
    expect(fixtures.queryVariants[0]?.variantId).not.toBe(fixtures.queryVariants[1]?.variantId);
  });

  it("can wrap a complete current executor checkpoint without dropping request or replacement fields", () => {
    // The concrete executor owns this validator. The envelope factory does not
    // pretend that its metadata schema can validate an opaque checkpoint.
    const payload = z.object({
      version: z.literal(2), ownerUserId: z.uuid(), campaignId: z.uuid(), worldVersionId: z.uuid().nullable(),
      baseIdentity: legacyGenerationBaseIdentitySchema, promptProtocolVersion: z.string(),
      generationPolicyIdentity: z.string().optional(), providerId: z.string(), providerModel: z.string(),
      providerConfigurationHash: z.string(), action: z.string(), originalInputHash: z.string(),
      requestBody: z.string(), requestPayloadHash: z.string(), draftHash: z.string(), producingAttempt: z.number().int().positive(),
      story: storyTurnOutputSchema, sentFactIds: z.array(z.string()),
      response: z.object({ content: z.string(), responseId: z.string(), finishReason: z.string(), outputLimited: z.boolean(), modelInstanceId: z.string(), usage: z.object({ inputTokens: z.number(), outputTokens: z.number(), totalTokens: z.number() }), reportedCost: z.object({ amount: z.string(), currency: z.string() }).nullable(), rawMetadata: z.record(z.string(), z.unknown()), preparedRequest: z.object({ body: z.string(), payloadHash: z.string() }).optional() }).strict()
    }).strict();
    const { generationPolicyIdentity, response, ...required } = payload.parse(fixtures.checkpoint);
    const { preparedRequest, ...responseFields } = response;
    const checkpoint: GenerationValidatedMainDraftCheckpoint = {
      ...required, ...(generationPolicyIdentity === undefined ? {} : { generationPolicyIdentity }),
      response: { ...responseFields, ...(preparedRequest === undefined ? {} : { preparedRequest }) }
    };
    expect(checkpoint).toEqual(fixtures.checkpoint);
    expect(readStoryContinuityCheckpoint(checkpoint, payload)).toEqual({ kind: "legacy_v2", checkpoint });
    const envelope = fixtures.checkpointEnvelope;
    expect(createStoryContinuityCheckpointV3Schema(payload).parse(envelope)).toEqual(envelope);
    expect(readStoryContinuityCheckpoint(envelope, payload)).toEqual({ kind: "v3", envelope });
    const invalid = structuredClone(envelope);
    Reflect.deleteProperty(invalid.checkpoint.story, "open_threads");
    expect(() => readStoryContinuityCheckpoint(invalid, payload)).toThrow(/discard.*reenqueue/i);
  });
});
