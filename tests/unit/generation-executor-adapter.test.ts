import { describe, expect, it, vi } from "vitest";
import type {
  ClaimedGeneration,
  IllustrationGenerationTransactionPort
} from "../../packages/application/src/index.js";
import type { GenerationExecutionRepository } from "../../packages/database/src/generation-execution-repository.js";
import type { GenerationExecutionPayload } from "../../packages/database/src/generation-execution-repository.js";
import type { DatabasePool } from "../../packages/database/src/pool.js";
import { PROMPT_TEMPLATE_CATALOG } from "../../packages/contracts/src/prompt-library.js";
import { storyTurnOutputSchema } from "../../packages/contracts/src/generation.js";
import { defaultStoryMemoryPolicy, storyMemoryPolicyHash } from "../../packages/contracts/src/story-memory-policy.js";
import { characterFictionAuthority, sha256, stableStringify } from "../../packages/domain/src/index.js";
import { canonicalEvidenceJson, readStoryEvidenceFromSource } from "../../packages/application/src/memory/generation-context.js";
import { ContextBudgetError } from "../../packages/story-engine/src/context-budget.js";
import { generationExecutionProtocolIdentity, storyOnlyPromptSnapshot } from "../../packages/story-engine/src/index.js";
import {
  createGenerationExecutor,
  generationContextFingerprint,
  planGenerationPromptContext,
  semanticRepairScope,
  sentCanonicalFactIds,
  type GenerationExecutionCollaborators
} from "../../services/runtime/src/generation-executor-adapter.js";
import { providerPromptProtocolVersion } from "../../services/runtime/src/provider-application-composition.js";
import { prepareGenerationReview } from "../../services/runtime/src/generation-review-adapter.js";
import type { GenerationReviewCheckpoint } from "../../packages/application/src/generation/review-checkpoint.js";
import { DEDICATED_CHUNKED_AUDIT } from "../fixtures/chronicle-retrieval-audits.js";

const claim: ClaimedGeneration = {
  jobId: "00000000-0000-4000-8000-000000000001",
  ownerUserId: "00000000-0000-4000-8000-000000000002",
  campaignId: "00000000-0000-4000-8000-000000000003",
  providerProfileId: "00000000-0000-4000-8000-000000000004",
  expectedTurnNumber: 3,
  attempts: 1,
  operationKind: "append",
  replacementTurnId: null
};

function rejectedCollaborators(): GenerationExecutionCollaborators {
  const unexpected = vi.fn(async (): Promise<never> => {
    throw new Error("A collaborator ran before the execution payload guard passed.");
  });
  const unexpectedSync = vi.fn((): never => {
    throw new Error("A collaborator ran before the execution payload guard passed.");
  });
  return {
    memory: {
      autoEnableCampaignEmbedding: unexpected,
      buildContextPreview: unexpected,
      loadGenerationContext: unexpected,
      enqueueEmbeddingReindex: unexpected,
      rebuildCampaignMemories: unexpected,
      storeDerivedTurnMemories: unexpected,
      writeAcceptedTurnFiction: unexpected
    } as never,
    illustration: {
      loadStreamingIllustrationConfig: unexpected,
      createProvisionalSet: unexpected,
      createProvisionalSegment: unexpected,
      promoteProvisionalSet: unexpected,
      orphanProvisionalSet: unexpected,
      enqueueAcceptedTurnIllustrationSegments: unexpected
    } as IllustrationGenerationTransactionPort,
    loadTextExecution: unexpected,
    promptFromSnapshot: unexpectedSync,
    recordProfileCost: unexpected,
    attributeGenerationCostsToTurn: unexpected
  };
}

function guardedRepository(): GenerationExecutionRepository {
  const unexpectedBoolean = vi.fn(async () => {
    throw new Error("A durable mutation ran before the execution payload guard passed.");
  });
  return {
    loadExecutionPayload: vi.fn(async () => null),
    renewLease: unexpectedBoolean,
    markGenerating: unexpectedBoolean,
    saveOrchestration: unexpectedBoolean,
    pauseForReview: unexpectedBoolean,
    savePartialNarration: unexpectedBoolean,
    saveStreamingSegments: unexpectedBoolean,
    recordAttempt: vi.fn(async () => {
      throw new Error("An attempt was recorded before the execution payload guard passed.");
    }),
    markRecoverable: unexpectedBoolean,
    markValidating: unexpectedBoolean,
    markCommitting: unexpectedBoolean,
    commitAcceptedTurn: vi.fn(async () => {
      throw new Error("A turn committed before the execution payload guard passed.");
    }),
    markFailed: unexpectedBoolean
  };
}

function validPromptSnapshot(): GenerationExecutionPayload["prompt_snapshot"] {
  return Object.fromEntries(Object.values(PROMPT_TEMPLATE_CATALOG).map((template) => [template.key, {
    content: template.defaultContent,
    hash: sha256(template.defaultContent),
    source: "shipped"
  }])) as GenerationExecutionPayload["prompt_snapshot"];
}

function snapshotProtocolIdentity(snapshot: GenerationExecutionPayload["prompt_snapshot"]): string {
  return providerPromptProtocolVersion(snapshot);
}

function completeGenerationExecutionPayload(): GenerationExecutionPayload {
  return {
    id: claim.jobId,
    owner_user_id: claim.ownerUserId,
    campaign_id: claim.campaignId,
    world_id: "00000000-0000-4000-8000-000000000006",
    world_version_id: "00000000-0000-4000-8000-000000000005",
    provider_profile_id: claim.providerProfileId,
    expected_turn_number: claim.expectedTurnNumber,
    operation_kind: "append",
    replacement_turn_id: null,
    base_turn_number: null,
    base_state_private: {},
    base_scratchpad_safe_for_prompt: false,
    action: "Open the observatory door.",
    requested_input_mode: "action",
    resolved_input_mode: "action",
    input_mode_source: "explicit",
    requested_model: "test-model",
    context_options: { budgetTokens: 8_000, compression: "auto", query: "Open the observatory door.", recentTurns: 4 },
    prompt_protocol_version: "test-protocol",
    prompt_snapshot: validPromptSnapshot(),
    generation_policy: null,
    generation_base_identity: {
      operationKind: "append", expectedTurnNumber: claim.expectedTurnNumber,
      baseTurnNumber: claim.expectedTurnNumber - 1, campaignActiveTurnNumber: claim.expectedTurnNumber - 1,
      campaignStateRevision: 1, stateEditRevision: null, narrationCorrectionRevision: null,
      baseTurnId: null, stateFingerprint: "state-fingerprint", narrationFingerprint: null
    },
    attempts: 1,
    orchestration_private: {},
    streaming_segments_state: {},
    orchestration_inputs: {
      useRpgStats: false, rpgStats: [], eventTriggers: [], pendingEventTriggers: [],
      storyMemoryDefaults: { canonicalFacts: [], supersededFacts: [] }, suppressEventTriggers: true,
      characterProfile: null, characterSnapshot: null
    }
  };
}

function authorizeReviewRetry(job: GenerationExecutionPayload, checkpoint: GenerationReviewCheckpoint): void {
  job.orchestration_private = {
    ...job.orchestration_private,
    generationReview: {
      ...checkpoint,
      state: "decided",
      revision: checkpoint.revision + 1,
      decisionJournal: [...checkpoint.decisionJournal, {
        reviewId: checkpoint.reviewId,
        revision: checkpoint.revision,
        actorUserId: job.owner_user_id,
        decision: "retry",
        decidedAt: "2026-09-17T00:00:00.000Z",
        candidateScope: checkpoint.candidateScope,
        candidateHash: checkpoint.gateCandidate.storyHash,
        findingsHash: checkpoint.originalFindingsHash,
        nextStage: checkpoint.stage,
        offeredCandidate: checkpoint.gateCandidate,
        offeredReasons: checkpoint.reasons,
        actionReceipt: {
          jobId: job.id,
          status: job.operation_kind === "append" ? "queued" : "replacement_queued",
          operationKind: job.operation_kind,
          replacementTurnId: job.replacement_turn_id
        }
      }]
    }
  };
}

