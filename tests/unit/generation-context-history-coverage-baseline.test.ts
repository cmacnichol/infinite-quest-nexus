import { describe, expect, it } from "vitest";
import { plannerBaselineCases, type PlannerBaselineCase } from "../fixtures/history-coverage/planner-baseline.js";
import {
  memoryGenerationAuthorityContextSchema,
  generationEvidenceManifestSchema,
  canonicalEvidenceJson
} from "../../packages/application/src/memory/generation-context.js";
import { castGenerationSnapshotFingerprint } from "../../packages/contracts/src/campaign-cast-context.js";
import { defaultStoryMemoryPolicy, storyMemoryPolicySchema } from "../../packages/contracts/src/story-memory-policy.js";
import { CONTINUITY_REVIEW_PROMPT_CATALOG, PROMPT_TEMPLATE_CATALOG } from "../../packages/contracts/src/prompt-library.js";
import { STORY_PRESET_ROUTE_PROTOCOL_V2, deriveTextExecutionPlan, textExecutionRouteBasisHash } from "../../packages/contracts/src/text-execution-plan.js";
import { queuedResponsePolicyV2Schema } from "../../packages/contracts/src/generation-response-contract.js";
import { sha256 } from "../../packages/domain/src/index.js";
import { serializeBoundFrozenPresetProviderRequest, serializeProviderRequest } from "../../packages/story-engine/src/provider-request.js";
import { planGenerationPromptContext } from "../../services/runtime/src/generation-context-planner.js";
import { estimateContinuityReviewPlanningTokens, prepareContinuityReview } from "../../services/runtime/src/story-continuity-review-adapter.js";
import { resolveGenerationResponseContractsV2 } from "../../services/runtime/src/generation-response-contract.js";

const ownerId = "10000000-0000-4000-8000-000000000001";
const campaignId = "10000000-0000-4000-8000-000000000002";
const worldVersionId = "10000000-0000-4000-8000-000000000003";
const characterId = "10000000-0000-4000-8000-000000000004";
const attemptId = "10000000-0000-4000-8000-000000000005";
const baseTurnId = "10000000-0000-4000-8000-000000000006";
const recentOneId = "10000000-0000-4000-8000-000000000007";
const recentTwoId = "10000000-0000-4000-8000-000000000008";
const factId = "10000000-0000-4000-8000-000000000009";
const castEditId = "10000000-0000-4000-8000-000000000010";
const castCharacterId = "10000000-0000-4000-8000-000000000011";
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

const provider = {
  id: "fixture-provider",
  name: "Fixture provider",
  providerRole: "text" as const,
  providerType: "openrouter" as const,
  baseUrl: "",
  model: "@preset/fixture-writer",
  contextWindowTokens: 48_000,
  maxOutputTokens: 2_048,
  temperature: 0.35,
  requestTimeoutMs: 30_000,
  configuration: {},
  async execute() {
    throw new Error("The compatibility fixture must not dispatch a provider request.");
  }
};

const textBytes = (value: string) => new TextEncoder().encode(value).byteLength;

function promptSnapshot(protocolIdentity: string) {
  return {
    version: 2,
    templates: Object.fromEntries(Object.entries(PROMPT_TEMPLATE_CATALOG).map(([key, value]) => [key, {
      content: value.defaultContent, hash: sha256(value.defaultContent), source: "shipped" as const
    }])),
    continuityReview: Object.fromEntries(Object.entries(CONTINUITY_REVIEW_PROMPT_CATALOG).map(([key, value]) => [key, {
      content: value.defaultContent, hash: sha256(value.defaultContent), source: "shipped" as const, protocolIdentity: value.protocolIdentity
    }])),
    storyMemoryCompatibility: {
      protocolIdentity,
      templateHashes: {
        story_system: sha256(PROMPT_TEMPLATE_CATALOG.story_system.defaultContent),
        event_extension: sha256(PROMPT_TEMPLATE_CATALOG.event_extension.defaultContent)
      }
    }
  };
}

function castSnapshot(state: "pending" | "current") {
  return {
    version: "cast-context-v1" as const,
    scope: { ownerUserId: ownerId, campaignId },
    worldVersionId,
    revision: 4,
    boundary: { turnNumber: 3, timelineRevision: 2 },
    coverageStartTurn: state === "current" ? 1 : null,
    trackedThroughTurn: state === "current" ? 3 : null,
    discoveryStatus: state,
    characters: [{
      id: castCharacterId, name: "Fixture Keeper", aliases: ["Keeper"], origin: { kind: "manual" as const },
      profile: {}, pinned: false, ignored: false, revision: 2, firstObservedTurn: 0, lastObservedTurn: 0
    }],
    details: [{
      characterId: castCharacterId,
      observations: [],
      overrides: [{ field: "appearance.description" as const, value: "wears a silver relay pin", evidence: { kind: "user" as const, editId: castEditId, effectiveTurnNumber: 0 } }]
    }]
  };
}

