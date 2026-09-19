import type { ResolvedPreset, TextModelSelection } from "@infinite-quest/contracts";
import {
  textExecutionPlanSchema,
  textGenerationParametersSchema,
  type TextExecutionPlan,
  type TextGenerationParameters
} from "../../../packages/application/src/providers/text-execution-plan.js";
import { stableStringify, sha256 } from "../../../packages/domain/src/text.js";
import { validateOpenRouterPresetConfig } from "../../../packages/story-engine/src/openrouter-presets.js";
import { composePresetPrompt } from "../../../packages/story-engine/src/preset-prompt.js";

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
  providerType: string;
  selection: TextModelSelection;
  /** Legacy/default profile sizing is not evidence of an unknown route's capacity. */
  contextWindowTokens?: number;
  maxOutputTokens: number;
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

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${field} must be a positive integer.`);
  return value as number;
}

function freeze<T>(value: T): T {
  return Object.freeze(value);
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
    limits.push(positiveInteger(overrides.conservativeContextWindowTokens, "conservativeContextWindowTokens"));
  }
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

export async function resolveTextExecutionPlan(input: ResolveTextExecutionPlanInput): Promise<TextExecutionPlan> {
  const profile = input.profile;
  const overrides = input.overrides ?? {};
  const selection = overrides.selection ?? profile.selection;
  const operationPrompt = input.operationPrompt.trim();
  if (!operationPrompt) throw new Error("An operation prompt is required.");

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
  const prompt = composePresetPrompt({ presetPrompt: presetSystemPrompt, operationPrompt });
  const configHash = preset ? sha256(stableStringify(config)) : null;
  const planWithoutHash = {
    version: PLAN_VERSION,
    selection,
    preset: preset ? { slug: preset.slug, versionId: preset.versionId, configHash: configHash! } : null,
    candidates,
    presetSystemPrompt,
    parameters,
    prompt,
    promptHash: sha256(prompt),
    endpointReference: profile.endpointReference,
    credentialReference: profile.credentialReference,
    profileRevision: profile.profileRevision,
    protocolVersion: profile.protocolVersion
  };
  const planHash = sha256(stableStringify(planWithoutHash));
  return freeze(textExecutionPlanSchema.parse({ ...planWithoutHash, planHash }));
}
