import { z } from "zod";
import { providerRoutingPolicySchema, textGenerationParametersSchema } from "./text-execution-plan.js";

export type PresetSummary = Readonly<{
  slug: string;
  name: string;
  status: string;
  designatedVersionId: string;
  updatedAt: string;
}>;

export type PresetPage = Readonly<{
  presets: readonly PresetSummary[];
  totalCount: number;
  offset: number;
  nextOffset: number | null;
}>;

export type ResolvedPreset = Readonly<{
  slug: string;
  name: string;
  versionId: string;
  version: number;
  systemPrompt: string;
  config: Readonly<Record<string, unknown>>;
  configHash: string;
}>;

export type ProviderPresetDiagnosticCode =
  | "authentication"
  | "discovery_unavailable"
  | "preset_missing"
  | "preset_inactive"
  | "preset_config_unsupported"
  | "invalid_response";

const presetSlugSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u).max(200);
const nullablePositiveInteger = z.number().int().positive().nullable();

export const providerPresetDiagnosticCodeSchema = z.enum([
  "authentication", "discovery_unavailable", "preset_missing", "preset_inactive",
  "preset_config_unsupported", "invalid_response"
]);

export const safePresetSummarySchema = z.object({
  slug: presetSlugSchema,
  name: z.string().trim().min(1).max(500),
  status: z.string().trim().min(1).max(100),
  designatedVersionId: z.string().trim().min(1).max(500),
  updatedAt: z.string().datetime()
}).strict();

export const safePresetPageSchema = z.object({
  presets: z.array(safePresetSummarySchema),
  totalCount: z.number().int().min(0),
  offset: z.number().int().min(0),
  nextOffset: z.number().int().min(0).nullable()
}).strict();

export const safePresetDetailSchema = z.object({
  slug: presetSlugSchema,
  name: z.string().trim().min(1).max(500),
  versionId: z.string().trim().min(1).max(500),
  version: z.number().int().positive(),
  standardPrompt: z.string().max(200_000),
  candidateModelIds: z.array(z.string().trim().min(1).max(500)).max(32),
  providerPolicy: providerRoutingPolicySchema,
  excludedProviderSlugs: z.array(z.string().trim().min(1).max(500)).max(64),
  parameters: textGenerationParametersSchema,
  limits: z.object({
    configuredMaxTokens: nullablePositiveInteger,
    configuredMaxCompletionTokens: nullablePositiveInteger,
    effectiveMaxOutputTokens: nullablePositiveInteger,
    contextWindowTokens: z.object({ status: z.literal("unknown"), value: z.null() }).strict()
  }).strict(),
  responseFormat: z.object({ mode: z.literal("json_schema"), assurance: z.literal("trusted_preset") }).strict()
}).strict();

export type SafePresetSummary = Readonly<z.infer<typeof safePresetSummarySchema>>;
export type SafePresetPage = Readonly<z.infer<typeof safePresetPageSchema>>;
export type SafePresetDetail = Readonly<z.infer<typeof safePresetDetailSchema>>;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function projectSafePresetPage(value: unknown): SafePresetPage {
  const page = record(value);
  const presets = Array.isArray(page.presets) ? page.presets.map((item) => {
    const preset = record(item);
    return safePresetSummarySchema.parse({
      slug: preset.slug, name: preset.name, status: preset.status,
      designatedVersionId: preset.designatedVersionId, updatedAt: preset.updatedAt
    });
  }) : page.presets;
  return safePresetPageSchema.parse({ presets, totalCount: page.totalCount, offset: page.offset, nextOffset: page.nextOffset });
}

export function projectSafePresetDetail(value: unknown): SafePresetDetail {
  const preset = record(value);
  const config = record(preset.config);
  const providerPolicy = config.provider === undefined ? {} : providerRoutingPolicySchema.parse(config.provider);
  const modelIdSchema = z.string().trim().min(1).max(500);
  const models = [
    ...(config.model === undefined ? [] : [modelIdSchema.parse(config.model)]),
    ...(config.models === undefined ? [] : z.array(modelIdSchema).parse(config.models))
  ];
  const candidateModelIds = [...new Set(models)];
  const parameterResult = textGenerationParametersSchema.safeParse(config);
  const parameters = parameterResult.success ? parameterResult.data : textGenerationParametersSchema.parse({
    ...Object.fromEntries(Object.entries(config).filter(([key]) => key in textGenerationParametersSchema.shape))
  });
  const configuredMaxTokens = typeof parameters.max_tokens === "number" ? parameters.max_tokens : null;
  const configuredMaxCompletionTokens = typeof parameters.max_completion_tokens === "number" ? parameters.max_completion_tokens : null;
  const configuredLimits = [configuredMaxTokens, configuredMaxCompletionTokens].filter((limit): limit is number => limit !== null);
  return safePresetDetailSchema.parse({
    slug: preset.slug, name: preset.name, versionId: preset.versionId, version: preset.version,
    standardPrompt: preset.systemPrompt, candidateModelIds, providerPolicy,
    excludedProviderSlugs: providerPolicy.ignore ?? [], parameters,
    limits: {
      configuredMaxTokens, configuredMaxCompletionTokens,
      effectiveMaxOutputTokens: configuredLimits.length > 0 ? Math.min(...configuredLimits) : null,
      contextWindowTokens: { status: "unknown", value: null }
    },
    responseFormat: { mode: "json_schema", assurance: "trusted_preset" }
  });
}
