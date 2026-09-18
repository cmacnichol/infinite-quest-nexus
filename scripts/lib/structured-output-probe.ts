import { Ajv } from "ajv";
import { createHash } from "node:crypto";
import type { ResponseSchemaOperation, SchemaVerification } from "../../packages/contracts/src/text-response-format.js";
import { stableStringify } from "../../packages/domain/src/text.js";
import { buildContinuityReviewInput, validateContinuityReview } from "../../packages/story-engine/src/continuity-review.js";
import { parseStoryOutput } from "../../packages/story-engine/src/output.js";
import { getProviderOutputSchema } from "../../packages/story-engine/src/provider-output-schema.js";
import { prepareResponseContract } from "../../packages/story-engine/src/provider-response-format.js";
import { serializeProviderRequest } from "../../packages/story-engine/src/provider-request.js";
import { parseChoiceRepair } from "../../packages/story-engine/src/story-only-output.js";
import { estimateStoryTokens } from "../../packages/story-engine/src/token-estimate.js";
import { capabilityRouteConfigHash, providerEndpointIdentity } from "../../services/runtime/src/provider-capability-cache.js";

export type ProbeInput = Readonly<{
  model: string; route: string; inputUsdPerToken: number; outputUsdPerToken: number; contextTokens: number;
  maxCalls: number; maxOutputTokens: number; temperature: number; priceObservedAt: string; profileId?: string | null;
}>;

export const DEFAULT_STRUCTURED_OUTPUT_PROBE: Readonly<Omit<ProbeInput, "profileId">> = Object.freeze({
  model: "deepseek/deepseek-v3.2-exp",
  route: "novita/fp8",
  inputUsdPerToken: 0.00000027,
  outputUsdPerToken: 0.00000041,
  contextTokens: 163_840,
  maxCalls: 12,
  maxOutputTokens: 2_048,
  temperature: 0,
  priceObservedAt: ""
});

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const CANONICAL_MODEL = DEFAULT_STRUCTURED_OUTPUT_PROBE.model;
const CANONICAL_ROUTE = DEFAULT_STRUCTURED_OUTPUT_PROBE.route;
const REQUIRED_CONTEXT_TOKENS = DEFAULT_STRUCTURED_OUTPUT_PROBE.contextTokens;
const REQUIRED_MAX_CALLS = DEFAULT_STRUCTURED_OUTPUT_PROBE.maxCalls;
const REQUIRED_MAX_OUTPUT_TOKENS = DEFAULT_STRUCTURED_OUTPUT_PROBE.maxOutputTokens;
const CURRENT_WORKER_TUPLES = ["story:stream", "story:nonstream", "choices:nonstream", "continuity_review:nonstream"] as const;
type ProbeOperation = ResponseSchemaOperation;

export type PreparedProbeRequest = Readonly<{
  scenario: "A" | "B"; operation: ProbeOperation; streaming: boolean; model: string; route: string;
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
  proposedRecords: readonly SchemaVerification[]; failure: Readonly<{ call: number; reason: string }> | null;
  observations: readonly Readonly<{ call: number; operation: ProbeOperation; streaming: boolean; status: "qualified" | "failed"; returnedModel: string | null; returnedProviderRoute: string | null; }>[];
  currentWorkerInvocationCoverage: readonly string[];
}>;

export function validateExecutionPriceObservation(observedAt: string, now: string, maxAgeMs = 86_400_000): void {
  const observed = Date.parse(observedAt); const current = Date.parse(now);
  if (!Number.isFinite(observed) || !Number.isFinite(current) || observed > current || current - observed > maxAgeMs) throw new Error("Execution requires current timestamped price and context evidence.");
}

function requireExact(input: ProbeInput) {
  if (input.model !== CANONICAL_MODEL) throw new Error("--model must be the canonical deepseek/deepseek-v3.2-exp target.");
  if (input.route !== CANONICAL_ROUTE) throw new Error("--route must be the full novita/fp8 routing slug.");
  if (input.contextTokens !== REQUIRED_CONTEXT_TOKENS) throw new Error("--context-tokens must be 163840 for this prepared target.");
  if (input.maxCalls !== REQUIRED_MAX_CALLS) throw new Error("--max-calls must be exactly 12.");
  if (input.maxOutputTokens !== REQUIRED_MAX_OUTPUT_TOKENS) throw new Error("--max-output-tokens must be exactly 2048.");
  if (![input.inputUsdPerToken, input.outputUsdPerToken].every((value) => Number.isFinite(value) && value > 0)) throw new Error("Per-token prices must be positive finite values.");
  if (!Number.isFinite(Date.parse(input.priceObservedAt)) || new Date(input.priceObservedAt).toISOString() !== input.priceObservedAt) throw new Error("--price-observed-at must be a canonical ISO timestamp.");
}

