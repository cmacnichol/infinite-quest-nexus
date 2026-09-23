import { campaignRuntimeStateContentSchema, characterProfileSchema, chronicleRetrievalAuditSchema, castGenerationSnapshotSchema, castGenerationSnapshotFingerprint, sha256Hex, z } from "@infinite-quest/contracts";
export type { ReviewEvidenceReference } from "@infinite-quest/contracts";

/** Private only: these values are not public preview projections. */
type DeepReadonly<T> = T extends readonly (infer U)[] ? readonly DeepReadonly<U>[]
  : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const jsonPointerSchema = z.string().regex(/^(?:\/(?:[^~/]|~[01])*)*$/);
const ordinalSchema = z.number().int().min(0);

/** Frozen current reader. Never fill new dependencies from mutable state. */
export const legacyGenerationBaseIdentitySchema = z.object({
  operationKind: z.enum(["append", "replace_latest"]), expectedTurnNumber: z.number().int().min(1),
  baseTurnNumber: ordinalSchema, campaignActiveTurnNumber: ordinalSchema, campaignStateRevision: ordinalSchema,
  stateEditRevision: ordinalSchema.nullable(), narrationCorrectionRevision: ordinalSchema.nullable(),
  baseTurnId: z.string().uuid().nullable(), stateFingerprint: hashSchema, narrationFingerprint: hashSchema.nullable()
}).strict();
export type LegacyGenerationBaseIdentity = DeepReadonly<z.infer<typeof legacyGenerationBaseIdentitySchema>>;
export function readLegacyGenerationBaseIdentity(value: unknown): LegacyGenerationBaseIdentity {
  return legacyGenerationBaseIdentitySchema.parse(value);
}
export const generationBaseIdentityV3Schema = legacyGenerationBaseIdentitySchema.extend({
  version: z.literal("generation-base-v3"), characterProfileRevision: ordinalSchema, characterProfileFingerprint: hashSchema,
  recentWindowFingerprint: hashSchema.optional()
}).strict();
export type GenerationBaseIdentityV3 = DeepReadonly<z.infer<typeof generationBaseIdentityV3Schema>>;
export const generationBaseIdentityV4Schema = generationBaseIdentityV3Schema.extend({
  version: z.literal("generation-base-v4"), castRevision: ordinalSchema, castTimelineRevision: ordinalSchema,
  castFingerprint: hashSchema, castCoverageStartTurn: ordinalSchema.min(1).nullable(), castTrackedThroughTurn: ordinalSchema.nullable()
}).strict();
export type GenerationBaseIdentityV4 = DeepReadonly<z.infer<typeof generationBaseIdentityV4Schema>>;
export const generationBaseIdentitySchema = z.union([legacyGenerationBaseIdentitySchema, generationBaseIdentityV3Schema, generationBaseIdentityV4Schema]);
export type GenerationBaseIdentity = DeepReadonly<z.infer<typeof generationBaseIdentitySchema>>;
/** Historical rows remain legacy-shaped; only a stored v3 marker authorizes the new reader. */
export function readGenerationBaseIdentity(value: unknown): GenerationBaseIdentity {
  return generationBaseIdentitySchema.parse(value);
}
export function isGenerationBaseIdentityV3(value: GenerationBaseIdentity): value is GenerationBaseIdentityV3 {
  return "version" in value && value.version === "generation-base-v3";
}
export function isGenerationBaseIdentityV4(value: GenerationBaseIdentity): value is GenerationBaseIdentityV4 {
  return "version" in value && value.version === "generation-base-v4";
}
export function hasGenerationCharacterAuthority(value: GenerationBaseIdentity): value is GenerationBaseIdentityV3 | GenerationBaseIdentityV4 {
  return isGenerationBaseIdentityV3(value) || isGenerationBaseIdentityV4(value);
}

