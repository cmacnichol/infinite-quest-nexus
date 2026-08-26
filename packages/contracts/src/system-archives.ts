import { z } from "zod";
import { archiveAssetRecordSchema, archiveErrorCodeSchema, archiveManifestSchema } from "./archives.js";

const nonnegativeSafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const boundedStringSchema = (maximum: number) => z.string().trim().min(1).max(maximum);
const archiveTimestampSchema = z.iso.datetime({ offset: true });
const identifierSchema = z.string().trim().min(1).max(300);
const shortTextSchema = z.string().trim().max(10_000);
const longTextSchema = z.string().trim().max(1_000_000);

export const SYSTEM_ARCHIVE_DOMAINS = [
  "providers", "prompts", "worlds", "world-versions", "world-drafts",
  "campaigns", "turns", "turn-corrections", "campaign-state",
  "campaign-history", "canonical-facts", "chronicle", "illustrations",
  "imports", "cost-events", "activity-events"
] as const;

export const systemArchiveDomainSchema = z.enum(SYSTEM_ARCHIVE_DOMAINS);
export const SYSTEM_ARCHIVE_OPERATIONAL_OMISSION_CATEGORIES = [
  "generation", "illustration", "chronicle", "imports", "system-archive"
] as const;
export const systemArchiveOperationalOmissionsSchema = z.object({
  generation: nonnegativeSafeIntegerSchema,
  illustration: nonnegativeSafeIntegerSchema,
  chronicle: nonnegativeSafeIntegerSchema,
  imports: nonnegativeSafeIntegerSchema,
  "system-archive": nonnegativeSafeIntegerSchema
}).strict();
export const systemArchiveJobKindSchema = z.enum(["export", "import"]);
export const systemArchiveJobStatusSchema = z.enum([
  "queued", "capturing", "writing", "verifying", "published",
  "uploading", "validating", "previewed", "revalidating",
  "waiting_for_gate", "importing", "authoritative_committed",
  "rebuilding", "completed", "cancelling", "cancelled",
  "rolled_back", "failed", "expired"
]);

/** Provider imports retain only configuration that can be safely re-entered without a credential. */
export const systemPortableProviderSchema = z.object({
  sourceId: z.string().uuid(),
  kind: z.enum(["text", "image", "embedding"]),
  displayName: boundedStringSchema(200),
  baseUrl: z.url().max(2_000).nullable(),
  selectedModel: boundedStringSchema(300).nullable(),
  contextWindow: nonnegativeSafeIntegerSchema.nullable(),
  timeoutMs: nonnegativeSafeIntegerSchema.nullable(),
  retryLimit: nonnegativeSafeIntegerSchema.nullable(),
  enabled: z.literal(false),
  health: z.literal("unknown")
}).strict();

const systemChronicleRecordBase = {
  sourceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  content: boundedStringSchema(1_000_000),
  occurredAt: archiveTimestampSchema,
  metadata: z.object({
    entityNames: z.array(identifierSchema).max(1_000),
    openThreadIds: z.array(z.string().uuid()).max(1_000).default([])
  }).strict()
};

export const systemSummaryCheckpointKindSchema = z.enum([
  "campaign_continuity",
  "campaign_summary",
  "legacy_full_history"
]);

/** Chronicle records are logical text/state only; vectors and chunk data are rebuilt locally. */
export const systemChronicleRecordSchema = z.discriminatedUnion("kind", [
  z.object({
    ...systemChronicleRecordBase,
    kind: z.literal("memory"),
    turnId: z.string().uuid().nullable(),
    memoryKind: z.enum([
      "turn_fiction", "legacy_summary", "campaign_summary", "canonical_fact", "open_thread"
    ])
  }).strict(),
  z.object({
    ...systemChronicleRecordBase,
    kind: z.literal("summary-checkpoint"),
    throughTurn: nonnegativeSafeIntegerSchema,
    summaryKind: systemSummaryCheckpointKindSchema
  }).strict()
]);

const systemPromptRecordSchema = z.object({
  sourceId: z.string().uuid(),
  campaignId: z.string().uuid().nullable(),
  templateKey: identifierSchema,
  overrideText: longTextSchema,
  updatedAt: archiveTimestampSchema
}).strict();

const systemWorldRecordSchema = z.object({
  sourceId: z.string().uuid(),
  title: identifierSchema,
  status: z.enum(["draft", "active", "archived"]),
  forkedFromWorldId: z.string().uuid().nullable().optional(),
  forkedFromWorldVersionId: z.string().uuid().nullable().optional(),
  createdAt: archiveTimestampSchema,
  updatedAt: archiveTimestampSchema
}).strict();

