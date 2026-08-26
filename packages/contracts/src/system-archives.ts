import { z } from "zod";
import {
  archiveAssetRecordSchema,
  archiveErrorCodeSchema,
  archiveManifestSchema,
  compactPortableAuthorityName,
  isExcludedPortableMetadataKey
} from "./archives.js";
import { providerRoleSchema, providerTypeSchema } from "./generation.js";

const nonnegativeSafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const nonBlankStringSchema = (maximum: number) => z.string().max(maximum).refine(
  (value) => value.trim().length > 0,
  "String must contain a non-whitespace character."
);
const boundedStringSchema = nonBlankStringSchema;
const archiveTimestampSchema = z.iso.datetime({ offset: true });
const identifierSchema = nonBlankStringSchema(300);
const shortTextSchema = z.string().max(10_000);
const longTextSchema = z.string().max(1_000_000);

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
  kind: providerRoleSchema,
  displayName: boundedStringSchema(200),
  baseUrl: z.url().max(2_000).nullable(),
  selectedModel: boundedStringSchema(300).nullable(),
  contextWindow: nonnegativeSafeIntegerSchema.nullable(),
  timeoutMs: nonnegativeSafeIntegerSchema.nullable(),
  retryLimit: nonnegativeSafeIntegerSchema.nullable(),
  enabled: z.literal(false),
  health: z.literal("unknown")
}).strict();

function validatePortableAuthorityJson(
  value: unknown,
  context: z.RefinementCtx,
  path: readonly PropertyKey[] = [],
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validatePortableAuthorityJson(item, context, [...path, index]));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (isExcludedPortableMetadataKey(key)) {
      context.addIssue({
        code: "custom",
        path: [...path, key],
        message: "Portable authority JSON cannot contain secrets, capabilities, operational state, or local storage authority."
      });
    } else {
      validatePortableAuthorityJson(child, context, [...path, key]);
    }
  }
}

export const systemPortableAuthorityJsonSchema = z.json().superRefine((value, context) => {
  validatePortableAuthorityJson(value, context);
});
const portableJsonSchema = systemPortableAuthorityJsonSchema;
const portableJsonObjectSchema = z.record(z.string(), z.json()).superRefine((value, context) => {
  validatePortableAuthorityJson(value, context);
});

