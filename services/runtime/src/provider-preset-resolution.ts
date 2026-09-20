import type { ResolvedPreset, TextModelSelection } from "@infinite-quest/contracts";
import {
  deriveTextExecutionPlan as deriveTextExecutionPlanFromContracts,
  textExecutionPlanSchema,
  textExecutionRouteBasisSchema,
  textGenerationParametersSchema,
  type TextExecutionRouteBasis,
  type TextExecutionPlan,
  type TextGenerationParameters
} from "@infinite-quest/contracts";
import { stableStringify, sha256 } from "../../../packages/domain/src/text.js";
import { validateOpenRouterPresetConfig } from "../../../packages/story-engine/src/openrouter-presets.js";

const PLAN_VERSION = 2 as const;

export type TextModelLimit = Readonly<{
  id: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
}>;

export type TextExecutionPlanDiscoveryPorts = Readonly<{
  resolvePreset(input: Readonly<{ ownerUserId: string; providerProfileId: string; slug: string }>): Promise<ResolvedPreset>;
  discoverModels(input: Readonly<{ ownerUserId: string; providerProfileId: string; modelIds: readonly string[] }>): Promise<readonly TextModelLimit[]>;
}>;

export type TextExecutionPlanProfile = Readonly<{
  ownerUserId: string;
  providerProfileId: string;
  profileRevision: string;
  authorityRevision?: string;
  providerType: string;
  selection: TextModelSelection;
  /** Legacy/default profile sizing is not evidence of an unknown route's capacity. */
  contextWindowTokens?: number;
  maxOutputTokens: number;
  requestTimeoutMs?: number;
  parameters?: TextGenerationParameters;
  endpointReference: string;
  credentialReference: string | null;
  protocolVersion: string;
}>;

export type TextExecutionPlanOverrides = Readonly<{
  /** Replaces the profile selection, including a preset; it does not select its first route. */
  selection?: TextModelSelection;
  parameters?: TextGenerationParameters;
  /** Required when no discovered model capacity and no profile context cap are available. */
  conservativeContextWindowTokens?: number;
}>;

export type ResolveTextExecutionPlanInput = Readonly<{
  profile: TextExecutionPlanProfile;
  operationPrompt: string;
  overrides?: TextExecutionPlanOverrides;
  ports: TextExecutionPlanDiscoveryPorts;
}>;

export type ResolveTextExecutionPlansInput = Readonly<{
  profile: TextExecutionPlanProfile;
  /** Named prompts become separately hashed immutable plans from one resolution snapshot. */
  operationPrompts: Readonly<Record<string, string>>;
  overrides?: TextExecutionPlanOverrides;
  ports: TextExecutionPlanDiscoveryPorts;
}>;

export type ResolvedTextExecutionPlans = Readonly<{
  plans: Readonly<Record<string, TextExecutionPlan>>;
}>;