const systemRpgStatSchema = z.object({
  id: identifierSchema,
  name: identifierSchema,
  value: z.number().int().min(1).max(99),
  note: shortTextSchema
}).strict();

const systemDefaultTriggerSchema = z.object({
  id: identifierSchema,
  name: identifierSchema,
  value: z.string().max(10_000),
  rules: z.string().max(4_000)
}).strict();

const characterProfileTextSchema = z.string().trim().max(20_000);
const characterProfileShortTextSchema = z.string().trim().max(2_000);

const systemCharacterProfileSchema = z.object({
  identity: z.object({
    aliases: z.array(boundedStringSchema(200)).max(20),
    pronouns: characterProfileShortTextSchema
  }).strict(),
  story: z.object({
    role: characterProfileTextSchema,
    background: characterProfileTextSchema,
    personality: characterProfileTextSchema,
    motivations: characterProfileTextSchema,
    goals: characterProfileTextSchema,
    fearsAndConflicts: characterProfileTextSchema,
    keyRelationships: characterProfileTextSchema,
    narrativeHooks: characterProfileTextSchema,
    voiceAndMannerisms: characterProfileTextSchema,
    otherGuidance: characterProfileTextSchema
  }).strict(),
  appearance: z.object({
    ancestryOrSpecies: characterProfileShortTextSchema,
    apparentAge: characterProfileShortTextSchema,
    genderPresentation: characterProfileShortTextSchema,
    build: characterProfileShortTextSchema,
    skinOrComplexion: characterProfileShortTextSchema,
    face: characterProfileTextSchema,
    eyes: characterProfileShortTextSchema,
    hair: characterProfileTextSchema,
    distinguishingFeatures: z.array(boundedStringSchema(2_000)).max(50),
    clothing: characterProfileTextSchema,
    equipmentAndAccessories: characterProfileTextSchema,
    otherVisualDetails: characterProfileTextSchema
  }).strict(),
  unclassifiedNotes: z.string().max(200_000)
}).strict();

const systemEventTriggerSchema = z.object({
  id: identifierSchema,
  label: identifierSchema,
  timing: z.enum(["before", "after"]),
  condition: shortTextSchema,
  effect: shortTextSchema,
  addTextAfter: z.boolean(),
  triggeredCount: nonnegativeSafeIntegerSchema,
  lastTriggeredTurn: z.number().int().positive().nullable(),
  lastTriggeredAt: archiveTimestampSchema.nullable()
}).strict();

const systemPendingEventTriggerSchema = z.object({
  id: identifierSchema,
  sourceTriggerId: identifierSchema,
  name: identifierSchema,
  timing: z.enum(["before", "after"]),
  condition: shortTextSchema,
  effect: shortTextSchema,
  instructions: shortTextSchema,
  reason: shortTextSchema,
  sourceTurn: z.number().int().positive().nullable()
}).strict();

const systemWorldContentSchema = z.object({
  schemaVersion: z.number().int().positive(),
  world: z.object({
    title: identifierSchema,
    genre: shortTextSchema,
    tone: shortTextSchema,
    premise: longTextSchema,
    backgroundStory: longTextSchema,
    firstAction: longTextSchema,
    rules: longTextSchema
  }).strict(),
  playableCharacters: z.array(z.object({
    id: identifierSchema,
    name: identifierSchema,
    characterText: longTextSchema,
    profile: systemCharacterProfileSchema.optional(),
    rpgStats: z.array(systemRpgStatSchema).max(10_000),
    defaultTriggers: z.array(systemDefaultTriggerSchema).max(10_000)
  }).strict()).max(1_000),
  entities: z.array(z.object({
    id: identifierSchema,
    name: identifierSchema,
    kind: identifierSchema,
    description: longTextSchema,
    tags: z.array(identifierSchema).max(1_000),
    facts: z.array(z.object({ key: identifierSchema, value: longTextSchema }).strict()).max(10_000)
  }).strict()).max(20_000),
  relationships: z.array(z.object({
    id: identifierSchema,
    fromEntityId: identifierSchema,
    toEntityId: identifierSchema,
    kind: identifierSchema,
    description: longTextSchema
  }).strict()).max(50_000),
  rpgStats: z.array(systemRpgStatSchema).max(10_000),
  defaultTriggers: z.array(systemDefaultTriggerSchema).max(10_000),
  eventTriggers: z.array(systemEventTriggerSchema).max(10_000),
  assets: z.array(z.object({
    assetId: z.string().uuid(),
    role: z.enum(["world_cover", "world_version_asset"])
  }).strict()).max(10_000),
  defaults: z.object({
    selectedCharacterId: identifierSchema.nullable(),
    initialLocation: shortTextSchema
  }).strict()
}).strict();