function contextFor(fixture: PlannerBaselineCase) {
  const state = {
    continuitySummary: "Fixture continuity: the relay gate remains sealed.",
    openThreads: ["Open the relay gate before moonrise."],
    canonicalFacts: [{ id: factId, content: "Fixture fact: the relay accepts a silver seal." }],
    scratchpad: "Fixture private fiction notes.", trackers: [], rpgStats: [], eventTriggers: [], pendingEventTriggers: []
  };
  const legacyBase = {
    operationKind: "append" as const, expectedTurnNumber: 4, baseTurnNumber: 3, campaignActiveTurnNumber: 3,
    campaignStateRevision: 7, stateEditRevision: null, narrationCorrectionRevision: null, baseTurnId,
    stateFingerprint: hashA, narrationFingerprint: hashB
  };
  const baseIdentity = fixture.protocol === "legacy" ? legacyBase : {
    ...legacyBase, version: fixture.protocol === "v3" ? "generation-base-v3" as const : "generation-base-v4" as const,
    characterProfileRevision: 3, characterProfileFingerprint: hashB,
    ...(fixture.protocol === "v4" ? (() => {
      const cast = castSnapshot(fixture.cast as "pending" | "current");
      return {
        castRevision: cast.revision, castTimelineRevision: cast.boundary.timelineRevision,
        castFingerprint: castGenerationSnapshotFingerprint(cast), castCoverageStartTurn: cast.coverageStartTurn,
        castTrackedThroughTurn: cast.trackedThroughTurn
      };
    })() : {})
  };
  const context = {
    authority: {
      rules: ["Fixture rule: a silver seal opens the relay."],
      worldCanon: { title: "Fixture Relay", premise: "A sealed relay waits above the harbor." },
      selectedCharacterId: characterId,
      currentContinuity: state,
      ...(fixture.protocol === "legacy" ? {} : {
        characterAuthority: { source: "campaign_profile" as const, name: "Fixture Mira", characterText: "Mira guards the relay through the storm.", profile: null },
        worldReferenceSource: {
          worldVersionId,
          worldContent: { entities: [{ id: "relay", name: "Fixture Relay", description: "The Fixture Relay opens only to silver seals." }] }
        }
      }),
      ...(fixture.protocol === "v4" ? { castSnapshot: castSnapshot(fixture.cast as "pending" | "current") } : {}),
      scratchpad: state.scratchpad, openThreads: state.openThreads, canonicalFacts: state.canonicalFacts,
      trackers: [], rpgStats: [], eventTriggers: [], pendingEventTriggers: [],
      latestTurn: { action: "Study the relay gate.", narration: "The relay gate hums beneath the storm.", inputMode: "scene" as const }
    },
    candidates: [{
      id: "fixture-history", turnId: recentOneId, ordinal: 1, kind: "turn_fiction" as const,
      content: "Fixture history: the keeper entrusted Mira with a silver seal.", tokenEstimate: 20, rank: 1
    }],
    ...(fixture.protocol === "legacy" ? {} : {
      recentTurns: [
        { turnId: recentOneId, turnNumber: 1, inputMode: "action" as const, action: "Find the keeper.", narration: "Mira finds the keeper at the relay.", narrationCorrectionRevision: 0, sourceHash: hashA },
        { turnId: recentTwoId, turnNumber: 2, inputMode: "scene" as const, action: "Ask about the seal.", narration: "The keeper names the silver seal.", narrationCorrectionRevision: 0, sourceHash: hashB }
      ]
    }),
    baseIdentity
  };
  return memoryGenerationAuthorityContextSchema.parse(context);
}

function frozenRouteSerializer() {
  const routeBasisDraft = {
    version: 2 as const, selection: { kind: "openrouter_preset" as const, slug: "fixture-writer" },
    preset: { slug: "fixture-writer", versionId: "fixture-v1", configHash: hashA },
    candidates: [{ modelId: "@preset/fixture-writer", providerPolicy: { only: ["fixture/provider"], require_parameters: false }, contextWindowTokens: 48_000, maxOutputTokens: 2_048 }],
    presetSystemPrompt: "", parameters: { temperature: 0.11 }, endpointReference: "fixture-endpoint",
    credentialReference: "fixture-credential", profileRevision: "fixture-profile", authorityRevision: "fixture-authority",
    requestTimeoutMs: 30_000, protocolVersion: STORY_PRESET_ROUTE_PROTOCOL_V2
  };
  const routeBasis = { ...routeBasisDraft, routeBasisHash: textExecutionRouteBasisHash({ ...routeBasisDraft, routeBasisHash: hashA }) };
  const queuedPolicy = queuedResponsePolicyV2Schema.parse({
    version: 2, policy: "required", providerProfileId: "10000000-0000-4000-8000-000000000012",
    admission: { mode: "json_schema", basis: "preset_trusted" },
    authority: { kind: "preset_trusted", routeBasisHash: routeBasis.routeBasisHash, selection: routeBasis.selection,
      endpointReference: routeBasis.endpointReference, credentialReference: routeBasis.credentialReference,
      authorityRevision: routeBasis.authorityRevision, profileRevision: routeBasis.profileRevision },
    operationClosureVersion: 2, invocationKeys: ["story:nonstream"]
  });
  const frozen = resolveGenerationResponseContractsV2({ queuedPolicy, routeProtocolVersion: STORY_PRESET_ROUTE_PROTOCOL_V2, capabilityEvidenceHash: hashB });
  const trustedOperationPrompt = "Fixture frozen writer instructions.";
  const plan = deriveTextExecutionPlan(routeBasis, trustedOperationPrompt);
  return (input: string) => serializeBoundFrozenPresetProviderRequest(provider, {
    systemPrompt: plan.prompt, input
  }, {
    frozen, routeBasis, plan, invocationKey: "story:nonstream", operation: "story_generation", trustedOperationPrompt
  }).body;
}

