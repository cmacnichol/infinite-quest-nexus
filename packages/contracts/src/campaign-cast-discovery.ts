import { z } from "zod";
import { castCharacterSchema, castFieldSchema, castScopeSchema, castBoundarySchema, castWriteBase, castWriteResultSchema } from "./campaign-cast.js";

export const CAST_DISCOVERY_PROTOCOL = "cast-discovery-v1";
export const castIdentityPolicySchema = z.enum(["strict", "unique_name"]);
export type CastIdentityPolicy = z.infer<typeof castIdentityPolicySchema>;
export const castIdentityBasisSchema = z.enum(["new_identity", "corroborated", "unique_name", "unique_world_name", "user_confirmed"]);
export type CastIdentityBasis = z.infer<typeof castIdentityBasisSchema>;
export const castDiscoveryPromptIdentifierSchema = z.enum(["cast-discovery-prompt-v1", "cast-discovery-prompt-v2"]);
export const castDiscoveryFrozenIdentitySchema = z.object({
  identityPolicy: castIdentityPolicySchema.default("strict"),
  promptIdentifier: castDiscoveryPromptIdentifierSchema.default("cast-discovery-prompt-v1")
}).strict().refine((value) => value.identityPolicy === "strict" ? value.promptIdentifier === "cast-discovery-prompt-v1" : value.promptIdentifier === "cast-discovery-prompt-v2", "Invalid discovery policy and prompt combination.");
export const CAST_DISCOVERY_TIMEOUT_MS = 120000;
export const CAST_DISCOVERY_MAX_OUTPUT_TOKENS = 4096;
// Existing durable jobs retain their original frozen execution policy.
export function isCastDiscoveryTimeout(value: unknown): value is number {
  return value === 30000 || value === CAST_DISCOVERY_TIMEOUT_MS;
}
export const castDiscoveryStatusSchema = z.object({
  enabled: z.boolean(), activeTurnNumber: z.number().int().nonnegative(),
  coverageStartTurn: z.number().int().positive().nullable(), trackedThroughTurn: z.number().int().nonnegative().nullable(),
  state: z.enum(["disabled", "not_enrolled", "catching_up", "failed", "complete"]),
  automaticJobs: z.object({
    queued: z.number().int().nonnegative(), runningTurn: z.number().int().positive().nullable(),
    retryWait: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), complete: z.number().int().nonnegative()
  }).strict().optional(),
  unresolvedCount: z.number().int().nonnegative(),
  firstGap: z.object({ turnNumber: z.number().int().positive(), jobId: z.uuid().nullable(),
    status: z.enum(["missing", "queued", "running", "retry_wait", "failed", "cancelled"]),
    diagnosticCode: z.enum(["admission_unavailable", "provider_timeout", "provider_failed", "invalid_output",
      "source_requires_manual_scan", "publication_failed"]).nullable() }).strict().nullable()
}).strict();
export type CastDiscoveryStatus = z.infer<typeof castDiscoveryStatusSchema>;
const evidence = z.object({ paragraphId: z.string().min(1).max(200), quote: z.string().min(1).max(1000) }).strict();
export const castDiscoveryCandidateSchema = z.object({
  localKey: z.string().min(1).max(100), name: z.string().trim().min(1).max(200),
  aliases: z.array(z.string().trim().min(1).max(200)).max(20), existingCharacterId: z.uuid().nullable(),
  identityEvidence: z.array(evidence).min(1).max(8),
  observations: z.array(evidence.extend({ field: castFieldSchema, value: z.string().min(1).max(2000),
    mode: z.enum(["fact", "claim"]), speakerCharacterId: z.uuid().nullable() }).strict()).max(20)
}).strict();
export const castDiscoveryOutputSchema = z.object({ version: z.literal(1), characters: z.array(castDiscoveryCandidateSchema).max(20) }).strict()
  .refine((value) => new Set(value.characters.map((person) => person.localKey)).size === value.characters.length, "Duplicate local character keys.");
export const castDiscoverySourceSchema = z.object({
  scope: castScopeSchema, turnId: z.uuid(), turnNumber: z.number().int().positive(), narrationRevision: z.number().int().nonnegative(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u), timelineRevision: z.number().int().nonnegative(),
  paragraphs: z.array(z.object({ id: z.string().min(1).max(200), text: z.string().min(1) }).strict()).min(1)
}).strict().refine((value) => new Set(value.paragraphs.map((paragraph) => paragraph.id)).size === value.paragraphs.length,
  "Duplicate source paragraph IDs.");
export type CastDiscoveryCandidate = z.infer<typeof castDiscoveryCandidateSchema>;
export type CastDiscoveryOutput = z.infer<typeof castDiscoveryOutputSchema>;
export type CastDiscoverySource = z.infer<typeof castDiscoverySourceSchema>;

