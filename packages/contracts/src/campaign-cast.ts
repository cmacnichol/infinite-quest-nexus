import { z } from "zod";

const ordinal = z.number().int().nonnegative();
const name = z.string().trim().min(1).max(200);
export const castScopeSchema = z.object({ ownerUserId: z.uuid(), campaignId: z.uuid() }).strict();
export const castBoundarySchema = z.object({ turnNumber: ordinal, timelineRevision: ordinal }).strict();
export const castOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }).strict(),
  z.object({ kind: z.literal("discovered") }).strict(),
  z.object({ kind: z.literal("world"), worldVersionId: z.uuid(), entityId: name }).strict(),
  z.object({ kind: z.literal("historical_world"), sourceWorldVersionId: z.uuid(), entityId: name }).strict(),
  z.object({ kind: z.literal("protagonist"), selectedCharacterId: name.nullable() }).strict()
]);
export const castFieldSchema = z.enum([
  "identity.pronouns", "story.role", "story.background", "story.personality",
  "story.motivations", "story.goals", "story.voiceAndMannerisms", "appearance.description",
  "state.location", "state.condition", "state.clothing"
]);
export const castEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("turn"), turnId: z.uuid(), turnNumber: ordinal.min(1),
    invalidated: z.literal(true).optional(),
    narrationRevision: ordinal, sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
    paragraphId: name, quote: z.string().min(1).max(1000) }).strict(),
  z.object({ kind: z.literal("user"), editId: z.uuid(), effectiveTurnNumber: ordinal }).strict(),
  z.object({ kind: z.literal("world"), worldVersionId: z.uuid(), sourcePath: z.string().min(1).max(500).startsWith("/") }).strict(),
  z.object({ kind: z.literal("historical_world"), sourceWorldVersionId: z.uuid(), sourcePath: z.string().min(1).max(500).startsWith("/") }).strict()
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
  revision: ordinal, boundary: castBoundarySchema, characters: z.array(castCharacterSchema)
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

/** Internal evidence commands; public editing accepts only the narrower write schemas below. */
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
  eventId: z.uuid(), revision: ordinal, characterIds: z.array(z.uuid()), observationIds: z.array(z.uuid()),
  result: z.object({ character: castCharacterSchema, revision: ordinal, boundary: castBoundarySchema }).strict().optional()
}).strict();
export type CastCommand = z.infer<typeof castCommandSchema>;
export type CastBatch = z.infer<typeof castBatchSchema>;
export type CastBatchReceipt = z.infer<typeof castBatchReceiptSchema>;

const castWriteBase = {
  expectedCastRevision: ordinal, expectedBoundary: castBoundarySchema,
  idempotencyKey: z.string().min(1).max(200)
};
export const createCastCharacterSchema = z.object({ ...castWriteBase, name,
  aliases: z.array(name).max(20), profile: castProfileSchema }).strict();
export const editCastCharacterSchema = z.object({ ...castWriteBase,
  expectedCharacterRevision: ordinal, name: name.optional(), aliases: z.array(name).max(20).optional(),
  setOverrides: castProfileSchema.optional(), clearOverrides: z.array(castFieldSchema).max(11).optional(),
  pinned: z.boolean().optional(), ignored: z.boolean().optional()
}).strict().refine((value) => !value.clearOverrides?.some((field) => Object.hasOwn(value.setOverrides ?? {}, field)),
  "Cannot set and clear the same override.").refine((value) => value.name !== undefined || value.aliases !== undefined
    || Object.keys(value.setOverrides ?? {}).length > 0 || (value.clearOverrides?.length ?? 0) > 0
    || value.pinned !== undefined || value.ignored !== undefined, "An edit must change at least one field.");
export const castWriteResultSchema = z.object({ character: castCharacterSchema, revision: ordinal, boundary: castBoundarySchema }).strict();
export const castListQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(50),
  cursor: z.uuid().optional(), query: z.string().trim().max(200).default("") }).strict();
export const castDetailSchema = castWriteResultSchema.extend({ observations: z.array(castObservationSchema),
  overrides: z.array(castOverrideSchema), identityEvents: z.array(z.object({
    eventId: z.uuid(), effectiveTurnNumber: ordinal, name, aliases: z.array(name).max(20), evidence: castEvidenceSchema
  }).strict()), unresolvedCandidateIds: z.array(z.uuid()), editorDestination: z.string().nullable() });
