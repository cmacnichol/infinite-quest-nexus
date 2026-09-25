import { Ajv } from "ajv";
import {
  getProviderOutputSchemaV2,
  providerOutputSchemaOperationV2Schema,
  type ProviderOutputSchemaOperationV2
} from "../../packages/contracts/src/provider-output-schema.js";
import type { SchemaVerificationV2 } from "../../packages/contracts/src/text-response-format.js";
import { authoringStageOutputSchema, authoringWorldOutlineSchema } from "../../packages/contracts/src/authoring.js";
import { characterProfileOrganizationResultSchema, playableCharacterSchema } from "../../packages/contracts/src/world-library.js";
import { sourceFactSchema } from "../../packages/contracts/src/source-authoring.js";
import { castDiscoveryOutputSchema } from "../../packages/contracts/src/campaign-cast-discovery.js";
import { stableStringify } from "../../packages/domain/src/text.js";
import { buildContinuityReviewInput, validateContinuityReview } from "../../packages/story-engine/src/continuity-review.js";
import { activatedEventsFromResponse, parseRpgAssessment } from "../../packages/story-engine/src/mechanics.js";
import { parseStoryOutput } from "../../packages/story-engine/src/output.js";
import { serializeProviderRequest } from "../../packages/story-engine/src/provider-request.js";
import { parseEventCoverageOutput, parseSceneCoverageOutput } from "../../packages/story-engine/src/scene-coverage.js";
import { parseChoiceRepair } from "../../packages/story-engine/src/story-only-output.js";
import { parseRefinedPrompt } from "../../services/runtime/src/illustration-segment-job-adapter.js";
import { estimateStoryTokens } from "../../packages/story-engine/src/token-estimate.js";
import { capabilityRouteConfigHash, providerEndpointIdentity } from "../../services/runtime/src/provider-capability-cache.js";

export type ProbeInput = Readonly<{
  model: string; route: string; inputUsdPerToken: number; outputUsdPerToken: number; contextTokens: number;
  maxCalls: number; maxOutputTokens: number; temperature: number; priceObservedAt: string; profileId?: string | null;
}>;

export const DEFAULT_STRUCTURED_OUTPUT_PROBE: Readonly<Omit<ProbeInput, "profileId">> = Object.freeze({
  model: "deepseek/deepseek-v3.2-exp",
  route: "",
  inputUsdPerToken: 0.00000027,
  outputUsdPerToken: 0.00000041,
  contextTokens: 163_840,
  maxCalls: 18,
  maxOutputTokens: 2_048,
  temperature: 0,
  priceObservedAt: ""
});

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const CANONICAL_MODEL = DEFAULT_STRUCTURED_OUTPUT_PROBE.model;
const TARGET_PRESET = "@preset/nexus-nsfw";
const REQUIRED_CONTEXT_TOKENS = DEFAULT_STRUCTURED_OUTPUT_PROBE.contextTokens;
const REQUIRED_MAX_CALLS = DEFAULT_STRUCTURED_OUTPUT_PROBE.maxCalls;
const REQUIRED_MAX_OUTPUT_TOKENS = DEFAULT_STRUCTURED_OUTPUT_PROBE.maxOutputTokens;
const NONSTREAM_OPERATIONS = providerOutputSchemaOperationV2Schema.options;
const CURRENT_WORKER_TUPLES = Object.freeze(["story:stream", ...NONSTREAM_OPERATIONS.map((operation) => `${operation}:nonstream`)]);
type ProbeOperation = ProviderOutputSchemaOperationV2;