export const castDiscoveryIdentitySnapshotSchema = z.object({
  revision: z.number().int().nonnegative(), characters: z.array(castCharacterSchema), worldVersionId: z.uuid(),
  identityHints: z.array(z.object({ characterId: z.uuid(), hints: z.array(z.string().min(1).max(2000)).max(20) }).strict()).optional(),
  seedActivations: z.array(z.object({ characterId: z.uuid(), seedEventId: z.uuid(), worldVersionId: z.uuid(), entityId: z.string().min(1).max(200) }).strict()).optional(),
  representedWorldCharacters: z.array(z.object({ characterId: z.uuid(), entityId: z.string().min(1).max(200), name: z.string().min(1).max(200),
    aliases: z.array(z.string().min(1).max(200)).max(20), identityHints: z.array(z.string().min(1).max(2000)).max(20).optional() }).strict()).optional(),
  worldCharacters: z.array(z.object({ entityId: z.string().min(1).max(200), name: z.string().min(1).max(200),
    aliases: z.array(z.string().min(1).max(200)).max(20), identityHints: z.array(z.string().min(1).max(2000)).max(20).optional() }).strict())
}).strict();
export type CastDiscoveryIdentitySnapshot = z.infer<typeof castDiscoveryIdentitySnapshotSchema>;

export const retryCastDiscoverySchema = z.object(castWriteBase).strict();
export const castDiscoveryRetryResultSchema = z.object({ jobId: z.uuid(), retryGeneration: z.number().int().positive() }).strict();
export type RetryCastDiscovery = z.infer<typeof retryCastDiscoverySchema>;
export type CastDiscoveryRetryResult = z.infer<typeof castDiscoveryRetryResultSchema>;

export const castCandidateQuerySchema = z.object({ cursor: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(50).default(20),
  view: z.enum(["all", "matches", "details", "review"]).default("all") }).strict();
export const castPendingCandidateSchema = z.object({ id: z.uuid(), reason: z.string().min(1).max(100), proposal: castDiscoveryCandidateSchema,
  resolvedCharacterId: z.uuid().optional(), suggestedCharacterId: z.uuid().optional(),
  details: z.array(z.object({ observationIndex: z.number().int().min(0).max(19), field: castFieldSchema,
    value: z.string().max(2000), quote: z.string().max(1000), reason: z.string(), canAcceptObservation: z.boolean().optional(), allowedActions: z.array(z.enum(["accept", "confirm", "dismiss"])).optional(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()).optional(),
  source: z.object({ turnId: z.uuid(), turnNumber: z.number().int().positive(), narrationRevision: z.number().int().nonnegative(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/u).optional() }).strict() }).strict();
export const castCandidateListSchema = z.object({ revision: z.number().int().nonnegative(), boundary: castBoundarySchema,
  candidates: z.array(castPendingCandidateSchema).max(50), nextCursor: z.uuid().nullable() }).strict();
export const resolveCastCandidateSchema = z.discriminatedUnion("action", [
  z.object({ ...castWriteBase, action: z.literal("attach"), characterId: z.uuid() }).strict(),
  z.object({ ...castWriteBase, action: z.literal("create") }).strict()
]);
export const castCandidateResolutionSchema = castWriteResultSchema.extend({ candidateId: z.uuid(), observationIds: z.array(z.uuid()).max(20),
  pendingObservations: z.array(z.object({ index: z.number().int().min(0).max(19), reason: z.string().min(1).max(100) }).strict()).max(20).optional() });
export type CastCandidateQuery = z.infer<typeof castCandidateQuerySchema>;
export type CastCandidateList = z.infer<typeof castCandidateListSchema>;
export type ResolveCastCandidate = z.infer<typeof resolveCastCandidateSchema>;
export type CastCandidateResolution = z.infer<typeof castCandidateResolutionSchema>;

const reviewDetailBase = { ...castWriteBase, expectedCharacterRevision: z.number().int().nonnegative(),
  observationIndex: z.number().int().min(0).max(19), sourceHash: z.string().regex(/^[a-f0-9]{64}$/u) };
export const reviewCastDetailSchema = z.discriminatedUnion("action", [
  z.object({ ...reviewDetailBase, action: z.literal("confirm"), confirmedValue: z.string().max(2000).optional() }).strict(),
  z.object({ ...reviewDetailBase, action: z.literal("accept") }).strict(),
  z.object({ ...reviewDetailBase, action: z.literal("dismiss") }).strict()
]);
export const reviewCastDetailResultSchema = castWriteResultSchema.extend({ candidateId: z.uuid(), observationIndex: z.number().int().min(0).max(19), disposition: z.enum(["confirm", "accept", "dismiss"]), observationId: z.uuid().optional() });
export type ReviewCastDetail = z.infer<typeof reviewCastDetailSchema>;
export type ReviewCastDetailResult = z.infer<typeof reviewCastDetailResultSchema>;