function policyFor(fixture: PlannerBaselineCase) {
  if (!fixture.policy) return undefined;
  const policy = defaultStoryMemoryPolicy(fixture.policy);
  return storyMemoryPolicySchema.parse({ ...policy, continuityReview: fixture.reviewMode });
}

function observe(fixture: PlannerBaselineCase) {
  const context = contextFor(fixture);
  const policy = policyFor(fixture);
  const protocolIdentity = fixture.protocol === "v4"
    ? "story-v17-campaign-cast|story-output-v2|current-continuity-v4"
    : "story-v16-fact-wire-distinction|story-output-v2|current-continuity-v3";
  const serializer = fixture.serializer === "direct"
    ? (input: string) => serializeProviderRequest(provider, { systemPrompt: "Fixture direct writer instructions.", input }).body
    : frozenRouteSerializer();
  const reviewInputTokens = fixture.reviewMode === "off" ? undefined : (manifest: NonNullable<ReturnType<typeof planGenerationPromptContext>["sourceManifest"]>) =>
    estimateContinuityReviewPlanningTokens({ provider, manifest, producingRequestHash: manifest.producingRequestHash,
      promptSnapshot: promptSnapshot(protocolIdentity), reviewMode: fixture.reviewMode as "observe" | "enforce",
      direction: "Ask Fixture Keeper to use the silver seal at the relay.", candidateOutputTokens: provider.maxOutputTokens });
  const planned = planGenerationPromptContext(context, provider, "Fixture builder system.", "Ask Fixture Keeper to use the silver seal at the relay.",
    ["Keep the fixture sequence coherent."], { profile: "brief", minWords: 100, maxWords: 120 }, "scene", 24_000, 22_000,
    attemptId, fixture.protocol === "legacy" ? "legacy" : "story_memory", policy, serializer, reviewInputTokens, fixture.expected.reviewerInputLimit ?? undefined);
  const manifest = generationEvidenceManifestSchema.parse(planned.sourceManifest);
  const review = fixture.reviewMode === "off" ? null : prepareContinuityReview({
    provider, manifest, producingRequestHash: manifest.producingRequestHash, promptSnapshot: promptSnapshot(protocolIdentity),
    reviewMode: fixture.reviewMode as "observe" | "enforce", direction: "Ask Fixture Keeper to use the silver seal at the relay.",
    draft: { narration: "Fixture narration.", choices: ["Wait", "Look", "Listen", "Leave"], custom_action_suggestion: "Use the seal.", scratchpad: "", tracker_updates: [], image_prompt: "", continuity_summary: "", canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: [] }
  });
  const manifestJson = canonicalEvidenceJson(manifest);
  const reviewPlanningTokens = fixture.reviewMode === "off" ? null : planned.contextPlan.additionalRequestTokens;
  return {
    writerBytes: textBytes(planned.contextPlan.serializedRequest), writerHash: sha256(planned.contextPlan.serializedRequest),
    manifestBytes: textBytes(manifestJson), manifestHash: manifest.manifestHash, producingRequestHash: manifest.producingRequestHash,
    reviewBytes: review ? textBytes(review.body) : null, reviewHash: review?.requestHash ?? null, reviewPlanningTokens,
    reviewerInputLimit: fixture.expected.reviewerInputLimit
  };
}

describe("generation context planner history-coverage baseline", () => {
  it.each(plannerBaselineCases)("preserves $id writer and manifest bytes", (fixture) => {
    const observed = observe(fixture);
    expect(observed).toEqual(fixture.expected);
    if (observed.reviewerInputLimit !== null) {
      expect(observed.reviewerInputLimit).toBeLessThan(22_000);
      expect(observed.reviewPlanningTokens! + Math.ceil(observed.reviewPlanningTokens! * 0.2) + 1_024)
        .toBeLessThanOrEqual(observed.reviewerInputLimit);
    }
  });
});