export type PreparedProbeRequest = Readonly<{
  scenario: "A"; operation: ProbeOperation; streaming: boolean; model: string; route: string;
  body: string; payloadHash: string; bodyByteCount: number; schemaHash: string; syntheticResponse: unknown;
  validate(value: unknown): { ok: true } | { ok: false; reason: string };
}>;
export type StructuredOutputProbePlan = Readonly<{
  profileId: string | null; endpointIdentity: string; routeConfigHash: string; requests: readonly PreparedProbeRequest[];
  safePlan: Readonly<Record<string, unknown>>;
}>;
export type ProbeExecutor = (request: PreparedProbeRequest) => Promise<Readonly<{
  content: string; finishReason: string; returnedModel: string | null | undefined; returnedProviderRoute: string | null | undefined;
  preparedRequest?: Readonly<{ body: string; payloadHash: string }>;
}>>;
export type ProbeRunResult = Readonly<{
  proposedRecords: readonly SchemaVerificationV2[]; failure: Readonly<{ call: number; reason: string }> | null;
  observations: readonly Readonly<{ call: number; operation: ProbeOperation; streaming: boolean; status: "qualified" | "failed"; returnedModel: string | null; returnedProviderRoute: string | null; }>[];
  currentWorkerInvocationCoverage: readonly string[];
}>;

export function validateExecutionPriceObservation(observedAt: string, now: string, maxAgeMs = 86_400_000): void {
  const observed = Date.parse(observedAt); const current = Date.parse(now);
  if (!Number.isFinite(observed) || !Number.isFinite(current) || observed > current || current - observed > maxAgeMs) throw new Error("Execution requires current timestamped price and context evidence.");
}

function requireExact(input: ProbeInput) {
  if (input.model !== CANONICAL_MODEL) throw new Error("--model must be the canonical deepseek/deepseek-v3.2-exp target.");
  if (!/^[a-z0-9][a-z0-9._/-]*$/i.test(input.route) || !input.route.includes("/")) throw new Error("--route must be a full configured provider routing slug.");
  if (input.contextTokens !== REQUIRED_CONTEXT_TOKENS) throw new Error("--context-tokens must be 163840 for this prepared target.");
  if (input.maxCalls !== REQUIRED_MAX_CALLS) throw new Error(`--max-calls must be exactly ${REQUIRED_MAX_CALLS}.`);
  if (input.maxOutputTokens !== REQUIRED_MAX_OUTPUT_TOKENS) throw new Error("--max-output-tokens must be exactly 2048.");
  if (![input.inputUsdPerToken, input.outputUsdPerToken].every((value) => Number.isFinite(value) && value > 0)) throw new Error("Per-token prices must be positive finite values.");
  if (!Number.isFinite(Date.parse(input.priceObservedAt)) || new Date(input.priceObservedAt).toISOString() !== input.priceObservedAt) throw new Error("--price-observed-at must be a canonical ISO timestamp.");
}

function characterProfile() {
  return {
    identity: { aliases: [], pronouns: "" },
    story: { role: "", background: "", personality: "", motivations: "", goals: "", fearsAndConflicts: "", keyRelationships: "", narrativeHooks: "", voiceAndMannerisms: "", otherGuidance: "" },
    appearance: { ancestryOrSpecies: "", apparentAge: "", genderPresentation: "", build: "", skinOrComplexion: "", face: "", eyes: "", hair: "", distinguishingFeatures: [], clothing: "", equipmentAndAccessories: "", otherVisualDetails: "" },
    unclassifiedNotes: ""
  };
}

const SYNTHETIC_STORY_NARRATION = "A synthetic traveler studies a quiet marker.";

function story() {
  const tracker_updates = [{ name: "Synthetic trust", value: "watchful", metadata: { history: [null, true, 2, { note: "nested" }], active: false, empty: {} } }];
  return {
    narration: SYNTHETIC_STORY_NARRATION,
    choices: ["Inspect the marker.", "Wait nearby.", "Follow the trail.", "Return to camp."],
    custom_action_suggestion: "Describe a careful next step.", scratchpad: "", tracker_updates,
    image_prompt: "", continuity_summary: "A synthetic scene remains unresolved.",
    canonical_facts: ["A synthetic marker is present."], superseded_facts: [],
    canonical_fact_updates: [], open_threads: ["Learn the marker's purpose."]
  };
}