export type CreateCastCharacter = z.infer<typeof createCastCharacterSchema>;
export type EditCastCharacter = z.infer<typeof editCastCharacterSchema>;
export type CastWriteResult = z.infer<typeof castWriteResultSchema>;
export type CastDetail = z.infer<typeof castDetailSchema>;
export type CastListQuery = z.infer<typeof castListQuerySchema>;

export const castStoredCommandSchema = z.object({ command: castCommandSchema, characterId: z.uuid().optional(), observationId: z.uuid().optional() }).strict();
export const portableCampaignCastSchema = z.object({
  formatVersion: z.literal(1), revision: ordinal,
  characters: z.array(z.object({ id: z.uuid(), origin: castOriginSchema, firstObservedTurn: ordinal }).strict()).max(10000),
  events: z.array(z.object({ id: z.uuid(), effectiveTurnNumber: ordinal, revision: ordinal,
    commands: z.array(castStoredCommandSchema).min(1).max(100) }).strict()).max(100000)
}).strict().superRefine((value, context) => {
  const characters = new Map(value.characters.map((person) => [person.id, person]));
  const events = new Set(value.events.map((event) => event.id));
  const observations = new Set<string>(), created = new Set<string>();
  const fail = () => context.addIssue({ code: "custom", message: "Invalid cast archive relationships." });
  if (characters.size !== value.characters.length || events.size !== value.events.length
    || value.characters.filter((person) => person.origin.kind === "protagonist").length > 1) fail();
  for (const event of value.events) for (const item of event.commands) {
    const command = item.command;
    if ((command.kind === "create" || command.kind === "observe") && command.evidence?.kind === "turn"
      && command.evidence.turnNumber > event.effectiveTurnNumber) fail();
    if (command.kind === "create") {
      const person = item.characterId ? characters.get(item.characterId) : undefined;
      const firstObservedTurn = command.evidence?.kind === "turn" ? command.evidence.turnNumber : event.effectiveTurnNumber;
      if (person?.firstObservedTurn !== firstObservedTurn || command.origin.kind === "protagonist"
        || command.origin.kind === "manual" && command.evidence !== undefined
        || command.origin.kind === "discovered" && command.evidence?.kind !== "turn") fail();
      if (!item.characterId || !characters.has(item.characterId) || created.has(item.characterId)
        || JSON.stringify(characters.get(item.characterId)?.origin) !== JSON.stringify(command.origin)) fail();
      else created.add(item.characterId);
    } else {
      const protagonistEvidence = command.kind === "observe" && characters.get(command.characterId)?.origin.kind === "protagonist";
      if (!characters.has(command.characterId) || !created.has(command.characterId) && !protagonistEvidence
        || characters.get(command.characterId)!.firstObservedTurn > event.effectiveTurnNumber) fail();
      if (command.kind === "observe") {
        if (command.evidence.kind === "turn" && command.evidence.invalidated) fail();
        if (!item.observationId || observations.has(item.observationId)
          || command.speakerCharacterId && !characters.has(command.speakerCharacterId)
          || command.supersedesObservationId && !observations.has(command.supersedesObservationId)) fail();
        if (item.observationId) observations.add(item.observationId);
      }
    }
  }
  if (value.characters.some((person) => person.origin.kind !== "protagonist" && !created.has(person.id))) fail();
});
export type PortableCampaignCast = z.infer<typeof portableCampaignCastSchema>;

export function portableCastReferences(cast: PortableCampaignCast): { turns: string[]; worlds: string[] } {
  const turns = new Set<string>(), worlds = new Set<string>();
  for (const person of cast.characters) if (person.origin.kind === "world") worlds.add(person.origin.worldVersionId);
  for (const event of cast.events) for (const { command } of event.commands) {
    if ((command.kind !== "create" && command.kind !== "observe") || !command.evidence) continue;
    if (command.evidence.kind === "turn" && !command.evidence.invalidated) turns.add(command.evidence.turnId);
    if (command.evidence.kind === "world") worlds.add(command.evidence.worldVersionId);
  }
  return { turns: [...turns], worlds: [...worlds] };
}
