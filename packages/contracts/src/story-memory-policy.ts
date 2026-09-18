import { z } from "zod";
import { sha256Hex } from "./hash.js";
import {
  LEGACY_STORY_MEMORY_PROMPT_PROTOCOL_VERSION,
  PREVIOUS_STORY_MEMORY_PROMPT_PROTOCOL_VERSION,
  STORY_MEMORY_CONTEXT_POLICY_VERSION,
  STORY_MEMORY_PROMPT_PROTOCOL_VERSION
} from "./story-prompt.js";

type DeepReadonly<T> = T extends readonly (infer U)[] ? readonly DeepReadonly<U>[]
  : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

export const storyMemoryCapabilitySchema = z.enum(["r1", "r2", "r3"]);
export const storyMemoryReviewModeSchema = z.enum(["off", "observe", "enforce"]);
export const storyMemoryLevelSchema = z.enum(["off", "standard", "enhanced", "max"]);
export type StoryMemoryLevel = z.infer<typeof storyMemoryLevelSchema>;
export const storyMemorySettingsSchema = z.object({
  level: storyMemoryLevelSchema,
  reviewMode: storyMemoryReviewModeSchema,
  availableLevels: z.array(storyMemoryLevelSchema)
}).strict();
export type StoryMemorySettings = Readonly<z.infer<typeof storyMemorySettingsSchema>>;
export const storyMemorySettingsUpdateSchema = z.object({ level: storyMemoryLevelSchema }).strict();
export const storyMemoryRankAggregationSchema = z.enum(["legacy_sum", "query_family_max_v1"]);
export const storyMemorySelectionReasonSchema = z.enum([
  "selected", "context_limit", "request_limit", "recent_gap", "unsupported_world_shape",
  "source_revision_changed", "unverifiable_excerpt", "duplicate_source"
]);
/** Frozen actual legacy wire shape; installing a new contract does not change planning. */
export const legacyChronicleQueryKindSchema = z.enum(["action", "entity_expanded", "scene", "open_thread"]);
export const storyMemoryQueryKindSchema = z.enum([...legacyChronicleQueryKindSchema.options, "temporal_hint"]);
export const legacyStoryMemoryQueryVariantSchema = z.object({
  kind: legacyChronicleQueryKindSchema, query: z.string().max(4_000), entityIds: z.array(z.string().min(1))
}).strict();
const queryInputSchema = z.object({
  kind: storyMemoryQueryKindSchema, query: z.string().min(1).max(4_000), entityIds: z.array(z.string().min(1)).max(200),
  actionSegment: z.object({ index: z.number().int().min(0), start: z.number().int().min(0), end: z.number().int().min(1) }).strict().refine(({ start, end }) => end > start).nullable(),
  temporalHint: z.object({ throughTurnNumber: z.number().int().min(0), label: z.string().min(1).max(200) }).strict().nullable()
}).strict();
export type StoryMemoryQueryVariantInput = DeepReadonly<z.infer<typeof queryInputSchema>>;
function queryIdentity(input: StoryMemoryQueryVariantInput) {
  return { familyId: input.kind, variantId: sha256Hex(canonicalJson({ version: "story-memory-query-v1", ...input })) };
}
/** Fragments have distinct identities but a shared ranking family. */
export const storyMemoryQueryVariantSchema = queryInputSchema.extend({
  version: z.literal("story-memory-query-v1"), familyId: storyMemoryQueryKindSchema, variantId: z.string().regex(/^[a-f0-9]{64}$/)
}).strict().superRefine((value, context) => {
  const { version, familyId, variantId, ...input } = value;
  const identity = queryIdentity(input);
  if (identity.familyId !== familyId || identity.variantId !== variantId) context.addIssue({ code: "custom", path: ["variantId"], message: "Query identity does not match its content and segment." });
  if ((value.kind === "action") !== (value.actionSegment !== null)) context.addIssue({ code: "custom", path: ["actionSegment"], message: "Only action variants must identify their direction segment." });
  if (value.kind === "temporal_hint" && !value.temporalHint) context.addIssue({ code: "custom", path: ["temporalHint"], message: "Temporal variants require a hint." });
});
export type StoryMemoryQueryVariant = DeepReadonly<z.infer<typeof storyMemoryQueryVariantSchema>>;
export type LegacyStoryMemoryQueryVariant = DeepReadonly<z.infer<typeof legacyStoryMemoryQueryVariantSchema>>;
export function createStoryMemoryQueryVariant(input: StoryMemoryQueryVariantInput): StoryMemoryQueryVariant {
  const parsed = queryInputSchema.parse(input);
  return storyMemoryQueryVariantSchema.parse({ ...parsed, version: "story-memory-query-v1", ...queryIdentity(parsed) });
}
export function readLegacyStoryMemoryQueryVariant(value: unknown): LegacyStoryMemoryQueryVariant {
  return legacyStoryMemoryQueryVariantSchema.parse(value);
}
export function readStoryMemoryQueryVariant(value: unknown):
  Readonly<{ kind: "legacy"; variant: LegacyStoryMemoryQueryVariant; rankAggregation: "legacy_sum" }>
  | Readonly<{ kind: "v1"; variant: StoryMemoryQueryVariant; rankAggregation: "query_family_max_v1" }> {
  if (value && typeof value === "object" && Object.hasOwn(value, "version")) {
    return { kind: "v1", variant: storyMemoryQueryVariantSchema.parse(value), rankAggregation: "query_family_max_v1" };
  }
  return { kind: "legacy", variant: readLegacyStoryMemoryQueryVariant(value), rankAggregation: "legacy_sum" };
}
/** Shared lossless serialization for cache keys and private diagnostics. */
export function serializeStoryMemoryQueryVariant(value: StoryMemoryQueryVariant | LegacyStoryMemoryQueryVariant): string {
  return canonicalJson(readStoryMemoryQueryVariant(value).variant);
}