/** Wire-shaped synthetic story response for whichever schema version is being probed. */
function storyWireResponse(schemaVersion: string = getProviderOutputSchemaV2("story").version): unknown {
  const { narration, ...rest } = story();
  return schemaVersion === "story-native-v3" ? { narration_paragraphs: [narration], ...rest } : { narration, ...rest };
}

function responseFor(operation: ProbeOperation): unknown {
  switch (operation) {
    case "cast_discovery": return { version: 1, characters: [{ localKey: "synthetic", name: "Synthetic traveler", aliases: [], existingCharacterId: null,
      identityEvidence: [{ paragraphId: "p1", quote: "Synthetic traveler waits." }], observations: [] }] };
    case "story": return storyWireResponse();
    case "choices": return { choices: story().choices, custom_action_suggestion: story().custom_action_suggestion };
    case "continuity_review": return { version: "story-continuity-review-v1", verdict: "pass", findings: [] };
    case "rpg_assessment": return { stat_id: "synthetic-stat", difficulty_modifier: 0, rationale: "Synthetic rationale.", favorable_outcome: "A synthetic success.", setback_outcome: "A synthetic setback." };
    case "event_trigger_before":
    case "event_trigger_after": return { activated_trigger_ids: [], reasons: {} };
    case "scene_coverage": return { covered: true, missing_required_beats: [], contradictions: [] };
    case "event_coverage": return { event_results: [] };
    case "world_outline": return { title: "Synthetic world", genre: "Fantasy", tone: "Measured", backgroundStory: "Synthetic background.", premise: "Synthetic premise.", firstAction: "Begin carefully.", story_rules: "Preserve the fixture.", rpg_statistics: [], default_triggers: [], event_triggers: [], character_seeds: [1, 2, 3].map((id) => ({ id: `seed-${id}`, name: `Seed ${id}`, role: "Traveler", concept: "Synthetic concept.", narrative_hook: "Synthetic hook." })) };
    case "world_seed_character": return { id: "seed-1", name: "Seed 1", character_text: "", profile: characterProfile(), rpg_statistics: [], default_triggers: [] };
    case "standalone_character": return { name: "Synthetic character", profile: characterProfile(), rpgStats: [], defaultTriggers: [] };
    case "character_organizer": return { candidate: characterProfile(), evidence: [], unassignedText: [], conflicts: [], warnings: [], protocolVersion: "character-profile-organization-v1" };
    case "source_extraction": return { facts: [{ category: "rule", subject: "Synthetic world", predicate: "requires", value: "evidence", provenance: "stated", citations: [{ evidenceId: "evidence:aaaaaaaaaaaaaaaaaaaaaaaa" }] }] };
    case "source_synthesis":
    case "source_character": return { fields: [{ path: "/title", value: "Synthetic value", supportingFactIds: ["fact-1"] }], characterFields: [], expansionCandidates: [] };
    case "illustration_prompt_refinement": return { image_prompt: "A synthetic marker under neutral light." };
  }
}
function syntheticRequestInput(operation: ProbeOperation) { return `Synthetic compatibility case. Produce this complete JSON shape for ${operation}: ${JSON.stringify(responseFor(operation))}`; }

