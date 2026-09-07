import { z } from "zod";
import { apiTimestampSchema } from "./http.js";
import {
  playableCharacterSchema,
  worldContentSchema,
  type PlayableCharacter,
  type WorldContent
} from "./world-library.js";

export const authoringStageSchema = z.enum(["world", "character", "organizer"]);
export const authoringIssueSchema = z.object({
  path: z.string().max(500),
  code: z.string().max(100),
  message: z.string().max(500)
}).strict();
export const authoringFailureCodeSchema = z.enum([
  "invalid_authoring_output",
  "authoring_output_limit",
  "authoring_provider_unavailable",
  "authoring_provider_timeout",
  "authoring_provider_rejected",
  "authoring_context_exceeded",
  "authoring_conflict",
  "authoring_expired",
  "authoring_cancelled",
  "authoring_retry_exhausted",
  "authoring_apply_unavailable"
]);
export const authoringFailureSchema = z.object({
  code: authoringFailureCodeSchema,
  stage: authoringStageSchema,
  retryable: z.boolean(),
  issues: z.array(authoringIssueSchema).max(20),
  correlationId: z.string().trim().min(1).max(200).optional()
}).strict();

export type AuthoringStage = z.infer<typeof authoringStageSchema>;
export type AuthoringIssue = z.infer<typeof authoringIssueSchema>;
export type AuthoringFailure = z.infer<typeof authoringFailureSchema>;

export const authoringKindSchema = z.enum(["world_concept", "character"]);
export const authoringJobStatusSchema = z.enum([
  "queued", "running", "awaiting_review", "recoverable", "failed",
  "cancel_requested", "cancelled", "applied", "expired"
]);
export const authoringStageStatusSchema = z.enum([
  "queued", "running", "validated", "recoverable", "failed", "cancelled"
]);

const authoringIdSchema = z.string().trim().min(1).max(200);
const authoringRevisionSchema = z.number().int().nonnegative();
const authoringDraftRevisionSchema = z.number().int().positive();
const authoringPromptSchema = z.string().trim().min(1).max(200_000);
const authoringIdempotencyKeySchema = z.string().trim().min(1).max(512);

export const authoringTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("new_world") }).strict(),
  z.object({
    kind: z.literal("world_draft"),
    worldId: authoringIdSchema,
    expectedRevision: authoringDraftRevisionSchema,
    characterId: authoringIdSchema.optional()
  }).strict()
]);

const worldConceptSubmitSchema = z.object({
  kind: z.literal("world_concept"),
  idempotencyKey: authoringIdempotencyKeySchema,
  target: authoringTargetSchema,
  prompt: authoringPromptSchema
}).strict();

const characterSubmitSchema = z.object({
  kind: z.literal("character"),
  idempotencyKey: authoringIdempotencyKeySchema,
  target: authoringTargetSchema,
  prompt: authoringPromptSchema,
  content: worldContentSchema,
  characterId: authoringIdSchema.optional()
}).strict().superRefine((value, context) => {
  if (value.target.kind === "new_world" && value.characterId !== undefined && !value.content.playableCharacters.some((character) => character.id === value.characterId)) {
    context.addIssue({ code: "custom", path: ["characterId"], message: "The selected character must belong to the submitted local world." });
  }
  if (value.target.kind === "world_draft" && value.target.characterId !== undefined && value.characterId !== undefined && value.target.characterId !== value.characterId) {
    context.addIssue({ code: "custom", path: ["characterId"], message: "The selected character must match the draft target." });
  }
});

export const authoringSubmitSchema = z.discriminatedUnion("kind", [worldConceptSubmitSchema, characterSubmitSchema]);

/**
 * Existing drafts have one durable character identity. Canonicalize the two
 * compatible request spellings before idempotency hashing and persistence.
 * New-world requests retain their root characterId because it identifies an
 * unsaved local-parent edit rather than a persisted draft target.
 */