const basePolicy = {
  version: z.literal("story-memory-v1"),
  queryPlanner: z.literal("balanced-v1"),
  rankAggregation: z.literal("query_family_max_v1"),
  worldResidualShare: z.literal(0.15),
  maximumSemanticRepairs: z.literal(1)
};

export const storyMemoryPolicySchema = z.discriminatedUnion("capability", [
  z.object({
    ...basePolicy, capability: z.literal("r1"), recentTurnTarget: z.literal(1), recentResidualShare: z.literal(0),
    excerptPolicy: z.literal("whole_only"), continuityReview: z.literal("off")
  }).strict(),
  z.object({
    ...basePolicy, capability: z.literal("r2"), recentTurnTarget: z.literal(3), recentResidualShare: z.literal(0.30),
    excerptPolicy: z.enum(["whole_only", "verified_spans_v1"]), continuityReview: z.literal("off")
  }).strict(),
  z.object({
    ...basePolicy, capability: z.literal("r3"), recentTurnTarget: z.literal(3), recentResidualShare: z.literal(0.30),
    excerptPolicy: z.enum(["whole_only", "verified_spans_v1"]), continuityReview: z.enum(["off", "observe", "enforce"])
  }).strict()
]);

export type StoryMemoryPolicy = Readonly<z.infer<typeof storyMemoryPolicySchema>>;
export type StoryMemoryCapability = z.infer<typeof storyMemoryCapabilitySchema>;

export function defaultStoryMemoryPolicy(capability: StoryMemoryCapability): StoryMemoryPolicy {
  const common = { version: "story-memory-v1", queryPlanner: "balanced-v1", rankAggregation: "query_family_max_v1", worldResidualShare: 0.15, maximumSemanticRepairs: 1 } as const;
  if (capability === "r1") return storyMemoryPolicySchema.parse({ ...common, capability, recentTurnTarget: 1, recentResidualShare: 0, excerptPolicy: "whole_only", continuityReview: "off" });
  if (capability === "r2") return storyMemoryPolicySchema.parse({ ...common, capability, recentTurnTarget: 3, recentResidualShare: 0.30, excerptPolicy: "whole_only", continuityReview: "off" });
  return storyMemoryPolicySchema.parse({ ...common, capability, recentTurnTarget: 3, recentResidualShare: 0.30, excerptPolicy: "verified_spans_v1", continuityReview: "observe" });
}