function validateResponse(operation: ProbeOperation, value: unknown): { ok: true } | { ok: false; reason: string } {
  const wire = new Ajv({ strict: false, allErrors: true }).compile(getProviderOutputSchemaV2(operation).schema);
  if (!wire(value)) return { ok: false, reason: "wire_schema" };
  try {
    if (operation === "story") {
      const parsed = parseStoryOutput(JSON.stringify(value));
      if (!parsed.ok || stableStringify(parsed.story.tracker_updates) !== stableStringify(story().tracker_updates)) return { ok: false, reason: "story_parser" };
    } else if (operation === "choices") parseChoiceRepair(JSON.stringify(value));
    else if (operation === "continuity_review") {
      const draft = story();
      const input = buildContinuityReviewInput({ evidence: [{ id: "a".repeat(64), content: "Synthetic source marker.", required: true, role: "source" }], requiredEvidenceIds: ["a".repeat(64)], direction: "Continue the synthetic scene.", draft });
      if (validateContinuityReview(input, value).verdict !== "pass") return { ok: false, reason: "review_parser" };
    } else if (operation === "rpg_assessment") parseRpgAssessment(JSON.stringify(value));
    else if (operation === "event_trigger_before" || operation === "event_trigger_after") activatedEventsFromResponse(JSON.stringify(value), [], 1);
    else if (operation === "scene_coverage") parseSceneCoverageOutput(JSON.stringify(value));
    else if (operation === "event_coverage") parseEventCoverageOutput(JSON.stringify(value), []);
    else if (operation === "world_outline") {
      const outline = value as ReturnType<typeof responseFor> & Record<string, any>;
      authoringWorldOutlineSchema.parse({ title: outline.title, genre: outline.genre, tone: outline.tone,
        backgroundStory: outline.backgroundStory, premise: outline.premise, firstAction: outline.firstAction,
        rules: outline.story_rules, seeds: outline.character_seeds.map((seed: Record<string, unknown>) => ({
          id: seed.id, name: seed.name, role: seed.role, concept: seed.concept, narrativeHook: seed.narrative_hook
        })),
        rpgStats: outline.rpg_statistics, defaultTriggers: outline.default_triggers, eventTriggers: outline.event_triggers });
    } else if (operation === "world_seed_character" || operation === "standalone_character") {
      const character = value as Record<string, any>;
      playableCharacterSchema.parse({ id: character.id ?? "synthetic-character", name: character.name,
        characterText: character.character_text ?? "", profile: character.profile,
        rpgStats: character.rpg_statistics ?? character.rpgStats, defaultTriggers: character.default_triggers ?? character.defaultTriggers, source: {} });
    } else if (operation === "character_organizer") characterProfileOrganizationResultSchema.parse(value);
    else if (operation === "source_extraction") {
      const facts = (value as Record<string, any>).facts as Array<Record<string, any>>;
      facts.forEach((fact, index) => sourceFactSchema.parse({ id: `synthetic-fact-${index}`, kind: fact.category,
        subject: fact.subject, predicate: fact.predicate, value: fact.value, provenance: fact.provenance,
        citations: fact.citations.map(() => ({ sourceId: "synthetic-source", paragraphId: "synthetic-paragraph", start: 0, end: 1, quote: "x" })) }));
    } else if (operation === "source_synthesis" || operation === "source_character") {
      const result = value as Record<string, any>;
      authoringStageOutputSchema.parse({ kind: "source_world", proposal: { world: { title: "Synthetic", genre: "Fantasy", tone: "Measured", premise: "Synthetic", backgroundStory: "Synthetic", firstAction: "Begin", rules: "" } },
        mappings: result.fields.map((field: Record<string, unknown>) => ({ target: "world", path: field.path, value: field.value, supportingFactIds: field.supportingFactIds })), expansionCandidates: [] });
    } else if (operation === "illustration_prompt_refinement") parseRefinedPrompt(JSON.stringify(value));
    else if (operation === "cast_discovery") castDiscoveryOutputSchema.parse(value);
    return { ok: true };
  } catch { return { ok: false, reason: "application_parser" }; }
}

function verification(operation: ProbeOperation, streaming: boolean, input: ProbeInput, endpointIdentity: string, routeConfigHash: string, verifiedAt: string): SchemaVerificationV2 {
  const schema = getProviderOutputSchemaV2(operation);
  return Object.freeze({ version: 2, providerType: "openrouter", endpointIdentity, model: input.model, routeConfigHash,
    adapterProtocol: "text-schema-adapter-v2", operation, schemaHash: schema.schemaHash, streaming, verifiedAt,
    expiresAt: new Date(Date.parse(verifiedAt) + 30 * 86_400_000).toISOString(), providerRoutingSlugs: [input.route],
    nativeOpenTrackerObjects: schema.requiresOpenTrackerObjects });
}

