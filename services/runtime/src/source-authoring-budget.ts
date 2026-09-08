import {
  serializeLegacyProviderRequest,
  type PreparedProviderRequest,
  type ProviderRequest,
  type ProviderResult,
  type LegacyProviderRequestProfile
} from "../../../packages/story-engine/src/index.js";
import type { AuthoringBudget } from "../../../packages/domain/src/source-authoring-budget.js";
import type { RuntimeTextExecution } from "./provider-credential-transport-adapter.js";
import type { RuntimeProviderExecutionPort } from "./provider-credential-transport-adapter.js";

const SOURCE_CONTEXT_FRACTION = 0.8;

export class RuntimeSourceAuthoringBudgetError extends Error {
  readonly code = "authoring_context_exceeded" as const;

  constructor(message: string) {
    super(message);
    this.name = "RuntimeSourceAuthoringBudgetError";
  }
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RuntimeSourceAuthoringBudgetError(`A positive ${name} is required for source authoring.`);
  }
  return value;
}

/**
 * Inventory discovery is optional and never performed here. When a caller has
 * a verified selected-model limit, it can only narrow the saved profile cap.
 */
export function resolveAuthoringContextWindowTokens(
  configuredContextWindowTokens: number,
  verifiedModelContextWindowTokens?: number
): number {
  const configured = positiveLimit(configuredContextWindowTokens, "configured context limit");
  if (verifiedModelContextWindowTokens === undefined) return configured;
  return Math.min(configured, positiveLimit(verifiedModelContextWindowTokens, "verified model context limit"));
}

export type SourceAuthoringModelInventory = Readonly<{
  listModels(input: Readonly<{
    ownerUserId: string;
    providerProfileId: string;
    providerRole: "text";
  }>): Promise<Readonly<{
    models: readonly Readonly<{
      id: string;
      contextWindowTokens?: number;
    }>[];
  }>>;
}>;

/**
 * Source-only admission seam. It does not alter ordinary text execution or
 * cache inventory. A missing/failed inventory leaves a valid configured cap.
 */
export async function resolveSourceAuthoringTextExecution(input: Readonly<{
  execution: RuntimeProviderExecutionPort;
  inventory: SourceAuthoringModelInventory;
  scope: Readonly<{ ownerUserId: string }>;
  providerProfileId: string;
  model: string;
}>): Promise<Readonly<{
  execution: RuntimeTextExecution;
  verifiedModelContextWindowTokens?: number;
}>> {
  let verifiedModelContextWindowTokens: number | undefined;
  try {
    const inventory = await input.inventory.listModels({
      ownerUserId: input.scope.ownerUserId,
      providerProfileId: input.providerProfileId,
      providerRole: "text"
    });
    const selected = inventory.models.find((candidate) => candidate.id === input.model);
    if (selected?.contextWindowTokens !== undefined) {
      verifiedModelContextWindowTokens = positiveLimit(selected.contextWindowTokens, "verified model context limit");
    }
  } catch {
    // Inventory is advisory for this source-only opt-in. The configured cap is
    // still a valid bounded fallback and no ordinary provider caller is changed.
  }
  const execution = verifiedModelContextWindowTokens === undefined
    ? await input.execution.text(input.scope, input.providerProfileId, "text", input.model)
    : await input.execution.text(input.scope, input.providerProfileId, "text", input.model, verifiedModelContextWindowTokens);
  return Object.freeze({
    execution,
    ...(verifiedModelContextWindowTokens === undefined ? {} : { verifiedModelContextWindowTokens })
  });
}

function legacyProfile(execution: RuntimeTextExecution): LegacyProviderRequestProfile {
  return {
    providerType: execution.providerType,
    model: execution.model,
    maxOutputTokens: execution.maxOutputTokens,
    temperature: execution.temperature
  };
}

export type PreparedSourceAuthoringRequest = Readonly<{
  request: ProviderRequest;
  body: string;
  payloadHash: string;
  byteLength: number;
  droppedRejectedResponse: boolean;
}>;