const systemWorldVersionRecordSchema = z.object({
  sourceId: z.string().uuid(),
  worldId: z.string().uuid(),
  versionNumber: z.number().int().positive(),
  title: identifierSchema,
  content: systemWorldContentSchema,
  contentFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  releaseNotes: longTextSchema,
  createdFromRevision: nonnegativeSafeIntegerSchema.nullable(),
  publishedAt: archiveTimestampSchema
}).strict();

const systemWorldDraftRecordSchema = z.object({
  sourceId: z.string().uuid(),
  worldId: z.string().uuid(),
  basedOnWorldVersionId: z.string().uuid().nullable(),
  title: identifierSchema,
  revision: nonnegativeSafeIntegerSchema,
  content: systemWorldContentSchema,
  createdAt: archiveTimestampSchema,
  updatedAt: archiveTimestampSchema
}).strict();

const systemCharacterSnapshotSchema = z.object({
  id: identifierSchema.optional(),
  name: identifierSchema,
  characterText: longTextSchema,
  profile: systemCharacterProfileSchema.optional(),
  rpgStats: z.array(systemRpgStatSchema).max(10_000).optional(),
  defaultTriggers: z.array(systemDefaultTriggerSchema).max(10_000).optional(),
  source: z.record(z.string().max(300), z.json()).optional()
}).strict();

const systemCampaignCharacterProfileSchema = z.object({
  name: identifierSchema,
  profile: z.record(z.string().max(300), z.json())
}).strict();

const systemCampaignStateSnapshotSchema = z.object({
  continuitySummary: longTextSchema,
  openThreads: z.array(shortTextSchema).max(500),
  canonicalFacts: z.array(z.object({ id: z.string().uuid().nullable(), content: longTextSchema }).strict()).max(2_000),
  scratchpad: longTextSchema,
  trackers: z.array(z.object({
    id: identifierSchema,
    name: identifierSchema,
    value: shortTextSchema,
    rules: shortTextSchema
  }).strict()).max(200),
  rpgStats: z.array(systemRpgStatSchema).max(100),
  defaultTriggers: z.array(systemDefaultTriggerSchema).max(200),
  eventTriggers: z.array(systemEventTriggerSchema).max(200),
  pendingEventTriggers: z.array(systemPendingEventTriggerSchema).max(200)
}).strict();

const systemCampaignRecordSchema = z.object({
  sourceId: z.string().uuid(),
  worldVersionId: z.string().uuid(),
  title: identifierSchema,
  status: z.enum(["active", "archived"]),
  activeTurnNumber: nonnegativeSafeIntegerSchema,
  settings: z.object({
    turnControlStyle: z.enum(["Auto", "Action", "Scene Direction"])
  }).strict(),
  selectedCharacterId: identifierSchema.nullable().optional(),
  characterSnapshot: systemCharacterSnapshotSchema.nullable().optional(),
  characterProfile: systemCampaignCharacterProfileSchema.nullable().optional(),
  characterProfileRevision: nonnegativeSafeIntegerSchema.optional(),
  createdAt: archiveTimestampSchema,
  updatedAt: archiveTimestampSchema
}).strict();

const systemTurnRecordSchema = z.object({
  sourceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  turnNumber: z.number().int().positive(),
  action: longTextSchema,
  narration: longTextSchema,
  choices: z.array(shortTextSchema).max(100),
  imagePrompt: longTextSchema,
  stateSnapshotPrivate: z.record(z.string().max(300), z.json()).optional(),
  acceptedAt: archiveTimestampSchema
}).strict();

const systemTurnCorrectionRecordSchema = z.object({
  sourceId: z.string().uuid(),
  turnId: z.string().uuid(),
  revision: z.number().int().positive(),
  narration: longTextSchema,
  previousEffectiveNarrationHash: z.string().regex(/^[a-f0-9]{64}$/),
  reason: boundedStringSchema(2_000).nullable(),
  source: z.enum(["user_edit", "legacy_import", "administrative"]),
  correctedAt: archiveTimestampSchema
}).strict();

const systemCampaignStateRecordSchema = z.object({
  sourceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  revision: nonnegativeSafeIntegerSchema,
  state: systemCampaignStateSnapshotSchema,
  updatedAt: archiveTimestampSchema
}).strict();

const systemCharacterProfileEditDetailsSchema = z.object({
  revision: z.number().int().positive(),
  previousProfile: systemCampaignCharacterProfileSchema.nullable().optional(),
  nextProfile: systemCampaignCharacterProfileSchema,
  editSource: z.enum(["world_version_seed", "manual", "ai_organized", "imported", "branch", "transfer"])
}).strict();

const systemCampaignStateEditDetailsSchema = z.object({
  effectiveTurnNumber: nonnegativeSafeIntegerSchema,
  revision: z.number().int().positive(),
  stateSnapshot: systemCampaignStateSnapshotSchema,
  changedFields: z.array(identifierSchema).max(1_000)
}).strict();

