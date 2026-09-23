import { z } from "zod";

const ordinal = z.number().int().nonnegative();
const name = z.string().trim().min(1).max(200);
export const castScopeSchema = z.object({ ownerUserId: z.uuid(), campaignId: z.uuid() }).strict();
export const castBoundarySchema = z.object({ turnNumber: ordinal, timelineRevision: ordinal }).strict();
export const castOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }).strict(),
  z.object({ kind: z.literal("discovered") }).strict(),
  z.object({ kind: z.literal("world"), worldVersionId: z.uuid(), entityId: name }).strict(),
  z.object({ kind: z.literal("protagonist"), selectedCharacterId: name.nullable() }).strict()
]);
export const castFieldSchema = z.enum([
  "identity.pronouns", "story.role", "story.background", "story.personality",
  "story.motivations", "story.goals", "story.voiceAndMannerisms", "appearance.description",
  "state.location", "state.condition", "state.clothing"
]);
export const castEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("turn"), turnId: z.uuid(), turnNumber: ordinal.min(1),
    narrationRevision: ordinal, sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
    paragraphId: name, quote: z.string().min(1).max(1000) }).strict(),
  z.object({ kind: z.literal("user"), editId: z.uuid(), effectiveTurnNumber: ordinal }).strict(),
  z.object({ kind: z.literal("world"), worldVersionId: z.uuid(), sourcePath: z.string().min(1).max(500).startsWith("/") }).strict()
]);
export const castProfileSchema = z.partialRecord(castFieldSchema, z.string().max(2000));
export const castObservationSchema = z.object({
  id: z.uuid(), characterId: z.uuid(), field: castFieldSchema, value: z.string().min(1).max(2000),
  mode: z.enum(["fact", "claim"]), speakerCharacterId: z.uuid().nullable(),
  evidence: castEvidenceSchema, supersedesObservationId: z.uuid().nullable()
}).strict();
export const castOverrideSchema = z.object({
  field: castFieldSchema, value: z.string().max(2000),
  evidence: castEvidenceSchema
}).strict().refine((value) => value.evidence.kind === "user", "Overrides require user evidence.");
export const castCharacterSchema = z.object({
  id: z.uuid(), name, aliases: z.array(name).max(20), origin: castOriginSchema,
  profile: castProfileSchema, pinned: z.boolean(), ignored: z.boolean(), revision: ordinal,
  firstObservedTurn: ordinal, lastObservedTurn: ordinal
}).strict().refine((value) => value.lastObservedTurn >= value.firstObservedTurn, "Invalid character chronology.");
export const castSnapshotSchema = z.object({
  revision: ordinal, boundary: castBoundarySchema, characters: z.array(castCharacterSchema),
  trackedThroughTurn: ordinal, coverageStartTurn: ordinal,
  discoveryStatus: z.enum(["off", "current", "pending", "failed"])
}).strict();

export type CastScope = z.infer<typeof castScopeSchema>;
export type CastBoundary = z.infer<typeof castBoundarySchema>;
export type CastOrigin = z.infer<typeof castOriginSchema>;
export type CastField = z.infer<typeof castFieldSchema>;
export type CastEvidence = z.infer<typeof castEvidenceSchema>;
export type CastObservation = z.infer<typeof castObservationSchema>;
export type CastOverride = z.infer<typeof castOverrideSchema>;
export type CastProfile = z.infer<typeof castProfileSchema>;
export type CastCharacter = z.infer<typeof castCharacterSchema>;
export type CastSnapshot = z.infer<typeof castSnapshotSchema>;

/** Internal persistence commands; no HTTP mutation route is enabled in phase 01. */
export const castCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), name, aliases: z.array(name).max(20), origin: castOriginSchema,
    evidence: castEvidenceSchema.optional() }).strict(),
  z.object({ kind: z.literal("observe"), ...castObservationSchema.omit({ id: true }).shape }).strict(),
  z.object({ kind: z.literal("override"), characterId: z.uuid(), field: castFieldSchema, value: z.string().max(2000) }).strict(),
  z.object({ kind: z.literal("clear_override"), characterId: z.uuid(), field: castFieldSchema }).strict(),
  z.object({ kind: z.literal("identity"), characterId: z.uuid(), name, aliases: z.array(name).max(20) }).strict(),
  z.object({ kind: z.literal("pin"), characterId: z.uuid(), value: z.boolean() }).strict(),
  z.object({ kind: z.literal("ignore"), characterId: z.uuid(), value: z.boolean() }).strict()
]);
export const castBatchSchema = z.object({
  boundary: castBoundarySchema, idempotencyKey: z.string().min(1).max(200),
  commands: z.array(castCommandSchema).min(1).max(100)
}).strict();
export const castBatchReceiptSchema = z.object({
  eventId: z.uuid(), revision: ordinal, characterIds: z.array(z.uuid()), observationIds: z.array(z.uuid())
}).strict();
export type CastCommand = z.infer<typeof castCommandSchema>;
export type CastBatch = z.infer<typeof castBatchSchema>;
export type CastBatchReceipt = z.infer<typeof castBatchReceiptSchema>;