const MAX_OPERATION_PLANS = 32;

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${field} must be a positive integer.`);
  return value as number;
}

function freeze<T>(value: T): T {
  return Object.freeze(value);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return value;
}

function parameterFields(config: Readonly<Record<string, unknown>>): TextGenerationParameters {
  const source = Object.fromEntries(Object.entries(config).filter(([key]) => key !== "model" && key !== "models" && key !== "provider"));
  return freeze(textGenerationParametersSchema.parse(source));
}

function modelIds(config: Readonly<Record<string, unknown>>): readonly string[] {
  const direct = typeof config.model === "string" ? [config.model] : [];
  const configured = Array.isArray(config.models) ? config.models as string[] : [];
  const ordered = [...direct, ...configured].filter((model, index, values) => values.indexOf(model) === index);
  if (!ordered.length) throw new Error("Preset config must include model or models.");
  return freeze(ordered);
}

function outputLimit(parameters: TextGenerationParameters, profileLimit: number, discovered?: number): number {
  const limits = [positiveInteger(profileLimit, "Profile maxOutputTokens")];
  if (parameters.max_tokens !== undefined) limits.push(parameters.max_tokens);
  if (parameters.max_completion_tokens !== undefined) limits.push(parameters.max_completion_tokens);
  if (discovered !== undefined) limits.push(positiveInteger(discovered, "Model maxOutputTokens"));
  return Math.min(...limits);
}

function contextLimit(discovered: readonly TextModelLimit[], profile: TextExecutionPlanProfile, overrides: TextExecutionPlanOverrides): number {
  const limits = discovered.flatMap((model) => model.contextWindowTokens === undefined ? [] : [positiveInteger(model.contextWindowTokens, "Model contextWindowTokens")]);
  const unknownRouteCapacity = discovered.length === 0 || discovered.some((model) => model.contextWindowTokens === undefined);
  if (unknownRouteCapacity) {
    if (overrides.conservativeContextWindowTokens === undefined) throw new Error("A conservative context cap is required when model context capacity is unknown.");
  }
  if (overrides.conservativeContextWindowTokens !== undefined) limits.push(positiveInteger(overrides.conservativeContextWindowTokens, "conservativeContextWindowTokens"));
  if (profile.contextWindowTokens !== undefined) limits.push(positiveInteger(profile.contextWindowTokens, "Profile contextWindowTokens"));
  return Math.min(...limits);
}

function limitsById(discovered: readonly TextModelLimit[]): ReadonlyMap<string, TextModelLimit> {
  const values = new Map<string, TextModelLimit>();
  for (const model of discovered) {
    if (!model.id.trim()) throw new Error("Discovered model ID is required.");
    if (values.has(model.id)) throw new Error(`Discovered model '${model.id}' was returned more than once.`);
    values.set(model.id, model);
  }
  return values;
}

function effectiveParameters(profile: TextExecutionPlanProfile, inherited: TextGenerationParameters, overrides: TextExecutionPlanOverrides): TextGenerationParameters {
  return freeze(textGenerationParametersSchema.parse({
    ...(profile.parameters ?? {}),
    ...inherited,
    ...(overrides.parameters ?? {})
  }));
}

function applyEffectiveOutputCap(parameters: TextGenerationParameters, maxOutputTokens: number): TextGenerationParameters {
  return freeze(textGenerationParametersSchema.parse({
    ...parameters,
    ...(parameters.max_tokens === undefined ? {} : { max_tokens: maxOutputTokens }),
    ...(parameters.max_completion_tokens === undefined ? {} : { max_completion_tokens: maxOutputTokens })
  }));
}

function operationEntries(operationPrompts: Readonly<Record<string, string>>): readonly (readonly [string, string])[] {
  const entries = Object.entries(operationPrompts);
  if (!entries.length || entries.length > MAX_OPERATION_PLANS) throw new Error(`Operation plan count must be between 1 and ${MAX_OPERATION_PLANS}.`);
  return freeze(entries.map(([name, prompt]) => {
    if (!name.trim() || name.length > 200) throw new Error("An operation name is required and must be at most 200 characters.");
    const operationPrompt = prompt.trim();
    if (!operationPrompt) throw new Error(`An operation prompt is required for '${name}'.`);
    return freeze([name, operationPrompt] as const);
  }));
}

type ResolvedPlanInputs = Readonly<{
  profile: TextExecutionPlanProfile;
  selection: TextModelSelection;
  preset: ResolvedPreset | null;
  configHash: string | null;
  candidates: readonly unknown[];
  parameters: TextGenerationParameters;
  presetSystemPrompt: string;
}>;

async function resolvePlanInputs(input: Omit<ResolveTextExecutionPlansInput, "operationPrompts">): Promise<ResolvedPlanInputs> {
  const profile = input.profile;
  const overrides = input.overrides ?? {};
  const selection = overrides.selection ?? profile.selection;
  let preset: ResolvedPreset | null = null;
  let config: Readonly<Record<string, unknown>> = {};
  if (selection.kind === "openrouter_preset") {
    if (profile.providerType !== "openrouter") throw new Error("OpenRouter presets require an OpenRouter profile.");
    preset = await input.ports.resolvePreset({ ownerUserId: profile.ownerUserId, providerProfileId: profile.providerProfileId, slug: selection.slug });
    if (preset.slug !== selection.slug) throw new Error("Resolved preset slug does not match the selected preset.");
    config = validateOpenRouterPresetConfig(preset.config);
  }

  const ids = selection.kind === "model" ? [selection.modelId] : modelIds(config);
  const discovered = await input.ports.discoverModels({ ownerUserId: profile.ownerUserId, providerProfileId: profile.providerProfileId, modelIds: ids });
  const byId = limitsById(discovered);
  // An omitted selected model is unknown capacity; unrelated inventory entries
  // cannot make a requested route safe.
  const selectedModels = ids.map((modelId) => byId.get(modelId) ?? { id: modelId });
  const contextWindowTokens = contextLimit(selectedModels, profile, overrides);
  const inherited = selection.kind === "openrouter_preset" ? parameterFields(config) : freeze({});
  const requestedParameters = effectiveParameters(profile, inherited, overrides);
  const providerPolicy = selection.kind === "openrouter_preset" ? config.provider ?? {} : {};
  const sharedMaxOutputTokens = Math.min(...ids.map((modelId) => outputLimit(requestedParameters, profile.maxOutputTokens, byId.get(modelId)?.maxOutputTokens)));
  const candidates = ids.map((modelId) => freeze({
    modelId,
    providerPolicy,
    contextWindowTokens,
    maxOutputTokens: sharedMaxOutputTokens
  }));
  const parameters = applyEffectiveOutputCap(requestedParameters, sharedMaxOutputTokens);
  const presetSystemPrompt = preset?.systemPrompt ?? "";
  const configHash = preset ? sha256(stableStringify(config)) : null;
  return freeze({ profile, selection, preset, configHash, candidates: freeze(candidates), parameters, presetSystemPrompt });
}

function createRouteBasis(inputs: ResolvedPlanInputs): TextExecutionRouteBasis {
  const basisWithoutHash = {
    version: PLAN_VERSION,
    selection: inputs.selection,
    preset: inputs.preset ? { slug: inputs.preset.slug, versionId: inputs.preset.versionId, configHash: inputs.configHash! } : null,
    candidates: inputs.candidates,
    presetSystemPrompt: inputs.presetSystemPrompt,
    parameters: inputs.parameters,
    endpointReference: inputs.profile.endpointReference,
    credentialReference: inputs.profile.credentialReference,
    profileRevision: inputs.profile.profileRevision,
    ...(inputs.profile.authorityRevision === undefined ? {} : { authorityRevision: inputs.profile.authorityRevision }),
    requestTimeoutMs: inputs.profile.requestTimeoutMs ?? 300_000,
    protocolVersion: inputs.profile.protocolVersion,
  };
  const parsedWithoutHash = textExecutionRouteBasisSchema.parse({ ...basisWithoutHash, routeBasisHash: "0".repeat(64) });
  const { routeBasisHash: _placeholder, ...normalizedWithoutHash } = parsedWithoutHash;
  const routeBasisHash = sha256(stableStringify(normalizedWithoutHash));
  return deepFreeze(textExecutionRouteBasisSchema.parse({ ...normalizedWithoutHash, routeBasisHash }));
}

/** Derives the complete, prompt-specific plan without reading mutable metadata. */
/** Compatibility export; all runtime and contract binding paths use the same pure derivation. */
export const deriveTextExecutionPlan = deriveTextExecutionPlanFromContracts;

/** Resolves one selected profile into an immutable prompt-independent route basis. */
export async function resolveTextExecutionRouteBasis(input: Omit<ResolveTextExecutionPlansInput, "operationPrompts">): Promise<TextExecutionRouteBasis> {
  return createRouteBasis(await resolvePlanInputs(input));
}

/**
 * Resolves one selected profile into prompt-specific plans without observing a
 * mutable preset or model inventory more than once for the operation set.
 */
export async function resolveTextExecutionPlans(input: ResolveTextExecutionPlansInput): Promise<ResolvedTextExecutionPlans> {
  const entries = operationEntries(input.operationPrompts);
  const routeBasis = await resolveTextExecutionRouteBasis(input);
  const plans = Object.fromEntries(entries.map(([name, operationPrompt]) => [name, deriveTextExecutionPlan(routeBasis, operationPrompt)]));
  return deepFreeze({ plans });
}

/** Compatibility API for callers that have exactly one operation prompt. */
export async function resolveTextExecutionPlan(input: ResolveTextExecutionPlanInput): Promise<TextExecutionPlan> {
  const resolved = await resolveTextExecutionPlans({
    profile: input.profile,
    operationPrompts: { single: input.operationPrompt },
    ...(input.overrides === undefined ? {} : { overrides: input.overrides }),
    ports: input.ports
  });
  return resolved.plans.single!;
}