export type RuntimeSourceAuthoringRequestBudget = Readonly<{
  budget: AuthoringBudget;
  inputLimit: number;
  /** Exact credential-free legacy envelope used for non-paid source planning probes. */
  render(request: ProviderRequest): string;
  prepareInitial(request: ProviderRequest): PreparedSourceAuthoringRequest;
  prepareRepair(request: ProviderRequest): PreparedSourceAuthoringRequest;
  executeInitial(request: ProviderRequest): Promise<ProviderResult>;
  executeRepair(request: ProviderRequest): Promise<ProviderResult>;
}>;

function sourceInputLimit(contextWindowTokens: number, maxOutputTokens: number): number {
  const outputReserve = positiveLimit(maxOutputTokens, "output reservation");
  const limit = Math.floor(contextWindowTokens * SOURCE_CONTEXT_FRACTION) - outputReserve;
  if (limit <= 0) {
    throw new RuntimeSourceAuthoringBudgetError("The effective context limit does not leave room for source authoring output.");
  }
  return limit;
}

function toPrepared(
  request: ProviderRequest,
  prepared: PreparedProviderRequest,
  inputLimit: number,
  droppedRejectedResponse: boolean
): PreparedSourceAuthoringRequest {
  const byteLength = new TextEncoder().encode(prepared.body).length;
  if (byteLength > inputLimit) {
    throw new RuntimeSourceAuthoringBudgetError("The complete serialized source authoring request exceeds its effective input budget.");
  }
  return Object.freeze({
    request,
    body: prepared.body,
    payloadHash: prepared.payloadHash,
    byteLength,
    droppedRejectedResponse
  });
}

/** Source requests always retain their complete selected text in the measured body. */
function assertMeasuredLegacySourceRequest(request: ProviderRequest): void {
  if (request.canonicalBudgeting === true) {
    throw new RuntimeSourceAuthoringBudgetError("Source authoring cannot switch to canonical transport serialization after budgeting.");
  }
  if (request.previousResponseId) {
    throw new RuntimeSourceAuthoringBudgetError("Source authoring repairs cannot use a previous response chain in place of selected source text.");
  }
}

export function createRuntimeSourceAuthoringRequestBudget(
  execution: RuntimeTextExecution,
  verifiedModelContextWindowTokens?: number
): RuntimeSourceAuthoringRequestBudget {
  const contextWindowTokens = resolveAuthoringContextWindowTokens(execution.contextWindowTokens, verifiedModelContextWindowTokens);
  const inputLimit = sourceInputLimit(contextWindowTokens, execution.maxOutputTokens);
  const profile = legacyProfile(execution);
  const budget: AuthoringBudget = Object.freeze({
    contextWindowTokens,
    maxOutputTokens: execution.maxOutputTokens,
    countTokens: (body) => new TextEncoder().encode(body).length
  });
  const prepareInitial = (request: ProviderRequest) => {
    assertMeasuredLegacySourceRequest(request);
    return toPrepared(request, serializeLegacyProviderRequest(profile, request), inputLimit, false);
  };
  const prepareRepair = (request: ProviderRequest) => {
    assertMeasuredLegacySourceRequest(request);
    try {
      return toPrepared(request, serializeLegacyProviderRequest(profile, request), inputLimit, false);
    } catch (error) {
      if (!(error instanceof RuntimeSourceAuthoringBudgetError) || !request.rejectedResponse) throw error;
      const { rejectedResponse: _rejectedResponse, ...withoutDiagnostic } = request;
      return toPrepared(withoutDiagnostic, serializeLegacyProviderRequest(profile, withoutDiagnostic), inputLimit, true);
    }
  };
  return Object.freeze({
    budget,
    inputLimit,
    render: (request) => {
      assertMeasuredLegacySourceRequest(request);
      return serializeLegacyProviderRequest(profile, request).body;
    },
    prepareInitial,
    prepareRepair,
    executeInitial: async (request) => {
      const prepared = prepareInitial(request);
      return execution.execute(prepared.request);
    },
    executeRepair: async (request) => {
      const prepared = prepareRepair(request);
      return execution.execute(prepared.request);
    }
  });
}