export function storyMemoryPolicyHash(policy: StoryMemoryPolicy): string {
  return sha256Hex(canonicalJson(policy));
}

/**
 * Frozen non-public identity for the provider configuration which materially
 * affects a generation request. The endpoint is already reduced to a hash by
 * the transport/repository boundary; credentials and display labels never
 * participate in this value.
 */
export function effectiveProviderConfigurationFingerprint(input: Readonly<{
  providerId: string;
  providerType: string;
  endpointIdentity: string;
  model: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  temperature: number;
  requestTimeoutMs: number;
  configuration: unknown;
  effectiveContextWindowTokens: number;
  inputSafetyPolicy: "estimated_20_percent_plus_1024";
  displayName?: string;
}>): string {
  const {
    providerId, providerType, endpointIdentity, model, contextWindowTokens,
    maxOutputTokens, temperature, requestTimeoutMs, configuration,
    effectiveContextWindowTokens, inputSafetyPolicy
  } = input;
  return sha256Hex(canonicalJson({
    providerId, providerType, endpointIdentity, model, contextWindowTokens,
    maxOutputTokens, temperature, requestTimeoutMs, configuration,
    effectiveContextWindowTokens, inputSafetyPolicy
  }));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export type StoryMemoryPolicyResolution = Readonly<{ kind: "legacy" }> | Readonly<{ kind: "policy"; policy: StoryMemoryPolicy; policyHash: string }>;

/** Enrolling a campaign is an explicit server-side operation; an install alone is inert. */
export function resolveStoryMemoryPolicy(input: Readonly<{
  installedCapability: StoryMemoryCapability | null;
  campaignEnrollment: StoryMemoryCapability | null;
}>): StoryMemoryPolicyResolution {
  if (!input.campaignEnrollment) return { kind: "legacy" };
  if (!input.installedCapability) {
    throw new Error("Campaign enrollment requires an unavailable Story Memory capability.");
  }
  const capabilities: readonly StoryMemoryCapability[] = ["r1", "r2", "r3"];
  if (capabilities.indexOf(input.campaignEnrollment) > capabilities.indexOf(input.installedCapability)) {
    throw new Error("Campaign enrollment requires an unavailable Story Memory capability.");
  }
  const policy = defaultStoryMemoryPolicy(input.campaignEnrollment);
  return { kind: "policy", policy, policyHash: storyMemoryPolicyHash(policy) };
}

export const storyMemoryPolicySnapshotSchema = z.object({
  policy: storyMemoryPolicySchema,
  policyHash: z.string().regex(/^[a-f0-9]{64}$/),
  contextProtocol: z.literal(STORY_MEMORY_CONTEXT_POLICY_VERSION),
  promptProtocol: z.union([
    z.literal(LEGACY_STORY_MEMORY_PROMPT_PROTOCOL_VERSION),
    z.literal(PREVIOUS_STORY_MEMORY_PROMPT_PROTOCOL_VERSION),
    z.literal(STORY_MEMORY_PROMPT_PROTOCOL_VERSION)
  ]),
  providerConfigurationFingerprint: z.string().regex(/^[a-f0-9]{64}$/)
}).strict().superRefine((value, context) => {
  if (storyMemoryPolicyHash(value.policy) !== value.policyHash) context.addIssue({ code: "custom", path: ["policyHash"], message: "Policy hash does not match the frozen policy." });
});

export type StoryMemoryPolicySnapshot = Readonly<z.infer<typeof storyMemoryPolicySnapshotSchema>>;