const systemWorldMigrationDetailsSchema = z.object({
  fromWorldVersionId: z.string().uuid(),
  toWorldVersionId: z.string().uuid(),
  note: shortTextSchema
}).strict();

const systemWorldTransferDetailsSchema = z.object({
  sourceCampaignId: z.string().uuid().nullable().optional(),
  targetCampaignId: z.string().uuid().nullable().optional(),
  fromWorldVersionId: z.string().uuid(),
  toWorldVersionId: z.string().uuid(),
  characterStrategy: z.literal("preserve_source"),
  stateStrategy: z.literal("preserve"),
  targetDefaultsPolicy: z.literal("retain_source"),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  warnings: z.array(shortTextSchema).max(1_000),
  note: shortTextSchema
}).strict().superRefine((details, context) => {
  if ((details.sourceCampaignId ?? null) === null && (details.targetCampaignId ?? null) === null) {
    context.addIssue({
      code: "custom",
      path: ["sourceCampaignId"],
      message: "World transfers require a source or target campaign."
    });
  }
});

const systemMemoryConfigDetailsSchema = z.object({
  embeddingEnabled: z.boolean(),
  embeddingProviderProfileId: z.string().uuid().nullable(),
  embeddingModel: z.string().max(300),
  embeddingBatchSize: z.number().int().min(1).max(128),
  embeddingDocumentPrefix: z.string().max(4_000).nullable().optional(),
  embeddingQueryPrefix: z.string().max(4_000).nullable().optional(),
  retrievalImplementation: z.enum(["legacy_hybrid", "chunked_hybrid"]).optional(),
  retrievalShadowEnabled: z.boolean().optional(),
  createdAt: archiveTimestampSchema.optional(),
  updatedAt: archiveTimestampSchema.optional()
}).strict().superRefine((details, context) => {
  if (details.embeddingEnabled
    && (details.embeddingProviderProfileId === null || details.embeddingModel.length === 0)) {
    context.addIssue({
      code: "custom",
      path: ["embeddingProviderProfileId"],
      message: "Enabled memory configuration requires a provider and model."
    });
  }
});

const systemIllustrationConfigDetailsSchema = z.object({
  enabled: z.boolean(),
  providerProfileId: z.string().uuid().nullable(),
  model: z.string().max(300),
  size: boundedStringSchema(100),
  aspectRatio: boundedStringSchema(100),
  quality: z.enum(["auto", "low", "medium", "high"]),
  outputFormat: z.enum(["png", "jpeg", "webp"]),
  maxAttempts: z.number().int().min(1).max(10),
  sourcePolicy: z.enum(["off", "library_only", "library_then_generate", "generate_only"]).optional(),
  matchingScope: z.enum(["campaign", "world", "owner_library", "shared"]).optional(),
  confidenceProfile: z.enum(["strict", "balanced", "broad"]).optional(),
  repetitionWindow: z.number().int().min(0).max(100).optional(),
  segmentWordCount: z.number().int().min(100).max(5_000),
  imagesPerSegment: z.number().int().min(1).max(2),
  segmentPromptMode: z.enum(["direct", "ai_refined"]),
  refinementPrompt: z.string().max(4_000),
  createdAt: archiveTimestampSchema.optional(),
  updatedAt: archiveTimestampSchema.optional()
}).strict().superRefine((details, context) => {
  if (details.sourcePolicy !== undefined && details.enabled !== (details.sourcePolicy !== "off")) {
    context.addIssue({
      code: "custom",
      path: ["sourcePolicy"],
      message: "Illustration source policy must match enabled state."
    });
  }
  if (details.enabled && (details.providerProfileId === null || details.model.length === 0)) {
    context.addIssue({
      code: "custom",
      path: ["providerProfileId"],
      message: "Enabled illustration configuration requires a provider and model."
    });
  }
});