function story(scenario: "A" | "B") {
  const tracker_updates = scenario === "A"
    ? [{ name: "Synthetic trust", value: "watchful", metadata: { history: [null, true, 2, { note: "nested" }], active: false, empty: {} } }]
    : [{ name: "Synthetic supplies", value: "packed", state: { rows: [{ count: 3 }, null, [false, { label: "sealed" }]], absent: null } }];
  return {
    narration: "A synthetic traveler studies a quiet marker.",
    choices: ["Inspect the marker.", "Wait nearby.", "Follow the trail.", "Return to camp."],
    custom_action_suggestion: "Describe a careful next step.", scratchpad: "", tracker_updates,
    image_prompt: "", continuity_summary: "A synthetic scene remains unresolved.",
    canonical_facts: scenario === "A" ? ["A synthetic marker is present."] : [], superseded_facts: [],
    canonical_fact_updates: [], open_threads: scenario === "A" ? ["Learn the marker's purpose."] : []
  };
}

function choices() { return { choices: ["Inspect the marker.", "Wait nearby.", "Follow the trail.", "Return to camp."], custom_action_suggestion: "Describe a careful next step." }; }
function review() { return { version: "story-continuity-review-v1", verdict: "pass", findings: [] }; }

function responseFor(operation: ProbeOperation, scenario: "A" | "B") { return operation === "story" ? story(scenario) : operation === "choices" ? choices() : review(); }
function syntheticRequestInput(operation: ProbeOperation, scenario: "A" | "B") { return `Synthetic compatibility scenario ${scenario}. Produce this complete JSON shape for ${operation}: ${JSON.stringify(responseFor(operation, scenario))}`; }

function validateResponse(operation: ProbeOperation, scenario: "A" | "B", value: unknown): { ok: true } | { ok: false; reason: string } {
  const wire = new Ajv({ allErrors: true }).compile(getProviderOutputSchema(operation).schema);
  if (!wire(value)) return { ok: false, reason: "wire_schema" };
  try {
    if (operation === "story") {
      const parsed = parseStoryOutput(JSON.stringify(value));
      if (!parsed.ok || stableStringify(parsed.story.tracker_updates) !== stableStringify(story(scenario).tracker_updates)) return { ok: false, reason: "story_parser" };
    } else if (operation === "choices") parseChoiceRepair(JSON.stringify(value));
    else {
      const draft = story(scenario);
      const input = buildContinuityReviewInput({ evidence: [{ id: "a".repeat(64), content: "Synthetic source marker.", required: true, role: "source" }], requiredEvidenceIds: ["a".repeat(64)], direction: "Continue the synthetic scene.", draft });
      if (validateContinuityReview(input, value).verdict !== "pass") return { ok: false, reason: "review_parser" };
    }
    return { ok: true };
  } catch { return { ok: false, reason: "application_parser" }; }
}

function contract(operation: ProbeOperation, streaming: boolean, routeConfigHash: string) {
  const schema = getProviderOutputSchema(operation);
  return prepareResponseContract({ version: 1, operation, streaming, forbidFormatFallback: true, mode: "json_schema", schemaVersion: schema.version, schemaHash: schema.schemaHash, schemaName: schema.name, schema: schema.schema, providerRoutingSlugs: [CANONICAL_ROUTE], routeConfigHash, adapterProtocol: "text-schema-adapter-v1" });
}

/** Recreates the exact synthetic request whose body was measured during preparation. */
export function providerRequestForPreparedProbe(request: PreparedProbeRequest, routeConfigHash: string) {
  return {
    systemPrompt: "Return only the requested synthetic JSON. Preserve every nested tracker value exactly when present.", input: syntheticRequestInput(request.operation, request.scenario),
    ...(request.streaming ? { onChunk: () => undefined } : {}),
    responseContract: contract(request.operation, request.streaming, routeConfigHash)
  };
}