describe("generation executor adapter", () => {
  it("prepares a final continuity offer that preserves the reviewed candidate and its retry stage", () => {
    const job = completeGenerationExecutionPayload();
    const story = storyTurnOutputSchema.parse({
      narration: "The observatory door opens onto a silent moonlit archive.",
      choices: ["Enter.", "Wait.", "Study.", "Call."], custom_action_suggestion: "Study the door.",
      scratchpad: "", tracker_updates: [], image_prompt: "A moonlit observatory archive.",
      continuity_summary: "The archive is open.", canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: []
    });
    const baseIdentity = { ...job.generation_base_identity!, stateFingerprint: "e".repeat(64) };
    const candidate = {
      scope: "final" as const, story, storyHash: sha256(canonicalEvidenceJson(story)), rawOutputReference: null,
      producingRequestHash: "a".repeat(64), producingResponseId: "provider-response", sentFactIds: [],
      ownerUserId: job.owner_user_id, campaignId: job.campaign_id, worldId: "00000000-0000-4000-8000-000000000006",
      worldVersionId: job.world_version_id ?? null, baseTurnNumber: baseIdentity.baseTurnNumber,
      expectedTurnNumber: job.expected_turn_number, policy: {}, policyHash: "b".repeat(64), baseIdentity,
      protocol: { version: job.prompt_protocol_version, promptHash: "c".repeat(64) },
      provider: { type: "openai_compatible", profileId: job.provider_profile_id, configurationHash: "d".repeat(64) },
      resumeDependencies: { generationContext: {}, producingProviderResult: { responseId: "provider-response" }, stageState: {}, frozenCommitInputs: {}, replacementTarget: null }
    };

    const review = prepareGenerationReview({ candidate, stage: "continuity", reasons: ["narrative_conflict"], operationKind: "append", replacementTurnId: null,
      eligibility: { structurallyValid: true, mechanicsClean: true, authorityValid: true, stageComplete: true, retryAvailable: true } });

    expect(review).toMatchObject({ state: "pending", stage: "continuity", candidateScope: "final", reasons: ["narrative_conflict"], eligibility: { complete: true, structurallyValid: true, mechanicsClean: true, authorityValid: true, stageComplete: true, retryAvailable: true } });
    expect(review.gateCandidate).toEqual(candidate);
    expect(review.originalFindingsHash).toBe(sha256(canonicalEvidenceJson(["narrative_conflict"])));
  });
  it("limits extension-only semantic repair to appended narration contradictions", () => {
    expect(semanticRepairScope({ hasExtension: true, mainNarration: "Main scene.", findings: [{ kind: "contradiction", output: { path: "/narration", start: "Main scene.".length } }] })).toBe("extension_only");
    expect(semanticRepairScope({ hasExtension: true, mainNarration: "Main scene.", findings: [{ kind: "contradiction", output: { path: "/continuity_summary", start: 0 } }] })).toBe("main");
    expect(semanticRepairScope({ hasExtension: false, mainNarration: "Main scene.", findings: [{ kind: "contradiction", output: { path: "/narration", start: 99 } }] })).toBe("main");
  });
  function plannerContext(characterAuthority: unknown, version: "legacy" | "v3" = "v3") {
    const baseIdentity = version === "v3"
      ? { version: "generation-base-v3", operationKind: "append", expectedTurnNumber: 1, baseTurnNumber: 0, campaignActiveTurnNumber: 0, campaignStateRevision: 1, stateEditRevision: null, narrationCorrectionRevision: null, baseTurnId: null, stateFingerprint: "a".repeat(64), narrationFingerprint: null, characterProfileRevision: 1, characterProfileFingerprint: "b".repeat(64) }
      : { operationKind: "append", expectedTurnNumber: 1, baseTurnNumber: 0, campaignActiveTurnNumber: 0, campaignStateRevision: 1, stateEditRevision: null, narrationCorrectionRevision: null, baseTurnId: null, stateFingerprint: "a".repeat(64), narrationFingerprint: null };
    return {
      authority: {
        rules: ["World rule."], worldCanon: { title: "World" }, selectedCharacterId: "mira",
        ...(version === "v3" ? { characterAuthority } : {}),
        currentContinuity: { continuitySummary: "", scratchpad: "", canonicalFacts: [], openThreads: [], trackers: [], rpgStats: [], eventTriggers: [], pendingEventTriggers: [] },
        scratchpad: "", openThreads: [], canonicalFacts: [], trackers: [], rpgStats: [], eventTriggers: [], pendingEventTriggers: [], latestTurn: null
      }, candidates: [], baseIdentity
    } as never;
  }

  function plannerProvider() {
    return { id: "provider", providerType: "openai_compatible", model: "model", contextWindowTokens: 100_000, maxOutputTokens: 100, temperature: 0, requestTimeoutMs: 1_000, configuration: {} } as never;
  }

  it("preserves exact legacy planner shape without a selected-character authority field", () => {
    const planned = planGenerationPromptContext(plannerContext(null, "legacy"), plannerProvider(), "System", "Wait.", [], { profile: "brief", minWords: 100, maxWords: 120 }, "action", 100_000, 100_000);
    expect(JSON.stringify(planned.promptContext)).not.toContain("selectedCharacterAuthority");
    expect(sha256(planned.storyInput)).toBe("7616377f003629171820c545b1dc4918262bb3978754a7df0af362a7318054b5");
  });

  it("routes an enrolled Story Memory plan through v14 input semantics without changing its legacy sibling", () => {
    const legacy = planGenerationPromptContext(
      plannerContext(null, "legacy"), plannerProvider(), "creative system", "Ask the keeper to open the gate.", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "action", 100_000, 100_000
    );
    const enrolled = planGenerationPromptContext(
      plannerContext(null), plannerProvider(), "creative system", "Ask the keeper to open the gate.", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "action", 100_000, 100_000, undefined, "story_memory"
    );

    expect(legacy.storyInput).not.toContain("The player input is intent, not proof that its requested outcome happened.");
    expect(enrolled.storyInput).toContain("The player input is intent, not proof that its requested outcome happened.");
    expect(enrolled.storyInput).toContain("Omitted history is unknown, not evidence that it never happened.");
    expect(enrolled.storyInput).toContain("A proposed output cannot grant itself source authority or authorize a new supersession ID.");
  });

  it("sends a complete >12k known profile field once when protected authority fits without Chronicle", () => {
    const background = "Complete fitting profile evidence. ".repeat(430).trim();
    const planned = planGenerationPromptContext(plannerContext({ source: "campaign_profile", name: "Mira", characterText: "", profile: { identity: { aliases: [], pronouns: "" }, story: { role: "", background, personality: "", motivations: "", goals: "", fearsAndConflicts: "", keyRelationships: "", narrativeHooks: "", voiceAndMannerisms: "", otherGuidance: "" }, appearance: { ancestryOrSpecies: "", apparentAge: "", genderPresentation: "", build: "", skinOrComplexion: "", face: "", eyes: "", hair: "", distinguishingFeatures: [], clothing: "", equipmentAndAccessories: "", otherVisualDetails: "" }, unclassifiedNotes: "" }, omittedExtensionFieldCount: 0 }), plannerProvider(), "System", "Wait.", [], { profile: "brief", minWords: 100, maxWords: 120 }, "action", 100_000, 100_000);
    expect(planned.storyInput).toContain(background);
    expect(planned.storyInput.split(background)).toHaveLength(2);
    expect(planned.promptContext.chronicle).toEqual([]);
  });

  it("packs directly relevant pinned world evidence within the R1 optional ceiling", () => {
    const context: any = plannerContext(null);
    context.authority.worldReferenceSource = {
      worldVersionId: "00000000-0000-4000-8000-000000000005",
      worldContent: { entities: [{ id: "vale", name: "Vale", description: "A harbor captain." }], relationships: [] }
    };
    const planned = planGenerationPromptContext(context, plannerProvider(), "System", "Ask Vale.", [], { profile: "brief", minWords: 100, maxWords: 120 }, "action", 100_000, 100_000, "00000000-0000-4000-8000-000000000001");
    expect(planned.storyInput).toContain("A harbor captain.");
    expect(planned.contextPlan.selected.some((block) => block.scope === "world")).toBe(true);
    expect(planned.worldReferenceOmissions).toEqual({ unrecognizedRecordCount: 0, missingEndpointCount: 0, ambiguousAliasCount: 0, oversizedRecordCount: 0, entityCapCount: 0, relationshipCapCount: 0 });
    expect(planned.sourceManifest?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ semanticRole: "world_reference", sourcePath: "/entities/0", form: "complete", selectionGroup: "world" })
    ]));
  });

  it("omits an oversized whole world record under a tight quota while optional history borrows the unused share", () => {
    const context: any = plannerContext({ source: "campaign_profile", name: "Mira", characterText: "", profile: { identity: { aliases: ["Vale"] } } });
    context.authority.worldReferenceSource = {
      worldVersionId: "00000000-0000-4000-8000-000000000005",
      worldContent: { entities: [
        { id: "vale", name: "Vale", description: "This complete world record is deliberately larger than the optional world allocation. ".repeat(14) }
      ], relationships: [] }
    };
    context.candidates = [{ id: "history", turnId: null, ordinal: 1, kind: "turn_fiction", content: "Borrowed history remains available when no world entry fits.", tokenEstimate: 10, rank: 0 }];

    const planned = planGenerationPromptContext(context, plannerProvider(), "System", "Ask Vale.", [], { profile: "brief", minWords: 100, maxWords: 120 }, "action", 3_000, 3_000);

    expect(planned.contextPlan.selected.some((block) => block.scope === "world")).toBe(false);
    expect(planned.promptContext.chronicle.map((candidate) => candidate.id)).toEqual(["history"]);
  });

  it("records every sent protected source and rebinds selected world evidence to its original pinned path", () => {
    const context: any = plannerContext({ source: "campaign_profile", name: "Mira", characterText: "", profile: { identity: { aliases: ["Vale"] } } });
    context.authority.currentContinuity = { continuitySummary: "Mira promised to return.", scratchpad: "", canonicalFacts: [{ id: "11111111-1111-4111-8111-111111111111", content: "The tide gate is locked." }], openThreads: ["Find Vale."], trackers: [], rpgStats: [], eventTriggers: [], pendingEventTriggers: [] };
    context.authority.latestTurn = { action: "Ask Vale.", narration: "The quay bell answers." };
    context.authority.worldReferenceSource = {
      worldVersionId: "00000000-0000-4000-8000-000000000005",
      worldContent: { entities: [{ id: "vale", name: "Vale", description: "A harbor captain.", internal: { secret: "must not reach the provider" } }], relationships: [] }
    };
    const planned = planGenerationPromptContext(context, plannerProvider(), "System", "Ask Vale.", [], { profile: "brief", minWords: 100, maxWords: 120 }, "action", 100_000, 100_000, "00000000-0000-4000-8000-000000000001");
    const manifest = planned.sourceManifest!;
    const roles = manifest.entries.map((entry) => entry.semanticRole);

    expect(roles).toEqual(expect.arrayContaining(["world_rule", "character_authority", "current_continuity", "canonical_fact", "accepted_narration", "player_intent", "world_reference"]));
    const world = manifest.entries.find((entry) => entry.semanticRole === "world_reference")!;
    expect(world.sourcePath).toBe("/entities/0");
    expect(world.source.revision).toBe(context.authority.worldReferenceSource.worldVersionId);
    expect(world.source.contentHash).toBe(sha256(canonicalEvidenceJson(context.authority.worldReferenceSource.worldContent)));
    expect(world.content).not.toContain("must not reach the provider");
    expect(planned.storyInput).not.toContain("must not reach the provider");
    expect(readStoryEvidenceFromSource(world, { entities: [world.content], relationships: [] }, {
      contentHash: sha256(canonicalEvidenceJson(context.authority.worldReferenceSource.worldContent))
    })).toEqual(world);
    const direction = manifest.entries.find((entry) => entry.selectionGroup === "direction")!;
    expect(readStoryEvidenceFromSource(direction, { text: "Ask Vale." })).toEqual(direction);
  });

  it("uses a stable character source identifier when no character is selected", () => {
    const context: any = plannerContext({ source: "none", name: "", characterText: "", profile: null });
    context.authority.selectedCharacterId = null;

    const planned = planGenerationPromptContext(context, plannerProvider(), "System", "Wait.", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "action", 100_000, 100_000,
      "00000000-0000-4000-8000-000000000001");

    expect(planned.sourceManifest?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ semanticRole: "character_authority", source: expect.objectContaining({ id: "selected-character" }) })
    ]));
  });

  it("exposes bounded count-only world selection omissions without world contents", () => {
    const context: any = plannerContext(null);
    const witnesses = Array.from({ length: 25 }, (_, index) => ({ id: `witness-${index}`, name: `Witness ${index}`, description: `Witness detail ${index}.` }));
    context.authority.worldReferenceSource = {
      worldVersionId: "00000000-0000-4000-8000-000000000005",
      worldContent: {
        entities: [
          { id: "warden-one", name: "Warden", description: "First warden." },
          { id: "warden-two", name: "Warden", description: "Second warden." },
          { id: "large", name: "Large", description: "x".repeat(30_000) },
          { hidden: "UNRECOGNIZED_WORLD_CONTENT" },
          ...witnesses
        ],
        relationships: [
          { from: "warden-one", to: "missing", description: "Broken relationship." },
          { source: { hidden: "UNRECOGNIZED_WORLD_CONTENT" } }
        ]
      }
    };
    const planned = planGenerationPromptContext(context, plannerProvider(), "System", `Warden ${witnesses.map((entry) => entry.name).join(" ")}`,
      [], { profile: "brief", minWords: 100, maxWords: 120 }, "action", 100_000, 100_000);

    expect(planned.worldReferenceOmissions).toEqual({ unrecognizedRecordCount: 2, missingEndpointCount: 1, ambiguousAliasCount: 1, oversizedRecordCount: 1, entityCapCount: 1, relationshipCapCount: 0 });
    expect(JSON.stringify(planned.worldReferenceOmissions)).not.toContain("UNRECOGNIZED_WORLD_CONTENT");
  });

  it("fails protected character overflow before any provider call or partial profile serialization", () => {
    const background = "Protected profile overflow. ".repeat(500).trim();
    expect(() => planGenerationPromptContext(plannerContext({ source: "campaign_profile", name: "Mira", characterText: "", profile: { identity: { aliases: [], pronouns: "" }, story: { role: "", background, personality: "", motivations: "", goals: "", fearsAndConflicts: "", keyRelationships: "", narrativeHooks: "", voiceAndMannerisms: "", otherGuidance: "" }, appearance: { ancestryOrSpecies: "", apparentAge: "", genderPresentation: "", build: "", skinOrComplexion: "", face: "", eyes: "", hair: "", distinguishingFeatures: [], clothing: "", equipmentAndAccessories: "", otherVisualDetails: "" }, unclassifiedNotes: "" }, omittedExtensionFieldCount: 0 }), plannerProvider(), "System", "Wait.", [], { profile: "brief", minWords: 100, maxWords: 120 }, "action", 100, 100)).toThrow(expect.objectContaining({ code: "context_budget_exceeded", protectedBlockIds: ["authority"] }));
  });

  it("uses a profile-only edit even when Chronicle candidates are unavailable", () => {
    const before = planGenerationPromptContext(plannerContext({ source: "campaign_profile", name: "Mira", characterText: "", profile: { story: { motivations: "Guard the east gate." } }, omittedExtensionFieldCount: 0 }), plannerProvider(), "System", "Wait.", [], { profile: "brief", minWords: 100, maxWords: 120 }, "action", 100_000, 100_000);
    const after = planGenerationPromptContext(plannerContext({ source: "campaign_profile", name: "Mira", characterText: "", profile: { story: { motivations: "Guard the west gate." } }, omittedExtensionFieldCount: 0 }), plannerProvider(), "System", "Wait.", [], { profile: "brief", minWords: 100, maxWords: 120 }, "action", 100_000, 100_000);
    expect(before.promptContext.chronicle).toEqual([]);
    expect(after.storyInput).toContain("Guard the west gate.");
    expect(after.storyInput).not.toContain("Guard the east gate.");
  });

  it("does not serialize recognized profile credentials into the private provider input", () => {
    const secret = "fixture-serialized-provider-token-T04";
    const authority = characterFictionAuthority({
      name: "Mira",
      profile: {
        story: { background: `Provider token: ${secret}\nMira keeps the bridge watch.` },
        unclassifiedNotes: `api_key=${secret}\nThe bridge bell rings at dusk.`
      }
    }, null);
    const planned = planGenerationPromptContext(plannerContext(authority), plannerProvider(), "System", "Wait.", [], { profile: "brief", minWords: 100, maxWords: 120 }, "action", 100_000, 100_000);
    expect(planned.storyInput).not.toContain(secret);
    expect(planned.storyInput).toContain("Mira keeps the bridge watch.");
    expect(planned.storyInput).toContain("The bridge bell rings at dusk.");
  });

  it("preserves the historical context fingerprint field set and separates frozen policy", () => {
    const input = { providerId: "provider", model: "model", protocol: "legacy", expectedTurnNumber: 2, action: "Act", inputMode: "action", storyLength: { label: "short" }, context: { world: "canon" } };
    expect(generationContextFingerprint(input)).toBe("6f4bd446bda2f101a509ba415a10f79036caf7d252b4f08fe37378e351254de3");
    expect(generationContextFingerprint({ ...input, generationPolicyIdentity: "frozen-policy" })).not.toBe(generationContextFingerprint(input));
  });
  it.each([0, Number.POSITIVE_INFINITY])("rejects supplied effective context window %s before provider execution", async (modelContextWindowTokens) => {
    const job = completeGenerationExecutionPayload();
    job.context_options.modelContextWindowTokens = modelContextWindowTokens;
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async () => true), savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true),
      recordAttempt: vi.fn(async () => undefined), markRecoverable: vi.fn(async () => true), markValidating: vi.fn(async () => true),
      markCommitting: vi.fn(async () => true), commitAcceptedTurn: vi.fn(async () => ({ turnId: "unexpected" })), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const provider = { id: claim.providerProfileId, name: "Provider", providerRole: "text" as const, providerType: "openai_compatible" as const,
      model: "test-model", contextWindowTokens: 16_000, maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {}, execute: vi.fn() };
    const collaborators = { ...rejectedCollaborators(), loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write fiction.") };

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators }).execute({ workerId: "invalid-window", leaseSeconds: 30, claim })).resolves.toBe(true);
    expect(provider.execute).not.toHaveBeenCalled();
    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "context_budget_invalid" }));
  });

  it("makes malformed canonical authority recoverable with a safe repair diagnostic before provider execution", async () => {
    const job = completeGenerationExecutionPayload();
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async () => true), recordAttempt: vi.fn(async () => undefined),
      markRecoverable: vi.fn(async () => true), markFailed: vi.fn(async () => true), commitAcceptedTurn: vi.fn()
    } as unknown as GenerationExecutionRepository;
    const provider = { id: claim.providerProfileId, providerType: "openai_compatible", model: "test",
      contextWindowTokens: 100_000, maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000,
      configuration: {}, execute: vi.fn() };
    const collaborators = { ...rejectedCollaborators(), loadTextExecution: vi.fn(async () => provider),
      promptFromSnapshot: vi.fn(() => "Write fiction."), memory: { loadGenerationContext: vi.fn(async () => {
        throw Object.assign(new Error("PRIVATE malformed persisted source"), { code: "authoritative_context_invalid", field: "canonical_facts" });
      }) } } as unknown as GenerationExecutionCollaborators;
    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
      .execute({ workerId: "invalid-authority", leaseSeconds: 30, claim })).resolves.toBe(true);
    expect(provider.execute).not.toHaveBeenCalled();
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "authoritative_context_invalid",
      recoveryMetadata: expect.objectContaining({ diagnostic: { code: "authoritative_context_invalid", operation: "story_generation",
        action: "repair_authority", field: "canonical_facts" } }) }));
    expect(JSON.stringify(vi.mocked(repository.markRecoverable).mock.calls)).not.toContain("PRIVATE");
  });

  it("accounts for the frozen Story Direction supplement before context retrieval or dispatch", async () => {
    const job = completeGenerationExecutionPayload();
    const supplement = "frozen story direction instruction ".repeat(6_000);
    const unmodifiedPolicy = {
      version: 1, playMode: "story_only", turnControlStyle: "flexible_scene", protocolVersion: "story-only-v1",
      prompts: {
        ...storyOnlyPromptSnapshot(),
        systemSupplement: supplement,
        systemSupplementHash: sha256(supplement)
      }
    } as const;
    job.generation_policy = unmodifiedPolicy;
    job.prompt_protocol_version = generationExecutionProtocolIdentity(snapshotProtocolIdentity(job.prompt_snapshot), unmodifiedPolicy);
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async () => true), savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true),
      recordAttempt: vi.fn(async () => undefined), markRecoverable: vi.fn(async () => true), markValidating: vi.fn(async () => true),
      markCommitting: vi.fn(async () => true), commitAcceptedTurn: vi.fn(async () => ({ turnId: "unexpected" })), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const provider = { id: claim.providerProfileId, name: "Provider", providerRole: "text" as const, providerType: "openai_compatible" as const,
      model: "test-model", contextWindowTokens: 12_000, maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {}, execute: vi.fn() };
    const loadGenerationContext = vi.fn();
    const collaborators = {
      ...rejectedCollaborators(), loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write fiction."),
      memory: { loadGenerationContext }, recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators }).execute({ workerId: "story-only-envelope", leaseSeconds: 30, claim })).resolves.toBe(true);

    expect(loadGenerationContext).not.toHaveBeenCalled();
    expect(provider.execute).not.toHaveBeenCalled();
    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "context_budget_invalid" }));
  });

  it("marks a hash-mismatched frozen Story Direction policy recoverable before provider work", async () => {
    const job = completeGenerationExecutionPayload();
    const unmodifiedPolicy = {
      version: 1, playMode: "story_only", turnControlStyle: "flexible_scene", protocolVersion: "story-only-v1",
      prompts: storyOnlyPromptSnapshot()
    } as const;
    job.prompt_protocol_version = generationExecutionProtocolIdentity(snapshotProtocolIdentity(job.prompt_snapshot), unmodifiedPolicy);
    job.generation_policy = { ...unmodifiedPolicy, prompts: { ...unmodifiedPolicy.prompts, systemSupplementHash: "0".repeat(64) } };
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async () => true), savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true),
      recordAttempt: vi.fn(async () => undefined), markRecoverable: vi.fn(async () => true), markValidating: vi.fn(async () => true),
      markCommitting: vi.fn(async () => true), commitAcceptedTurn: vi.fn(async () => ({ turnId: "unexpected" })), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const provider = { id: claim.providerProfileId, name: "Provider", providerRole: "text" as const, providerType: "openai_compatible" as const,
      model: "test-model", contextWindowTokens: 16_000, maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {}, execute: vi.fn() };
    const loadGenerationContext = vi.fn();
    const collaborators = {
      ...rejectedCollaborators(), loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write fiction."),
      memory: { loadGenerationContext }, recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators }).execute({ workerId: "story-only-hash", leaseSeconds: 30, claim })).resolves.toBe(false);

    expect(loadGenerationContext).not.toHaveBeenCalled();
    expect(provider.execute).not.toHaveBeenCalled();
    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "generation_policy_invalid",
      recoveryMetadata: expect.objectContaining({ reason: "generation_policy_invalid" })
    }));
    expect(repository.markFailed).not.toHaveBeenCalled();
  });

  it("marks a schema-invalid non-null policy recoverable before provider work", async () => {
    const job = completeGenerationExecutionPayload();
    job.generation_policy = { version: 1, playMode: "legacy", turnControlStyle: "flexible_scene" } as never;
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async () => true), savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true),
      recordAttempt: vi.fn(async () => undefined), markRecoverable: vi.fn(async () => true), markValidating: vi.fn(async () => true),
      markCommitting: vi.fn(async () => true), commitAcceptedTurn: vi.fn(async () => ({ turnId: "unexpected" })), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const provider = { id: claim.providerProfileId, name: "Provider", providerRole: "text" as const, providerType: "openai_compatible" as const,
      model: "test-model", contextWindowTokens: 16_000, maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {}, execute: vi.fn() };
    const loadGenerationContext = vi.fn();
    const collaborators = {
      ...rejectedCollaborators(), loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write fiction."),
      memory: { loadGenerationContext }, recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators }).execute({ workerId: "story-only-schema", leaseSeconds: 30, claim })).resolves.toBe(false);

    expect(loadGenerationContext).not.toHaveBeenCalled();
    expect(provider.execute).not.toHaveBeenCalled();
    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "generation_policy_invalid" }));
  });

  it.each([
    { label: "a normal completion", finishReason: "stop", outputLimited: false },
    { label: "a complete length-finish response", finishReason: "length", outputLimited: true }
  ])("runs Story Direction through one fiction-only provider operation without dormant mechanics guidance after $label", async ({ finishReason, outputLimited }) => {
    const job = completeGenerationExecutionPayload();
    job.generation_base_identity = { ...job.generation_base_identity!, stateFingerprint: "a".repeat(64) };
    const policy = {
      version: 1, playMode: "story_only", turnControlStyle: "flexible_scene", protocolVersion: "story-only-v1",
      prompts: storyOnlyPromptSnapshot()
    } as const;
    job.generation_policy = policy;
    job.prompt_protocol_version = generationExecutionProtocolIdentity(snapshotProtocolIdentity(job.prompt_snapshot), policy);
    job.resolved_input_mode = "scene";
    job.orchestration_inputs = {
      ...job.orchestration_inputs,
      useRpgStats: true,
      suppressEventTriggers: false,
      rpgStats: [{ id: "private-stat", name: "PRIVATE_STAT_CANARY", value: 17 }] as never,
      eventTriggers: [
        { id: "before-trigger", label: "PRIVATE_BEFORE_CANARY", timing: "before", condition: "PRIVATE_BEFORE_CANARY", effect: "PRIVATE_BEFORE_CANARY", addTextAfter: false, triggeredCount: 0, lastTriggeredTurn: null, lastTriggeredAt: null },
        { id: "after-trigger", label: "PRIVATE_AFTER_CANARY", timing: "after", condition: "PRIVATE_AFTER_CANARY", effect: "PRIVATE_AFTER_CANARY", addTextAfter: true, triggeredCount: 0, lastTriggeredTurn: null, lastTriggeredAt: null }
      ] as never,
      pendingEventTriggers: [{ id: "pending-trigger", sourceTriggerId: "dormant-trigger", name: "PRIVATE_PENDING_CANARY", timing: "before", condition: "PRIVATE_PENDING_CANARY", effect: "PRIVATE_PENDING_CANARY", instructions: "PRIVATE_PENDING_CANARY", reason: "", sourceTurn: 2, addTextAfter: false }] as never
    };
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async (_scope, value) => { job.orchestration_private = value; return true; }),
      savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true),
      recordAttempt: vi.fn(async () => undefined), markRecoverable: vi.fn(async () => true), markValidating: vi.fn(async () => true),
      markCommitting: vi.fn(async () => true), commitAcceptedTurn: vi.fn(async () => ({ turnId: "00000000-0000-4000-8000-000000000006" })),
      markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const story = {
      narration: "The observatory door opens onto a room of silver instruments.",
      choices: ["Enter the room.", "Study the instruments.", "Call for the keeper.", "Wait outside."],
      custom_action_suggestion: "Examine the moonlit lens.", scratchpad: "The door is open.", tracker_updates: [],
      image_prompt: "A moonlit observatory.", continuity_summary: "The observatory door is open.",
      canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: ["Learn who built the observatory."]
    };
    const provider = {
      id: claim.providerProfileId, name: "Story-only provider", providerRole: "text" as const,
      providerType: "openai_compatible" as const, model: "test-model", contextWindowTokens: 16_000,
      maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {},
      execute: vi.fn(async () => ({ content: JSON.stringify(story), responseId: "story-only", finishReason, outputLimited, modelInstanceId: "test-instance", usage: {}, reportedCost: null, rawMetadata: {} }))
    };
    const operations: string[] = [];
    const collaborators = {
      memory: { loadGenerationContext: vi.fn(async () => ({
        authority: { rules: ["Protect the observatory."], worldCanon: { title: "Observatory" }, currentContinuity: { openThreads: ["Learn who built the observatory."] }, latestTurn: null },
        candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT
      })) },
      illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) },
      loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write a concise fictional scene."),
      recordProfileCost: vi.fn(async (_pool, _provider, attribution) => { operations.push(attribution.operation); }),
      attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
      .execute({ workerId: "story-only-worker", leaseSeconds: 30, claim })).resolves.toBe(true);

    expect(operations).toEqual(["story_generation"]);
    expect(provider.execute).toHaveBeenCalledOnce();
    expect(repository.commitAcceptedTurn, JSON.stringify(job.orchestration_private)).toHaveBeenCalledWith(expect.objectContaining({
      story: expect.objectContaining({ choices: story.choices }),
      orchestration: expect.not.objectContaining({ beforeEvents: expect.any(Array) })
    }));
    expect(repository.commitAcceptedTurn).toHaveBeenCalledWith(expect.objectContaining({
      orchestration: expect.not.objectContaining({ afterEvents: expect.any(Array) })
    }));
    const wire = JSON.stringify((provider.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
    expect(wire).not.toContain("PRIVATE_STAT_CANARY");
    expect(wire).not.toContain("PRIVATE_BEFORE_CANARY");
    expect(wire).not.toContain("PRIVATE_AFTER_CANARY");
    expect(wire).not.toContain("PRIVATE_PENDING_CANARY");
  });

  it("stops before validation when the complete primary capture cannot be persisted", async () => {
    const job = completeGenerationExecutionPayload();
    const policy = { version: 1, playMode: "story_only", turnControlStyle: "flexible_scene", protocolVersion: "story-only-v1", prompts: storyOnlyPromptSnapshot() } as const;
    job.generation_policy = policy;
    job.prompt_protocol_version = generationExecutionProtocolIdentity(snapshotProtocolIdentity(job.prompt_snapshot), policy);
    job.resolved_input_mode = "scene";
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async (_scope, value) => !value.primaryResult),
      savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true), recordAttempt: vi.fn(async () => undefined),
      markRecoverable: vi.fn(async () => true), markValidating: vi.fn(async () => true), markCommitting: vi.fn(async () => true),
      commitAcceptedTurn: vi.fn(async () => ({ turnId: "unexpected" })), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const provider = {
      id: claim.providerProfileId, name: "Capture failure provider", providerRole: "text" as const, providerType: "openai_compatible" as const,
      model: "test-model", contextWindowTokens: 16_000, maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {},
      execute: vi.fn(async () => ({ content: JSON.stringify({ narration: "The moonlit observatory opens.", choices: ["Enter.", "Wait.", "Study.", "Call."], custom_action_suggestion: "Study the lens.", scratchpad: "", tracker_updates: [], image_prompt: "A moonlit observatory.", continuity_summary: "The observatory opens.", canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: [] }), responseId: "capture-failure", finishReason: "stop", outputLimited: false, modelInstanceId: "test", usage: {}, reportedCost: null, rawMetadata: {} }))
    };
    const collaborators = {
      memory: { loadGenerationContext: vi.fn(async () => ({ authority: {}, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT })) },
      illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) }, loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write fiction."),
      recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
      .execute({ workerId: "capture-failure", leaseSeconds: 30, claim })).resolves.toBe(true);

    expect(provider.execute).toHaveBeenCalledOnce();
    expect(repository.recordAttempt).not.toHaveBeenCalled();
    expect(repository.markValidating).not.toHaveBeenCalled();
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
  });

  it("pauses a reclaimed reserved primary request before another narration call", async () => {
    const job = completeGenerationExecutionPayload();
    job.attempts = 2;
    job.generation_base_identity = { ...job.generation_base_identity!, stateFingerprint: "e".repeat(64) };
    job.orchestration_private = {
      primaryReservation: { version: 1, requestBody: "{\"request\":true}", requestPayloadHash: sha256("{\"request\":true}"), providerConfigurationHash: "a".repeat(64), attempt: 1, status: "reserved" }
    } as never;
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async () => true), pauseForReview: vi.fn(async () => true), savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true),
      recordAttempt: vi.fn(async () => undefined), markRecoverable: vi.fn(async () => true), markValidating: vi.fn(async () => true), markCommitting: vi.fn(async () => true),
      commitAcceptedTurn: vi.fn(async () => ({ turnId: "unexpected" })), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const provider = { id: claim.providerProfileId, name: "Reservation provider", providerRole: "text" as const, providerType: "openai_compatible" as const,
      model: "test-model", contextWindowTokens: 16_000, maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {}, execute: vi.fn() };
    const collaborators = { memory: { loadGenerationContext: vi.fn(async () => ({ authority: {}, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT })) },
      illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) }, loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write fiction."), recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined) } as unknown as GenerationExecutionCollaborators;

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
      .execute({ workerId: "reserved-primary", leaseSeconds: 30, claim: { ...claim, attempts: 2 } })).resolves.toBe(true);

    expect(provider.execute).not.toHaveBeenCalled();
    expect(repository.markFailed).not.toHaveBeenCalled();
    expect(repository.pauseForReview).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      stage: "structure", candidateScope: "main", reasons: ["output_incomplete"], gateCandidate: expect.objectContaining({ story: null })
    }));
  });

  it.each([
    { label: "malformed JSON", content: "{not-valid-json", outputLimited: false, expectedOperations: ["story_generation"], errorCode: "invalid_json", expectedStage: "structure", expectedReason: "invalid_structure" },
    { label: "output-limited partial JSON", content: "{\"narration\":\"The observatory", outputLimited: true, expectedOperations: ["story_generation"], errorCode: "output_limit", expectedStage: "structure", expectedReason: "output_incomplete" },
    { label: "output-limited duplicate choices", content: JSON.stringify({ narration: "The observatory door opens.", choices: ["Wait.", " WAIT. ", "Look.", "Listen."], custom_action_suggestion: "Study.", scratchpad: "", tracker_updates: [], image_prompt: "", continuity_summary: "The door opens.", canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: [] }), outputLimited: true, expectedOperations: ["story_generation"], errorCode: "output_limit", expectedStage: "choices", expectedReason: "invalid_choices" }
  ])("keeps Story Direction $label recoverable without mechanical follow-up dispatch", async ({ content, outputLimited, expectedOperations, errorCode, expectedStage, expectedReason }) => {
    const job = completeGenerationExecutionPayload();
    job.generation_base_identity = { ...job.generation_base_identity!, stateFingerprint: "a".repeat(64) };
    const policy = {
      version: 1, playMode: "story_only", turnControlStyle: "flexible_scene", protocolVersion: "story-only-v1",
      prompts: storyOnlyPromptSnapshot()
    } as const;
    job.generation_policy = policy;
    job.prompt_protocol_version = generationExecutionProtocolIdentity(snapshotProtocolIdentity(job.prompt_snapshot), policy);
    job.resolved_input_mode = "scene";
    job.orchestration_inputs = {
      ...job.orchestration_inputs,
      useRpgStats: true,
      suppressEventTriggers: false,
      rpgStats: [{ id: "private-stat", name: "PRIVATE_STAT_CANARY", value: 17 }] as never,
      eventTriggers: [{ id: "before", label: "PRIVATE_EVENT_CANARY", timing: "before", condition: "PRIVATE_EVENT_CANARY", effect: "PRIVATE_EVENT_CANARY", addTextAfter: false, triggeredCount: 0, lastTriggeredTurn: null, lastTriggeredAt: null }] as never,
      pendingEventTriggers: [{ id: "pending", sourceTriggerId: "separate", name: "PRIVATE_PENDING_CANARY", timing: "before", condition: "PRIVATE_PENDING_CANARY", effect: "PRIVATE_PENDING_CANARY", instructions: "PRIVATE_PENDING_CANARY", reason: "", sourceTurn: 2, addTextAfter: false }] as never
    };
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async (_scope, value) => { job.orchestration_private = value; return true; }),
      savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true),
      recordAttempt: vi.fn(async () => undefined), pauseForReview: vi.fn(async () => true), markRecoverable: vi.fn(async () => true), markValidating: vi.fn(async () => true),
      markCommitting: vi.fn(async () => true), commitAcceptedTurn: vi.fn(async () => ({ turnId: "unexpected" })), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const provider = {
      id: claim.providerProfileId, name: "Story-only recovery provider", providerRole: "text" as const,
      providerType: "openai_compatible" as const, model: "test-model", contextWindowTokens: 16_000,
      maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {},
      execute: vi.fn(async () => ({ content, responseId: "invalid-story", finishReason: outputLimited ? "length" : "stop", outputLimited, modelInstanceId: "test-instance", usage: {}, reportedCost: null, rawMetadata: {} }))
    };
    const operations: string[] = [];
    const collaborators = {
      memory: { loadGenerationContext: vi.fn(async () => ({ authority: {}, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT })) },
      illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) },
      loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write fiction."),
      recordProfileCost: vi.fn(async (_pool, _provider, attribution) => { operations.push(attribution.operation); }),
      attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
      .execute({ workerId: `story-only-${errorCode}`, leaseSeconds: 30, claim })).resolves.toBe(true);

    expect(operations).toEqual(expectedOperations);
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
    expect(repository.markRecoverable).not.toHaveBeenCalled();
    expect(repository.markFailed).not.toHaveBeenCalled();
    expect(repository.pauseForReview).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      state: "pending", stage: expectedStage, candidateScope: "main",
      reasons: [expectedReason]
    }));
  });

  it("rejects a reclaimed Story Direction mechanical checkpoint before it can consume dormant events", async () => {
    const job = completeGenerationExecutionPayload();
    const policy = {
      version: 1, playMode: "story_only", turnControlStyle: "flexible_scene", protocolVersion: "story-only-v1",
      prompts: storyOnlyPromptSnapshot()
    } as const;
    job.generation_policy = policy;
    job.prompt_protocol_version = generationExecutionProtocolIdentity(snapshotProtocolIdentity(job.prompt_snapshot), policy);
    job.orchestration_private = {
      beforeEvents: [{ id: "dormant", sourceTriggerId: "dormant", name: "Dormant", timing: "before", condition: "", effect: "", instructions: "must not be consumed", reason: "", sourceTurn: 2, addTextAfter: false }]
    } as never;
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markRecoverable: vi.fn(async () => true),
      markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const provider = { id: claim.providerProfileId, name: "Provider", providerRole: "text" as const, providerType: "openai_compatible" as const,
      model: "test-model", contextWindowTokens: 16_000, maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {}, execute: vi.fn() };
    const collaborators = {
      ...rejectedCollaborators(), loadTextExecution: vi.fn(async () => provider),
      promptFromSnapshot: vi.fn(() => "Write fiction."),
      memory: { loadGenerationContext: vi.fn(async () => ({
        authority: {}, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT
      })) }
    } as unknown as GenerationExecutionCollaborators;

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
      .execute({ workerId: "story-only-reclaim", leaseSeconds: 30, claim: { ...claim, attempts: 2 } })).resolves.toBe(true);

    expect(provider.execute).not.toHaveBeenCalled();
    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "generation_checkpoint_incompatible",
      recoveryMetadata: expect.objectContaining({ reason: "story_only_mechanics_checkpoint" })
    }));
  });

  it("extracts fact authority from exact main, extension, and LM Studio recovery bodies only", () => {
    const authorized = "11111111-1111-4111-8111-111111111111";
    const invented = "22222222-2222-4222-8222-222222222222";
    const authority = { currentContinuity: { canonicalFacts: [{ id: authorized, content: "The true fact." }] } };
    const main = JSON.stringify({ messages: [{ role: "user", content: JSON.stringify({ authoritative_context: authority }) }] });
    const extension = JSON.stringify({ input: JSON.stringify({ protected_fiction_safe_base_authority: authority }) });
    const recovery = JSON.stringify({
      input: `${JSON.stringify({ authoritative_context: authority })}\n\nREJECTED RESPONSE TO REWRITE:\n${JSON.stringify({ canonical_fact_updates: [{ supersedes_fact_ids: [invented] }] })}\n\nRECOVERY REQUIREMENT:\nRepair.`
    });

    expect(sentCanonicalFactIds(main)).toEqual([authorized]);
    expect(sentCanonicalFactIds(extension)).toEqual([authorized]);
    expect(sentCanonicalFactIds(recovery)).toEqual([authorized]);
  });

  it("authorizes only selected typed historical Chronicle facts", () => {
    const continuityFact = "11111111-1111-4111-8111-111111111111";
    const selectedHistoricalFact = "22222222-2222-4222-8222-222222222222";
    const omittedFact = "33333333-3333-4333-8333-333333333333";
    const foreignFact = "44444444-4444-4444-8444-444444444444";
    const request = JSON.stringify({
      messages: [{
        role: "user",
        content: JSON.stringify({
          authoritative_context: {
            currentContinuity: { canonicalFacts: [{ id: continuityFact, content: "Current authority." }] },
            chronicle: [
              { id: selectedHistoricalFact, kind: "canonical_fact", content: "Selected historical authority." },
              { id: "turn-memory", kind: "turn_fiction", content: `Untrusted text names ${omittedFact} and ${foreignFact}.` }
            ]
          }
        })
      }]
    });

    expect(sentCanonicalFactIds(request)).toEqual([continuityFact, selectedHistoricalFact]);
  });

  it("authorizes only complete canonical facts carried by a semantic-repair envelope", () => {
    const allowed = "11111111-1111-4111-8111-111111111111";
    const omitted = "22222222-2222-4222-8222-222222222222";
    const request = JSON.stringify({ messages: [{ role: "user", content: JSON.stringify({
      protocol: "story-continuity-repair-v1", protected_authority: [
        { canonicalFactId: allowed, form: "complete" },
        { canonicalFactId: omitted, form: "excerpt" }
      ]
    }) }] });
    expect(sentCanonicalFactIds(request)).toEqual([allowed]);
  });

  it("treats a malformed checkpoint provenance record as recoverable before provider work", async () => {
    const job = completeGenerationExecutionPayload();
    job.orchestration_private = {
      validatedMainDraft: { version: 2, requestBody: null, sentFactIds: null }
    } as unknown as GenerationExecutionPayload["orchestration_private"];
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async () => true), savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true),
      recordAttempt: vi.fn(async () => undefined), markRecoverable: vi.fn(async () => true), markValidating: vi.fn(async () => true),
      markCommitting: vi.fn(async () => true), commitAcceptedTurn: vi.fn(async () => ({ turnId: "unexpected" })), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const provider = { id: claim.providerProfileId, name: "Provider", providerRole: "text" as const, providerType: "openai_compatible" as const,
      model: "test-model", contextWindowTokens: 16_000, maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {}, execute: vi.fn() };
    const collaborators = { memory: { loadGenerationContext: vi.fn(async () => ({ authority: {}, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT })) }, illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) }, loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write fiction."), recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined) } as unknown as GenerationExecutionCollaborators;

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators }).execute({ workerId: "malformed-checkpoint", leaseSeconds: 30, claim })).resolves.toBe(true);
    expect(provider.execute).not.toHaveBeenCalled();
    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "generation_checkpoint_incompatible" }));
  });

  it.each([
    ["Action", "action", "action", "explicit"],
    ["Scene", "scene", "scene", "explicit"],
    ["resolved Auto", "auto", "action", "auto"],
    ["new Action policy", "action", "action", "explicit"]
  ] as const)("reclaims a captured complete %s result without another narration call", async (label, requestedInputMode, resolvedInputMode, inputModeSource) => {
    const job = completeGenerationExecutionPayload();
    job.requested_input_mode = requestedInputMode;
    job.resolved_input_mode = resolvedInputMode;
    job.input_mode_source = inputModeSource;
    job.generation_policy = null;
    if (label === "new Action policy") {
      job.generation_policy = { version: 1, playMode: "legacy", turnControlStyle: "flexible_action" };
      job.prompt_protocol_version = generationExecutionProtocolIdentity(snapshotProtocolIdentity(job.prompt_snapshot), job.generation_policy);
    }
    const firstNarration = "The first validated draft opens the observatory door.";
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true),
      markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async (_scope, value) => {
        job.orchestration_private = value;
        return true;
      }),
      pauseForReview: vi.fn(async (_scope, checkpoint) => {
        job.orchestration_private = { ...job.orchestration_private, generationReview: checkpoint };
        return true;
      }),
      savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true),
      recordAttempt: vi.fn(async () => undefined), markRecoverable: vi.fn(async () => true),
      markValidating: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
      markCommitting: vi.fn(async () => true),
      commitAcceptedTurn: vi.fn(async () => ({ turnId: "00000000-0000-4000-8000-000000000006" })),
      markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const provider = {
      id: claim.providerProfileId, name: "Captured provider", providerRole: "text" as const,
      providerType: "openai_compatible" as const, model: "test-model", contextWindowTokens: 16_000,
      maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {},
      execute: vi.fn()
        .mockResolvedValueOnce({
          content: JSON.stringify({
            narration: firstNarration,
            choices: ["Enter.", "Wait.", "Study.", "Call."],
            custom_action_suggestion: "Study the lens.", scratchpad: "The door is open.",
            tracker_updates: [], image_prompt: "A moonlit observatory hall.",
            continuity_summary: "The observatory door is open.", canonical_facts: [],
            superseded_facts: [], canonical_fact_updates: [], open_threads: []
          }),
          responseId: "first-response", finishReason: "stop", outputLimited: false,
          modelInstanceId: "test-instance", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          reportedCost: null, rawMetadata: {}
        })
        .mockResolvedValue({
          content: JSON.stringify({ covered: true, missing_required_beats: [], contradictions: [] }),
          responseId: "scene-coverage", finishReason: "stop", outputLimited: false,
          modelInstanceId: "test-instance", usage: {}, reportedCost: null, rawMetadata: {}
        })
    };
    const collaborators = {
      memory: {
        loadGenerationContext: vi.fn(async () => ({
          authority: {}, candidates: [], baseIdentity: job.generation_base_identity,
          chronicleRetrieval: DEDICATED_CHUNKED_AUDIT
        }))
      },
      illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) },
      loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn((_snapshot, key) => String(key)),
      recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;

    const executor = createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators });
    await expect(executor.execute({ workerId: "worker-a", leaseSeconds: 30, claim })).resolves.toBe(true);
    expect(job.orchestration_private.primaryResult).toMatchObject({
      requestPayloadHash: expect.any(String), response: { responseId: "first-response" },
      sentFactIds: expect.any(Array)
    });
    expect(repository.savePartialNarration).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: job.id }), firstNarration
    );
    expect(job.orchestration_private.validatedMainDraft).toBeDefined();
    const capturedPrimary = job.orchestration_private.primaryResult;
    job.orchestration_private = { primaryResult: capturedPrimary! };
    job.attempts = 2;
    await expect(executor.execute({ workerId: "worker-b", leaseSeconds: 30, claim: { ...claim, attempts: 2 } })).resolves.toBe(true);

    const mainNarrationCalls = (provider.execute as ReturnType<typeof vi.fn>).mock.calls
      .filter(([request]) => request.systemPrompt === "story_system");
    expect(mainNarrationCalls).toHaveLength(1);
    expect(repository.commitAcceptedTurn).toHaveBeenCalledWith(expect.objectContaining({
      story: expect.objectContaining({ narration: firstNarration }),
      response: expect.objectContaining({ responseId: "first-response" })
    }));
    if (label === "new Action policy") {
      expect(job.generation_policy).toEqual({ version: 1, playMode: "legacy", turnControlStyle: "flexible_action" });
    } else {
      expect(job.prompt_protocol_version).toBe("test-protocol");
      expect(job.generation_policy).toBeNull();
    }
    expect(repository.markRecoverable).not.toHaveBeenCalled();
  });

  it("makes an incompatible validated-draft checkpoint recoverable before provider work", async () => {
    const job = completeGenerationExecutionPayload();
    job.orchestration_private = {
      validatedMainDraft: { version: 1, providerId: "different-provider" }
    } as unknown as GenerationExecutionPayload["orchestration_private"];
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true),
      markGenerating: vi.fn(async () => true), saveOrchestration: vi.fn(async () => true),
      savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true),
      recordAttempt: vi.fn(async () => undefined), markRecoverable: vi.fn(async () => true),
      markValidating: vi.fn(async () => true), markCommitting: vi.fn(async () => true),
      commitAcceptedTurn: vi.fn(async () => ({ turnId: "unexpected" })), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const provider = {
      id: claim.providerProfileId, name: "Captured provider", providerRole: "text" as const,
      providerType: "openai_compatible" as const, model: "test-model", contextWindowTokens: 16_000,
      maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {}, execute: vi.fn()
    };
    const collaborators = {
      memory: { loadGenerationContext: vi.fn(async () => ({ authority: {}, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT })) },
      illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) },
      loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write a concise fictional scene."),
      recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
      .execute({ workerId: "checkpoint-worker", leaseSeconds: 30, claim })).resolves.toBe(true);

    expect(provider.execute).not.toHaveBeenCalled();
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "generation_checkpoint_incompatible"
    }));
  });

  it("does not repeat a consumed automatic repair after a lease reclaim", async () => {
    const job = completeGenerationExecutionPayload();
    job.orchestration_private = {
      automaticRepair: {
        stage: "schema_repair",
        rejectedDraftHash: "rejected-draft-hash",
        consumedAttempt: 1
      }
    };
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true),
      markGenerating: vi.fn(async () => true), saveOrchestration: vi.fn(async () => true),
      markRecoverable: vi.fn(async () => true), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const provider = {
      id: claim.providerProfileId, name: "Captured provider", providerRole: "text" as const,
      providerType: "openai_compatible" as const, model: "test-model", contextWindowTokens: 16_000,
      maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {}, execute: vi.fn()
    };
    const collaborators = {
      memory: { loadGenerationContext: vi.fn(async () => ({ authority: {}, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT })) },
      illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) },
      loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write a concise fictional scene."),
      recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
      .execute({ workerId: "reclaim-worker", leaseSeconds: 30, claim: { ...claim, attempts: 2 } })).resolves.toBe(true);

    expect(provider.execute).not.toHaveBeenCalled();
    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "automatic_repair_consumed",
      recoveryMetadata: expect.objectContaining({ stage: "schema_repair" })
    }));
  });

  it("persists one event-coverage repair and commits only its revalidated full story", async () => {
    const job = completeGenerationExecutionPayload();
    job.generation_base_identity = { ...job.generation_base_identity!, stateFingerprint: "a".repeat(64) };
    job.orchestration_inputs.suppressEventTriggers = false;
    const immediateEvent = {
      id: "immediate-bell",
      triggerId: "00000000-0000-4000-8000-000000000010",
      sourceTriggerId: "00000000-0000-4000-8000-000000000010",
      sourceTurn: claim.expectedTurnNumber,
      addTextAfter: true,
      instructions: "A silver bell rings in the observatory.",
      summary: "The bell must ring."
    };
    job.orchestration_private.afterEvents = [immediateEvent] as never;
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true),
      markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async (_scope, value) => {
        job.orchestration_private = value;
        return true;
      }),
      pauseForReview: vi.fn(async (_scope, checkpoint) => {
        job.orchestration_private = { ...job.orchestration_private, generationReview: checkpoint };
        return true;
      }),
      savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true),
      recordAttempt: vi.fn(async () => undefined), markRecoverable: vi.fn(async () => true),
      markValidating: vi.fn(async () => true), markCommitting: vi.fn(async () => true),
      commitAcceptedTurn: vi.fn(async () => ({ turnId: "00000000-0000-4000-8000-000000000006" })),
      markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const story = (narration: string) => JSON.stringify({
      narration, choices: ["Enter.", "Wait.", "Study.", "Call."], custom_action_suggestion: "Study the lens.",
      scratchpad: "The door is open.", tracker_updates: [], image_prompt: "A moonlit observatory hall.",
      continuity_summary: "The observatory door is open.", canonical_facts: [], superseded_facts: [],
      canonical_fact_updates: [], open_threads: []
    });
    const provider = {
      id: claim.providerProfileId, name: "Captured provider", providerRole: "text" as const,
      providerType: "openai_compatible" as const, model: "test-model", contextWindowTokens: 16_000,
      maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {}, execute: vi.fn()
        .mockResolvedValueOnce({ content: story("The observatory door opens."), responseId: "main", finishReason: "stop", outputLimited: false, modelInstanceId: "test-instance", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: story("The observatory door opens.\n\nThe chamber stays silent."), responseId: "extension", finishReason: "stop", outputLimited: false, modelInstanceId: "test-instance", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: JSON.stringify({ event_results: [{ event_id: "immediate-bell", covered: false, missing_required_beats: ["bell"], contradictions: [] }] }), responseId: "coverage-1", finishReason: "stop", outputLimited: false, modelInstanceId: "test-instance", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: JSON.stringify({ event_results: [{ event_id: "immediate-bell", covered: true, missing_required_beats: [], contradictions: [] }] }), responseId: "coverage-2", finishReason: "stop", outputLimited: false, modelInstanceId: "test-instance", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: JSON.stringify({ event_results: [{ event_id: "immediate-bell", covered: true, missing_required_beats: [], contradictions: [] }] }), responseId: "appended-coverage", finishReason: "stop", outputLimited: false, modelInstanceId: "test-instance", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: story("The observatory door opens.\n\nA silver bell rings."), responseId: "repair", finishReason: "stop", outputLimited: false, modelInstanceId: "test-instance", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: JSON.stringify({ event_results: [{ event_id: "immediate-bell", covered: true, missing_required_beats: [], contradictions: [] }] }), responseId: "repair-coverage", finishReason: "stop", outputLimited: false, modelInstanceId: "test-instance", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: JSON.stringify({ event_results: [{ event_id: "immediate-bell", covered: true, missing_required_beats: [], contradictions: [] }] }), responseId: "repair-appended-coverage", finishReason: "stop", outputLimited: false, modelInstanceId: "test-instance", usage: {}, reportedCost: null, rawMetadata: {} })
    };
    const collaborators = {
      memory: { loadGenerationContext: vi.fn(async () => ({
        authority: {
          worldCanon: {
            rpgStats: [{ id: "private-stat", value: 17, note: "PRIVATE_STAT_CANARY" }],
            trackers: [
              { id: "private-tracker", value: 12, note: "PRIVATE_TRACKER_CANARY" },
              { id: "doorway", name: "Silver doorway", value: "hidden" }
            ]
          },
          currentContinuity: {
            rpgStats: [{ id: "private-current-stat", value: 9, note: "PRIVATE_STAT_CANARY" }],
            eventTriggers: [{ id: "private-trigger", instructions: "PRIVATE_TRACKER_CANARY" }]
          }
        },
        candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT
      })) },
      illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) },
      loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write a concise fictional scene."),
      recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;

    const executor = createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators });
    await expect(executor.execute({ workerId: "event-repair-initial", leaseSeconds: 30, claim })).resolves.toBe(true);
    const validatedMainDraftHash = job.orchestration_private.validatedMainDraft?.draftHash;
    expect(validatedMainDraftHash).toEqual(expect.any(String));
    expect(provider.execute).toHaveBeenCalledTimes(3);
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
    const pendingEventGate = job.orchestration_private.generationReview as GenerationReviewCheckpoint;
    expect(pendingEventGate).toMatchObject({ state: "pending", stage: "event_coverage", candidateScope: "final" });
    authorizeReviewRetry(job, pendingEventGate);
    await expect(executor.execute({ workerId: "event-repair-worker", leaseSeconds: 30, claim: { ...claim, attempts: 2 } })).resolves.toBe(true);

    expect(job.orchestration_private.eventCoverageRepair).toEqual(expect.objectContaining({
      consumedAttempt: 1,
      authorizedReviewId: pendingEventGate.reviewId,
      authorizedRevision: pendingEventGate.revision
    }));
    expect(repository.commitAcceptedTurn).toHaveBeenCalledWith(expect.objectContaining({
      story: expect.objectContaining({ narration: "The observatory door opens.\n\nA silver bell rings." })
    }));
    const serializedFictionRequests = provider.execute.mock.calls.map(([request]) => String(request.input));
    expect(serializedFictionRequests).toHaveLength(8);
    for (const request of serializedFictionRequests) {
      expect(request).not.toContain("PRIVATE_STAT_CANARY");
      expect(request).not.toContain("PRIVATE_TRACKER_CANARY");
    }
    expect(serializedFictionRequests[0]).toContain("Silver doorway");
    expect(provider.execute.mock.calls[5]?.[0].budgetOutput).toEqual({
      kind: "event_extension",
      protectedStory: {
        narration: "The observatory door opens.",
        scratchpad: "The door is open.",
        continuitySummary: "The observatory door is open.",
        openThreads: []
      },
      narrationCharacterLimit: 200_000
    });
    expect(JSON.parse(provider.execute.mock.calls[5]?.[0].input || "{}")).toMatchObject({
      protected_fiction_safe_base_authority: expect.objectContaining({
        worldCanon: expect.objectContaining({ trackers: [{ id: "doorway", name: "Silver doorway", value: "hidden" }] })
      }),
      complete_validated_main_draft: expect.objectContaining({ narration: "The observatory door opens." }),
      original_player_action: "Open the observatory door."
    });
    job.attempts = 2;
    job.orchestration_private.extension = {
      story: JSON.parse(story("The observatory door opens.\n\nThe keeper's unique warning remains.")),
      finalStoryHash: "",
      producingAttempt: 1,
      producingOperation: "event_extension",
      validatedMainDraftHash: job.orchestration_private.validatedMainDraft?.draftHash || "missing-main-draft",
      producingRequestPayloadHash: "extension-request-fixture",
      sentFactIds: []
    };
    job.orchestration_private.extension.finalStoryHash = stableStringify(job.orchestration_private.extension.story);
    delete job.orchestration_private.eventCoverageRepair;
    provider.execute.mockReset()
      .mockResolvedValueOnce({ content: JSON.stringify({ covered: false, missing_required_beats: ["bell"], contradictions: [] }), responseId: "coverage-drop", finishReason: "stop", outputLimited: false, modelInstanceId: "test-instance", usage: {}, reportedCost: null, rawMetadata: {} })
      .mockResolvedValueOnce({ content: story("The observatory door opens.\n\nA silver bell rings."), responseId: "repair-drop", finishReason: "stop", outputLimited: false, modelInstanceId: "test-instance", usage: {}, reportedCost: null, rawMetadata: {} });
    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
      .execute({ workerId: "event-repair-reclaim", leaseSeconds: 30, claim: { ...claim, attempts: 2 } })).resolves.toBe(true);
    expect(provider.execute).not.toHaveBeenCalled();
    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "generation_checkpoint_incompatible"
    }));
    expect(repository.commitAcceptedTurn).toHaveBeenCalledTimes(1);
  });

  it("repairs before-event coverage once, revalidates it, and commits the repaired main draft", async () => {
    const job = completeGenerationExecutionPayload();
    job.generation_base_identity = { ...job.generation_base_identity!, stateFingerprint: "a".repeat(64) };
    job.orchestration_inputs.suppressEventTriggers = false;
    job.orchestration_private.beforeEvents = [{
      id: "before-event", sourceTriggerId: "before-trigger", name: "Bell", timing: "before",
      condition: "", effect: "", instructions: "A bell rings in the hall.", reason: "", sourceTurn: 3,
      addTextAfter: false
    }];
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async (_scope, value) => { job.orchestration_private = value; return true; }),
      pauseForReview: vi.fn(async (_scope, checkpoint) => { job.orchestration_private = { ...job.orchestration_private, generationReview: checkpoint }; return true; }),
      savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true), recordAttempt: vi.fn(async () => undefined),
      markRecoverable: vi.fn(async () => true), markValidating: vi.fn(async () => true), markCommitting: vi.fn(async () => true),
      commitAcceptedTurn: vi.fn(async () => ({ turnId: "turn" })), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const output = (narration: string) => JSON.stringify({ narration, choices: ["A", "B", "C", "D"], custom_action_suggestion: "Wait.", scratchpad: "", tracker_updates: [], image_prompt: "", continuity_summary: "", canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: [] });
    const provider = { id: claim.providerProfileId, name: "Provider", providerRole: "text" as const, providerType: "openai_compatible" as const,
      model: "test-model", contextWindowTokens: 16_000, maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {},
      execute: vi.fn()
        .mockResolvedValueOnce({ content: output("The hall is quiet."), responseId: "main", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: JSON.stringify({ event_results: [{ event_id: "before-event", covered: false, missing_required_beats: ["before-event"], contradictions: [] }] }), responseId: "miss", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: JSON.stringify({ event_results: [{ event_id: "before-event", covered: true, missing_required_beats: [], contradictions: [] }] }), responseId: "retry-check", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: output("The hall is quiet.\n\nA bell rings in the hall."), responseId: "repair", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: JSON.stringify({ event_results: [{ event_id: "before-event", covered: true, missing_required_beats: [], contradictions: [] }] }), responseId: "verified", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} }) };
    const collaborators = { memory: { loadGenerationContext: vi.fn(async () => ({ authority: {}, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT })) }, illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) }, loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write fiction."), recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined) } as unknown as GenerationExecutionCollaborators;

    const executor = createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators });
    await expect(executor.execute({ workerId: "before-repair", leaseSeconds: 30, claim })).resolves.toBe(true);
    expect(provider.execute).toHaveBeenCalledTimes(2);
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
    const pendingEventGate = job.orchestration_private.generationReview as GenerationReviewCheckpoint;
    expect(pendingEventGate).toMatchObject({ state: "pending", stage: "event_coverage", candidateScope: "main" });
    authorizeReviewRetry(job, pendingEventGate);
    await expect(executor.execute({ workerId: "before-repair-retry", leaseSeconds: 30, claim: { ...claim, attempts: 2 } })).resolves.toBe(true);
    expect(repository.markRecoverable).not.toHaveBeenCalled();
    expect(provider.execute).toHaveBeenCalledTimes(5);
    expect(repository.commitAcceptedTurn).toHaveBeenCalledWith(expect.objectContaining({ story: expect.objectContaining({ narration: expect.stringContaining("bell rings") }) }));

  });

  it("stops after a rewritten before-event draft still fails coverage", async () => {
    const job = completeGenerationExecutionPayload();
    job.generation_base_identity = { ...job.generation_base_identity!, stateFingerprint: "a".repeat(64) };
    job.orchestration_inputs.suppressEventTriggers = false;
    job.orchestration_private.beforeEvents = [{
      id: "before-event", sourceTriggerId: "before-trigger", name: "Bell", timing: "before",
      condition: "", effect: "", instructions: "A bell rings in the hall.", reason: "", sourceTurn: 3,
      addTextAfter: false
    }];
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async (_scope, value) => { job.orchestration_private = value; return true; }),
      pauseForReview: vi.fn(async (_scope, checkpoint) => { job.orchestration_private = { ...job.orchestration_private, generationReview: checkpoint }; return true; }),
      savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true), recordAttempt: vi.fn(async () => undefined),
      markRecoverable: vi.fn(async () => true), markValidating: vi.fn(async () => true), markCommitting: vi.fn(async () => true),
      commitAcceptedTurn: vi.fn(async () => ({ turnId: "turn" })), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const output = (narration: string) => JSON.stringify({ narration, choices: ["A", "B", "C", "D"], custom_action_suggestion: "Wait.", scratchpad: "", tracker_updates: [], image_prompt: "", continuity_summary: "", canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: [] });
    const provider = { id: claim.providerProfileId, name: "Provider", providerRole: "text" as const, providerType: "openai_compatible" as const,
      model: "test-model", contextWindowTokens: 16_000, maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {},
      execute: vi.fn()
        .mockResolvedValueOnce({ content: output("The hall is quiet."), responseId: "main", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: JSON.stringify({ event_results: [{ event_id: "before-event", covered: false, missing_required_beats: ["before-event"], contradictions: [] }] }), responseId: "miss", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: JSON.stringify({ event_results: [{ event_id: "before-event", covered: true, missing_required_beats: [], contradictions: [] }] }), responseId: "retry-check", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: output("The hall remains quiet."), responseId: "repair", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: JSON.stringify({ event_results: [{ event_id: "before-event", covered: false, missing_required_beats: ["before-event"], contradictions: [] }] }), responseId: "still-missing", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} }) };
    const collaborators = { memory: { loadGenerationContext: vi.fn(async () => ({ authority: {}, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT })) }, illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) }, loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write fiction."), recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined) } as unknown as GenerationExecutionCollaborators;

    const executor = createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators });
    await expect(executor.execute({ workerId: "before-repair-exhausted", leaseSeconds: 30, claim })).resolves.toBe(true);
    expect(provider.execute).toHaveBeenCalledTimes(2);
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
    authorizeReviewRetry(job, job.orchestration_private.generationReview as GenerationReviewCheckpoint);
    await expect(executor.execute({ workerId: "before-repair-exhausted-retry", leaseSeconds: 30, claim: { ...claim, attempts: 2 } })).resolves.toBe(true);

    expect(provider.execute).toHaveBeenCalledTimes(5);
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
    expect(repository.markRecoverable).not.toHaveBeenCalled();
    expect(job.orchestration_private.generationReview).toMatchObject({ state: "pending", stage: "event_coverage", eligibility: { retryAvailable: false } });
  });

  it("uses replacement output budgeting for a feasible near-limit before-event rewrite", async () => {
    const job = completeGenerationExecutionPayload();
    job.generation_base_identity = { ...job.generation_base_identity!, stateFingerprint: "a".repeat(64) };
    job.orchestration_inputs.suppressEventTriggers = false;
    job.orchestration_private.beforeEvents = [{
      id: "before-event", sourceTriggerId: "before-trigger", name: "Bell", timing: "before",
      condition: "", effect: "", instructions: "A bell rings in the hall.", reason: "", sourceTurn: 3,
      addTextAfter: false
    }];
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async (_scope, value) => { job.orchestration_private = value; return true; }),
      pauseForReview: vi.fn(async (_scope, checkpoint) => { job.orchestration_private = { ...job.orchestration_private, generationReview: checkpoint }; return true; }),
      savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true), recordAttempt: vi.fn(async () => undefined),
      markRecoverable: vi.fn(async () => true), markValidating: vi.fn(async () => true), markCommitting: vi.fn(async () => true),
      commitAcceptedTurn: vi.fn(async () => ({ turnId: "turn" })), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const output = (narration: string) => JSON.stringify({ narration, choices: ["A", "B", "C", "D"], custom_action_suggestion: "Wait.", scratchpad: "", tracker_updates: [], image_prompt: "", continuity_summary: "", canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: [] });
    const provider = { id: claim.providerProfileId, name: "Provider", providerRole: "text" as const, providerType: "openai_compatible" as const,
      model: "test-model", contextWindowTokens: 1_000_000, maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {},
      execute: vi.fn(async (request: { budgetOutput?: { kind: string } }) => {
        if (request.budgetOutput?.kind === "story_replace") return { content: output("A bell rings in the hall."), responseId: "repair", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} };
        if (request.budgetOutput?.kind === "event_extension") throw Object.assign(new Error("prefix-preserving output cannot fit"), { code: "extension_narration_limit_exceeded" });
        if ((provider.execute as ReturnType<typeof vi.fn>).mock.calls.length === 1) return { content: output("N".repeat(200_000)), responseId: "main", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} };
        return { content: JSON.stringify({ event_results: [{ event_id: "before-event", covered: (provider.execute as ReturnType<typeof vi.fn>).mock.calls.length > 2, missing_required_beats: (provider.execute as ReturnType<typeof vi.fn>).mock.calls.length > 2 ? [] : ["before-event"], contradictions: [] }] }), responseId: "coverage", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} };
      }) };
    const collaborators = { memory: { loadGenerationContext: vi.fn(async () => ({ authority: {}, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT })) }, illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) }, loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write fiction."), recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined) } as unknown as GenerationExecutionCollaborators;

    const executor = createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators });
    await expect(executor.execute({ workerId: "near-limit-before-repair", leaseSeconds: 30, claim })).resolves.toBe(true);
    expect(provider.execute).toHaveBeenCalledTimes(2);
    authorizeReviewRetry(job, job.orchestration_private.generationReview as GenerationReviewCheckpoint);
    await expect(executor.execute({ workerId: "near-limit-before-repair-retry", leaseSeconds: 30, claim: { ...claim, attempts: 2 } })).resolves.toBe(true);

    expect(provider.execute.mock.calls[3]?.[0].budgetOutput).toEqual({ kind: "story_replace" });
    expect(repository.markRecoverable).not.toHaveBeenCalled();
    expect(repository.commitAcceptedTurn).toHaveBeenCalledWith(expect.objectContaining({ story: expect.objectContaining({ narration: "A bell rings in the hall." }) }));
  });

  it("sends planner-selected private authority candidates and records omitted candidates without reading the legacy preview", async () => {
    const job = completeGenerationExecutionPayload();
    job.context_options = { ...job.context_options, budgetTokens: 1_000 };
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true),
      markGenerating: vi.fn(async () => true), saveOrchestration: vi.fn(async () => true),
      savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true),
      recordAttempt: vi.fn(async () => undefined), markRecoverable: vi.fn(async () => true),
      markValidating: vi.fn(async () => true), markCommitting: vi.fn(async () => true),
      commitAcceptedTurn: vi.fn(async () => ({ turnId: "00000000-0000-4000-8000-000000000006" })),
      markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const provider = {
      id: claim.providerProfileId, name: "Captured provider", providerRole: "text" as const,
      providerType: "openai_compatible" as const, model: "test-model", contextWindowTokens: 16_000,
      maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {},
      execute: vi.fn(async () => ({
        content: JSON.stringify({ narration: "The observatory door opens onto a quiet moonlit hall.",
          choices: ["Enter.", "Wait.", "Study.", "Call."], custom_action_suggestion: "Study the lens.",
          scratchpad: "The door is open.", tracker_updates: [], image_prompt: "A moonlit observatory hall.",
          continuity_summary: "The observatory door is open.", canonical_facts: [], superseded_facts: [],
          canonical_fact_updates: [], open_threads: [] }), responseId: "test-response", finishReason: "stop",
        outputLimited: false, modelInstanceId: "test-instance", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        reportedCost: null, rawMetadata: {}
      }))
    };
    const collaborators = {
      memory: {
        loadGenerationContext: vi.fn(async () => ({
          authority: { rules: ["Never abandon the observatory."], worldCanon: { title: "Moon Archive" },
            selectedCharacterId: null, currentContinuity: { continuitySummary: "The keeper waits.", scratchpad: "Private note.", openThreads: [], canonicalFacts: [], trackers: {}, rpgStats: [], eventTriggers: [], pendingEventTriggers: [] },
            scratchpad: "Private note.", openThreads: [], canonicalFacts: [], trackers: {}, rpgStats: [], eventTriggers: [], pendingEventTriggers: [], latestTurn: null },
          candidates: [
            { id: "selected-memory", turnId: null, ordinal: 1, kind: "turn_fiction", content: "The keeper lit the lantern.", tokenEstimate: 10, rank: 1 },
            { id: "omitted-memory", turnId: null, ordinal: 2, kind: "turn_fiction", content: "x".repeat(10_000), tokenEstimate: 10_000, rank: 2 }
          ], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT
        })),
        buildContextPreview: vi.fn(async () => { throw new Error("legacy preview must not be read"); })
      },
      illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) },
      loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write a concise fictional scene."),
      recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;
    const executor = createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators });

    await expect(executor.execute({ workerId: "worker-a", leaseSeconds: 30, claim })).resolves.toBe(true);

    expect(collaborators.memory.buildContextPreview).not.toHaveBeenCalled();
    const input = JSON.parse((provider.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].input);
    expect(input.authoritative_context.authoritativeRules).toEqual(["Never abandon the observatory."]);
    expect(input.authoritative_context.currentContinuity).not.toHaveProperty("rpgStats");
    expect(input.authoritative_context.currentContinuity).not.toHaveProperty("eventTriggers");
    expect(input.authoritative_context.currentContinuity).not.toHaveProperty("pendingEventTriggers");
    expect(input.authoritative_context.chronicle.map((entry: { id: string }) => entry.id)).toEqual(["selected-memory"]);
    const accepted = (repository.commitAcceptedTurn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(accepted.contextDiagnostics.selectedContext).toEqual([{ id: "authority", revision: expect.any(String) }, { id: "selected-memory", revision: expect.any(String) }]);
    expect(accepted.contextDiagnostics.omittedContext).toEqual([{ id: "omitted-memory", revision: expect.any(String), reason: "context_limit" }]);
    expect(accepted.contextDiagnostics).toMatchObject({
      countMode: "estimated",
      estimatorVersion: "story-token-estimate-v1"
    });
  });

  it("makes a provider-request budget overflow recoverable before an RPG fallback can commit a turn", async () => {
    const job = completeGenerationExecutionPayload();
    job.orchestration_inputs = {
      ...job.orchestration_inputs,
      useRpgStats: true,
      rpgStats: [{ id: "courage", name: "Courage", value: 3, note: "Steady under pressure." }]
    };
    const repository = {
      loadExecutionPayload: vi.fn(async () => job),
      renewLease: vi.fn(async () => true),
      markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async () => true),
      pauseForReview: vi.fn(async () => true),
      savePartialNarration: vi.fn(async () => true),
      saveStreamingSegments: vi.fn(async () => true),
      recordAttempt: vi.fn(async () => undefined),
      markRecoverable: vi.fn(async () => true),
      markValidating: vi.fn(async () => true),
      markCommitting: vi.fn(async () => true),
      commitAcceptedTurn: vi.fn(async () => ({ turnId: "00000000-0000-4000-8000-000000000006" })),
      markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const provider = {
      id: claim.providerProfileId, name: "Captured provider", providerRole: "text" as const,
      providerType: "openai_compatible" as const, model: "test-model", contextWindowTokens: 16_000,
      maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {},
      execute: vi.fn()
        .mockRejectedValueOnce(new ContextBudgetError("context_budget_exceeded", 100, 10, undefined, { scope: "provider_request" }))
        .mockResolvedValueOnce({
          content: JSON.stringify({
            narration: "The observatory door opens onto a quiet moonlit hall.",
            choices: ["Enter the hall.", "Wait outside.", "Inspect the lock.", "Call for the keeper."],
            custom_action_suggestion: "Study the observatory lens.", scratchpad: "The door is now open.",
            tracker_updates: [], image_prompt: "A quiet moonlit observatory hall.",
            continuity_summary: "The observatory door is open.", canonical_facts: [],
            superseded_facts: [], canonical_fact_updates: [], open_threads: []
          }), responseId: "test-response", finishReason: "stop", outputLimited: false,
          modelInstanceId: "test-instance", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          reportedCost: null, rawMetadata: {}
        })
    };
    const collaborators = {
      memory: {
        loadGenerationContext: vi.fn(async () => ({ authority: {}, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT })),
        buildContextPreview: vi.fn(async () => ({
          campaign: { id: claim.campaignId, worldVersionId: job.world_version_id, selectedCharacterId: null, characterProfileRevision: 0 },
          selectedCompression: null, retrieval: {}, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT,
          scopes: { worldCanon: {}, campaignCanon: {}, chronicle: [], currentScene: null,
            currentContinuity: { continuitySummary: "", openThreads: [], canonicalFacts: [], scratchpad: "" } }
        }))
      },
      illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) },
      loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write a concise fictional scene."),
      recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;

    const executor = createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators });
    await expect(executor.execute({ workerId: "worker-a", leaseSeconds: 30, claim })).resolves.toBe(true);

    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "context_budget_exceeded",
      errorMessage: "Generation context could not be safely prepared.",
      recoveryMetadata: expect.objectContaining({
        diagnostic: {
          code: "context_budget_exceeded",
          operation: "story_generation",
          action: "adjust_context",
          scope: "provider_request",
          requiredTokens: 100,
          availableTokens: 10,
          countMode: "estimated",
          estimatorVersion: "story-token-estimate-v1"
        }
      })
    }));
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
    expect(repository.markFailed).not.toHaveBeenCalled();
    expect(provider.execute).toHaveBeenCalledOnce();
    expect(collaborators.memory.loadGenerationContext).toHaveBeenCalledWith({}, expect.objectContaining({
      expectedBaseIdentity: job.generation_base_identity,
      retrievalBudgetTokens: 8_000
    }));
  });

  it.each(["legacy", "v3"])("classifies a provider-window overflow with safe protected categories: %s", async (version) => {
    const job = completeGenerationExecutionPayload();
    job.context_options = { ...job.context_options, budgetTokens: 1_000_000 };
    if (version === "v3") job.generation_base_identity = { ...job.generation_base_identity!, version: "generation-base-v3", characterProfileRevision: 1, characterProfileFingerprint: "b".repeat(64) };
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async () => true), savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true),
      recordAttempt: vi.fn(async () => undefined), markRecoverable: vi.fn(async () => true), markValidating: vi.fn(async () => true),
      markCommitting: vi.fn(async () => true), commitAcceptedTurn: vi.fn(async () => ({ turnId: "unexpected" })), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const provider = {
      id: claim.providerProfileId, name: "Constrained provider", providerRole: "text" as const,
      providerType: "openai_compatible" as const, model: "test-model", contextWindowTokens: 20_000,
      maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {}, execute: vi.fn()
    };
    const collaborators = {
      memory: {
        loadGenerationContext: vi.fn(async () => ({
          authority: { worldCanon: { premise: "word ".repeat(12_000) } }, candidates: [],
          baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT
        }))
      },
      illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) },
      loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write a concise fictional scene."),
      recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;

    const executor = createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators });
    await expect(executor.execute({ workerId: "worker-a", leaseSeconds: 30, claim })).resolves.toBe(true);

    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "context_budget_exceeded",
      recoveryMetadata: expect.objectContaining({ diagnostic: expect.objectContaining({ scope: "provider_request" }) })
    }));
    if (version === "v3") expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({
      recoveryMetadata: expect.objectContaining({ diagnostic: expect.objectContaining({ protectedComponents: expect.objectContaining({ world_canon: expect.any(Number) }) }) })
    }));
    expect(provider.execute).not.toHaveBeenCalled();
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
  });

  it("treats a missing guarded payload as cancellation before provider work or mutation", async () => {
    const repository = guardedRepository();
    const collaborators = rejectedCollaborators();
    const executor = createGenerationExecutor({
      pool: {} as DatabasePool,
      repository,
      collaborators
    });

    await expect(executor.execute({ workerId: "worker-a", leaseSeconds: 30, claim })).resolves.toBe(false);

    expect(repository.loadExecutionPayload).toHaveBeenCalledOnce();
    expect(repository.loadExecutionPayload).toHaveBeenCalledWith({
      workerId: "worker-a",
      leaseSeconds: 30,
      claim
    });
    expect(collaborators.illustration.loadStreamingIllustrationConfig).not.toHaveBeenCalled();
    expect(collaborators.illustration.createProvisionalSet).not.toHaveBeenCalled();
    expect(repository.renewLease).not.toHaveBeenCalled();
    expect(repository.markGenerating).not.toHaveBeenCalled();
    expect(repository.markFailed).not.toHaveBeenCalled();
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
  });

  it("does not call a provider for a malformed loaded prompt snapshot", async () => {
    const providerCalls: unknown[] = [];
    const malformedJob = { ...completeGenerationExecutionPayload(), prompt_snapshot: {} as never };
    const repository = {
      loadExecutionPayload: vi.fn(async () => malformedJob),
      renewLease: vi.fn(async () => true),
      markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async () => true),
      pauseForReview: vi.fn(async () => true),
      savePartialNarration: vi.fn(async () => true),
      saveStreamingSegments: vi.fn(async () => true),
      recordAttempt: vi.fn(async () => undefined),
      markRecoverable: vi.fn(async () => true),
      markValidating: vi.fn(async () => true),
      markCommitting: vi.fn(async () => true),
      commitAcceptedTurn: vi.fn(async () => ({ turnId: "00000000-0000-4000-8000-000000000006" })),
      markFailed: vi.fn(async () => true)
    } as GenerationExecutionRepository;
    const provider = {
      id: claim.providerProfileId, name: "Captured provider", providerRole: "text" as const,
      providerType: "openai_compatible" as const, model: "test-model", contextWindowTokens: 16_000,
      maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {},
      execute: vi.fn(async (request: unknown) => {
        providerCalls.push(request);
        throw new Error("The malformed snapshot must not reach provider execution.");
      })
    };
    const collaborators = {
      memory: {
        autoEnableCampaignEmbedding: vi.fn(async () => undefined),
        loadGenerationContext: vi.fn(async () => ({ authority: {}, candidates: [], baseIdentity: malformedJob.generation_base_identity })),
        buildContextPreview: vi.fn(async () => ({
          campaign: { id: claim.campaignId, worldVersionId: malformedJob.world_version_id, selectedCharacterId: null, characterProfileRevision: 0 },
          selectedCompression: null,
          retrieval: {},
          chronicleRetrieval: DEDICATED_CHUNKED_AUDIT,
          scopes: {
            worldCanon: {}, campaignCanon: {}, chronicle: [], currentScene: null,
            currentContinuity: { continuitySummary: "", openThreads: [], canonicalFacts: [], scratchpad: "" }
          }
        })),
        enqueueEmbeddingReindex: vi.fn(async () => undefined),
        rebuildCampaignMemories: vi.fn(async () => undefined),
        storeDerivedTurnMemories: vi.fn(async () => undefined),
        writeAcceptedTurnFiction: vi.fn(async () => undefined)
      },
      illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) },
      loadTextExecution: vi.fn(async () => provider),
      promptFromSnapshot: vi.fn(() => "Write a concise fictional scene."),
      recordProfileCost: vi.fn(async () => undefined),
      attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;
    const executor = createGenerationExecutor({
      pool: {} as DatabasePool,
      repository,
      collaborators
    });

    const executed = await executor.execute({ workerId: "worker-a", leaseSeconds: 30, claim });
    expect(providerCalls).toEqual([]);
    expect(executed).toBe(false);
    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "generation_prompt_snapshot_invalid",
      recoveryMetadata: expect.objectContaining({ diagnostic: {
        code: "prompt_protocol_upgrade_required", operation: "story_generation", action: "discard_and_reenqueue"
      } })
    }));
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
  });

  it("refuses an unsupported future Story Memory policy before loading its provider and publishes discard recovery", async () => {
    const policy = defaultStoryMemoryPolicy("r2");
    const job = completeGenerationExecutionPayload();
    job.context_options = {
      ...job.context_options,
      storyMemoryPolicy: {
        policy: { ...policy, capability: "r4" }, policyHash: storyMemoryPolicyHash(policy), contextProtocol: "current-continuity-v3",
        promptProtocol: "story-v14-continuity-context", providerConfigurationFingerprint: "a".repeat(64)
      }
    } as never;
    const repository = { ...guardedRepository(), loadExecutionPayload: vi.fn(async () => job), markRecoverable: vi.fn(async () => true) };
    const collaborators = rejectedCollaborators();

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
      .execute({ workerId: "worker-a", leaseSeconds: 30, claim })).resolves.toBe(false);

    expect(collaborators.loadTextExecution).not.toHaveBeenCalled();
    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "story_memory_policy_invalid",
      recoveryMetadata: expect.objectContaining({ diagnostic: {
        code: "prompt_protocol_upgrade_required", operation: "story_generation", action: "discard_and_reenqueue"
      } })
    }));
  });

  it("raises generation_cancelled when malformed snapshot recovery loses its lease", async () => {
    const malformedJob = { ...completeGenerationExecutionPayload(), prompt_snapshot: {} as never };
    const repository = {
      ...guardedRepository(),
      loadExecutionPayload: vi.fn(async () => malformedJob),
      markRecoverable: vi.fn(async () => false)
    } as GenerationExecutionRepository;
    const executor = createGenerationExecutor({
      pool: {} as DatabasePool,
      repository,
      collaborators: rejectedCollaborators()
    });

    await expect(executor.execute({ workerId: "worker-a", leaseSeconds: 30, claim }))
      .rejects.toMatchObject({ code: "generation_cancelled" });
  });

  it("passes the validated Chronicle retrieval audit unchanged into the accepted-turn commit", async () => {
    const retrievalDiagnostics = { fallbackReason: "chunk_index_not_ready", selectedMemoryCount: 4 };
    const job = {
      id: claim.jobId,
      owner_user_id: claim.ownerUserId,
      campaign_id: claim.campaignId,
      world_version_id: "00000000-0000-4000-8000-000000000005",
      provider_profile_id: claim.providerProfileId,
      expected_turn_number: claim.expectedTurnNumber,
      operation_kind: "append",
      replacement_turn_id: null,
      base_turn_number: null,
      base_state_private: {},
      base_scratchpad_safe_for_prompt: false,
      action: "Open the observatory door.",
      requested_input_mode: "action",
      resolved_input_mode: "action",
      input_mode_source: "explicit",
      requested_model: "test-model",
      context_options: {
        budgetTokens: 8_000,
        modelContextWindowTokens: 8_000,
        compression: "auto",
        query: "Open the observatory door.",
        recentTurns: 4
      },
      prompt_protocol_version: "test-protocol",
      prompt_snapshot: validPromptSnapshot(),
      generation_policy: null,
      generation_base_identity: {
        operationKind: "append",
        expectedTurnNumber: claim.expectedTurnNumber,
        baseTurnNumber: claim.expectedTurnNumber - 1,
        campaignActiveTurnNumber: claim.expectedTurnNumber - 1,
        campaignStateRevision: 1,
        stateEditRevision: null,
        narrationCorrectionRevision: null,
        baseTurnId: null,
        stateFingerprint: "state-fingerprint",
        narrationFingerprint: null
      },
      attempts: 1,
      orchestration_private: {},
      streaming_segments_state: {},
      orchestration_inputs: {
        useRpgStats: false,
        rpgStats: [],
        eventTriggers: [],
        pendingEventTriggers: [],
        storyMemoryDefaults: { canonicalFacts: [], supersededFacts: [] },
        suppressEventTriggers: true,
        characterProfile: null,
        characterSnapshot: null
      }
    } as GenerationExecutionPayload;
    const repository = {
      loadExecutionPayload: vi.fn(async () => job),
      renewLease: vi.fn(async () => true),
      markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async () => true),
      savePartialNarration: vi.fn(async () => true),
      saveStreamingSegments: vi.fn(async () => true),
      recordAttempt: vi.fn(async () => undefined),
      markRecoverable: vi.fn(async () => true),
      markValidating: vi.fn(async () => true),
      markCommitting: vi.fn(async () => true),
      commitAcceptedTurn: vi.fn(async () => ({ turnId: "00000000-0000-4000-8000-000000000006" })),
      markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const collaborators = {
      memory: {
        loadGenerationContext: vi.fn(async () => ({
          authority: { currentContinuity: { continuitySummary: "The keeper is alive.", openThreads: [],
            canonicalFacts: [{ id: "11111111-1111-4111-8111-111111111111", content: "The keeper is alive." }],
            scratchpad: "Private harbor details." } },
          candidates: [{
            id: "22222222-2222-4222-8222-222222222222", turnId: null, ordinal: 1,
            kind: "canonical_fact", content: "The historical keeper has left the observatory.", tokenEstimate: 12, rank: 1
          }, {
            id: "33333333-3333-4333-8333-333333333333", turnId: null, ordinal: 0,
            kind: "canonical_fact", content: "x".repeat(100_000), tokenEstimate: 25_000, rank: 2
          }], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT
        })),
        buildContextPreview: vi.fn(async () => ({
          campaign: {
            id: claim.campaignId,
            worldVersionId: job.world_version_id,
            selectedCharacterId: null,
            characterProfileRevision: 0
          },
          selectedCompression: null,
          retrieval: retrievalDiagnostics,
          chronicleRetrieval: DEDICATED_CHUNKED_AUDIT,
          scopes: {
            worldCanon: {},
            campaignCanon: {},
            chronicle: [],
            currentScene: null,
            currentContinuity: {
              continuitySummary: "The keeper is alive.",
              openThreads: [],
              canonicalFacts: [{ id: "11111111-1111-4111-8111-111111111111", content: "The keeper is alive." }],
              scratchpad: "Private harbor details."
            }
          }
        }))
      } as never,
      illustration: {
        loadStreamingIllustrationConfig: vi.fn(async () => null)
      } as unknown as IllustrationGenerationTransactionPort,
      loadTextExecution: vi.fn(async () => ({
        id: claim.providerProfileId,
        name: "Test provider",
        providerRole: "text" as const,
        providerType: "openai_compatible" as const,
        model: "test-model",
        contextWindowTokens: 16_000,
        maxOutputTokens: 2_000,
        temperature: 0,
        requestTimeoutMs: 1_000,
        configuration: {},
        execute: vi.fn(async () => ({
          content: JSON.stringify({
            narration: "The observatory door opens onto a quiet moonlit hall.",
            choices: ["Enter the hall.", "Wait outside.", "Inspect the lock.", "Call for the keeper."],
            custom_action_suggestion: "Study the observatory lens.",
            scratchpad: "The door is now open.",
            tracker_updates: [],
            image_prompt: "A quiet moonlit observatory hall.",
            continuity_summary: "The observatory door is open.",
            canonical_facts: ["The observatory door is open."],
            superseded_facts: [],
            canonical_fact_updates: [{
              content: "The historical keeper has departed the observatory.",
              supersedes_fact_ids: ["22222222-2222-4222-8222-222222222222"]
            }],
            open_threads: ["Learn who opened the observatory."]
          }),
          responseId: "test-response",
          finishReason: "stop",
          outputLimited: false,
          modelInstanceId: "test-instance",
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          reportedCost: null,
          rawMetadata: {}
        }))
      })),
      promptFromSnapshot: vi.fn(() => "Write a concise fictional scene."),
      recordProfileCost: vi.fn(async () => undefined),
      attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;
    const executor = createGenerationExecutor({
      pool: {} as DatabasePool,
      repository,
      collaborators
    });

    await expect(executor.execute({ workerId: "worker-a", leaseSeconds: 30, claim })).resolves.toBe(true);

    expect(repository.commitAcceptedTurn).toHaveBeenCalledOnce();
    const accepted = (repository.commitAcceptedTurn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      chronicleRetrieval?: unknown;
      contextDiagnostics: { retrieval?: unknown; selectedContext?: unknown };
      sentFactIds?: unknown;
    };
    expect(accepted.chronicleRetrieval).toStrictEqual(DEDICATED_CHUNKED_AUDIT);
    expect(accepted.contextDiagnostics.selectedContext).toEqual([
      { id: "authority", revision: expect.any(String) },
      { id: "22222222-2222-4222-8222-222222222222", revision: expect.any(String) }
    ]);
    expect(accepted.sentFactIds).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222"
    ]);
    expect(accepted.sentFactIds).not.toContain("33333333-3333-4333-8333-333333333333");
    const providerRequest = (collaborators.loadTextExecution as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    const provider = await providerRequest;
    expect((provider.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      canonicalBudgeting: true,
      effectiveContextWindowTokens: 8_000
    });
    const input = JSON.parse((provider.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].input);
    expect(input.authoritative_context.currentContinuity.canonicalFacts).toEqual([
      { id: "11111111-1111-4111-8111-111111111111", content: "The keeper is alive." }
    ]);
    expect(input.authoritative_context.chronicle).toEqual([expect.objectContaining({
      id: "22222222-2222-4222-8222-222222222222", kind: "canonical_fact"
    })]);
  });
});