export const systemCampaignHistoryDetailsSchema = z.discriminatedUnion("eventType", [
  z.object({ eventType: z.literal("character-profile-edit"), details: systemCharacterProfileEditDetailsSchema }).strict(),
  z.object({ eventType: z.literal("campaign-state-edit"), details: systemCampaignStateEditDetailsSchema }).strict(),
  z.object({ eventType: z.literal("world-migration"), details: systemWorldMigrationDetailsSchema }).strict(),
  z.object({ eventType: z.literal("world-transfer"), details: systemWorldTransferDetailsSchema }).strict(),
  z.object({ eventType: z.literal("memory-config"), details: systemMemoryConfigDetailsSchema }).strict(),
  z.object({ eventType: z.literal("illustration-config"), details: systemIllustrationConfigDetailsSchema }).strict(),
  z.object({
    eventType: z.literal("accepted-turn-mode"),
    details: z.object({
      turnId: z.string().uuid(),
      turnNumber: z.number().int().positive(),
      inputMode: z.enum(["action", "scene"]),
      inputModeSource: z.enum(["explicit", "auto", "generated_choice", "opening_action", "fallback"])
    }).strict()
  }).strict(),
  z.object({
    eventType: z.literal("illustration-set"),
    details: z.object({
      turnId: z.string().uuid(),
      segmentWordCount: z.number().int().min(100).max(5_000),
      imagesPerSegment: z.number().int().min(1).max(2),
      promptMode: z.enum(["direct", "ai_refined", "legacy"]),
      status: z.enum(["queued", "refining", "generating", "completed", "partial", "failed", "superseded"]),
      isActive: z.boolean(),
      characterVisualReference: z.string().max(20_000).nullable().optional(),
      completedAt: archiveTimestampSchema.nullable().optional()
    }).strict()
  }).strict(),
  z.object({
    eventType: z.literal("illustration-segment"),
    details: z.object({
      illustrationSetId: z.string().uuid(),
      turnId: z.string().uuid(),
      ordinal: nonnegativeSafeIntegerSchema,
      startOffset: nonnegativeSafeIntegerSchema,
      endOffset: nonnegativeSafeIntegerSchema,
      startWord: nonnegativeSafeIntegerSchema,
      endWord: nonnegativeSafeIntegerSchema,
      directPrompt: longTextSchema,
      resolvedPrompt: longTextSchema,
      promptSource: z.enum(["direct", "ai_refined", "ai_fallback", "legacy"]),
      status: z.enum(["queued", "refining", "generating", "completed", "recoverable", "failed"])
    }).strict()
  }).strict()
]);

export function parseSystemCampaignHistoryDetails(eventType: string, content: string) {
  let details: unknown;
  try {
    details = JSON.parse(content);
  } catch {
    details = undefined;
  }
  return systemCampaignHistoryDetailsSchema.parse({ eventType, details });
}

const systemCampaignHistoryRecordSchema = z.object({
  sourceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  eventType: identifierSchema,
  content: longTextSchema,
  occurredAt: archiveTimestampSchema
}).strict();

const systemCanonicalFactRecordSchema = z.object({
  sourceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  worldVersionId: z.string().uuid(),
  sourceTurnId: z.string().uuid().nullable(),
  sourceStateEditId: z.string().uuid().nullable(),
  sourceTurnNumber: nonnegativeSafeIntegerSchema,
  sourceFactIndex: nonnegativeSafeIntegerSchema,
  subject: shortTextSchema,
  predicate: shortTextSchema,
  object: longTextSchema,
  validFromTurn: nonnegativeSafeIntegerSchema,
  validUntilTurn: nonnegativeSafeIntegerSchema.nullable(),
  supersededByFactId: z.string().uuid().nullable(),
  createdAt: archiveTimestampSchema,
  updatedAt: archiveTimestampSchema
}).strict().superRefine((record, context) => {
  if ((record.sourceTurnId === null) === (record.sourceStateEditId === null)) {
    context.addIssue({
      code: "custom",
      path: ["sourceTurnId"],
      message: "Canonical facts require exactly one authoritative source turn or state edit."
    });
  }
  if (record.validUntilTurn !== null && record.validUntilTurn <= record.validFromTurn) {
    context.addIssue({
      code: "custom",
      path: ["validUntilTurn"],
      message: "Canonical fact validity cannot end before it begins."
    });
  }
});

const systemIllustrationRecordSchema = z.object({
  sourceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  turnId: z.string().uuid().nullable(),
  assetId: z.string().uuid(),
  fictionPrompt: longTextSchema,
  selected: z.boolean(),
  createdAt: archiveTimestampSchema
}).strict();

const systemImportRecordSchema = z.object({
  sourceId: z.string().uuid(),
  campaignId: z.string().uuid().nullable(),
  sourceType: identifierSchema,
  sourceName: shortTextSchema,
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  completedAt: archiveTimestampSchema.nullable()
}).strict();

const systemCostEventRecordSchema = z.object({
  sourceId: z.string().uuid(),
  campaignId: z.string().uuid().nullable(),
  providerKind: z.enum(["text", "image", "embedding"]),
  amountMicros: nonnegativeSafeIntegerSchema,
  occurredAt: archiveTimestampSchema
}).strict();

const systemActivityEventRecordSchema = z.object({
  sourceId: z.string().uuid(),
  campaignId: z.string().uuid().nullable(),
  eventType: identifierSchema,
  summary: shortTextSchema,
  occurredAt: archiveTimestampSchema
}).strict();

