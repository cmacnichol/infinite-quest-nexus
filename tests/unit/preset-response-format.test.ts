import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { Ajv } from "ajv";
import {
  normalizeNewTextResponsePolicy,
  presetResponseAdmission,
  resolveResponseContractAdmission,
  resolveResponseFormatEligibilityV2
} from "../../packages/application/src/providers/response-format.js";
import {
  getProviderOutputSchemaV2,
  providerOutputSchemaOperationV2Schema,
  stableJsonHash
} from "../../packages/contracts/src/provider-output-schema.js";
import {
  assertPresetResponseContractAuthorityBinding,
  frozenResponseContractsV2SelectionHash,
  readFrozenResponseContractsV2,
  readQueuedResponsePolicyV2
} from "../../packages/contracts/src/generation-response-contract.js";
import { preparedResponseContractV2Schema } from "../../packages/contracts/src/text-response-format.js";
import { getProviderOutputSchema } from "../../packages/story-engine/src/provider-output-schema.js";
import { deriveTextExecutionPlan, textExecutionPlanHash, textExecutionRouteBasisHash } from "../../packages/contracts/src/text-execution-plan.js";

const now = "2026-09-19T12:00:00.000Z";
const digest = "a".repeat(64);
const profileId = "11111111-1111-4111-8111-111111111111";

