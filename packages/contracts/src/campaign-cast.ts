import { z } from "zod";
import { characterProfileSchema } from "./world-library.js";

const ordinal = z.number().int().nonnegative();
const name = z.string().trim().min(1).max(200);
export const normalizeCastAlias = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
export function castAliasDelta(before: readonly string[], after: readonly string[]) {
  const old = new Set(before.map(normalizeCastAlias)), next = new Set(after.map(normalizeCastAlias));
  return { added: after.filter(alias => !old.has(normalizeCastAlias(alias))), removed: before.filter(alias => !next.has(normalizeCastAlias(alias))) };
}
export function applyCastAliasDelta(before: readonly string[], delta: { added: readonly string[]; removed: readonly string[] }): string[] {
  const removed = new Set(delta.removed.map(normalizeCastAlias));
  const aliases = before.filter(alias => !removed.has(normalizeCastAlias(alias)));
  for (const alias of delta.added) if (!aliases.some(existing => normalizeCastAlias(existing) === normalizeCastAlias(alias))) aliases.push(alias);
  return aliases;
}
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
export const castSourceRangeSchema = z.object({ turnId: z.uuid(), narrationRevision: ordinal,
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u), paragraphId: name,
  start: ordinal, end: ordinal }).strict().refine((range) => range.end > range.start);
export const castAttachmentSchema = z.object({ eventId: z.uuid(), characterId: z.uuid(),
  basis: z.enum(["unique_name", "unique_world_name"]), sourceRanges: z.array(castSourceRangeSchema).min(1),
  observationIds: z.array(z.uuid()) }).strict();
export type CastSourceRange = z.infer<typeof castSourceRangeSchema>;
export type CastAttachment = z.infer<typeof castAttachmentSchema>;
export const castProfileSchema = z.partialRecord(castFieldSchema, z.string().max(2000));
/** Full detail values are distinct from 2,000-character observation and override inputs. */
export const castDetailProfileSchema = z.partialRecord(castFieldSchema, z.string().max(20_000)).superRefine((profile, context) => {
  for (const [field, value] of Object.entries(profile)) if ((field === "identity.pronouns" || field.startsWith("state.") || field === "appearance.description") && value.length > 2_000)
    context.addIssue({ code: "custom", path: [field], message: "Field exceeds 2,000 characters." });
});
export const castOverrideProfileSchema = z.partialRecord(castFieldSchema, z.string().max(20_000)).superRefine((profile, context) => {
  for (const [field, value] of Object.entries(profile)) {
    if (field !== "story.goals" && value.length > 2_000) context.addIssue({ code: "custom", path: [field], message: "Override exceeds field limit." });
    if (!value.trim() && (field === "story.goals" || field.startsWith("state."))) context.addIssue({ code: "custom", path: [field], message: "Clear this override instead of saving it empty." });
  }
});
export const castRosterSummaryProfileSchema = z.partialRecord(castFieldSchema, z.string().max(200));
export const castObservationSchema = z.object({
  id: z.uuid(), characterId: z.uuid(), field: castFieldSchema, value: z.string().min(1).max(2000),
  mode: z.enum(["fact", "claim"]), speakerCharacterId: z.uuid().nullable(),
  evidence: castEvidenceSchema, supersedesObservationId: z.uuid().nullable()
}).strict();
export const castOverrideSchema = z.object({
  field: castFieldSchema, value: z.string().max(20_000),
  evidence: castEvidenceSchema
}).strict().refine((value) => value.evidence.kind === "user", "Overrides require user evidence.")
  .refine((value) => value.field === "story.goals" || value.value.length <= 2000, "Override exceeds field limit.");