const systemRecordEnvelopeBase = {
  formatVersion: z.literal(1),
  sourceId: z.string().uuid()
};

/**
 * The archive stream is deliberately closed by domain. Each projection carries
 * only explicitly portable logical fields; operational and secret-bearing
 * source structures have no representation in this contract.
 */
export const systemRecordEnvelopeSchema = z.discriminatedUnion("domain", [
  z.object({ domain: z.literal("providers"), ...systemRecordEnvelopeBase, record: systemPortableProviderSchema }).strict(),
  z.object({ domain: z.literal("prompts"), ...systemRecordEnvelopeBase, record: systemPromptRecordSchema }).strict(),
  z.object({ domain: z.literal("worlds"), ...systemRecordEnvelopeBase, record: systemWorldRecordSchema }).strict(),
  z.object({ domain: z.literal("world-versions"), ...systemRecordEnvelopeBase, record: systemWorldVersionRecordSchema }).strict(),
  z.object({ domain: z.literal("world-drafts"), ...systemRecordEnvelopeBase, record: systemWorldDraftRecordSchema }).strict(),
  z.object({ domain: z.literal("campaigns"), ...systemRecordEnvelopeBase, record: systemCampaignRecordSchema }).strict(),
  z.object({ domain: z.literal("turns"), ...systemRecordEnvelopeBase, record: systemTurnRecordSchema }).strict(),
  z.object({ domain: z.literal("turn-corrections"), ...systemRecordEnvelopeBase, record: systemTurnCorrectionRecordSchema }).strict(),
  z.object({ domain: z.literal("campaign-state"), ...systemRecordEnvelopeBase, record: systemCampaignStateRecordSchema }).strict(),
  z.object({ domain: z.literal("campaign-history"), ...systemRecordEnvelopeBase, record: systemCampaignHistoryRecordSchema }).strict(),
  z.object({ domain: z.literal("canonical-facts"), ...systemRecordEnvelopeBase, record: systemCanonicalFactRecordSchema }).strict(),
  z.object({ domain: z.literal("chronicle"), ...systemRecordEnvelopeBase, record: systemChronicleRecordSchema }).strict(),
  z.object({ domain: z.literal("illustrations"), ...systemRecordEnvelopeBase, record: systemIllustrationRecordSchema }).strict(),
  z.object({ domain: z.literal("imports"), ...systemRecordEnvelopeBase, record: systemImportRecordSchema }).strict(),
  z.object({ domain: z.literal("cost-events"), ...systemRecordEnvelopeBase, record: systemCostEventRecordSchema }).strict(),
  z.object({ domain: z.literal("activity-events"), ...systemRecordEnvelopeBase, record: systemActivityEventRecordSchema }).strict()
]);

export const systemArchivePayloadSchema = z.object({
  formatVersion: z.literal(1),
  sourceInstallationId: z.string().uuid(),
  sourceOwnerCount: z.literal(1),
  sourceOwner: z.object({
    sourceId: z.string().uuid(),
    displayName: boundedStringSchema(300)
  }).strict(),
  records: z.array(systemRecordEnvelopeSchema)
}).strict();

export const systemArchiveSafeVersionsSchema = z.object({
  archiveFormat: z.literal(1),
  sourceApplication: boundedStringSchema(100),
  sourceMigration: z.string().regex(/^\d{4}_[a-z0-9_]+$/u).max(200),
  destinationApplication: boundedStringSchema(100),
  destinationMigration: boundedStringSchema(200)
}).strict();

const systemArchiveRebuildStatusSchema = z.enum(["pending", "queueing", "queued"]);
export const systemArchiveRebuildStateSchema = z.object({
  chronicleIndex: z.object({
    category: z.literal("chronicle-index"),
    status: systemArchiveRebuildStatusSchema,
    itemCount: nonnegativeSafeIntegerSchema
  }).strict(),
  assetThumbnails: z.object({
    category: z.literal("asset-thumbnails"),
    status: systemArchiveRebuildStatusSchema,
    itemCount: nonnegativeSafeIntegerSchema
  }).strict()
}).strict();

function operationalOmissionTotal(value: z.infer<typeof systemArchiveOperationalOmissionsSchema>): number {
  return Object.values(value).reduce((total, count) => total + count, 0);
}

export const systemArchiveReportSchema = z.object({
  completedAt: z.iso.datetime({ offset: true }),
  archiveFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  recordsByDomain: z.record(systemArchiveDomainSchema, nonnegativeSafeIntegerSchema),
  assetCount: nonnegativeSafeIntegerSchema,
  assetBytes: nonnegativeSafeIntegerSchema,
  omittedOperationalRows: nonnegativeSafeIntegerSchema,
  operationalOmissions: systemArchiveOperationalOmissionsSchema,
  warnings: z.array(boundedStringSchema(1_000)),
  errors: z.array(archiveErrorCodeSchema)
}).strict().superRefine((report, context) => {
  if (report.omittedOperationalRows !== operationalOmissionTotal(report.operationalOmissions)) {
    context.addIssue({
      code: "custom",
      path: ["omittedOperationalRows"],
      message: "Operational omission total must match its categorized inventory."
    });
  }
});