/** T04 resolves the complete profile at capture; absent authority is explicit, never synthesized. */
export const generationCharacterAuthoritySchema = z.object({
  source: z.enum(["campaign_profile", "origin_snapshot", "legacy_guidance", "none"]),
  name: z.string(), characterText: z.string(), profile: characterProfileSchema.nullable(),
  omittedExtensionFieldCount: z.number().int().nonnegative().optional()
}).strict();
export type GenerationCharacterAuthority = DeepReadonly<z.infer<typeof generationCharacterAuthoritySchema>>;

/** Open world contents remain legacy-compatible; the private seam itself is closed. */
export const generationContextAuthoritySchema = z.object({
  rules: z.array(z.string()), worldCanon: z.record(z.string(), z.unknown()), selectedCharacterId: z.string().nullable(),
  currentContinuity: campaignRuntimeStateContentSchema,
  characterAuthority: generationCharacterAuthoritySchema.optional(),
  castSnapshot: castGenerationSnapshotSchema.optional(),
  /** Pinned world-version JSON only; adapter selection happens in the private v3 planner. */
  worldReferenceSource: z.object({ worldVersionId: z.string().uuid(), worldContent: z.unknown() }).strict().optional(),
  scratchpad: z.string(), openThreads: campaignRuntimeStateContentSchema.shape.openThreads,
  canonicalFacts: campaignRuntimeStateContentSchema.shape.canonicalFacts,
  trackers: campaignRuntimeStateContentSchema.shape.trackers, rpgStats: campaignRuntimeStateContentSchema.shape.rpgStats,
  eventTriggers: campaignRuntimeStateContentSchema.shape.eventTriggers,
  pendingEventTriggers: campaignRuntimeStateContentSchema.shape.pendingEventTriggers,
  latestTurn: z.object({ action: z.string(), narration: z.string(), inputMode: z.enum(["action", "scene"]).optional() }).strict().nullable()
}).strict();
export type GenerationContextAuthority = DeepReadonly<z.infer<typeof generationContextAuthoritySchema>>;
export const generationContextCandidateSchema = z.object({
  id: z.string().min(1), turnId: z.string().nullable(), ordinal: ordinalSchema,
  kind: z.enum(["turn_fiction", "legacy_summary", "campaign_summary", "canonical_fact", "open_thread"]),
  sourceValidationFailed: z.literal(true).optional(),
  narrativeSource: z.object({ normalizationVersion: z.literal("story-fiction-source-v1"), sourceHash: hashSchema,
    spans: z.array(z.object({ start: ordinalSchema, end: ordinalSchema }).strict()).min(1) }).strict().optional(),
  content: z.string(), tokenEstimate: z.number().finite().min(0), rank: z.number().finite()
}).strict();
export type GenerationContextCandidate = DeepReadonly<z.infer<typeof generationContextCandidateSchema>>;
export const generationRecentTurnSchema = z.object({
  turnId: z.uuid(), turnNumber: ordinalSchema, inputMode: z.enum(["action", "scene"]),
  action: z.string(), narration: z.string(), narrationCorrectionRevision: ordinalSchema, sourceHash: hashSchema
}).strict();
export type GenerationRecentTurn = DeepReadonly<z.infer<typeof generationRecentTurnSchema>>;
export const memoryGenerationAuthorityContextSchema = z.object({
  authority: generationContextAuthoritySchema, candidates: z.array(generationContextCandidateSchema),
  recentTurns: z.array(generationRecentTurnSchema).max(2).optional(),
  baseIdentity: generationBaseIdentitySchema, chronicleRetrieval: chronicleRetrievalAuditSchema.optional()
}).strict().superRefine((value, context) => {
  const cast = value.authority.castSnapshot;
  if (!isGenerationBaseIdentityV4(value.baseIdentity)) {
    if (cast) context.addIssue({ code: "custom", message: "Historical generation bases cannot acquire cast authority." });
    return;
  }
  const base = value.baseIdentity;
  if (!cast || !value.authority.characterAuthority || cast.revision !== base.castRevision
    || cast.boundary.timelineRevision !== base.castTimelineRevision || cast.boundary.turnNumber !== base.baseTurnNumber
    || cast.coverageStartTurn !== base.castCoverageStartTurn || cast.trackedThroughTurn !== base.castTrackedThroughTurn
    || castGenerationSnapshotFingerprint(cast) !== base.castFingerprint) {
    context.addIssue({ code: "custom", message: "Captured cast does not match the generation base." });
  }
});
export type MemoryGenerationAuthorityContext = DeepReadonly<z.infer<typeof memoryGenerationAuthorityContextSchema>>;

