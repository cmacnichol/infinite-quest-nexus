import { z } from "zod";
import { castCharacterSchema, castFieldSchema, castScopeSchema, castBoundarySchema, castWriteBase, castWriteResultSchema } from "./campaign-cast.js";

export const CAST_DISCOVERY_PROTOCOL = "cast-discovery-v1";
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
  worldCharacters: z.array(z.object({ entityId: z.string().min(1).max(200), name: z.string().min(1).max(200),
    aliases: z.array(z.string().min(1).max(200)).max(20), identityHints: z.array(z.string().min(1).max(2000)).max(20).optional() }).strict())
}).strict();
export type CastDiscoveryIdentitySnapshot = z.infer<typeof castDiscoveryIdentitySnapshotSchema>;

export const retryCastDiscoverySchema = z.object(castWriteBase).strict();
export const castDiscoveryRetryResultSchema = z.object({ jobId: z.uuid(), retryGeneration: z.number().int().positive() }).strict();
export type RetryCastDiscovery = z.infer<typeof retryCastDiscoverySchema>;
export type CastDiscoveryRetryResult = z.infer<typeof castDiscoveryRetryResultSchema>;

export const castCandidateQuerySchema = z.object({ cursor: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(50).default(20),
  view: z.enum(["all", "matches"]).default("all") }).strict();
export const castPendingCandidateSchema = z.object({ id: z.uuid(), reason: z.string().min(1).max(100), proposal: castDiscoveryCandidateSchema,
  resolvedCharacterId: z.uuid().optional(),
  source: z.object({ turnId: z.uuid(), turnNumber: z.number().int().positive(), narrationRevision: z.number().int().nonnegative() }).strict() }).strict();
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