export const castAuthoredPathSchema = z.enum([
  "identity.pronouns", "story.role", "story.background", "story.personality", "story.motivations",
  "story.fearsAndConflicts", "story.keyRelationships", "story.narrativeHooks", "story.voiceAndMannerisms", "story.otherGuidance",
  "appearance.ancestryOrSpecies", "appearance.apparentAge", "appearance.genderPresentation", "appearance.build",
  "appearance.skinOrComplexion", "appearance.face", "appearance.eyes", "appearance.hair", "appearance.distinguishingFeatures",
  "appearance.clothing", "appearance.equipmentAndAccessories", "appearance.otherVisualDetails", "unclassifiedNotes"
]);
// These edits are also accepted from portable archives, independently of the HTTP writer.
export const castAuthoredValuesSchema = z.partialRecord(castAuthoredPathSchema,
  z.union([z.string().max(200_000), z.array(z.string().min(1).max(2_000)).max(50)])).superRefine((fields, ctx) => {
  for (const [path, value] of Object.entries(fields)) {
    const [section, key] = path.split(".");
    const strings = Array.isArray(value) ? value : [value];
    // PostgreSQL JSONB stores Unicode scalar values and cannot represent a NUL character.
    if (strings.some(text => /[\u0000\uD800-\uDFFF]/u.test(text))
      || (path === "appearance.distinguishingFeatures") !== Array.isArray(value)
      || !characterProfileSchema.safeParse(key ? { [section!]: { [key]: value } } : { [section!]: value }).success) {
      ctx.addIssue({ code: "custom", path: [path], message: "Invalid authored field." });
    }
  }
});
export const castSeedProfileSchema = z.object({ seedEventId: z.uuid(), worldVersionId: z.uuid(), entityId: name,
  rosterName: name, rosterAliases: z.array(name).max(20), legacyCharacterText: z.string().max(200_000),
  profile: characterProfileSchema, evidence: z.discriminatedUnion("kind", [castEvidenceSchema.options[2], castEvidenceSchema.options[3]]) }).strict();
export const castCharacterSchema = z.object({
  id: z.uuid(), name, aliases: z.array(name).max(20), origin: castOriginSchema,
  profile: castDetailProfileSchema, originProfile: castSeedProfileSchema.optional(), campaignProfile: characterProfileSchema.optional(),
  fieldSources: z.partialRecord(z.enum([...castFieldSchema.options, ...castAuthoredPathSchema.options]), z.enum(["authored", "campaign_edit", "observation", "override", "none"])).optional(), pinned: z.boolean(), ignored: z.boolean(), removed: z.boolean().optional(), mergedIntoCharacterId: z.uuid().nullable().optional(), activeMerges: z.array(z.object({ mergeEventId: z.uuid(), sourceCharacterId: z.uuid(), sourceName: name, canUndo: z.boolean() }).strict()).optional(), revision: ordinal,
  firstObservedTurn: ordinal, lastObservedTurn: ordinal, lastMentionedTurn: ordinal.nullable().default(null)
}).strict().refine((value) => value.lastObservedTurn >= value.firstObservedTurn, "Invalid character chronology.");
/** List readers may receive full legacy rows. Compact them at this boundary; never use summaries for editing. */
export const castRosterCharacterSchema = castCharacterSchema.transform(({ originProfile, campaignProfile, fieldSources, profile, ...row }) => ({
  ...row, profile: castRosterSummaryProfileSchema.parse(Object.fromEntries(Object.entries(profile).map(([field, value]) => [field, value.slice(0, 200)])))
}));
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
export type CastProfile = z.infer<typeof castDetailProfileSchema>;
export type CastCharacter = z.input<typeof castCharacterSchema>;
export type CastSnapshot = z.infer<typeof castSnapshotSchema>;