export const sourceRefSchema = z.object({
  kind: z.enum(["world", "character", "cast", "state_edit", "turn", "canonical_fact", "direction"]),
  id: z.string().min(1), revision: z.string().min(1), turnNumber: ordinalSchema.nullable(), contentHash: hashSchema
}).strict();
const spanSchema = z.object({ start: ordinalSchema, end: ordinalSchema }).strict()
  .refine(({ start, end }) => end > start, "Span end must exceed start.");
const evidenceShapeSchema = z.object({
  id: hashSchema, source: sourceRefSchema,
  semanticRole: z.enum(["accepted_narration", "player_intent", "world_reference", "world_rule", "character_authority", "corrected_state", "current_continuity", "canonical_fact", "derived_summary"]),
  form: z.enum(["complete", "excerpt"]), content: z.string(), spans: z.array(spanSchema),
  sourceLength: ordinalSchema, canonicalFactId: z.string().uuid().nullable(), rank: z.number().finite(),
  selectionGroup: z.enum(["protected", "direction", "recent", "world", "cast", "historical_fact", "retrieved"]),
  sourcePath: jsonPointerSchema, normalizationVersion: z.enum(["fiction-safe-json-v1", "story-fiction-source-v1"])
}).strict();
export type SourceRef = DeepReadonly<z.infer<typeof sourceRefSchema>>;
export type StoryEvidence = DeepReadonly<z.infer<typeof evidenceShapeSchema>>;