const SIGNED_OR_TEMPORARY_QUERY_KEYS = new Set([
  "exp", "expires", "expiry", "se", "sig", "signature", "sp", "sr", "sv"
]);
const RAW_HTTP_URL_AUTHORITY_PATTERN = /^https?:\/\/([^/?#]+)(?:[/?#]|$)/iu;

function isLocalIpv4(parts: readonly [number, number, number, number]): boolean {
  const [first, second] = parts;
  return first === 0 || first === 10 || first === 127 || first >= 224
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

function isLocalPortableImageHost(hostname: string): boolean {
  const normalized = hostname.toLocaleLowerCase("en-US")
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost")
    || normalized.endsWith(".local") || normalized.endsWith(".internal")) return true;
  const ipv4 = normalized.split(".").map(Number);
  if (ipv4.length === 4 && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return isLocalIpv4(ipv4 as [number, number, number, number]);
  }
  const mappedIpv4 = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(normalized);
  if (mappedIpv4) {
    const high = Number.parseInt(mappedIpv4[1]!, 16);
    const low = Number.parseInt(mappedIpv4[2]!, 16);
    return isLocalIpv4([high >>> 8, high & 0xff, low >>> 8, low & 0xff]);
  }
  return normalized === "::" || normalized === "::1"
    || /^(?:fc|fd)/u.test(normalized)
    || /^fe[89ab]/u.test(normalized)
    || /^ff/u.test(normalized);
}

function isSecretBearingImageQueryKey(key: string): boolean {
  const compact = compactPortableAuthorityName(key);
  return isExcludedPortableMetadataKey(key)
    || SIGNED_OR_TEMPORARY_QUERY_KEYS.has(compact)
    || /^(?:xamz|xgoog|xms)/u.test(compact);
}

const UNSAFE_PORTABLE_IMAGE_PATH_SEGMENTS = new Set([
  "capability", "presigned", "signed", "temp", "temporary"
]);

function hasUnsafePortableImagePath(pathname: string): boolean {
  return pathname.split("/").some((encodedSegment) => {
    let decodedSegment: string;
    try {
      decodedSegment = decodeURIComponent(encodedSegment);
    } catch {
      return true;
    }
    if (decodedSegment.includes("%") || decodedSegment.includes("/") || decodedSegment.includes("\\")) {
      return true;
    }
    const compact = compactPortableAuthorityName(decodedSegment);
    return UNSAFE_PORTABLE_IMAGE_PATH_SEGMENTS.has(compact);
  });
}

interface ParsedPortableImageUrl {
  readonly protocol: string;
  readonly username: string;
  readonly password: string;
  readonly hash: string;
  readonly hostname: string;
  readonly pathname: string;
  readonly searchParams: { keys(): IterableIterator<string> };
}

export const systemPortableImageUrlSchema = z.string().max(1_000_000).superRefine((value, context) => {
  if (value.trim() !== value) {
    context.addIssue({ code: "custom", message: "Portable image authority must not contain surrounding whitespace." });
    return;
  }
  if (value === "" || /^\/api\/v1\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) return;
  const rawAuthority = RAW_HTTP_URL_AUTHORITY_PATTERN.exec(value);
  if (!rawAuthority) {
    context.addIssue({ code: "custom", message: "Portable image authority must use canonical HTTP(S) authority syntax." });
    return;
  }
  let url: ParsedPortableImageUrl;
  try {
    const Url = Reflect.get(globalThis, "URL") as
      | (new (input: string) => ParsedPortableImageUrl)
      | undefined;
    if (Url === undefined) throw new TypeError("URL parser is unavailable.");
    url = new Url(value);
  } catch {
    context.addIssue({ code: "custom", message: "Portable image authority must be a stable HTTP(S) URL." });
    return;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || url.username !== "" || url.password !== ""
    || rawAuthority[1]!.includes("@") || value.includes("#") || url.hash !== ""
    || isLocalPortableImageHost(url.hostname)
    || [...url.searchParams.keys()].some(isSecretBearingImageQueryKey)
    || hasUnsafePortableImagePath(url.pathname)) {
    context.addIssue({
      code: "custom",
      message: "Portable image authority cannot contain local, temporary, signed, credentialed, or secret-bearing URLs."
    });
  }
});
const safeProviderConfigurationSchema = z.object({
  streaming: z.boolean().optional(),
  streamingSupport: z.boolean().optional(),
  httpReferer: z.string().optional(),
  modelDiscoveryEnabled: z.boolean().optional(),
  network: z.enum(["fast", "relaxed"]).optional(),
  tokenType: z.enum(["auto", "sogni", "spark"]).optional(),
  contentFilter: z.enum(["enabled", "disabled"]).optional(),
  defaultWidth: z.number().finite().optional(),
  defaultHeight: z.number().finite().optional(),
  defaultAspectRatio: z.string().optional(),
  defaultSizePreset: z.string().optional(),
  defaultOutputFormat: z.enum(["png", "jpeg", "webp"]).optional(),
  defaultQuality: z.enum(["auto", "low", "medium", "high"]).optional(),
  defaultImageCount: z.number().finite().optional(),
  defaultSteps: z.number().finite().optional(),
  defaultGuidance: z.number().finite().optional(),
  defaultSeed: z.number().finite().optional(),
  defaultSampler: z.string().optional(),
  defaultScheduler: z.string().optional(),
  defaultPreviewCount: z.number().finite().optional(),
  pollIntervalMs: z.number().finite().optional(),
  maximumPollIntervalMs: z.number().finite().optional(),
  generationTimeoutMs: z.number().finite().optional(),
  maximumAttempts: z.number().finite().optional(),
  retryLimit: nonnegativeSafeIntegerSchema.optional(),
  allowPrivateArtifactHosts: z.boolean().optional(),
  embeddingMaxInputTokens: z.number().int().optional(),
  embeddingMaxBatchItems: z.number().int().optional(),
  embeddingMaxBatchTokens: z.number().int().optional(),
  embeddingDimensions: z.number().int().optional(),
  embeddingMaxRetries: z.number().int().optional()
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
  forkedFromWorldId: z.string().uuid().nullable(),
  forkedFromWorldVersionId: z.string().uuid().nullable(),
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

const characterProfileTextSchema = z.string().max(20_000);
const characterProfileShortTextSchema = z.string().max(2_000);

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
  id: identifierSchema,
  name: identifierSchema,
  characterText: longTextSchema,
  profile: z.object({
    identity: z.object({
      aliases: z.array(boundedStringSchema(200)).max(20).optional(),
      pronouns: characterProfileShortTextSchema.optional()
    }).strict().optional(),
    story: z.object({
      role: characterProfileTextSchema.optional(),
      background: characterProfileTextSchema.optional(),
      personality: characterProfileTextSchema.optional(),
      motivations: characterProfileTextSchema.optional(),
      goals: characterProfileTextSchema.optional(),
      fearsAndConflicts: characterProfileTextSchema.optional(),
      keyRelationships: characterProfileTextSchema.optional(),
      narrativeHooks: characterProfileTextSchema.optional(),
      voiceAndMannerisms: characterProfileTextSchema.optional(),
      otherGuidance: characterProfileTextSchema.optional()
    }).strict().optional(),
    appearance: z.object({
      ancestryOrSpecies: characterProfileShortTextSchema.optional(),
      apparentAge: characterProfileShortTextSchema.optional(),
      genderPresentation: characterProfileShortTextSchema.optional(),
      build: characterProfileShortTextSchema.optional(),
      skinOrComplexion: characterProfileShortTextSchema.optional(),
      face: characterProfileTextSchema.optional(),
      eyes: characterProfileShortTextSchema.optional(),
      hair: characterProfileTextSchema.optional(),
      distinguishingFeatures: z.array(boundedStringSchema(2_000)).max(50).optional(),
      clothing: characterProfileTextSchema.optional(),
      equipmentAndAccessories: characterProfileTextSchema.optional(),
      otherVisualDetails: characterProfileTextSchema.optional()
    }).strict().optional(),
    unclassifiedNotes: z.string().max(200_000).optional()
  }).strict().optional(),
  rpgStats: z.array(systemRpgStatSchema).max(10_000),
  defaultTriggers: z.array(systemDefaultTriggerSchema).max(10_000),
  source: z.object({
    type: boundedStringSchema(100).optional(),
    revision: nonnegativeSafeIntegerSchema.optional(),
    index: nonnegativeSafeIntegerSchema.optional(),
    externalId: boundedStringSchema(300).optional()
  }).strict()
}).strict();

// Explicit v1 compatibility boundary: legacy profiles may omit known sections and
// fields, but unknown authority (including provider/session material) is rejected.
// Parsing preserves the supplied shape and never manufactures profile defaults.
const systemCompatibleCharacterProfileSchema = z.object({
  identity: z.object({
    aliases: z.array(boundedStringSchema(200)).max(20).optional(),
    pronouns: characterProfileShortTextSchema.optional()
  }).strict().optional(),
  story: z.object({
    role: characterProfileTextSchema.optional(),
    background: characterProfileTextSchema.optional(),
    personality: characterProfileTextSchema.optional(),
    motivations: characterProfileTextSchema.optional(),
    goals: characterProfileTextSchema.optional(),
    fearsAndConflicts: characterProfileTextSchema.optional(),
    keyRelationships: characterProfileTextSchema.optional(),
    narrativeHooks: characterProfileTextSchema.optional(),
    voiceAndMannerisms: characterProfileTextSchema.optional(),
    otherGuidance: characterProfileTextSchema.optional()
  }).strict().optional(),
  appearance: z.object({
    ancestryOrSpecies: characterProfileShortTextSchema.optional(),
    apparentAge: characterProfileShortTextSchema.optional(),
    genderPresentation: characterProfileShortTextSchema.optional(),
    build: characterProfileShortTextSchema.optional(),
    skinOrComplexion: characterProfileShortTextSchema.optional(),
    face: characterProfileTextSchema.optional(),
    eyes: characterProfileShortTextSchema.optional(),
    hair: characterProfileTextSchema.optional(),
    distinguishingFeatures: z.array(boundedStringSchema(2_000)).max(50).optional(),
    clothing: characterProfileTextSchema.optional(),
    equipmentAndAccessories: characterProfileTextSchema.optional(),
    otherVisualDetails: characterProfileTextSchema.optional()
  }).strict().optional(),
  unclassifiedNotes: z.string().max(200_000).optional()
}).strict();

const systemCampaignCharacterProfileSchema = z.object({
  name: identifierSchema,
  profile: systemCompatibleCharacterProfileSchema
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
  selectedCharacterId: identifierSchema.nullable(),
  characterSnapshot: systemCharacterSnapshotSchema.nullable(),
  characterProfile: systemCampaignCharacterProfileSchema.nullable(),
  characterProfileRevision: nonnegativeSafeIntegerSchema,
  createdAt: archiveTimestampSchema,
  updatedAt: archiveTimestampSchema
}).strict().superRefine((record, context) => {
  if (record.selectedCharacterId === null) {
    if (record.characterSnapshot !== null || record.characterProfile !== null
      || record.characterProfileRevision !== 0) {
      context.addIssue({
        code: "custom",
        path: ["selectedCharacterId"],
        message: "Campaign character authority must be consistently absent."
      });
    }
    return;
  }
  if (record.characterSnapshot?.id !== record.selectedCharacterId) {
    context.addIssue({
      code: "custom",
      path: ["characterSnapshot", "id"],
      message: "Selected character ID must match its campaign-owned snapshot."
    });
  }
  if ((record.characterProfile === null) !== (record.characterProfileRevision === 0)) {
    context.addIssue({
      code: "custom",
      path: ["characterProfileRevision"],
      message: "Campaign character profile and revision must be consistent."
    });
  }
});

// Accepted historical turns may predate individual state fields. This adapter
// admits only omitted known fields; it neither accepts arbitrary keys nor fills
// omitted authority with current-state defaults.
const systemHistoricalCampaignStateSnapshotSchema = systemCampaignStateSnapshotSchema.partial().strict();

const systemTurnRecordSchema = z.object({
  sourceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  turnNumber: z.number().int().positive(),
  action: longTextSchema,
  narration: longTextSchema,
  choices: z.array(shortTextSchema).max(100),
  imagePrompt: longTextSchema,
  stateSnapshotPrivate: systemHistoricalCampaignStateSnapshotSchema,
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
  previousProfile: systemCampaignCharacterProfileSchema.nullable(),
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
  sourceCampaignId: z.string().uuid().nullable(),
  targetCampaignId: z.string().uuid().nullable(),
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
  embeddingDocumentPrefix: z.string().max(4_000).nullable(),
  embeddingQueryPrefix: z.string().max(4_000).nullable(),
  retrievalImplementation: z.enum(["legacy_hybrid", "chunked_hybrid"]),
  retrievalShadowEnabled: z.boolean(),
  createdAt: archiveTimestampSchema,
  updatedAt: archiveTimestampSchema
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
  sourcePolicy: z.enum(["off", "library_only", "library_then_generate", "generate_only"]),
  matchingScope: z.enum(["campaign", "world", "owner_library", "shared"]),
  confidenceProfile: z.enum(["strict", "balanced", "broad"]),
  repetitionWindow: z.number().int().min(0).max(100),
  segmentWordCount: z.number().int().min(100).max(5_000),
  imagesPerSegment: z.number().int().min(1).max(2),
  segmentPromptMode: z.enum(["direct", "ai_refined"]),
  refinementPrompt: z.string().max(4_000),
  createdAt: archiveTimestampSchema,
  updatedAt: archiveTimestampSchema
}).strict().superRefine((details, context) => {
  if (details.enabled !== (details.sourcePolicy !== "off")) {
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
      characterVisualReference: z.string().max(20_000),
      completedAt: archiveTimestampSchema.nullable()
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

const systemPortableProviderV2Schema = systemPortableProviderSchema.safeExtend({
  authority: z.object({
    providerType: providerTypeSchema,
    providerRole: providerRoleSchema,
    defaultModel: z.string().max(300),
    contextWindowTokens: nonnegativeSafeIntegerSchema,
    maxOutputTokens: nonnegativeSafeIntegerSchema,
    temperature: z.number().finite(),
    configuration: safeProviderConfigurationSchema,
    requestTimeoutMs: nonnegativeSafeIntegerSchema,
    enabled: z.boolean(),
    isDefault: z.boolean(),
    createdAt: archiveTimestampSchema,
    updatedAt: archiveTimestampSchema
  }).strict()
});

const systemPromptRecordV2Schema = systemPromptRecordSchema.safeExtend({
  authority: z.object({ createdAt: archiveTimestampSchema }).strict()
});

const systemWorldRecordV2Schema = systemWorldRecordSchema.safeExtend({
  authority: z.object({
    nextVersionNumber: z.number().int().positive(),
    coverAssetId: z.string().uuid().nullable()
  }).strict()
});

const systemWorldVersionRecordV2Schema = systemWorldVersionRecordSchema.safeExtend({
  authority: z.object({
    sourceHash: z.string().max(2_000).nullable(),
    createdAt: archiveTimestampSchema
  }).strict()
});

const systemWorldDraftRecordV2Schema = systemWorldDraftRecordSchema.safeExtend({
  authority: z.object({}).strict()
});

const systemCampaignRecordV2Schema = systemCampaignRecordSchema.safeExtend({
  authority: z.object({
    textProviderProfileId: z.string().uuid().nullable(),
    imageProviderProfileId: z.string().uuid().nullable(),
    storyLengthProfile: z.enum(["brief", "standard", "long", "extended"]),
    turnControlStyle: z.enum(["action_only", "flexible_auto", "flexible_action", "flexible_scene"]),
    legacySettings: portableJsonObjectSchema
  }).strict()
});

const systemTurnRecordV2Schema = systemTurnRecordSchema.safeExtend({
  authority: z.object({
    sourceTurnId: z.string().max(2_000).nullable(),
    customActionSuggestion: z.string().max(1_000_000),
    imageUrl: systemPortableImageUrlSchema.nullable(),
    mechanicsPrivate: portableJsonSchema.nullable(),
    modelMetadata: portableJsonObjectSchema,
    importMetadata: portableJsonObjectSchema,
    createdAt: archiveTimestampSchema,
    inputMode: z.enum(["action", "scene"]),
    inputModeSource: z.enum(["explicit", "auto", "generated_choice", "opening_action", "fallback"])
  }).strict()
});

const systemTurnCorrectionRecordV2Schema = systemTurnCorrectionRecordSchema.safeExtend({
  authority: z.object({
    campaignId: z.string().uuid(),
    createdByUserId: z.string().uuid(),
    createdAt: archiveTimestampSchema
  }).strict()
});

const systemCampaignStateRecordV2Schema = systemCampaignStateRecordSchema.safeExtend({
  authority: z.object({
    importProvenance: portableJsonSchema,
    scratchpadSafeForPrompt: z.boolean(),
    initialStateSnapshot: portableJsonSchema
  }).strict()
});

const systemCampaignHistoryRecordV2Base = {
  sourceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  content: longTextSchema,
  occurredAt: archiveTimestampSchema
};
const systemCampaignHistoryRecordV2Schema = z.union([
  z.object({
    ...systemCampaignHistoryRecordV2Base,
    eventType: z.enum([
      "character-profile-edit", "campaign-state-edit", "world-migration",
      "memory-config", "illustration-config", "accepted-turn-mode"
    ]),
    authority: z.object({}).strict()
  }).strict(),
  z.object({
    ...systemCampaignHistoryRecordV2Base,
    eventType: z.literal("world-transfer"),
    authority: z.object({ idempotencyKey: z.string().uuid() }).strict()
  }).strict(),
  z.object({
    ...systemCampaignHistoryRecordV2Base,
    eventType: z.literal("illustration-set"),
    authority: z.object({
      sourceTextHash: z.string().regex(/^[a-f0-9]{64}$/)
    }).strict()
  }).strict(),
  z.object({
    ...systemCampaignHistoryRecordV2Base,
    eventType: z.literal("illustration-segment"),
    authority: z.object({
      sourceText: z.string().max(1_000_000),
      sourceTextHash: z.string().regex(/^[a-f0-9]{64}$/),
      updatedAt: archiveTimestampSchema
    }).strict()
  }).strict()
]);

const systemCanonicalFactRecordV2Schema = systemCanonicalFactRecordSchema.safeExtend({
  authority: z.object({
    content: longTextSchema,
    normalizedContent: longTextSchema,
    entities: z.array(z.string().max(10_000)).max(10_000),
    metadata: portableJsonObjectSchema,
    entityIds: z.array(z.string().uuid()).max(10_000)
  }).strict()
});

const systemChronicleRecordV2Schema = z.discriminatedUnion("kind", [
  z.object({
    sourceId: z.string().uuid(),
    campaignId: z.string().uuid(),
    kind: z.literal("memory"),
    turnId: z.string().uuid().nullable(),
    memoryKind: z.enum([
      "turn_fiction", "legacy_summary", "campaign_summary", "canonical_fact", "open_thread"
    ]),
    content: z.string().max(1_000_000),
    authority: z.object({
      worldVersionId: z.string().uuid(),
      ordinal: nonnegativeSafeIntegerSchema,
      tokenEstimate: nonnegativeSafeIntegerSchema,
      importance: z.number().finite(),
      entities: z.array(z.string().max(10_000)).max(10_000),
      metadata: portableJsonObjectSchema,
      entityIds: z.array(z.string().uuid()).max(10_000),
      contentHash: z.string().regex(/^[a-f0-9]{64}$/),
      createdAt: archiveTimestampSchema,
      updatedAt: archiveTimestampSchema
    }).strict()
  }).strict(),
  z.object({
    sourceId: z.string().uuid(),
    campaignId: z.string().uuid(),
    kind: z.literal("summary-checkpoint"),
    throughTurn: nonnegativeSafeIntegerSchema,
    summaryKind: systemSummaryCheckpointKindSchema,
    content: portableJsonSchema,
    authority: z.object({
      tokenEstimate: nonnegativeSafeIntegerSchema,
      createdAt: archiveTimestampSchema
    }).strict()
  }).strict()
]);

const systemIllustrationRecordV2Schema = systemIllustrationRecordSchema.safeExtend({
  authority: z.object({
    segmentId: z.string().uuid(),
    variantIndex: nonnegativeSafeIntegerSchema,
    createdAt: archiveTimestampSchema
  }).strict()
});

const systemImportRecordV2Schema = systemImportRecordSchema.safeExtend({
  authority: z.object({
    status: z.enum(["processing", "completed", "failed"]),
    worldId: z.string().uuid().nullable(),
    worldVersionId: z.string().uuid().nullable(),
    stats: portableJsonObjectSchema,
    errorMessage: z.string().max(1_000_000).nullable(),
    createdAt: archiveTimestampSchema
  }).strict()
});

const systemCostEventRecordV2Schema = z.object({
  sourceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  authority: z.object({
    turnId: z.string().uuid().nullable(),
    providerProfileId: z.string().uuid().nullable(),
    localCallId: z.string().uuid(),
    providerType: providerTypeSchema,
    category: z.enum(["story", "image", "memory"]),
    operation: nonBlankStringSchema(300),
    requestedModel: z.string().max(300).nullable(),
    resolvedModel: z.string().max(300).nullable(),
    amount: z.string().regex(/^-?\d+(?:\.\d+)?$/),
    currency: nonBlankStringSchema(20),
    usageMetadata: portableJsonObjectSchema,
    occurredAt: archiveTimestampSchema,
    createdAt: archiveTimestampSchema
  }).strict()
}).strict();

const systemActivityEventRecordV2Schema = z.object({
  sourceId: z.string().refine(
    (value) => value.length <= 19
      && /^[1-9]\d*$/u.test(value)
      && BigInt(value) <= 9_223_372_036_854_775_807n,
    "Activity identity must fit a positive PostgreSQL signed bigint."
  ),
  campaignId: z.string().uuid().nullable(),
  eventType: identifierSchema,
  authority: z.object({
    correlationId: z.string().max(2_000).nullable(),
    details: portableJsonObjectSchema,
    createdAt: archiveTimestampSchema
  }).strict()
}).strict();

const systemRecordEnvelopeV1Base = {
  formatVersion: z.literal(1),
  sourceId: z.string().uuid()
};
const systemRecordEnvelopeV2Base = {
  formatVersion: z.literal(2),
  sourceId: identifierSchema
};

/**
 * The archive stream is deliberately closed by domain. Each projection carries
 * only explicitly portable logical fields; operational and secret-bearing
 * source structures have no representation in this contract.
 */
const systemRecordEnvelopeV1Schema = z.discriminatedUnion("domain", [
  z.object({ domain: z.literal("providers"), ...systemRecordEnvelopeV1Base, record: systemPortableProviderSchema }).strict(),
  z.object({ domain: z.literal("prompts"), ...systemRecordEnvelopeV1Base, record: systemPromptRecordSchema }).strict(),
  z.object({ domain: z.literal("worlds"), ...systemRecordEnvelopeV1Base, record: systemWorldRecordSchema }).strict(),
  z.object({ domain: z.literal("world-versions"), ...systemRecordEnvelopeV1Base, record: systemWorldVersionRecordSchema }).strict(),
  z.object({ domain: z.literal("world-drafts"), ...systemRecordEnvelopeV1Base, record: systemWorldDraftRecordSchema }).strict(),
  z.object({ domain: z.literal("campaigns"), ...systemRecordEnvelopeV1Base, record: systemCampaignRecordSchema }).strict(),
  z.object({ domain: z.literal("turns"), ...systemRecordEnvelopeV1Base, record: systemTurnRecordSchema }).strict(),
  z.object({ domain: z.literal("turn-corrections"), ...systemRecordEnvelopeV1Base, record: systemTurnCorrectionRecordSchema }).strict(),
  z.object({ domain: z.literal("campaign-state"), ...systemRecordEnvelopeV1Base, record: systemCampaignStateRecordSchema }).strict(),
  z.object({ domain: z.literal("campaign-history"), ...systemRecordEnvelopeV1Base, record: systemCampaignHistoryRecordSchema }).strict(),
  z.object({ domain: z.literal("canonical-facts"), ...systemRecordEnvelopeV1Base, record: systemCanonicalFactRecordSchema }).strict(),
  z.object({ domain: z.literal("chronicle"), ...systemRecordEnvelopeV1Base, record: systemChronicleRecordSchema }).strict(),
  z.object({ domain: z.literal("illustrations"), ...systemRecordEnvelopeV1Base, record: systemIllustrationRecordSchema }).strict(),
  z.object({ domain: z.literal("imports"), ...systemRecordEnvelopeV1Base, record: systemImportRecordSchema }).strict(),
  z.object({ domain: z.literal("cost-events"), ...systemRecordEnvelopeV1Base, record: systemCostEventRecordSchema }).strict(),
  z.object({ domain: z.literal("activity-events"), ...systemRecordEnvelopeV1Base, record: systemActivityEventRecordSchema }).strict()
]);

const systemRecordEnvelopeV2Schema = z.discriminatedUnion("domain", [
  z.object({ domain: z.literal("providers"), ...systemRecordEnvelopeV2Base, record: systemPortableProviderV2Schema }).strict(),
  z.object({ domain: z.literal("prompts"), ...systemRecordEnvelopeV2Base, record: systemPromptRecordV2Schema }).strict(),
  z.object({ domain: z.literal("worlds"), ...systemRecordEnvelopeV2Base, record: systemWorldRecordV2Schema }).strict(),
  z.object({ domain: z.literal("world-versions"), ...systemRecordEnvelopeV2Base, record: systemWorldVersionRecordV2Schema }).strict(),
  z.object({ domain: z.literal("world-drafts"), ...systemRecordEnvelopeV2Base, record: systemWorldDraftRecordV2Schema }).strict(),
  z.object({ domain: z.literal("campaigns"), ...systemRecordEnvelopeV2Base, record: systemCampaignRecordV2Schema }).strict(),
  z.object({ domain: z.literal("turns"), ...systemRecordEnvelopeV2Base, record: systemTurnRecordV2Schema }).strict(),
  z.object({ domain: z.literal("turn-corrections"), ...systemRecordEnvelopeV2Base, record: systemTurnCorrectionRecordV2Schema }).strict(),
  z.object({ domain: z.literal("campaign-state"), ...systemRecordEnvelopeV2Base, record: systemCampaignStateRecordV2Schema }).strict(),
  z.object({ domain: z.literal("campaign-history"), ...systemRecordEnvelopeV2Base, record: systemCampaignHistoryRecordV2Schema }).strict(),
  z.object({ domain: z.literal("canonical-facts"), ...systemRecordEnvelopeV2Base, record: systemCanonicalFactRecordV2Schema }).strict(),
  z.object({ domain: z.literal("chronicle"), ...systemRecordEnvelopeV2Base, record: systemChronicleRecordV2Schema }).strict(),
  z.object({ domain: z.literal("illustrations"), ...systemRecordEnvelopeV2Base, record: systemIllustrationRecordV2Schema }).strict(),
  z.object({ domain: z.literal("imports"), ...systemRecordEnvelopeV2Base, record: systemImportRecordV2Schema }).strict(),
  z.object({ domain: z.literal("cost-events"), ...systemRecordEnvelopeV2Base, record: systemCostEventRecordV2Schema }).strict(),
  z.object({ domain: z.literal("activity-events"), ...systemRecordEnvelopeV2Base, record: systemActivityEventRecordV2Schema }).strict()
]);

export const systemRecordEnvelopeSchema = z.union([
  systemRecordEnvelopeV2Schema,
  systemRecordEnvelopeV1Schema
]);

const systemArchivePayloadV1Schema = z.object({
  formatVersion: z.literal(1),
  sourceInstallationId: z.string().uuid(),
  sourceOwnerCount: z.literal(1),
  sourceOwner: z.object({
    sourceId: z.string().uuid(),
    displayName: boundedStringSchema(300)
  }).strict(),
  records: z.array(systemRecordEnvelopeSchema)
}).strict().superRefine((payload, context) => {
  if (payload.records.some((record) => record.formatVersion !== 1)) {
    context.addIssue({ code: "custom", path: ["records"], message: "Version-one payloads require version-one records." });
  }
});

const systemArchivePayloadV2Schema = z.object({
  formatVersion: z.literal(2),
  sourceInstallationId: z.string().uuid(),
  sourceOwnerCount: z.literal(1),
  sourceOwner: z.object({
    sourceId: z.string().uuid(),
    displayName: boundedStringSchema(300),
    status: z.enum(["active", "disabled"]),
    settings: portableJsonObjectSchema,
    createdAt: archiveTimestampSchema,
    updatedAt: archiveTimestampSchema
  }).strict(),
  records: z.array(systemRecordEnvelopeV2Schema)
}).strict();

export const systemArchivePayloadSchema = z.union([
  systemArchivePayloadV2Schema,
  systemArchivePayloadV1Schema
]);

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

const systemArchiveAssetsPayloadV1Schema = z.object({
  formatVersion: z.literal(1),
  assets: z.array(archiveAssetRecordSchema)
}).strict();

export const systemArchiveAssetBindingV2Schema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("world_cover"), worldId: z.uuid() }).strict(),
  z.object({
    role: z.literal("world_version_asset"),
    worldId: z.uuid(),
    worldVersionId: z.uuid()
  }).strict(),
  z.object({ role: z.literal("campaign_asset"), campaignId: z.uuid() }).strict(),
  z.object({
    role: z.literal("turn_illustration"),
    campaignId: z.uuid(),
    turnId: z.uuid()
  }).strict(),
  z.object({
    role: z.literal("illustration_segment_variant"),
    campaignId: z.uuid(),
    turnId: z.uuid(),
    segmentId: z.uuid(),
    variantIndex: nonnegativeSafeIntegerSchema,
    createdAt: archiveTimestampSchema
  }).strict(),
  z.object({
    role: z.literal("imported_attachment"),
    campaignId: z.uuid(),
    turnId: z.uuid().nullable()
  }).strict(),
  z.object({
    role: z.literal("generation_context"),
    campaignId: z.uuid().nullable(),
    worldId: z.uuid().nullable(),
    worldVersionId: z.uuid().nullable(),
    turnId: z.uuid().nullable(),
    sourceContextId: z.uuid(),
    authority: z.object({
      createdByUserId: z.uuid(),
      targetType: z.enum(["world_cover", "turn_illustration", "streaming_illustration", "other"]),
      variantIndex: nonnegativeSafeIntegerSchema,
      fictionPrompt: z.string().max(20_000),
      negativePrompt: z.string().max(10_000).nullable(),
      entities: portableJsonSchema,
      characters: portableJsonSchema,
      locations: portableJsonSchema,
      factions: portableJsonSchema,
      sceneAttributes: portableJsonSchema,
      providerProfileId: z.uuid().nullable(),
      providerType: z.string().max(300).nullable(),
      model: z.string().max(500),
      generationParameters: portableJsonSchema,
      parentAssetIds: z.array(z.uuid()).max(10_000),
      metadataSchemaVersion: z.number().int().positive(),
      createdAt: archiveTimestampSchema
    }).strict()
  }).strict()
]);

export const systemArchiveAssetRecordV2Schema = archiveAssetRecordSchema.safeExtend({
  technicalMetadata: portableJsonObjectSchema,
  bindings: z.array(systemArchiveAssetBindingV2Schema),
  authority: z.object({
    references: z.array(z.object({
      sourceId: z.string().uuid(),
      campaignId: z.string().uuid(),
      turnId: z.string().uuid().nullable(),
      assetRole: identifierSchema,
      createdAt: archiveTimestampSchema
    }).strict()).max(100_000),
    library: z.object({
      createdByUserId: z.string().uuid(),
      metadataRevision: z.number().int().positive(),
      createdAt: archiveTimestampSchema,
      updatedAt: archiveTimestampSchema
    }).strict().nullable()
  }).strict()
});

const systemArchiveAssetsPayloadV2Schema = z.object({
  formatVersion: z.literal(2),
  assets: z.array(systemArchiveAssetRecordV2Schema)
}).strict();

export const systemArchiveAssetsPayloadSchema = z.union([
  systemArchiveAssetsPayloadV2Schema,
  systemArchiveAssetsPayloadV1Schema
]);

export const systemArchiveManifestSchema = archiveManifestSchema.safeExtend({
  archiveType: z.literal("system"),
  assets: z.array(z.union([systemArchiveAssetRecordV2Schema, archiveAssetRecordSchema])),
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
export type SystemArchiveAssetBindingV2 = z.infer<typeof systemArchiveAssetBindingV2Schema>;
export type SystemArchiveAssetRecordV2 = z.infer<typeof systemArchiveAssetRecordV2Schema>;
export type SystemArchiveAssetRecord =
  | z.infer<typeof archiveAssetRecordSchema>
  | SystemArchiveAssetRecordV2;