function contract(operation: ProbeOperation, streaming: boolean, input: ProbeInput, endpointIdentity: string, routeConfigHash: string) {
  const schema = getProviderOutputSchemaV2(operation);
  const evidence = verification(operation, streaming, input, endpointIdentity, routeConfigHash, input.priceObservedAt);
  return {
    version: 2 as const, mode: "json_schema" as const,
    admission: { mode: "json_schema" as const, basis: "model_verified" as const,
      verification: { ...evidence, providerRoutingSlugs: [...evidence.providerRoutingSlugs] } },
    operation, streaming, forbidFormatFallback: true as const, schemaVersion: schema.version, schemaHash: schema.schemaHash,
    schemaName: schema.name, schema: schema.schema,
    authority: { kind: "model_verified" as const, providerProfileId: "00000000-0000-4000-8000-000000000001",
      providerType: "openrouter" as const, endpointIdentity, model: input.model, providerConfigurationHash: routeConfigHash,
      routeConfigHash, verificationRegistryHash: "0".repeat(64) }
  };
}

/** Recreates the exact synthetic request whose body was measured during preparation. */
export function providerRequestForPreparedProbe(request: PreparedProbeRequest, routeConfigHash: string) {
  const input = { ...DEFAULT_STRUCTURED_OUTPUT_PROBE, model: request.model, route: request.route, priceObservedAt: "2026-09-20T00:00:00.000Z" };
  return {
    systemPrompt: "Return only the requested synthetic JSON. Preserve every nested tracker value exactly when present.", input: syntheticRequestInput(request.operation),
    ...(request.streaming ? { onChunk: () => undefined } : {}),
    responseContract: contract(request.operation, request.streaming, input, providerEndpointIdentity(OPENROUTER_BASE_URL), routeConfigHash)
  };
}

/** Pure offline preparation. The provider route is explicit input, never inferred from public endpoint ordering. */
export function prepareStructuredOutputProbe(input: ProbeInput): StructuredOutputProbePlan {
  requireExact(input);
  const endpointIdentity = providerEndpointIdentity(OPENROUTER_BASE_URL);
  const configuration = { streaming: true, streamingSupport: true, textResponseFormatPolicy: "required" as const, explicitProviderRoute: input.route };
  const routeConfigHash = capabilityRouteConfigHash(configuration);
  const profile = { providerType: "openrouter" as const, baseUrl: "", model: input.model, contextWindowTokens: input.contextTokens, maxOutputTokens: input.maxOutputTokens, temperature: input.temperature, configuration };
  const tuples = [{ operation: "story" as const, streaming: true }, ...NONSTREAM_OPERATIONS.map((operation) => ({ operation, streaming: false }))];
  const requests = tuples.map(({ operation, streaming }): PreparedProbeRequest => {
    const prepared = serializeProviderRequest(profile, { systemPrompt: "Return only the requested synthetic JSON. Preserve every nested tracker value exactly when present.", input: syntheticRequestInput(operation), ...(streaming ? { onChunk: () => undefined } : {}), responseContract: contract(operation, streaming, input, endpointIdentity, routeConfigHash) });
    return Object.freeze({ scenario: "A", operation, streaming, model: input.model, route: input.route, body: prepared.body,
      payloadHash: prepared.payloadHash, bodyByteCount: Buffer.byteLength(prepared.body, "utf8"),
      schemaHash: getProviderOutputSchemaV2(operation).schemaHash, syntheticResponse: responseFor(operation),
      validate: (value: unknown) => validateResponse(operation, value) });
  });
  const largestBodyByteCount = Math.max(...requests.map((request) => request.bodyByteCount));
  const preparedInputTokenEstimate = Math.max(...requests.map((request) => estimateStoryTokens(request.body)));
  if (preparedInputTokenEstimate + input.maxOutputTokens > input.contextTokens) throw new Error("Prepared request estimate exceeds the advertised context constraint.");
  const conservativePerCallUsd = input.contextTokens * input.inputUsdPerToken + input.maxOutputTokens * input.outputUsdPerToken;
  const exactCeiling = conservativePerCallUsd * input.maxCalls;
  const maxInferenceCostUsd = Math.ceil((exactCeiling + Number.EPSILON) * 1_000_000) / 1_000_000;
  return Object.freeze({ profileId: input.profileId ?? null, endpointIdentity, routeConfigHash, requests: Object.freeze(requests), safePlan: Object.freeze({
    targetPreset: TARGET_PRESET, presetRoutingStatus: "requires_private_configured_candidate_order", model: input.model,
    route: input.route, routeSource: "explicit_configured_candidate_input",
    configuredCandidateOrder: [input.route], pricingScope: "hypothetical_explicit_candidate_set", requestCount: requests.length,
    endpointIdentity, routeConfigHash, largestBodyByteCount, preparedInputTokenEstimate,
    preparedInputTokenEstimateKind: "application_estimate_not_billing_bound", conservativeInputTokenCeiling: input.contextTokens,
    outputTokenCeiling: input.maxOutputTokens, maxInferenceCostUsd, priceObservedAt: input.priceObservedAt,
    schemas: requests.map((request) => { const schema = getProviderOutputSchemaV2(request.operation); return { operation: request.operation,
      streaming: request.streaming, schemaName: schema.name, schemaVersion: schema.version, schemaHash: request.schemaHash,
      payloadHash: request.payloadHash, bodyByteCount: request.bodyByteCount }; })
  }) });
}