export function normalizeAuthoringSubmitForAdmission(input: AuthoringSubmit): AuthoringSubmit {
  if (input.kind !== "character" || input.target.kind !== "world_draft") return input;
  const characterId = input.target.characterId ?? input.characterId;
  if (characterId === undefined) return input;
  const { characterId: _rootCharacterId, ...request } = input;
  return { ...request, target: { ...input.target, characterId } };
}

/** Internal durable-stage contract. It is not part of any HTTP response projection. */
export const authoringWorldOutlineSchema = z.object({
  title: z.string().trim().min(1).max(500),
  genre: z.string().trim().min(1).max(500),
  tone: z.string().trim().min(1).max(500),
  backgroundStory: z.string().trim().min(1).max(100_000),
  premise: z.string().trim().min(1).max(100_000),
  firstAction: z.string().trim().min(1).max(100_000),
  rules: z.string().trim().max(100_000),
  seeds: z.array(z.object({
    id: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(500),
    role: z.string().trim().min(1).max(1_000),
    concept: z.string().trim().min(1).max(10_000),
    narrativeHook: z.string().trim().min(1).max(10_000)
  }).strict()).max(100),
  rpgStats: z.array(z.unknown()).max(10_000),
  defaultTriggers: z.array(z.unknown()).max(10_000),
  eventTriggers: z.array(z.unknown()).max(10_000)
}).strict();

export const authoringStageOutputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("outline"), outline: authoringWorldOutlineSchema }).strict(),
  z.object({ kind: z.literal("character"), character: playableCharacterSchema }).strict()
]);

/** Safe pinned execution fields only; endpoint URLs and credentials are deliberately absent. */
export const authoringExecutionSnapshotSchema = z.object({
  providerProfileId: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(500),
  configurationHash: z.string().regex(/^[0-9a-f]{64}$/u),
  contextWindowTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  requestTimeoutMs: z.number().int().positive(),
  prompts: z.record(z.string().min(1).max(200), z.string().max(200_000)),
  protocols: z.record(z.string().min(1).max(200), z.string().min(1).max(1_000))
}).strict();

export const authoringStageViewSchema = z.object({
  id: authoringIdSchema,
  key: z.string().trim().min(1).max(300),
  generation: z.number().int().nonnegative(),
  status: authoringStageStatusSchema,
  attemptCount: z.number().int().nonnegative(),
  failure: authoringFailureSchema.optional()
}).strict();

const authoringJobViewFields = {
  id: authoringIdSchema,
  revision: authoringRevisionSchema,
  status: authoringJobStatusSchema,
  target: authoringTargetSchema,
  stages: z.array(authoringStageViewSchema).max(10_000),
  expiresAt: apiTimestampSchema,
  canApply: z.boolean(),
  incomplete: z.boolean()
};

const worldConceptJobViewSchema = z.object({
  ...authoringJobViewFields,
  kind: z.literal("world_concept"),
  result: worldContentSchema.optional(),
  request: worldConceptSubmitSchema.optional(),
  reviewedContent: worldContentSchema.optional(),
  /** Exact selection saved with the current owner review; list projections omit it. */
  reviewedStageIds: z.array(authoringIdSchema).max(10_000).optional()
}).strict();

const characterJobViewSchema = z.object({
  ...authoringJobViewFields,
  kind: z.literal("character"),
  result: playableCharacterSchema.optional(),
  request: characterSubmitSchema.optional(),
  reviewedContent: playableCharacterSchema.optional(),
  /** Exact selection saved with the current owner review; list projections omit it. */
  reviewedStageIds: z.array(authoringIdSchema).max(10_000).optional()
}).strict();

/** Owner-only detail projection. It intentionally retains resumable proposal content. */
export const authoringJobViewSchema = z.discriminatedUnion("kind", [worldConceptJobViewSchema, characterJobViewSchema]);

/** Safe list projection. Proposal inputs and outputs are detail-only. */
export const authoringJobListItemSchema = z.object({
  ...authoringJobViewFields,
  kind: authoringKindSchema
}).strict();