/** Internal evidence commands; public editing accepts only the narrower write schemas below. */
export const castCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), name, aliases: z.array(name).max(20), origin: castOriginSchema,
    evidence: castEvidenceSchema.optional() }).strict(),
  z.object({ kind: z.literal("observe"), ...castObservationSchema.omit({ id: true }).shape }).strict(),
  z.object({ kind: z.literal("mention"), characterId: z.uuid(), evidence: castEvidenceSchema.options[0], kindOfMention: z.literal("lexical").optional(), sourceRange: castSourceRangeSchema.optional() }).strict().refine((item) => (item.kindOfMention === "lexical") === (item.sourceRange !== undefined)),
  z.object({ kind: z.literal("seed_profile"), characterId: z.uuid(), worldVersionId: z.uuid(), entityId: name,
    rosterName: name, rosterAliases: z.array(name).max(20), legacyCharacterText: z.string().max(200_000),
    profile: characterProfileSchema, evidence: z.discriminatedUnion("kind", [castEvidenceSchema.options[2], castEvidenceSchema.options[3]]) }).strict(),
  z.object({ kind: z.literal("edit_authored_profile"), characterId: z.uuid(), seedEventId: z.uuid(),
    set: castAuthoredValuesSchema, reset: z.array(castAuthoredPathSchema).max(30),
    restoreAuthoredGoals: z.literal(true).optional() }).strict(),
  z.object({ kind: z.literal("detach"), characterId: z.uuid(), eventId: z.uuid() }).strict(),
  z.object({ kind: z.literal("override"), characterId: z.uuid(), field: castFieldSchema, value: z.string().max(20_000) }).strict().refine((value) => value.field === "story.goals" || value.value.length <= 2000),
  z.object({ kind: z.literal("clear_override"), characterId: z.uuid(), field: castFieldSchema }).strict(),
  z.object({ kind: z.literal("identity"), characterId: z.uuid(), name, aliases: z.array(name).max(20), aliasChanges: z.object({ added: z.array(name).max(20), removed: z.array(name).max(20) }).strict().optional() }).strict(),
  z.object({ kind: z.literal("merge"), characterId: z.uuid(), sourceCharacterId: z.uuid(), reviewedAliases: z.array(name).max(20), choices: z.partialRecord(z.enum([...new Set([...castFieldSchema.options, ...castAuthoredPathSchema.options])]), z.enum(["source", "target"])), aliasChanges: z.object({ priorTargetAliases: z.array(name).max(20), added: z.array(name).max(20), removed: z.array(name).max(20) }).strict() }).strict().refine(value => value.characterId !== value.sourceCharacterId),
  z.object({ kind: z.literal("unmerge"), characterId: z.uuid(), mergeEventId: z.uuid() }).strict(),
  z.object({ kind: z.literal("remove"), characterId: z.uuid() }).strict(),
  z.object({ kind: z.literal("restore"), characterId: z.uuid() }).strict(),
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

export const castWriteBase = {
  expectedCastRevision: ordinal, expectedBoundary: castBoundarySchema,
  idempotencyKey: z.string().min(1).max(200)
};
export const castDraftEvidenceSchema = z.object({ evidenceId: z.uuid(), characterId: z.uuid(), turnId: z.uuid(), turnNumber: ordinal,
  narrationRevision: ordinal, sourceHash: z.string().regex(/^[a-f0-9]{64}$/u), paragraphId: name,
  start: ordinal, end: ordinal, quote: z.string().min(1).max(1000) }).strict().refine(item => item.end > item.start);
export const castDraftEvidenceFenceSchema = z.object({ path: z.string().min(1).max(200), value: z.string().min(1).max(20_000),
  evidence: z.array(castDraftEvidenceSchema).min(1).max(40) }).strict();
export const castDraftEvidenceFencesSchema = z.array(castDraftEvidenceFenceSchema).max(30).refine(fences =>
  fences.reduce((sum, fence) => sum + fence.evidence.length, 0) <= 40
  && fences.reduce((sum, fence) => sum + fence.evidence.reduce((total, item) => total + item.quote.length, 0), 0) <= 24_000,
  "Draft evidence exceeds the citation limit.");
export const castDraftPreviewRequestSchema = z.object({ expectedCastRevision: ordinal, expectedBoundary: castBoundarySchema,
  expectedCharacterRevision: ordinal, direction: z.string().max(2000).optional() }).strict();
export const castDraftPreviewResponseSchema = z.object({ boundary: castBoundarySchema, characterRevision: ordinal,
  proposals: z.array(z.object({ path: z.string().min(1).max(200), value: z.string().min(1).max(20_000), evidenceIds: z.array(z.uuid()).max(40),
    draftEvidenceFence: castDraftEvidenceFenceSchema.optional() }).strict()).max(30), evidence: z.array(castDraftEvidenceSchema).max(40),
  omitted: z.array(z.object({ path: z.string().max(200), reason: z.string().max(100) }).strict()).max(30) }).strict();
export type CastDraftEvidenceFence = z.infer<typeof castDraftEvidenceFenceSchema>;
export type CastDraftPreviewRequest = z.infer<typeof castDraftPreviewRequestSchema>;
export type CastDraftPreviewResponse = z.infer<typeof castDraftPreviewResponseSchema>;
export const createCastCharacterSchema = z.object({ ...castWriteBase, name,
  aliases: z.array(name).max(20), profile: castOverrideProfileSchema }).strict();