export const systemArchiveImportReportSchema = systemArchiveReportSchema.safeExtend({
  archiveFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  versions: systemArchiveSafeVersionsSchema,
  sourceOwnerCount: z.literal(1),
  ownerMapping: z.object({
    sourceOwnerId: z.string().uuid(),
    destinationOwnerId: z.string().uuid()
  }).strict(),
  disabledProviders: nonnegativeSafeIntegerSchema,
  normalization: z.tuple([
    z.literal("map-source-owner-to-initial-owner"),
    z.literal("disable-provider-profiles")
  ]),
  invalidatedAccess: z.tuple([
    z.literal("share-links"),
    z.literal("sessions"),
    z.literal("oidc-identities"),
    z.literal("external-authorizations")
  ]),
  integrityReconciliation: z.object({
    archiveFingerprintVerified: z.literal(true),
    recordsMatched: z.literal(true),
    assetsMatched: z.literal(true)
  }).strict(),
  rebuildState: systemArchiveRebuildStateSchema
}).strict();

const systemArchiveJobViewBase = {
  id: z.string().uuid(),
  status: systemArchiveJobStatusSchema,
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true })
};

export const systemArchiveJobViewSchema = z.discriminatedUnion("kind", [
  z.object({
    ...systemArchiveJobViewBase,
    kind: z.literal("export"),
    report: systemArchiveReportSchema.nullable()
  }).strict(),
  z.object({
    ...systemArchiveJobViewBase,
    kind: z.literal("import"),
    report: systemArchiveImportReportSchema.nullable()
  }).strict()
]);

export const systemUploadViewSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["created", "uploading", "completed", "expired", "failed"]),
  byteLength: nonnegativeSafeIntegerSchema,
  receivedBytes: nonnegativeSafeIntegerSchema,
  expiresAt: z.iso.datetime({ offset: true })
}).strict().superRefine((upload, context) => {
  if (upload.receivedBytes > upload.byteLength) {
    context.addIssue({ code: "custom", message: "Upload received bytes cannot exceed its declared byte length." });
  }
});

const systemArchiveCapacityCheckSchema = z.object({
  requiredBytes: nonnegativeSafeIntegerSchema,
  availableBytes: nonnegativeSafeIntegerSchema.nullable(),
  verified: z.boolean(),
  sufficient: z.boolean(),
  overrideUsed: z.boolean()
}).strict().superRefine((capacity, context) => {
  if ((capacity.availableBytes === null) === capacity.verified) {
    context.addIssue({ code: "custom", message: "Verified capacity requires an available-byte measurement." });
  }
  if (capacity.availableBytes !== null
    && capacity.sufficient !== (capacity.availableBytes >= capacity.requiredBytes)) {
    context.addIssue({ code: "custom", message: "Capacity sufficiency must match the measured available bytes." });
  }
  if (capacity.overrideUsed && (capacity.availableBytes !== null || !capacity.sufficient)) {
    context.addIssue({ code: "custom", message: "Only an unknown capacity may use the explicit sufficient-capacity override." });
  }
  if (capacity.availableBytes === null && capacity.sufficient !== capacity.overrideUsed) {
    context.addIssue({ code: "custom", message: "Unknown capacity is sufficient if and only if the operator override was used." });
  }
});