/** Compatibility discovery has no provider or proposal details. */
export const authoringCapabilitiesSchema = z.object({
  enabled: z.boolean(),
  supportedKinds: z.array(authoringKindSchema),
  limits: z.object({
    activeJobsPerOwner: z.literal(5),
    maximumInputBytes: z.literal(2 * 1024 * 1024),
    listPageSize: z.literal(20)
  }).strict()
}).strict();

export const authoringJobPageSchema = z.object({
  jobs: z.array(authoringJobListItemSchema).max(20),
  nextCursor: z.string().min(1).optional()
}).strict();

export const authoringReviewSchema = z.object({
  expectedRevision: authoringRevisionSchema,
  content: z.union([worldContentSchema, playableCharacterSchema]),
  selectedStageIds: z.array(authoringIdSchema).max(10_000)
}).strict();

/** Strict command envelopes shared by the HTTP API and replacement client. */
export const authoringRetrySchema = z.object({
  stageId: authoringIdSchema,
  expectedRevision: authoringRevisionSchema
}).strict();

export const authoringRevisionCommandSchema = z.object({
  expectedRevision: authoringRevisionSchema
}).strict();

export const authoringJobListQuerySchema = z.object({
  cursor: z.string().min(1).max(2_000).optional()
}).strict();

export const authoringApplySchema = z.object({
  expectedRevision: authoringRevisionSchema,
  idempotencyKey: authoringIdempotencyKeySchema,
  selectedStageIds: z.array(authoringIdSchema).max(10_000),
  content: z.union([worldContentSchema, playableCharacterSchema])
}).strict();

export const authoringApplyReceiptSchema = z.object({
  jobId: authoringIdSchema,
  worldId: authoringIdSchema,
  draftRevision: authoringRevisionSchema,
  characterId: authoringIdSchema.optional()
}).strict();

export const authoringJobCommandContextSchema = z.object({
  kind: authoringKindSchema,
  target: authoringTargetSchema
}).strict();

export function parseAuthoringCommandForJob(
  context: AuthoringJobCommandContext,
  command: "review" | "apply",
  input: unknown
): AuthoringReview | AuthoringApply {
  const parsed = command === "review" ? authoringReviewSchema.parse(input) : authoringApplySchema.parse(input);
  const content = context.kind === "world_concept"
    ? worldContentSchema.parse(parsed.content)
    : playableCharacterSchema.parse(parsed.content);
  return { ...parsed, content } as AuthoringReview | AuthoringApply;
}

export type AuthoringKind = z.infer<typeof authoringKindSchema>;
export type AuthoringJobStatus = z.infer<typeof authoringJobStatusSchema>;
export type AuthoringStageStatus = z.infer<typeof authoringStageStatusSchema>;
export type AuthoringTarget = z.infer<typeof authoringTargetSchema>;
export type AuthoringSubmit = z.infer<typeof authoringSubmitSchema>;
export type AuthoringStageView = z.infer<typeof authoringStageViewSchema>;
export type AuthoringJobView = z.infer<typeof authoringJobViewSchema>;
export type AuthoringJobListItem = z.infer<typeof authoringJobListItemSchema>;
export type AuthoringCapabilities = z.infer<typeof authoringCapabilitiesSchema>;
export type AuthoringJobPage = z.infer<typeof authoringJobPageSchema>;
export type AuthoringReview = z.infer<typeof authoringReviewSchema>;
export type AuthoringRetry = z.infer<typeof authoringRetrySchema>;
export type AuthoringRevisionCommand = z.infer<typeof authoringRevisionCommandSchema>;
export type AuthoringApply = z.infer<typeof authoringApplySchema>;
export type AuthoringApplyReceipt = z.infer<typeof authoringApplyReceiptSchema>;
export type AuthoringJobCommandContext = z.infer<typeof authoringJobCommandContextSchema>;
export type AuthoringResult = WorldContent | PlayableCharacter;
export type AuthoringWorldOutline = z.infer<typeof authoringWorldOutlineSchema>;
export type AuthoringStageOutput = z.infer<typeof authoringStageOutputSchema>;
export type AuthoringExecutionSnapshot = z.infer<typeof authoringExecutionSnapshotSchema>;