export const editCastCharacterSchema = z.object({ ...castWriteBase,
  expectedCharacterRevision: ordinal, name: name.optional(), aliases: z.array(name).max(20).optional(),
  setOverrides: castOverrideProfileSchema.optional(), clearOverrides: z.array(castFieldSchema).max(11).optional(),
  pinned: z.boolean().optional(), ignored: z.boolean().optional(), draftEvidenceFences: castDraftEvidenceFencesSchema.optional()
}).strict().refine((value) => !value.clearOverrides?.some((field) => Object.hasOwn(value.setOverrides ?? {}, field)),
  "Cannot set and clear the same override.").refine((value) => value.name !== undefined || value.aliases !== undefined
    || Object.keys(value.setOverrides ?? {}).length > 0 || (value.clearOverrides?.length ?? 0) > 0
    || value.pinned !== undefined || value.ignored !== undefined, "An edit must change at least one field.");
export const castLifecycleChangeSchema = z.object({ ...castWriteBase, expectedCharacterRevision: ordinal }).strict();
export type CastLifecycleChange = z.infer<typeof castLifecycleChangeSchema>;
export const detachCastAttachmentSchema = z.object({ ...castWriteBase, expectedCharacterRevision: ordinal }).strict();
export type DetachCastAttachment = z.infer<typeof detachCastAttachmentSchema>;
export const castWriteResultSchema = z.object({ character: castCharacterSchema, revision: ordinal, boundary: castBoundarySchema }).strict();
export const detachCastAttachmentResultSchema = castWriteResultSchema.extend({ detachedEventId: z.uuid() });
export type DetachCastAttachmentResult = z.infer<typeof detachCastAttachmentResultSchema>;
export const castListQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(50),
  cursor: z.uuid().optional(), query: z.string().trim().max(200).default(""),
  filter: z.enum(["all", "main", "recent", "pinned", "needs_review", "conflicts", "ignored", "removed"]).default("all"),
  expectedRevision: z.coerce.number().int().nonnegative().optional(),
  expectedTurnNumber: z.coerce.number().int().nonnegative().optional(),
  expectedTimelineRevision: z.coerce.number().int().nonnegative().optional() }).strict();
export const castDetailSchema = castWriteResultSchema.extend({ draftFromStoryEligible: z.boolean().optional(), observations: z.array(castObservationSchema),
  overrides: z.array(castOverrideSchema), autoMatches: z.array(castAttachmentSchema.extend({ turnNumber: ordinal, quote: z.string() })).default([]), identityEvents: z.array(z.object({
    eventId: z.uuid(), effectiveTurnNumber: ordinal, name, aliases: z.array(name).max(20), evidence: castEvidenceSchema
  }).strict()), authoredHistory: z.array(z.object({ eventId: z.uuid(), seedEventId: z.uuid(), effectiveTurnNumber: ordinal,
    set: castAuthoredValuesSchema, reset: z.array(castAuthoredPathSchema).max(30) }).strict()).optional(),
  unresolvedCandidateIds: z.array(z.uuid()), editorDestination: z.string().nullable() });
export type CreateCastCharacter = z.infer<typeof createCastCharacterSchema>;
export type EditCastCharacter = z.infer<typeof editCastCharacterSchema>;
export type CastWriteResult = z.infer<typeof castWriteResultSchema>;
export type CastDetail = z.infer<typeof castDetailSchema>;
export type CastListQuery = z.infer<typeof castListQuerySchema>;