/** Pure offline preparation: no runtime, database, credential, or network dependency. */
export function prepareStructuredOutputProbe(input: ProbeInput): StructuredOutputProbePlan {
  requireExact(input);
  const configuration = { streaming: true, streamingSupport: true, textResponseFormatPolicy: "required" as const };
  const routeConfigHash = capabilityRouteConfigHash(configuration);
  const profile = { providerType: "openrouter" as const, baseUrl: "", model: CANONICAL_MODEL, contextWindowTokens: REQUIRED_CONTEXT_TOKENS, maxOutputTokens: REQUIRED_MAX_OUTPUT_TOKENS, temperature: input.temperature, configuration };
  const requests: PreparedProbeRequest[] = [];
  for (const scenario of ["A", "B"] as const) for (const operation of ["story", "choices", "continuity_review"] as const) for (const streaming of [false, true]) {
    const prepared = serializeProviderRequest(profile, { systemPrompt: "Return only the requested synthetic JSON. Preserve every nested tracker value exactly when present.", input: syntheticRequestInput(operation, scenario), ...(streaming ? { onChunk: () => undefined } : {}), responseContract: contract(operation, streaming, routeConfigHash) });
    requests.push(Object.freeze({ scenario, operation, streaming, model: CANONICAL_MODEL, route: CANONICAL_ROUTE, body: prepared.body, payloadHash: prepared.payloadHash, bodyByteCount: Buffer.byteLength(prepared.body, "utf8"), schemaHash: getProviderOutputSchema(operation).schemaHash, syntheticResponse: responseFor(operation, scenario), validate: (value: unknown) => validateResponse(operation, scenario, value) }));
  }
  const largestBodyByteCount = Math.max(...requests.map((request) => request.bodyByteCount));
  const preparedInputTokenEstimate = Math.max(...requests.map((request) => estimateStoryTokens(request.body)));
  if (preparedInputTokenEstimate + input.maxOutputTokens > input.contextTokens) throw new Error("Prepared request estimate exceeds the advertised context constraint.");
  const conservativePerCallUsd = input.contextTokens * input.inputUsdPerToken + input.maxOutputTokens * input.outputUsdPerToken;
  const exactCeiling = conservativePerCallUsd * input.maxCalls;
  const maxInferenceCostUsd = Math.ceil((exactCeiling + Number.EPSILON) * 1_000_000) / 1_000_000;
  return Object.freeze({ profileId: input.profileId ?? null, endpointIdentity: providerEndpointIdentity(OPENROUTER_BASE_URL), routeConfigHash, requests: Object.freeze(requests), safePlan: Object.freeze({ model: CANONICAL_MODEL, route: CANONICAL_ROUTE, requestCount: requests.length, endpointIdentity: providerEndpointIdentity(OPENROUTER_BASE_URL), routeConfigHash, largestBodyByteCount, preparedInputTokenEstimate, preparedInputTokenEstimateKind: "application_estimate_not_billing_bound", conservativeInputTokenCeiling: input.contextTokens, outputTokenCeiling: input.maxOutputTokens, maxInferenceCostUsd, priceObservedAt: input.priceObservedAt, schemas: requests.map((request) => { const schema = getProviderOutputSchema(request.operation); return { operation: request.operation, streaming: request.streaming, schemaName: schema.name, schemaVersion: schema.version, schemaHash: request.schemaHash, payloadHash: request.payloadHash, bodyByteCount: request.bodyByteCount }; }) }) });
}

export async function runStructuredOutputProbe(plan: StructuredOutputProbePlan, execute: ProbeExecutor, options: Readonly<{ now?: string }> = {}): Promise<ProbeRunResult> {
  const records: SchemaVerification[] = [];
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
      const schema = getProviderOutputSchema(request.operation); const verifiedAt = options.now ?? new Date().toISOString();
      records.push(Object.freeze({ version: 1, providerType: "openrouter", endpointIdentity: plan.endpointIdentity, model: request.model, routeConfigHash: plan.routeConfigHash, adapterProtocol: "text-schema-adapter-v1", operation: request.operation, schemaHash: schema.schemaHash, streaming: request.streaming, verifiedAt, expiresAt: new Date(Date.parse(verifiedAt) + 30 * 86_400_000).toISOString(), providerRoutingSlugs: [request.route], nativeOpenTrackerObjects: schema.requiresOpenTrackerObjects }));
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