function independentCanonicalFixture(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(independentCanonicalFixture).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${independentCanonicalFixture(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function independentSchemaHash(value: unknown): string {
  return createHash("sha256").update(independentCanonicalFixture(value), "utf8").digest("hex");
}
function textHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
const profile = {
  identity: { aliases: [], pronouns: "" },
  story: { role: "role", background: "background", personality: "", motivations: "", goals: "", fearsAndConflicts: "", keyRelationships: "", narrativeHooks: "", voiceAndMannerisms: "", otherGuidance: "" },
  appearance: { ancestryOrSpecies: "", apparentAge: "", genderPresentation: "", build: "", skinOrComplexion: "", face: "", eyes: "", hair: "", distinguishingFeatures: [], clothing: "", equipmentAndAccessories: "", otherVisualDetails: "" },
  unclassifiedNotes: ""
};
const stat = { name: "Courage", value: 50, note: "Resolve" };
const trigger = { name: "Lantern", value: "lit", rules: "Changes with the fiction." };
const sourceField = { path: "world.rules", value: "Keep faith.", supportingFactIds: ["fact-1"] };
const validEnvelopeFixtures = {
  story: { narration: "The door opens.", choices: ["Enter", "Wait", "Call", "Leave"], custom_action_suggestion: "Listen", scratchpad: "", tracker_updates: [{ any: { nested: true } }], image_prompt: "", continuity_summary: "", canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: [] },
  choices: { choices: ["Enter", "Wait", "Call", "Leave"], custom_action_suggestion: "Listen" },
  continuity_review: { version: "story-continuity-review-v1", verdict: "pass", findings: [] },
  rpg_assessment: { stat_id: "courage", difficulty_modifier: 0, rationale: "A hard choice.", favorable_outcome: "The guard yields.", setback_outcome: "The guard resists." },
  event_trigger_before: { activated_trigger_ids: [], reasons: {} },
  event_trigger_after: { activated_trigger_ids: ["event-1"], reasons: { "event-1": "The omen appears." } },
  scene_coverage: { covered: true, missing_required_beats: [], contradictions: [] },
  event_coverage: { event_results: [{ event_id: "event-1", covered: true, missing_required_beats: [], contradictions: [] }] },
  world_outline: { title: "World", genre: "Fantasy", tone: "Hopeful", backgroundStory: "History", premise: "Quest", firstAction: "Begin", story_rules: "Respect vows", rpg_statistics: [stat], default_triggers: [trigger], event_triggers: [trigger], character_seeds: [{ id: "hero", name: "Hero", role: "Lead", concept: "A wanderer", narrative_hook: "A promise" }, { id: "guide", name: "Guide", role: "Mentor", concept: "A scholar", narrative_hook: "A map" }, { id: "rival", name: "Rival", role: "Foil", concept: "A knight", narrative_hook: "A debt" }] },
  world_seed_character: { id: "hero", name: "Hero", character_text: "", profile, rpg_statistics: [stat], default_triggers: [trigger] },
  standalone_character: { name: "Hero", profile, rpgStats: [stat], defaultTriggers: [trigger] },
  character_organizer: { candidate: profile, evidence: [{ path: "story.role", source: "legacy", quote: "A scout" }], unassignedText: [], conflicts: [], warnings: [], protocolVersion: "organizer-v1" },
  source_extraction: { facts: [{ category: "character", subject: "Iris", predicate: "role", value: "Scout", provenance: "stated", citations: [{ evidenceId: "evidence:1234567890abcdef12345678" }] }] },
  source_synthesis: { fields: [sourceField], characterFields: [], expansionCandidates: [] },
  source_character: { fields: [], characterFields: [{ selectedCharacterFactId: "fact-1", fields: [sourceField] }], expansionCandidates: [] },
  illustration_prompt_refinement: { image_prompt: "Moonlit market, watercolor." }
} as const;
const malformedEnvelopeFixtures = {
  story: { ...validEnvelopeFixtures.story, choices: ["Enter", "Wait", "Leave"] },
  choices: { ...validEnvelopeFixtures.choices, choices: ["Enter", "Wait", "Leave"] },
  continuity_review: { ...validEnvelopeFixtures.continuity_review, findings: [null] },
  rpg_assessment: { ...validEnvelopeFixtures.rpg_assessment, difficulty_modifier: "hard" },
  event_trigger_before: { ...validEnvelopeFixtures.event_trigger_before, activated_trigger_ids: [3] },
  event_trigger_after: { ...validEnvelopeFixtures.event_trigger_after, reasons: { "event-1": 3 } },
  scene_coverage: { ...validEnvelopeFixtures.scene_coverage, missing_required_beats: [3] },
  event_coverage: { ...validEnvelopeFixtures.event_coverage, event_results: [{ event_id: "event-1" }] },
  world_outline: { ...validEnvelopeFixtures.world_outline, character_seeds: [validEnvelopeFixtures.world_outline.character_seeds[0]] },
  world_seed_character: { ...validEnvelopeFixtures.world_seed_character, profile: { identity: { aliases: [], pronouns: "" } } },
  standalone_character: { ...validEnvelopeFixtures.standalone_character, rpgStats: [{ name: "Courage", value: "50", note: "Resolve" }] },
  character_organizer: { ...validEnvelopeFixtures.character_organizer, evidence: [{ path: "story.role", source: "legacy" }] },
  source_extraction: { ...validEnvelopeFixtures.source_extraction, facts: [{ ...validEnvelopeFixtures.source_extraction.facts[0], citations: [{}] }] },
  source_synthesis: { ...validEnvelopeFixtures.source_synthesis, fields: [{ path: "world.rules", value: "Keep faith." }] },
  source_character: { ...validEnvelopeFixtures.source_character, characterFields: [{}] },
  illustration_prompt_refinement: { image_prompt: 3 }
} as const;

describe("native response-contract admission", () => {
  it.each([
    [null],
    [{ supportedParameters: [], discoveredAt: now }],
    [{ supportedParameters: ["response_format"], discoveredAt: now }]
  ])("trusts a preset schema without model metadata or verification evidence", (advertisement) => {
    const directEligibility = vi.fn(() => {
      throw new Error("preset admission must not call the direct-model capability gate");
    });
    expect(resolveResponseContractAdmission({
      selection: { kind: "openrouter_preset", slug: "nexus-nsfw" },
      advertisement,
      directEligibility
    })).toEqual({ mode: "json_schema", basis: "preset_trusted" });
    expect(presetResponseAdmission({ kind: "openrouter_preset", slug: "nexus-nsfw" }))
      .toEqual({ mode: "json_schema", basis: "preset_trusted" });
    expect(directEligibility).not.toHaveBeenCalled();
  });

  it("defaults new direct-model work to required while preserving explicit compatibility choices", () => {
    expect(normalizeNewTextResponsePolicy({ kind: "model", modelId: "model-a" }, undefined)).toBe("required");
    expect(normalizeNewTextResponsePolicy({ kind: "model", modelId: "model-a" }, "legacy")).toBe("legacy");
    expect(normalizeNewTextResponsePolicy({ kind: "model", modelId: "model-a" }, "auto")).toBe("auto");
    expect(normalizeNewTextResponsePolicy({ kind: "openrouter_preset", slug: "nexus-nsfw" }, "legacy")).toBe("required");
  });

  it("requires exact v2 direct-model advertisement, operation, schema, stream, and unexpired evidence", () => {
    const schema = getProviderOutputSchemaV2("event_coverage");
    const verification = {
      version: 2 as const,
      providerType: "openrouter" as const,
      endpointIdentity: "endpoint-hash",
      model: "openrouter/model",
      routeConfigHash: "route-hash",
      adapterProtocol: "text-schema-adapter-v2" as const,
      operation: "event_coverage" as const,
      schemaHash: schema.schemaHash,
      streaming: false,
      verifiedAt: "2026-09-18T12:00:00.000Z",
      expiresAt: "2026-09-20T12:00:00.000Z",
      providerRoutingSlugs: [],
      nativeOpenTrackerObjects: false
    };
    const input = {
      advertisement: { supportedParameters: ["response_format", "structured_outputs"], discoveredAt: now },
      providerType: "openrouter" as const,
      endpointIdentity: "endpoint-hash",
      model: "openrouter/model",
      routeConfigHash: "route-hash",
      adapterProtocol: "text-schema-adapter-v2" as const,
      operation: "event_coverage" as const,
      schemaHash: schema.schemaHash,
      streaming: false,
      now,
      verifications: [verification]
    };
    expect(resolveResponseFormatEligibilityV2(input)).toMatchObject({ status: "verified", verification });
    expect(resolveResponseFormatEligibilityV2({ ...input, operation: "scene_coverage" })).toMatchObject({ status: "advertised", reason: "missing_verification" });
    expect(resolveResponseFormatEligibilityV2({ ...input, schemaHash: digest })).toMatchObject({ status: "advertised", reason: "missing_verification" });
    expect(resolveResponseFormatEligibilityV2({ ...input, streaming: true })).toMatchObject({ status: "advertised", reason: "missing_verification" });
    expect(() => resolveResponseContractAdmission({
      selection: { kind: "model", modelId: "model-b" },
      directEligibility: () => ({ status: "verified", reason: "verified", verification })
    })).toThrow(/does not match the selected model/i);
  });

  it("publishes an immutable strict schema for every active response operation", () => {
    expect(providerOutputSchemaOperationV2Schema.options).toEqual([
      "story", "choices", "continuity_review", "rpg_assessment", "event_trigger_before", "event_trigger_after",
      "scene_coverage", "event_coverage", "world_outline", "world_seed_character", "standalone_character",
      "character_organizer", "source_extraction", "source_synthesis", "source_character", "illustration_prompt_refinement"
    ]);
    for (const operation of providerOutputSchemaOperationV2Schema.options) {
      const schema = getProviderOutputSchemaV2(operation);
      expect(schema.schema.additionalProperties).toBe(false);
      expect(schema.schemaHash).toBe(independentSchemaHash(schema.schema));
      expect(Object.isFrozen(schema.schema)).toBe(true);
    }
    expect(getProviderOutputSchemaV2("event_coverage").schema).not.toEqual(getProviderOutputSchemaV2("scene_coverage").schema);
    for (const operation of ["story", "choices", "continuity_review"] as const) {
      expect(getProviderOutputSchemaV2(operation).schema).toEqual(getProviderOutputSchema(operation).schema);
    }
  });

  it("accepts each documented wire envelope and rejects operation-specific nested malformed envelopes before local semantic parsing", () => {
    const ajv = new Ajv({ strict: false });
    for (const operation of providerOutputSchemaOperationV2Schema.options) {
      const validate = ajv.compile(getProviderOutputSchemaV2(operation).schema);
      expect(validate(validEnvelopeFixtures[operation])).toBe(true);
      expect(validate({})).toBe(false);
      expect(validate(malformedEnvelopeFixtures[operation])).toBe(false);
    }
  });

  it("rejects tampered v2 schema, duplicate operation keys, and mismatched preset authority", () => {
    const schema = getProviderOutputSchemaV2("story");
    const selected = {
      version: 2 as const,
      queuedPolicy: {
        version: 2 as const,
        policy: "required" as const,
        providerProfileId: profileId,
        admission: { mode: "json_schema" as const, basis: "preset_trusted" as const },
        authority: {
          kind: "preset_trusted" as const,
          routeBasisHash: digest,
          selection: { kind: "openrouter_preset" as const, slug: "nexus-nsfw" },
          endpointReference: "endpoint",
          credentialReference: "credential",
          authorityRevision: "authority-v1",
          profileRevision: "profile-v1"
        },
        operationClosureVersion: 2 as const,
        invocationKeys: ["story:nonstream"]
      },
      selectedAt: now,
      capabilityEvidenceHash: digest,
      contracts: {
        "story:nonstream": {
          version: 2 as const,
          mode: "json_schema" as const,
          admission: { mode: "json_schema" as const, basis: "preset_trusted" as const },
          operation: "story" as const,
          streaming: false,
          forbidFormatFallback: true as const,
          schemaVersion: schema.version,
          schemaHash: schema.schemaHash,
          schemaName: schema.name,
          schema: schema.schema,
          authority: { kind: "preset_trusted" as const, routeBasisHash: digest, planHash: digest }
        }
      }
    };
    const frozen = { ...selected, selectionHash: frozenResponseContractsV2SelectionHash(selected) };
    expect(readFrozenResponseContractsV2(frozen)).toMatchObject({ version: 2, selectionHash: frozen.selectionHash });
    const rehash = <T extends Record<string, unknown>>(value: T) => ({ ...value, selectionHash: frozenResponseContractsV2SelectionHash(value) });
    const alteredSchema = { ...schema.schema, x_tampered: true };
    expect(() => readFrozenResponseContractsV2(rehash({ ...frozen, contracts: { ...frozen.contracts, "story:nonstream": { ...frozen.contracts["story:nonstream"], schema: alteredSchema, schemaHash: independentSchemaHash(alteredSchema) } } }))).toThrow(/invalid or incompatible/i);
    expect(() => readFrozenResponseContractsV2(rehash({ ...frozen, contracts: { ...frozen.contracts, "story:nonstream": { ...frozen.contracts["story:nonstream"], schemaVersion: "wrong-version" } } }))).toThrow(/invalid or incompatible/i);
    expect(() => readFrozenResponseContractsV2(rehash({ ...frozen, queuedPolicy: { ...frozen.queuedPolicy, invocationKeys: ["story:nonstream", "story:nonstream"] } }))).toThrow(/invalid or incompatible/i);
  });

  it("binds preset contracts to validated route-basis and prompt-plan identities", () => {
    const routeBasisDraft = {
      version: 2 as const, selection: { kind: "openrouter_preset" as const, slug: "nexus-nsfw" },
      preset: { slug: "nexus-nsfw", versionId: "preset-v1", configHash: digest }, candidates: [{ modelId: "provider/model", providerPolicy: {}, contextWindowTokens: 16_384, maxOutputTokens: 1_024 }],
      presetSystemPrompt: "Preset instruction.", parameters: {}, endpointReference: "endpoint", credentialReference: "credential", profileRevision: "profile-v1", authorityRevision: "authority-v1", requestTimeoutMs: 30_000, protocolVersion: "plan-v2", routeBasisHash: digest
    };
    const routeBasis = { ...routeBasisDraft, routeBasisHash: textExecutionRouteBasisHash(routeBasisDraft) };
    const planDraft = {
      ...routeBasis, prompt: "Preset instruction.\n\nOperation instruction.", promptHash: textHash("Preset instruction.\n\nOperation instruction."), planHash: digest
    };
    const plan = { ...planDraft, planHash: textExecutionPlanHash(planDraft) };
    const policy = {
      version: 2 as const, policy: "required" as const, providerProfileId: profileId, admission: { mode: "json_schema" as const, basis: "preset_trusted" as const },
      authority: { kind: "preset_trusted" as const, routeBasisHash: routeBasis.routeBasisHash, selection: routeBasis.selection, endpointReference: "endpoint", credentialReference: "credential", authorityRevision: "authority-v1", profileRevision: "profile-v1" },
      operationClosureVersion: 2 as const, invocationKeys: ["story:nonstream" as const]
    };
    const story = getProviderOutputSchemaV2("story");
    const contract = {
      version: 2 as const, mode: "json_schema" as const, admission: policy.admission, operation: "story" as const, streaming: false, forbidFormatFallback: true as const,
      schemaVersion: story.version, schemaHash: story.schemaHash, schemaName: story.name, schema: story.schema,
      authority: { kind: "preset_trusted" as const, routeBasisHash: routeBasis.routeBasisHash, planHash: plan.planHash }
    };
    expect(plan).toEqual(deriveTextExecutionPlan(routeBasis, "Operation instruction."));
    expect(assertPresetResponseContractAuthorityBinding(policy, contract, routeBasis, plan, "Operation instruction.")).toMatchObject({ plan: { planHash: plan.planHash } });
    const rewrittenPlanDraft = { ...plan, prompt: "Changed prompt", promptHash: textHash("Changed prompt") };
    const rewrittenPlan = { ...rewrittenPlanDraft, planHash: textExecutionPlanHash(rewrittenPlanDraft) };
    expect(() => assertPresetResponseContractAuthorityBinding(policy, contract, routeBasis, rewrittenPlan, "Operation instruction.")).toThrow(/basis or plan identity changed/i);
    const changedAuthorityDraft = { ...routeBasis, authorityRevision: "authority-v2" };
    const changedAuthority = { ...changedAuthorityDraft, routeBasisHash: textExecutionRouteBasisHash(changedAuthorityDraft) };
    expect(() => assertPresetResponseContractAuthorityBinding(policy, contract, changedAuthority, plan, "Operation instruction.")).toThrow(/basis or plan identity changed/i);
    const changedRoutePlanDraft = { ...plan, candidates: [{ ...plan.candidates[0], modelId: "other/model" }], endpointReference: "other-endpoint" };
    const changedRoutePlan = { ...changedRoutePlanDraft, planHash: textExecutionPlanHash(changedRoutePlanDraft) };
    const changedRouteContract = { ...contract, authority: { ...contract.authority, planHash: changedRoutePlan.planHash } };
    expect(() => assertPresetResponseContractAuthorityBinding(policy, changedRouteContract, routeBasis, changedRoutePlan, "Operation instruction.")).toThrow(/basis or plan identity changed/i);
  });

  it("rejects a direct v2 policy when its queued profile differs from its verified authority", () => {
    const schema = getProviderOutputSchemaV2("event_coverage");
    expect(() => readQueuedResponsePolicyV2({
      version: 2, policy: "required", providerProfileId: profileId,
      admission: { mode: "json_schema", basis: "model_verified", verification: {
        version: 2, providerType: "openrouter", endpointIdentity: "endpoint", model: "model-a", routeConfigHash: digest,
        adapterProtocol: "text-schema-adapter-v2", operation: "event_coverage", schemaHash: schema.schemaHash, streaming: false,
        verifiedAt: "2026-09-18T00:00:00.000Z", expiresAt: "2026-09-20T00:00:00.000Z", providerRoutingSlugs: [], nativeOpenTrackerObjects: false
      } },
      authority: { kind: "model_verified", providerProfileId: "22222222-2222-4222-8222-222222222222", providerType: "openrouter", endpointIdentity: "endpoint", model: "model-a", providerConfigurationHash: digest, routeConfigHash: digest, verificationRegistryHash: digest },
      operationClosureVersion: 2, invocationKeys: ["event_coverage:nonstream"]
    })).toThrow(/invalid or incompatible/i);
  });

  it("rejects contradictory direct verification evidence and a Story contract without native tracker support", () => {
    const eventSchema = getProviderOutputSchemaV2("event_coverage");
    const directPolicy = {
      version: 2, policy: "required", providerProfileId: profileId,
      admission: { mode: "json_schema", basis: "model_verified", verification: {
        version: 2, providerType: "openrouter", endpointIdentity: "verified-endpoint", model: "verified-model", routeConfigHash: "b".repeat(64),
        adapterProtocol: "text-schema-adapter-v2", operation: "event_coverage", schemaHash: eventSchema.schemaHash, streaming: false,
        verifiedAt: "2026-09-18T00:00:00.000Z", expiresAt: "2026-09-20T00:00:00.000Z", providerRoutingSlugs: [], nativeOpenTrackerObjects: false
      } },
      authority: { kind: "model_verified", providerProfileId: profileId, providerType: "openrouter", endpointIdentity: "authority-endpoint", model: "authority-model", providerConfigurationHash: digest, routeConfigHash: digest, verificationRegistryHash: digest },
      operationClosureVersion: 2, invocationKeys: ["event_coverage:nonstream"]
    };
    expect(() => readQueuedResponsePolicyV2(directPolicy)).toThrow(/invalid or incompatible/i);

    const story = getProviderOutputSchemaV2("story");
    expect(() => preparedResponseContractV2Schema.parse({
      version: 2, mode: "json_schema", operation: "story", streaming: false, forbidFormatFallback: true,
      admission: { mode: "json_schema", basis: "model_verified", verification: {
        version: 2, providerType: "openrouter", endpointIdentity: "endpoint", model: "model-a", routeConfigHash: digest,
        adapterProtocol: "text-schema-adapter-v2", operation: "story", schemaHash: story.schemaHash, streaming: false,
        verifiedAt: "2026-09-18T00:00:00.000Z", expiresAt: "2026-09-20T00:00:00.000Z", providerRoutingSlugs: [], nativeOpenTrackerObjects: false
      } },
      schemaVersion: story.version, schemaHash: story.schemaHash, schemaName: story.name, schema: story.schema,
      authority: { kind: "model_verified", providerProfileId: profileId, providerType: "openrouter", endpointIdentity: "endpoint", model: "model-a", providerConfigurationHash: digest, routeConfigHash: digest, verificationRegistryHash: digest }
    })).toThrow();
  });

  it("rejects a rehashed frozen direct closure when queued verification evidence changes", () => {
    const schema = getProviderOutputSchemaV2("event_coverage");
    const verification = {
      version: 2 as const, providerType: "openrouter" as const, endpointIdentity: "endpoint", model: "model-a", routeConfigHash: digest,
      adapterProtocol: "text-schema-adapter-v2" as const, operation: "event_coverage" as const, schemaHash: schema.schemaHash, streaming: false,
      verifiedAt: "2026-09-18T00:00:00.000Z", expiresAt: "2026-09-20T00:00:00.000Z", providerRoutingSlugs: [], nativeOpenTrackerObjects: false
    };
    const authority = { kind: "model_verified" as const, providerProfileId: profileId, providerType: "openrouter" as const, endpointIdentity: "endpoint", model: "model-a", providerConfigurationHash: digest, routeConfigHash: digest, verificationRegistryHash: digest };
    const queuedPolicy = {
      version: 2 as const, policy: "required" as const, providerProfileId: profileId,
      admission: { mode: "json_schema" as const, basis: "model_verified" as const, verification }, authority,
      operationClosureVersion: 2 as const, invocationKeys: ["event_coverage:nonstream" as const]
    };
    const contract = {
      version: 2 as const, mode: "json_schema" as const, admission: queuedPolicy.admission, operation: "event_coverage" as const, streaming: false, forbidFormatFallback: true as const,
      schemaVersion: schema.version, schemaHash: schema.schemaHash, schemaName: schema.name, schema: schema.schema, authority
    };
    const selected = { version: 2 as const, queuedPolicy, selectedAt: now, capabilityEvidenceHash: digest, contracts: { "event_coverage:nonstream": contract } };
    const frozen = { ...selected, selectionHash: frozenResponseContractsV2SelectionHash(selected) };
    expect(readFrozenResponseContractsV2(frozen)).toMatchObject({ version: 2 });
    const altered = { ...frozen, queuedPolicy: { ...queuedPolicy, admission: { ...queuedPolicy.admission, verification: { ...verification, endpointIdentity: "other-endpoint" } } } };
    expect(() => readFrozenResponseContractsV2({ ...altered, selectionHash: frozenResponseContractsV2SelectionHash(altered) })).toThrow(/invalid or incompatible/i);
  });
});