export const castStoredCommandSchema = z.object({ command: castCommandSchema, characterId: z.uuid().optional(), observationId: z.uuid().optional() }).strict();
export const portableCampaignCastSchema = z.object({
  formatVersion: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]), revision: ordinal,
  characters: z.array(z.object({ id: z.uuid(), origin: castOriginSchema, firstObservedTurn: ordinal }).strict()).max(10000),
  events: z.array(z.object({ id: z.uuid(), effectiveTurnNumber: ordinal, revision: ordinal,
    receipt: castBatchReceiptSchema.optional(), commands: z.array(castStoredCommandSchema).min(1).max(100), attachment: castAttachmentSchema.optional() }).strict()).max(100000)
}).strict().superRefine((value, context) => {
  const characters = new Map(value.characters.map((person) => [person.id, person]));
  const events = new Set(value.events.map((event) => event.id));
  const observations = new Set<string>(), created = new Set<string>();
  const fail = () => context.addIssue({ code: "custom", message: "Invalid cast archive relationships." });
  if (characters.size !== value.characters.length || events.size !== value.events.length
    || value.characters.filter((person) => person.origin.kind === "protagonist").length > 1) fail();
  const attachments = new Map<string, CastAttachment>();
  const seeds = new Map<string, string>();
  const seedCommands = new Map<string, Extract<CastCommand, { kind: "seed_profile" }>>();
  const canonical = (item: unknown): string => Array.isArray(item) ? `[${item.map(canonical).join(",")}]`
    : item && typeof item === "object" ? `{${Object.entries(item).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`).join(",")}}` : JSON.stringify(item);
  const detached = new Set<string>();
  const activeMerges = new Map<string, { target: string; source: string; order: number }>();
  let lastLifecycleTurn = 0;
  const removed = new Set<string>();
  const currentNames = new Map<string, string>();
  type AliasOperation = { eventId: string; aliases: string[]; delta?: { added: string[]; removed: string[] }; mergeOwned: boolean };
  const aliasHistory = new Map<string, AliasOperation[]>(), currentAliases = new Map<string, string[]>(), undoneAliases = new Set<string>();
  const replayAliases = (characterId: string) => {
    let aliases: string[] = [];
    for (const operation of aliasHistory.get(characterId) ?? []) {
      if (operation.mergeOwned && undoneAliases.has(operation.eventId)) continue;
      aliases = operation.delta ? applyCastAliasDelta(aliases, operation.delta) : operation.aliases;
    }
    currentAliases.set(characterId, aliases);
  };
  for (const [order, event] of value.events.entries()) {
    const receipt = event.receipt;
    const merges = event.commands.filter(item => item.command.kind === "merge");
    const undo = event.commands.find(item => item.command.kind === "unmerge")?.command;
    if (undo?.kind === "unmerge" && (event.commands[0]?.command !== undo || event.commands.slice(1).some(({ command }) =>
      command.kind !== "identity" || command.characterId !== undo.characterId))) fail();
    if (merges.length) {
      const merge = merges[0]!.command;
      const identities = event.commands.filter(item => item.command.kind === "identity");
      if (merges.length !== 1 || merge.kind !== "merge" || event.commands.some(({ command }) => command !== merge
        && (!("characterId" in command) || command.characterId !== merge.characterId || !["identity", "override", "edit_authored_profile"].includes(command.kind)))
        || identities.length !== 1 || identities[0]!.command.kind !== "identity"
        || canonical(identities[0]!.command.aliases) !== canonical(merge.reviewedAliases)) fail();
    }
    if (receipt && (value.formatVersion < 3 || receipt.eventId !== event.id || receipt.revision !== event.revision
      || receipt.characterIds.some(id => !characters.has(id))
      || receipt.result && (receipt.result.revision !== event.revision || !characters.has(receipt.result.character.id)))) fail();
    if (event.attachment) {
      const attachment = event.attachment;
      const ownedObservations = event.commands.filter((item) => item.command.kind === "observe").map((item) => item.observationId);
      if (value.formatVersion === 1 || attachment.eventId !== event.id || !characters.has(attachment.characterId)
        || characters.get(attachment.characterId)?.origin.kind === "protagonist"
        || event.commands.some((item) => item.command.kind === "create" ? item.characterId !== attachment.characterId
          : item.command.characterId !== attachment.characterId || item.command.kind === "detach")
        || new Set(attachment.observationIds).size !== attachment.observationIds.length
        || ownedObservations.length !== attachment.observationIds.length
        || ownedObservations.some((id) => !id || !attachment.observationIds.includes(id))) fail();
      attachments.set(event.id, attachment);
    }
    for (const item of event.commands) {
    const command = item.command;
    const lifecycleCommand = ["merge", "unmerge", "remove", "restore"].includes(command.kind);
    if (value.formatVersion < 4 && (lifecycleCommand || command.kind === "identity" && command.aliasChanges)) fail();
    // Live decisions use the active turn. Rewind discards later decisions before another can be written.
    // Their journal prefixes must therefore also be valid at each historical turn. Discovery may arrive out of order.
    if (lifecycleCommand || command.kind === "detach" && seedCommands.has(command.eventId)) {
      if (event.effectiveTurnNumber < lastLifecycleTurn) fail();
      lastLifecycleTurn = event.effectiveTurnNumber;
    }
    if (command.kind === "merge") {
      if (!created.has(command.sourceCharacterId) || command.sourceCharacterId === command.characterId
        || characters.get(command.sourceCharacterId)?.origin.kind === "protagonist" || characters.get(command.characterId)?.origin.kind === "protagonist"
        || [...activeMerges.values()].some(merge => merge.source === command.sourceCharacterId || merge.source === command.characterId)
        || removed.has(command.sourceCharacterId) || removed.has(command.characterId)) fail();
      const before = currentAliases.get(command.characterId) ?? [];
      if (canonical(command.aliasChanges.priorTargetAliases) !== canonical(before)
        || canonical({ added: command.aliasChanges.added, removed: command.aliasChanges.removed }) !== canonical(castAliasDelta(before, command.reviewedAliases))) fail();
      activeMerges.set(event.id, { target: command.characterId, source: command.sourceCharacterId, order });
    }
    if (command.kind === "unmerge") {
      const merge = activeMerges.get(command.mergeEventId);
      if (!merge || merge.target !== command.characterId || removed.has(command.characterId)
        || [...activeMerges.values()].some(later => later.order > merge.order && (later.source === merge.source || later.target === merge.source || later.source === merge.target || later.target === merge.target))) fail();
      activeMerges.delete(command.mergeEventId);
      undoneAliases.add(command.mergeEventId);
      replayAliases(command.characterId);
      if (event.commands.length > 1 && (currentAliases.get(command.characterId)?.length ?? 0) <= 20) fail();
      if (![...activeMerges.values()].some(item => item.target === command.characterId)) {
        aliasHistory.set(command.characterId, [{ eventId: event.id, aliases: currentAliases.get(command.characterId) ?? [], mergeOwned: false }]);
      }
    }
    if (command.kind === "remove") {
      if (removed.has(command.characterId) || characters.get(command.characterId)?.origin.kind === "protagonist"
        || [...activeMerges.values()].some(merge => merge.source === command.characterId)) fail();
      removed.add(command.characterId);
    }
    if (command.kind === "restore") { if (!removed.has(command.characterId) || characters.get(command.characterId)?.origin.kind === "protagonist") fail(); removed.delete(command.characterId); }
    if (value.formatVersion < 3 && (command.kind === "seed_profile" || command.kind === "edit_authored_profile"
      || command.kind === "override" && command.field === "story.goals" && command.value.length > 2000)) fail();
    if (command.kind === "seed_profile") {
      if (seeds.has(command.characterId)) fail();
      const evidence = command.evidence;
      if (evidence.kind === "world" ? evidence.worldVersionId !== command.worldVersionId
        : evidence.kind !== "historical_world" || evidence.sourceWorldVersionId !== command.worldVersionId) fail();
      seeds.set(command.characterId, event.id);
      seedCommands.set(event.id, command);
    }
    if (command.kind === "edit_authored_profile" && (seeds.get(command.characterId) !== command.seedEventId
      || command.reset.some(path => Object.hasOwn(command.set, path)))) fail();
    if ((command.kind === "create" || command.kind === "observe" || command.kind === "mention") && command.evidence?.kind === "turn"
      && command.evidence.turnNumber > event.effectiveTurnNumber) fail();
    if (value.formatVersion === 1 && command.kind === "mention" && command.kindOfMention) fail();
    if (command.kind === "detach") {
      if (value.formatVersion === 1) fail();
      const attachment = attachments.get(command.eventId);
      if (!attachment || command.eventId === event.id || attachment.characterId !== command.characterId || detached.has(command.eventId)) fail();
      // Live detach resolves merged sources to their target before checking for a dependent merge.
      if (seedCommands.has(command.eventId) && [...activeMerges.values()].some(merge =>
        merge.target === command.characterId || merge.source === command.characterId)) fail();
      detached.add(command.eventId);
      if (seeds.get(command.characterId) === command.eventId) seeds.delete(command.characterId);
    }
    if (command.kind === "create") {
      const person = item.characterId ? characters.get(item.characterId) : undefined;
      const firstObservedTurn = command.evidence?.kind === "turn" ? command.evidence.turnNumber : event.effectiveTurnNumber;
      if (person?.firstObservedTurn !== firstObservedTurn || command.origin.kind === "protagonist"
        || command.origin.kind === "manual" && command.evidence !== undefined
        || command.origin.kind === "discovered" && command.evidence?.kind !== "turn") fail();
      if (!item.characterId || !characters.has(item.characterId) || created.has(item.characterId)
        || JSON.stringify(characters.get(item.characterId)?.origin) !== JSON.stringify(command.origin)) fail();
      else {
        created.add(item.characterId);
        currentNames.set(item.characterId, command.name);
        aliasHistory.set(item.characterId, [{ eventId: event.id, aliases: command.aliases, mergeOwned: false }]);
        currentAliases.set(item.characterId, command.aliases);
      }
    } else {
      const protagonistEvidence = (command.kind === "observe" || command.kind === "mention") && characters.get(command.characterId)?.origin.kind === "protagonist";
      if (!characters.has(command.characterId) || !created.has(command.characterId) && !protagonistEvidence
        || characters.get(command.characterId)!.firstObservedTurn > event.effectiveTurnNumber) fail();
      if (command.kind === "identity") {
        const mergeOwned = merges.length > 0, before = currentAliases.get(command.characterId) ?? [];
        if (undo && (command.name !== currentNames.get(command.characterId) || command.aliases.some(alias => !before.includes(alias))
          || new Set(command.aliases.map(normalizeCastAlias)).size !== command.aliases.length)) fail();
        currentNames.set(command.characterId, command.name);
        if (!mergeOwned && [...activeMerges.values()].some(merge => merge.target === command.characterId) && !command.aliasChanges) fail();
        if (command.aliasChanges && canonical(command.aliasChanges) !== canonical(castAliasDelta(before, command.aliases))) fail();
        const operation: AliasOperation = { eventId: event.id, aliases: command.aliases, mergeOwned, ...(command.aliasChanges ? { delta: command.aliasChanges } : {}) };
        const history = aliasHistory.get(command.characterId) ?? [];
        history.push(operation); aliasHistory.set(command.characterId, history);
        currentAliases.set(command.characterId, operation.delta ? applyCastAliasDelta(before, operation.delta) : operation.aliases);
      }
      if (command.kind === "observe") {
        if (command.evidence.kind === "turn" && command.evidence.invalidated) fail();
        if (!item.observationId || observations.has(item.observationId)
          || command.speakerCharacterId && !characters.has(command.speakerCharacterId)
          || command.supersedesObservationId && !observations.has(command.supersedesObservationId)) fail();
        if (item.observationId) observations.add(item.observationId);
      }
    }
  }
    if (undo?.kind === "unmerge" && (currentAliases.get(undo.characterId)?.length ?? 0) > 20) fail();
    if (receipt?.observationIds.some(id => !observations.has(id))) fail();
    const result = receipt?.result?.character;
    if (result && canonical(result.origin) !== canonical(characters.get(result.id)?.origin)) fail();
    if (result) {
      const activeSeedId = seeds.get(result.id);
      const origin = result.originProfile;
      if (Boolean(origin) !== Boolean(activeSeedId) || origin && origin.seedEventId !== activeSeedId) fail();
      if (origin && activeSeedId) {
        const seed = seedCommands.get(activeSeedId);
        if (!seed || canonical({ worldVersionId: origin.worldVersionId, entityId: origin.entityId, rosterName: origin.rosterName,
          rosterAliases: origin.rosterAliases, legacyCharacterText: origin.legacyCharacterText, profile: origin.profile, evidence: origin.evidence })
          !== canonical({ worldVersionId: seed.worldVersionId, entityId: seed.entityId, rosterName: seed.rosterName,
            rosterAliases: seed.rosterAliases, legacyCharacterText: seed.legacyCharacterText, profile: seed.profile, evidence: seed.evidence })) fail();
      }
    }
  }
  if (value.characters.some((person) => person.origin.kind !== "protagonist" && !created.has(person.id))) fail();
});
export type PortableCampaignCast = z.infer<typeof portableCampaignCastSchema>;

export function portableCastReferences(cast: PortableCampaignCast): { turns: string[]; worlds: string[] } {
  const turns = new Set<string>(), worlds = new Set<string>();
  for (const person of cast.characters) if (person.origin.kind === "world") worlds.add(person.origin.worldVersionId);
  for (const event of cast.events) {
    for (const range of event.attachment?.sourceRanges ?? []) turns.add(range.turnId);
    for (const { command } of event.commands) {
    if ((command.kind !== "create" && command.kind !== "observe" && command.kind !== "mention" && command.kind !== "seed_profile") || !command.evidence) continue;
    if (command.evidence.kind === "turn" && !command.evidence.invalidated) turns.add(command.evidence.turnId);
    if (command.kind === "mention" && command.sourceRange && !command.evidence.invalidated) turns.add(command.sourceRange.turnId);
    if (command.evidence.kind === "world") worlds.add(command.evidence.worldVersionId);
  }
  }
  return { turns: [...turns], worlds: [...worlds] };
}