export const systemImportPreviewViewSchema = z.object({
  valid: z.boolean(),
  previewHandle: boundedStringSchema(200).nullable(),
  versions: systemArchiveSafeVersionsSchema,
  sourceOwnerCount: z.literal(1),
  archiveFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  recordsByDomain: z.record(systemArchiveDomainSchema, nonnegativeSafeIntegerSchema),
  assets: z.object({
    originalCount: nonnegativeSafeIntegerSchema,
    totalBytes: nonnegativeSafeIntegerSchema
  }).strict(),
  destinationEmpty: z.boolean(),
  ownerMapping: z.object({
    sourceOwnerId: z.string().uuid(),
    destinationOwnerId: z.string().uuid()
  }).strict(),
  disabledProviders: nonnegativeSafeIntegerSchema,
  omittedOperationalRows: nonnegativeSafeIntegerSchema,
  operationalOmissions: systemArchiveOperationalOmissionsSchema,
  invalidatedAccess: z.array(z.enum([
    "share-links", "sessions", "oidc-identities", "external-authorizations"
  ])).max(4),
  normalization: z.array(z.enum([
    "map-source-owner-to-initial-owner", "disable-provider-profiles"
  ])).max(2),
  rebuilds: systemArchiveRebuildStateSchema,
  space: z.object({
    staging: systemArchiveCapacityCheckSchema,
    assetRoot: systemArchiveCapacityCheckSchema
  }).strict(),
  warnings: z.array(boundedStringSchema(1_000)),
  errors: z.array(archiveErrorCodeSchema),
  expiresAt: z.iso.datetime({ offset: true }).nullable()
}).strict().superRefine((preview, context) => {
  const valid = preview.destinationEmpty
    && preview.archiveFingerprint !== null
    && preview.space.staging.sufficient
    && preview.space.assetRoot.sufficient
    && preview.errors.length === 0;
  if (preview.valid !== valid) {
    context.addIssue({ code: "custom", message: "System Import Preview validity does not match its verified checks." });
  }
  if ((preview.previewHandle === null) !== !preview.valid || (preview.expiresAt === null) !== !preview.valid) {
    context.addIssue({ code: "custom", message: "Only a valid preview may carry opaque preview authority." });
  }
  if (preview.omittedOperationalRows !== operationalOmissionTotal(preview.operationalOmissions)) {
    context.addIssue({
      code: "custom",
      path: ["omittedOperationalRows"],
      message: "Operational omission total must match its categorized inventory."
    });
  }
  if (preview.rebuilds.chronicleIndex.status !== "pending"
    || preview.rebuilds.assetThumbnails.status !== "pending"
    || preview.rebuilds.chronicleIndex.itemCount !== preview.recordsByDomain.campaigns
    || preview.rebuilds.assetThumbnails.itemCount !== preview.assets.originalCount) {
    context.addIssue({
      code: "custom",
      path: ["rebuilds"],
      message: "Import Preview rebuild work must match the portable authority inventory."
    });
  }
});

export const systemArchiveExportRequestSchema = z.object({
  idempotencyKey: boundedStringSchema(200)
}).strict();

export const systemArchiveUploadCreateRequestSchema = z.object({
  byteLength: nonnegativeSafeIntegerSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

export const systemArchiveImportCommitRequestSchema = z.object({
  previewHandle: boundedStringSchema(200),
  idempotencyKey: boundedStringSchema(200),
  acknowledgeSensitiveArchive: z.literal(true),
  acknowledgeEmptyDestination: z.literal(true),
  acknowledgeInvalidatedAccess: z.literal(true),
  acknowledgeProviderReentry: z.literal(true),
  acknowledgeNonCancellableBoundary: z.literal(true)
}).strict();

export const systemArchiveManifestSchema = archiveManifestSchema.safeExtend({
  archiveType: z.literal("system"),
  sourceApplication: boundedStringSchema(100),
  sourceMigration: z.string().regex(/^\d{4}_[a-z0-9_]+$/u).max(200),
  sourceInstallationId: z.string().uuid(),
  sourceOwnerCount: z.literal(1),
  sourceOwner: z.object({
    sourceId: z.string().uuid(),
    displayName: boundedStringSchema(300)
  }).strict(),
  omittedOperationalRows: nonnegativeSafeIntegerSchema,
  operationalOmissions: systemArchiveOperationalOmissionsSchema
}).strict().superRefine((manifest, context) => {
  if (manifest.omittedOperationalRows !== operationalOmissionTotal(manifest.operationalOmissions)) {
    context.addIssue({
      code: "custom",
      path: ["omittedOperationalRows"],
      message: "Operational omission total must match its categorized inventory."
    });
  }
});

export const systemArchiveAssetsPayloadSchema = z.object({
  formatVersion: z.literal(1),
  assets: z.array(archiveAssetRecordSchema)
}).strict();

export type SystemArchiveDomain = z.infer<typeof systemArchiveDomainSchema>;
export type SystemArchiveJobKind = z.infer<typeof systemArchiveJobKindSchema>;
export type SystemArchiveJobStatus = z.infer<typeof systemArchiveJobStatusSchema>;
export type SystemArchiveJobView = z.infer<typeof systemArchiveJobViewSchema>;
export type SystemArchivePayload = z.infer<typeof systemArchivePayloadSchema>;
export type SystemArchiveReport = z.infer<typeof systemArchiveReportSchema>;
export type SystemArchiveImportReport = z.infer<typeof systemArchiveImportReportSchema>;
export type SystemArchiveUploadView = z.infer<typeof systemUploadViewSchema>;
export type SystemImportPreviewView = z.infer<typeof systemImportPreviewViewSchema>;
export type SystemRecordEnvelope = z.infer<typeof systemRecordEnvelopeSchema>;