export async function runStructuredOutputProbe(plan: StructuredOutputProbePlan, execute: ProbeExecutor, options: Readonly<{ now?: string }> = {}): Promise<ProbeRunResult> {
  const records: SchemaVerificationV2[] = [];
  const observations: Array<{ call: number; operation: ProbeOperation; streaming: boolean; status: "qualified" | "failed"; returnedModel: string | null; returnedProviderRoute: string | null; }> = [];
  for (let index = 0; index < plan.requests.length; index += 1) {
    const request = plan.requests[index]!;
    let returnedModel: string | null = null; let returnedProviderRoute: string | null = null;
    try {
      const result = await execute(request);
      returnedModel = printableIdentity(result.returnedModel); returnedProviderRoute = printableIdentity(result.returnedProviderRoute);
      if (result.finishReason !== "stop" || returnedModel !== request.model || returnedProviderRoute !== request.route) throw new Error("response_identity_or_completion");
      if (!result.preparedRequest || result.preparedRequest.body !== request.body || result.preparedRequest.payloadHash !== request.payloadHash) throw new Error("prepared_wire_mismatch");
      let content: unknown; try { content = JSON.parse(result.content); } catch { throw new Error("invalid_json"); }
      const validated = request.validate(content); if (!validated.ok) throw new Error(validated.reason);
      const verifiedAt = options.now ?? new Date().toISOString();
      records.push(verification(request.operation, request.streaming, { ...DEFAULT_STRUCTURED_OUTPUT_PROBE,
        model: request.model, route: request.route, priceObservedAt: verifiedAt }, plan.endpointIdentity, plan.routeConfigHash, verifiedAt));
      observations.push({ call: index + 1, operation: request.operation, streaming: request.streaming, status: "qualified", returnedModel, returnedProviderRoute });
    } catch (error) { observations.push({ call: index + 1, operation: request.operation, streaming: request.streaming, status: "failed", returnedModel, returnedProviderRoute }); return { proposedRecords: [], failure: { call: index + 1, reason: safeFailureReason(error) }, observations, currentWorkerInvocationCoverage: CURRENT_WORKER_TUPLES }; }
  }
  return { proposedRecords: records, failure: null, observations, currentWorkerInvocationCoverage: CURRENT_WORKER_TUPLES };
}

function printableIdentity(value: unknown): string | null { return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[\x20-\x7e]+$/u.test(value) ? value : null; }
function safeFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (["response_identity_or_completion", "prepared_wire_mismatch", "invalid_json", "wire_schema", "story_parser", "review_parser", "application_parser"].includes(message)) return message;
  if (/timeout/i.test(message)) return "timeout";
  if (/refusal/i.test(message)) return "refusal";
  return "execution_failure";
}