/** JSON key order is canonical; array order (including selection order) is significant. */
export function canonicalEvidenceJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalEvidenceJson).join(",")}]`;
  if (typeof value === "object" && value !== null && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalEvidenceJson(child)}`).join(",")}}`;
  }
  throw new Error("Evidence sources must contain only JSON values.");
}
export function storyEvidenceId(value: Pick<StoryEvidence, "source" | "sourcePath" | "semanticRole" | "normalizationVersion" | "spans" | "form">): string {
  return sha256Hex(canonicalEvidenceJson({ source: value.source, sourcePath: value.sourcePath,
    semanticRole: value.semanticRole, normalizationVersion: value.normalizationVersion, spans: value.spans, form: value.form }));
}
export const storyEvidenceSchema = evidenceShapeSchema.superRefine((value, context) => {
  const issue = (path: string, message: string) => context.addIssue({ code: "custom", path: [path], message });
  if (value.form === "complete" && (value.spans.length || value.content.length !== value.sourceLength)) issue("spans", "Complete evidence must represent the entire field without excerpt spans.");
  if (value.form === "excerpt" && !value.spans.length) issue("spans", "Excerpt evidence requires verified spans.");
  if (value.form === "excerpt" && value.selectionGroup === "protected") issue("form", "Protected evidence must remain complete.");
  let previousEnd = 0;
  for (const span of value.spans) {
    if (span.start < previousEnd || span.end > value.sourceLength) issue("spans", "Spans must be ordered, disjoint and within the normalized source field.");
    previousEnd = span.end;
  }
  if (value.canonicalFactId && (value.form !== "complete" || value.semanticRole !== "canonical_fact")) issue("canonicalFactId", "Only a complete canonical fact may name a fact UUID.");
  if (value.semanticRole === "canonical_fact" && value.form !== "complete") issue("form", "Canonical facts must remain complete.");
  if (value.id !== storyEvidenceId(value)) issue("id", "Evidence identity does not match its source.");
});
function resolvePointer(source: unknown, pointer: string): unknown {
  jsonPointerSchema.parse(pointer);
  let value = source;
  for (const part of pointer === "" ? [] : pointer.slice(1).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)
      || (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key))) throw new Error("Evidence source pointer does not resolve within the source.");
    value = Reflect.get(value, key);
  }
  return value;
}
export type StoryEvidenceInput = Omit<StoryEvidence, "id" | "content" | "sourceLength" | "source"> & Readonly<{ source: Omit<SourceRef, "contentHash"> }>;
export type StoryEvidenceSourceOptions = Readonly<{
  /** The immutable source can be hashed separately from a fiction-safe projection used for review text. */
  contentHash?: string;
}>;
/** Input is an already fiction-safe scoped source; this helper grants no authorization. */
export function createStoryEvidence(input: StoryEvidenceInput, sourceDocument: unknown, options: StoryEvidenceSourceOptions = {}): StoryEvidence {
  const sourceHash = options.contentHash ?? sha256Hex(canonicalEvidenceJson(sourceDocument));
  const field = resolvePointer(sourceDocument, input.sourcePath);
  const text = typeof field === "string" ? field : canonicalEvidenceJson(field);
  const identity = { ...input, source: { ...input.source, contentHash: sourceHash } };
  return storyEvidenceSchema.parse({ ...identity, id: storyEvidenceId(identity), sourceLength: text.length,
    content: input.form === "complete" ? text : input.spans.map(({ start, end }) => text.slice(start, end)).join("\n[…]\n") });
}
/** Persisted metadata alone cannot prove source text. Rebind it to the captured scoped source. */
export function readStoryEvidenceFromSource(value: unknown, sourceDocument: unknown, options: StoryEvidenceSourceOptions = {}): StoryEvidence {
  const evidence = storyEvidenceSchema.parse(value);
  const { id, content, sourceLength, source, ...input } = evidence;
  const { contentHash, ...sourceIdentity } = source;
  const rebound = createStoryEvidence({ ...input, source: sourceIdentity }, sourceDocument, options);
  if (canonicalEvidenceJson(rebound) !== canonicalEvidenceJson(evidence)) throw new Error("Evidence does not match its captured source.");
  return evidence;
}
const manifestShapeSchema = z.object({
  version: z.literal("generation-evidence-v1"), attemptId: z.string().uuid(), producingRequestHash: hashSchema,
  entries: z.array(storyEvidenceSchema), requiredReviewEvidenceIds: z.array(hashSchema), manifestHash: hashSchema
}).strict();
export type GenerationEvidenceManifest = DeepReadonly<z.infer<typeof manifestShapeSchema>>;
export function generationEvidenceManifestHash(value: Omit<GenerationEvidenceManifest, "manifestHash"> & { readonly manifestHash?: string }): string {
  const { manifestHash: ignored, ...body } = value;
  return sha256Hex(canonicalEvidenceJson(body));
}
export const generationEvidenceManifestSchema = manifestShapeSchema.superRefine((value, context) => {
  const ids = new Set(value.entries.map((entry) => entry.id));
  if (ids.size !== value.entries.length) context.addIssue({ code: "custom", path: ["entries"], message: "Evidence IDs must be unique." });
  if (new Set(value.requiredReviewEvidenceIds).size !== value.requiredReviewEvidenceIds.length || value.requiredReviewEvidenceIds.some((id) => !ids.has(id))) {
    context.addIssue({ code: "custom", path: ["requiredReviewEvidenceIds"], message: "Required review evidence must be a unique subset of supplied entries." });
  }
  if (generationEvidenceManifestHash(value) !== value.manifestHash) context.addIssue({ code: "custom", path: ["manifestHash"], message: "Manifest hash does not match canonical content." });
});
export const generationContextSnapshotSchema = z.object({
  version: z.literal("current-continuity-v3"), ownerUserId: z.string().uuid(), campaignId: z.string().uuid(), worldVersionId: z.string().uuid(),
  baseIdentity: generationBaseIdentityV3Schema, protectedAuthority: generationContextAuthoritySchema.required({ characterAuthority: true }),
  candidates: z.array(storyEvidenceSchema), manifest: generationEvidenceManifestSchema
}).strict();
export type GenerationContextSnapshot = DeepReadonly<z.infer<typeof generationContextSnapshotSchema>>;
