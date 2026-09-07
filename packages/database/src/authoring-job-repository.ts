import {
  authoringFailureSchema,
  authoringExecutionSnapshotSchema,
  authoringJobListItemSchema,
  authoringStageOutputSchema,
  authoringApplyReceiptSchema,
  authoringJobViewSchema,
  parseAuthoringCommandForJob,
  type AuthoringReview,
  type AuthoringApply,
  type AuthoringApplyReceipt,
  normalizeAuthoringSubmitForAdmission,
  authoringSubmitSchema,
  authoringTargetSchema,
  type AuthoringExecutionSnapshot,
  type AuthoringFailure,
  type AuthoringJobListItem,
  type AuthoringJobView,
  type AuthoringStageOutput,
  type AuthoringSubmit
} from "../../contracts/src/authoring.js";
import {
  sourceAuthoringViewSchema,
  sourceFactReviewSchema,
  persistedSourceFactReviewSchema,
  type SourceAuthoringInput,
  type SourceFact,
  type SourceFactReview
} from "../../contracts/src/source-authoring.js";
import { createHash, randomUUID } from "node:crypto";
import { canonicalizeWorldContent, playableCharacterSchema, type WorldContent } from "../../contracts/src/world-library.js";
import type {
  AuthoringClaim,
  AuthoringExecutionRepository,
  AuthoringTargetPort,
  AuthoringWorldApplyPort
} from "../../application/src/authoring/ports.js";
import { AuthoringRepositoryError } from "../../application/src/authoring/types.js";
import type { OwnerScope } from "../../application/src/generation/types.js";
import { retryAuthoringStage, type AuthoringStageLifecycle } from "../../domain/src/authoring-jobs.js";
import { projectAuthoringFailure, validateGeneratedCharacter, validateGeneratedWorldFiction } from "../../domain/src/authoring-output.js";
import { assembleGeneratedWorldContent } from "../../domain/src/generated-world-assembly.js";
import { mergeSourceFacts, normalizeSourceDocument, sourceDocumentFromNormalizedText } from "../../domain/src/source-authoring.js";
import { withTransaction, type DatabaseClient, type DatabasePool } from "./pool.js";
import { runPostgresWorldCampaignCommandWithClient } from "./world-campaign-transaction.js";

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_LEASE_SECONDS = 3_600;
const PAGE_SIZE = 20;
const ACTIVE_JOB_LIMIT = 5;
const ACTIVE_JOB_STATUSES = ["queued", "running", "awaiting_review", "recoverable", "cancel_requested"];
const MAX_CLEANUP_BATCH_SIZE = 100;

type JobRow = {
  id: string;
  ownerUserId: string;
  kind: unknown;
  target: unknown;
  input: unknown;
  requestHash: string;
  idempotencyKey: string;
  status: unknown;
  revision: number;
  executionGeneration: number;
  executionSnapshot: unknown;
  reviewedContent: unknown;
  reviewedStageIds: unknown;
  reviewGeneration: number;
  applyKey: string | null;
  applyHash: string | null;
  applyReceipt: unknown;
  sourcePlan: unknown;
  sourceReview: unknown;
  expiresAt: unknown;
  createdAt: unknown;
};
type JobListRow = Pick<JobRow, "id" | "kind" | "target" | "status" | "revision" | "reviewedStageIds" | "expiresAt" | "createdAt"> & { hasReviewedContent: boolean };

type StageRow = {
  id: string;
  jobId: string;
  ownerUserId: string;
  stageKey: string;
  generation: number;
  parentGenerations: unknown;
  status: unknown;
  attemptCount: number;
  retryCount: number;
  leaseToken: string | null;
  leaseExpiresAt: unknown;
  output: unknown;
  hasOutput?: boolean;
  failure: unknown;
  sourceReviewGeneration: number | null;
};

function json(value: unknown): string {
  return JSON.stringify(value);
}

function stableJson(value: unknown): string {
  if (value === undefined || value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function timestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  throw new Error("Authoring repository returned an invalid timestamp.");
}

function leaseSeconds(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_LEASE_SECONDS) {
    throw new RangeError(`Authoring lease seconds must be an integer from 1 to ${MAX_LEASE_SECONDS}.`);
  }
  return value;
}

function requestHash(value: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new TypeError("Authoring request hash must be a SHA-256 hex digest.");
  return value;
}

function validateStageOutput(stageKey: string, value: unknown): AuthoringStageOutput {
  const output = authoringStageOutputSchema.parse(value);
  if (stageKey === "source:plan" && output.kind !== "source_plan") throw new TypeError("The source planning stage requires a source plan output.");
  if (stageKey.startsWith("source:chunk:") && output.kind !== "source_extraction") throw new TypeError("A source extraction stage requires source facts.");
  if (stageKey === "source:synthesis" && output.kind !== "source_world") throw new TypeError("The source synthesis stage requires a source-world proposal.");
  if (stageKey.startsWith("source:character:") && output.kind !== "source_world") throw new TypeError("A selected source character stage requires a source-world proposal.");
  if (stageKey === "source:plan" || stageKey.startsWith("source:chunk:")) return output;
  if (stageKey === "source:synthesis" || stageKey.startsWith("source:character:")) return output;
  if (stageKey === "world" && output.kind !== "outline") throw new TypeError("The world stage requires an outline output.");
  if (stageKey.startsWith("character:") && output.kind !== "character") throw new TypeError("A character stage requires a character output.");
  if (stageKey.startsWith("character:") && output.kind === "character") {
    const expectedId = stageKey.slice("character:".length);
    if (expectedId !== "initial" && output.character.id !== expectedId) throw new TypeError("The character output does not match its assigned stage identity.");
  }
  if (stageKey !== "world" && !stageKey.startsWith("character:")) throw new TypeError("Unknown durable authoring stage key.");
  if (output.kind === "character") {
    validateGeneratedCharacter(output.character, "creative");
  } else if (output.kind === "outline") {
    validateGeneratedWorldFiction(output.outline);
    for (const seed of output.outline.seeds) {
      validateGeneratedWorldFiction({
        title: seed.name,
        genre: seed.role,
        tone: seed.concept,
        backgroundStory: seed.narrativeHook,
        premise: seed.concept,
        firstAction: seed.narrativeHook
      });
    }
  }
  return output;
}

function stageKey(input: AuthoringSubmit): string {
  if (input.kind === "world_concept") return "world";
  if (input.kind === "story_source") return "source:plan";
  const targetCharacterId = input.target.kind === "world_draft" ? input.target.characterId : undefined;
  // Called only after inserting a new job. Keep application identity in the stage,
  // because public characterId denotes an existing roster member to edit.
  return `character:${input.characterId ?? targetCharacterId ?? randomUUID()}`;
}

function isDiscardedInput(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>).discarded === true;
}

function isAppliedInput(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>).applied === true;
}

function currentSourceFacts(stages: readonly StageRow[]): SourceFact[] {
  return currentStagesForRows(stages)
    .filter((stage) => stage.stageKey.startsWith("source:chunk:") && stage.status === "validated" && stage.output !== null && stage.output !== undefined && parentsAreCurrentAndValidated(stages, stage.parentGenerations))
    .flatMap((stage) => {
      const output = validateStageOutput(stage.stageKey, stage.output);
      // The immutable provider output retains its source-local fact id. Review
      // commands use this generation-bound projection, so a retried leaf cannot
      // silently accept an id from its superseded extraction generation.
      return output.kind === "source_extraction"
        ? output.facts.map((fact) => ({ ...fact, id: `source-fact:${stage.id}:${createHash("sha256").update(fact.id, "utf8").digest("hex")}` }))
        : [];
    });
}

/** Project an immutable expansion envelope into a reviewable, generation-bound source fact. */
function sourceWorldExpansionFacts(stages: readonly StageRow[], knownFacts: readonly SourceFact[]): SourceFact[] {
  const knownById = new Map(knownFacts.map((fact) => [fact.id, fact]));
  return currentStagesForRows(stages)
    .filter((stage) => (stage.stageKey === "source:synthesis" || stage.stageKey.startsWith("source:character:"))
      && stage.status === "validated" && stage.output !== null && stage.output !== undefined
      && parentsAreCurrentAndValidated(stages, stage.parentGenerations))
    .flatMap((stage) => {
      const output = validateStageOutput(stage.stageKey, stage.output);
      if (output.kind !== "source_world") return [];
      return output.expansionCandidates.map((candidate) => {
        const ownerId = candidate.target === "world" ? undefined : candidate.target.characterRepresentativeFactId;
        const owner = ownerId === undefined ? undefined : knownById.get(ownerId);
        const worldPath = candidate.path === "world.rules"
          ? { kind: "rule" as const, subject: "World", predicate: "rule" }
          : candidate.path === "world.tone"
            ? { kind: "tone" as const, subject: "World", predicate: "tone" }
            : { kind: "event" as const, subject: "World", predicate: candidate.path };
        const profilePredicate = candidate.path.startsWith("profile.appearance.")
          ? candidate.path.slice("profile.appearance.".length)
          : candidate.path;
        return {
          id: `source-fact:expansion:${stage.id}:${createHash("sha256").update(stableJson(candidate), "utf8").digest("hex")}`,
          ...(owner === undefined ? worldPath : { kind: "character" as const, subject: owner.subject, predicate: profilePredicate }),
          value: candidate.value,
          provenance: "invented" as const,
          citations: []
        };
      });
    });
}

function sourceDetail(job: JobRow, input: SourceAuthoringInput, stages: readonly StageRow[]) {
  const source = sourceDocumentFromNormalizedText(input.name, input.text, job.id);
  const planStage = currentStagesForRows(stages).find((stage) => stage.stageKey === "source:plan" && stage.status === "validated" && stage.output !== null);
  const plan = planStage?.output ? validateStageOutput("source:plan", planStage.output) : undefined;
  const plannedChunks = plan?.kind === "source_plan" ? plan.chunks : [];
  const persistedPlan = typeof job.sourcePlan === "object" && job.sourcePlan !== null && !Array.isArray(job.sourcePlan)
    ? (job.sourcePlan as { chunks?: unknown }).chunks
    : undefined;
  const persistedOutput = Array.isArray(persistedPlan)
    ? authoringStageOutputSchema.parse({ kind: "source_plan", chunks: persistedPlan })
    : undefined;
  const chunks = persistedOutput?.kind === "source_plan" ? persistedOutput.chunks : plannedChunks;
  const current = currentStagesForRows(stages);
  const extractionComplete = chunks.length > 0 && chunks.every((chunk) => current.some((stage) =>
    stage.stageKey === `source:chunk:${chunk.id}` && stage.status === "validated" && parentsAreCurrentAndValidated(stages, stage.parentGenerations)));
  const review = job.sourceReview === null || job.sourceReview === undefined
    ? undefined
    : persistedSourceFactReviewSchema.safeParse(job.sourceReview).data;
  const baseFacts = mergeSourceFacts([
    ...currentSourceFacts(stages),
    ...(review?.manualFacts ?? []),
    ...(review?.expansionCandidates ?? [])
  ]);
  const facts = mergeSourceFacts([...baseFacts, ...sourceWorldExpansionFacts(stages, baseFacts)]);
  return sourceAuthoringViewSchema.parse({
    source,
    boundaryParagraphId: input.boundaryParagraphId,
    mode: input.mode,
    facts,
    extractionComplete,
    acceptedFactIds: review?.acceptedFactIds ?? [],
    rejectedFactIds: review?.rejectedFactIds ?? [],
    uncertainFactIds: review?.uncertainFactIds ?? [],
    selectedCharacterFactIds: review?.selectedCharacterFactIds ?? [],
    characterIdentityGroups: review?.characterIdentityGroups ?? [],
    expansionCandidates: facts.filter((fact) => fact.provenance !== "stated")
  });
}

function reviewedSourceSelection(job: JobRow, input: SourceAuthoringInput, stages: readonly StageRow[]) {
  const review = persistedSourceFactReviewSchema.safeParse(job.sourceReview).data;
  if (!review) return null;
  const detail = sourceDetail(job, input, stages);
  if (!detail.extractionComplete) return null;
  const byId = new Map(detail.facts.map((fact) => [fact.id, fact]));
  const acceptedFacts = review.acceptedFactIds.map((id) => byId.get(id));
  if (acceptedFacts.some((fact) => fact === undefined)) return null;
  return {
    source: detail.source,
    boundaryParagraphId: input.boundaryParagraphId,
    acceptedFacts: acceptedFacts as SourceFact[],
    selectedCharacterFactIds: review.selectedCharacterFactIds,
    characterIdentityGroups: review.characterIdentityGroups,
    mode: input.mode,
    reviewGeneration: job.reviewGeneration
  };
}

function factsConflict(facts: readonly SourceFact[]): boolean {
  return facts.some((fact, index) => facts.slice(index + 1).some((other) =>
    fact.subject.trim().toLocaleLowerCase() === other.subject.trim().toLocaleLowerCase()
    && fact.predicate.trim().toLocaleLowerCase() === other.predicate.trim().toLocaleLowerCase()
    && fact.value.trim().toLocaleLowerCase() !== other.value.trim().toLocaleLowerCase()));
}

function splitSourceChunk(source: ReturnType<typeof sourceDocumentFromNormalizedText>, chunk: Extract<AuthoringStageOutput, { kind: "source_plan" }> ["chunks"][number]) {
  const characters = Array.from(source.text);
  const { start, end } = chunk.sourceRange;
  if (end - start < 2) throw new TypeError("The smallest source extraction chunk cannot be split further.");
  const midpoint = start + Math.floor((end - start) / 2);
  const makeChild = (rangeStart: number, rangeEnd: number, suffix: string) => ({
    id: `${chunk.id}:split-${suffix}`,
    sourceId: source.id,
    sourceRange: { start: rangeStart, end: rangeEnd },
    contentHash: createHash("sha256").update(characters.slice(rangeStart, rangeEnd).join(""), "utf8").digest("hex"),
    spans: source.paragraphs.filter((paragraph) => paragraph.end > rangeStart && paragraph.start < rangeEnd).map((paragraph) => ({
      paragraphId: paragraph.id,
      start: Math.max(rangeStart, paragraph.start),
      end: Math.min(rangeEnd, paragraph.end)
    }))
  });
  return [makeChild(start, midpoint, "a"), makeChild(midpoint, end, "b")];
}

function jobView(job: JobRow, stages: StageRow[]): AuthoringJobView {
  if (isDiscardedInput(job.input)) throw new AuthoringRepositoryError("not_found");
  const input = isAppliedInput(job.input) || job.status === "expired"
    ? undefined
    : authoringSubmitSchema.parse(job.input);
  const target = authoringTargetSchema.parse(job.target);
  const parsedStages = stages.map((stage) => {
    if (stage.output !== null && stage.output !== undefined) validateStageOutput(stage.stageKey, stage.output);
    const value = {
      id: stage.id,
      key: stage.stageKey,
      generation: stage.generation,
      status: stage.status,
      attemptCount: stage.attemptCount,
      ...(stage.failure === null || stage.failure === undefined ? {} : { failure: projectAuthoringFailure(authoringFailureSchema.parse(stage.failure)) })
    };
    return value;
  });
  const currentStages = parsedStages.filter((stage) => !parsedStages.some((other) => other.key === stage.key && other.generation > stage.generation));
  const activeStages = currentStages.filter((stage) => stage.status !== "cancelled");
  const allValidated = activeStages.length > 0 && activeStages.every((stage) => stage.status === "validated");
  const characterStage = job.kind === "character"
    ? currentStagesForRows(stages).find(stage => stage.stageKey.startsWith("character:") && stage.status === "validated" && parentsAreCurrentAndValidated(stages, stage.parentGenerations))
    : undefined;
  const characterOutput = characterStage?.output ? validateStageOutput(characterStage.stageKey, characterStage.output) : undefined;
  const result = job.kind === "world_concept" ? partialWorldResult(stages)
    : job.kind === "story_source" ? sourceWorldResult(stages)
      : characterOutput?.kind === "character" ? characterOutput.character : undefined;
  return authoringJobViewSchema.parse({
    id: job.id,
    kind: job.kind,
    revision: job.revision,
    status: job.status,
    target,
    stages: parsedStages,
    expiresAt: timestamp(job.expiresAt),
    canApply: canApply({ ...job, hasReviewedContent: job.reviewedContent !== null && job.reviewedContent !== undefined }, stages),
    incomplete: !allValidated,
    ...(input === undefined ? {} : { request: input }),
    ...(result === undefined ? {} : { result }),
    ...(input?.kind === "story_source" ? { source: sourceDetail(job, input, stages) } : {}),
    ...(job.reviewedContent === null || job.reviewedContent === undefined ? {} : {
      reviewedContent: job.reviewedContent,
      reviewedStageIds: Array.isArray(job.reviewedStageIds) ? job.reviewedStageIds : []
    })
  });
}

/** Build a reviewable preview solely from validated active stages; it never fills missing characters. */
function partialWorldResult(stages: readonly StageRow[]): WorldContent | undefined {
  const current = currentStagesForRows(stages).filter((stage) => stage.status !== "cancelled");
  const outlineStage = current.find((stage) => stage.stageKey === "world" && stage.status === "validated");
  if (!outlineStage?.output) return undefined;
  const outline = validateStageOutput("world", outlineStage.output);
  if (outline.kind !== "outline") return undefined;
  const characterIds = new Set(outline.outline.seeds.map((seed) => seed.id));
  const playableCharacters = current
    .filter((stage) => stage.stageKey.startsWith("character:") && stage.status === "validated" && stage.output !== null)
    .map((stage) => validateStageOutput(stage.stageKey, stage.output))
    .flatMap((output) => output.kind === "character" && characterIds.has(output.character.id) ? [output.character] : []);
  return assembleGeneratedWorldContent({
    outline: outline.outline,
    playableCharacters,
    importedFrom: "authoring-proposal"
  });
}

/** Assemble only current, fenced source-world descendants; stale selections never project. */
function sourceWorldResult(stages: readonly StageRow[]): WorldContent | undefined {
  const current = currentStagesForRows(stages).filter((stage) => stage.status !== "cancelled");
  const overviewStage = current.find((stage) => stage.stageKey === "source:synthesis" && stage.status === "validated" && parentsAreCurrentAndValidated(stages, stage.parentGenerations));
  if (!overviewStage?.output) return undefined;
  const overview = validateStageOutput("source:synthesis", overviewStage.output);
  if (overview.kind !== "source_world") return undefined;
  const playableCharacters = current
    .filter((stage) => stage.stageKey.startsWith("source:character:") && stage.status === "validated" && stage.output !== null && parentsAreCurrentAndValidated(stages, stage.parentGenerations))
    .flatMap((stage) => {
      const output = validateStageOutput(stage.stageKey, stage.output);
      return output.kind === "source_world" ? output.proposal.playableCharacters : [];
    });
  return canonicalizeWorldContent({ ...overview.proposal, playableCharacters });
}

function currentStagesForRows(rows: readonly StageRow[]): StageRow[] {
  return rows.filter((stage) => !rows.some((other) => other.stageKey === stage.stageKey && other.generation > stage.generation));
}

function parentsAreCurrentAndValidated(stages: readonly StageRow[], rawParents: unknown): boolean {
  if (!rawParents || typeof rawParents !== "object" || Array.isArray(rawParents)) return false;
  const parents = Object.entries(rawParents as Record<string, unknown>);
  if (parents.some(([, generation]) => !Number.isInteger(generation) || (generation as number) < 1)) return false;
  const current = currentStagesForRows(stages);
  return parents.every(([key, generation]) => current.some((stage) =>
    stage.stageKey === key && stage.generation === generation && stage.status === "validated"
  ));
}

function hasValidatedOutput(stage: StageRow): boolean {
  return stage.hasOutput ?? (stage.output !== null && stage.output !== undefined);
}

function canApply(job: Pick<JobRow, "kind" | "target" | "status" | "reviewedStageIds"> & { hasReviewedContent: boolean }, stages: readonly StageRow[]): boolean {
  if (job.kind === "story_source") return false;
  if (job.status !== "awaiting_review" && job.status !== "recoverable") return false;
  if (!job.hasReviewedContent) return false;
  const target = authoringTargetSchema.parse(job.target);
  if (job.kind === "character" && target.kind === "new_world") return false;
  const selected = Array.isArray(job.reviewedStageIds) ? job.reviewedStageIds : [];
  if (!selected.length || new Set(selected).size !== selected.length || !selected.every((id): id is string => typeof id === "string")) return false;
  const current = currentStagesForRows(stages).filter((stage) => stage.status !== "cancelled");
  return selected.every((id) => {
    const stage = current.find((candidate) => candidate.id === id);
    return stage?.status === "validated" && hasValidatedOutput(stage) && parentsAreCurrentAndValidated(stages, stage.parentGenerations);
  });
}

function listItem(job: JobRow, stages: StageRow[]): AuthoringJobListItem {
  const view = jobView(job, stages);
  const { request: _request, result: _result, reviewedContent: _reviewedContent, reviewedStageIds: _reviewedStageIds, ...item } = view;
  return authoringJobListItemSchema.parse(item);
}

function decodeListCursor(cursor?: string): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { createdAt?: unknown; id?: unknown };
    if (typeof parsed.createdAt !== "string" || Number.isNaN(Date.parse(parsed.createdAt)) || typeof parsed.id !== "string") throw new Error();
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch { throw new TypeError("Invalid authoring job list cursor."); }
}

function encodeListCursor(createdAt: unknown, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt: timestamp(createdAt), id })).toString("base64url");
}

function metadataListItem(job: JobListRow, stages: StageRow[]): AuthoringJobListItem {
  const views = stages.map((stage) => ({ id: stage.id, key: stage.stageKey, generation: stage.generation, status: stage.status, attemptCount: stage.attemptCount, ...(stage.failure === null || stage.failure === undefined ? {} : { failure: projectAuthoringFailure(authoringFailureSchema.parse(stage.failure)) }) }));
  const current = views.filter((stage) => !views.some((other) => other.key === stage.key && other.generation > stage.generation) && stage.status !== "cancelled");
  return authoringJobListItemSchema.parse({ id: job.id, kind: job.kind, revision: job.revision, status: job.status, target: authoringTargetSchema.parse(job.target), stages: views, expiresAt: timestamp(job.expiresAt), canApply: canApply(job, stages), incomplete: !(current.length > 0 && current.every((stage) => stage.status === "validated")) });
}

const JOB_SELECT = `
  id, owner_user_id AS "ownerUserId", kind, target, input,
  request_hash AS "requestHash", idempotency_key AS "idempotencyKey", status,
  revision, execution_generation AS "executionGeneration",
  execution_snapshot AS "executionSnapshot", reviewed_content AS "reviewedContent",
  reviewed_stage_ids AS "reviewedStageIds", review_generation AS "reviewGeneration",
  apply_key AS "applyKey", apply_hash AS "applyHash", apply_receipt AS "applyReceipt",
  source_plan AS "sourcePlan", source_review AS "sourceReview",
  expires_at AS "expiresAt", created_at AS "createdAt"`;
const JOB_LIST_SELECT = `id, kind, target, status, revision, reviewed_stage_ids AS "reviewedStageIds", reviewed_content IS NOT NULL AS "hasReviewedContent", expires_at AS "expiresAt", to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"`;

const STAGE_SELECT = `
  id, job_id AS "jobId", owner_user_id AS "ownerUserId", stage_key AS "stageKey",
  generation, parent_generations AS "parentGenerations", status,
  attempt_count AS "attemptCount", retry_count AS "retryCount",
  lease_token AS "leaseToken", lease_expires_at AS "leaseExpiresAt", output, failure,
  source_review_generation AS "sourceReviewGeneration"`;

const STAGE_RETURNING = `
  stages.id, stages.job_id AS "jobId", stages.owner_user_id AS "ownerUserId", stages.stage_key AS "stageKey",
  stages.generation, stages.parent_generations AS "parentGenerations", stages.status,
  stages.attempt_count AS "attemptCount", stages.retry_count AS "retryCount",
  stages.lease_token AS "leaseToken", stages.lease_expires_at AS "leaseExpiresAt", stages.output, stages.failure,
  stages.source_review_generation AS "sourceReviewGeneration"`;

export function createPostgresAuthoringRepository(pool: DatabasePool): AuthoringExecutionRepository {
  async function loadStages(jobIds: readonly string[]): Promise<Map<string, StageRow[]>> {
    const byJob = new Map<string, StageRow[]>();
    if (!jobIds.length) return byJob;
    const result = await pool.query<StageRow>(
      `SELECT ${STAGE_SELECT} FROM authoring_job_stages
        WHERE job_id = ANY($1::uuid[]) ORDER BY stage_key, generation`,
      [jobIds]
    );
    for (const stage of result.rows) {
      const current = byJob.get(stage.jobId) ?? [];
      current.push(stage);
      byJob.set(stage.jobId, current);
    }
    return byJob;
  }

  async function readOne(scope: OwnerScope, jobId: string): Promise<AuthoringJobView | null> {
    const jobs = await pool.query<JobRow>(
      `SELECT ${JOB_SELECT} FROM authoring_jobs WHERE id = $1 AND owner_user_id = $2`,
      [jobId, scope.ownerUserId]
    );
    const job = jobs.rows[0];
    if (!job || isDiscardedInput(job.input)) return null;
    const stages = await loadStages([job.id]);
    return jobView(job, stages.get(job.id) ?? []);
  }

  async function assertDraftTarget(client: DatabaseClient, scope: OwnerScope, target: { worldId: string; expectedRevision: number; characterId?: string | undefined }): Promise<void> {
    const draft = await client.query<{ revision: number; content: unknown }>(
      `SELECT wd.revision, wd.content FROM worlds w
        JOIN world_drafts wd ON wd.world_id = w.id AND wd.owner_user_id = w.owner_user_id
       WHERE w.id = $1 AND w.owner_user_id = $2 AND w.status <> 'archived'
       FOR KEY SHARE OF w, wd`,
      [target.worldId, scope.ownerUserId]
    );
    const current = draft.rows[0];
    if (!current) throw new AuthoringRepositoryError("not_found");
    if (current.revision !== target.expectedRevision) throw new AuthoringRepositoryError("revision_conflict");
    if (target.characterId !== undefined) {
      const matches = await client.query(
        `SELECT 1 FROM jsonb_array_elements(COALESCE($1::jsonb->'playableCharacters', '[]'::jsonb)) character
          WHERE character->>'id' = $2`,
        [json(current.content), target.characterId]
      );
      if (matches.rowCount !== 1) throw new AuthoringRepositoryError("not_found");
    }
  }

  function claimParameters(claim: AuthoringClaim): unknown[] {
    return [
      claim.stageId, claim.jobId, claim.ownerUserId, claim.jobGeneration,
      claim.stageGeneration, claim.leaseToken
    ];
  }

  async function parentsAreValidated(client: DatabaseClient, jobId: string, rawParents: unknown): Promise<boolean> {
    if (!rawParents || typeof rawParents !== "object" || Array.isArray(rawParents)) return false;
    const entries = Object.entries(rawParents as Record<string, unknown>);
    if (entries.some(([, generation]) => !Number.isInteger(generation) || (generation as number) < 1)) return false;
    for (const [key, generation] of entries) {
      const parent = await client.query<{ status: string }>(
        `SELECT status FROM authoring_job_stages
          WHERE job_id = $1 AND stage_key = $2 AND generation = $3
            AND generation = (SELECT max(current.generation) FROM authoring_job_stages current WHERE current.job_id = authoring_job_stages.job_id AND current.stage_key = authoring_job_stages.stage_key)`,
        [jobId, key, generation]
      );
      if (parent.rows[0]?.status !== "validated") return false;
    }
    return true;
  }

  async function stageIsCurrent(client: DatabaseClient, stage: StageRow): Promise<boolean> {
    const latest = await client.query<{ generation: number }>(
      `SELECT max(generation)::int AS generation FROM authoring_job_stages WHERE job_id = $1 AND stage_key = $2`,
      [stage.jobId, stage.stageKey]
    );
    return latest.rows[0]?.generation === stage.generation;
  }

  async function withCurrentClaim<T>(claim: AuthoringClaim, work: (client: DatabaseClient, job: JobRow, stage: StageRow) => Promise<T>): Promise<T | null> {
    return withTransaction(pool, async (client) => {
      const jobs = await client.query<JobRow>(`SELECT ${JOB_SELECT} FROM authoring_jobs WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`, [claim.jobId, claim.ownerUserId]);
      const job = jobs.rows[0];
      if (!job || job.executionGeneration !== claim.jobGeneration || job.status !== "running") return null;
      const stages = await client.query<StageRow>(`SELECT ${STAGE_SELECT} FROM authoring_job_stages WHERE id = $1 AND job_id = $2 AND owner_user_id = $3 FOR UPDATE`, [claim.stageId, claim.jobId, claim.ownerUserId]);
      const stage = stages.rows[0];
      if (!stage || stage.generation !== claim.stageGeneration || stage.status !== "running" || stage.leaseToken !== claim.leaseToken) return null;
      if (stage.sourceReviewGeneration !== null && stage.sourceReviewGeneration !== job.reviewGeneration) return null;
      const lease = await client.query("SELECT 1 FROM authoring_job_stages WHERE id = $1 AND lease_expires_at > clock_timestamp()", [stage.id]);
      if (lease.rowCount !== 1 || !(await stageIsCurrent(client, stage)) || !(await parentsAreValidated(client, stage.jobId, stage.parentGenerations))) return null;
      return work(client, job, stage);
    });
  }

  async function completeCurrentStages(client: DatabaseClient, jobId: string): Promise<boolean> {
    const stages = await client.query<StageRow>(`SELECT ${STAGE_SELECT} FROM authoring_job_stages stages WHERE stages.job_id = $1 AND stages.generation = (SELECT max(current.generation) FROM authoring_job_stages current WHERE current.job_id = stages.job_id AND current.stage_key = stages.stage_key)`, [jobId]);
    const active = stages.rows.filter((stage) => stage.status !== "cancelled");
    if (active.length === 0) return false;
    for (const stage of active) {
      if (stage.status !== "validated" || !await parentsAreValidated(client, jobId, stage.parentGenerations)) return false;
    }
    return true;
  }

  /**
   * Source review and extraction are semantic inputs to every overview and
   * selected-character stage. Preserve old outputs for audit, but retire their
   * current generations before a changed input can be claimed or projected.
   */
  async function invalidateSourceSynthesisDescendants(client: DatabaseClient, jobId: string): Promise<void> {
    await client.query(
      `UPDATE authoring_job_stages descendants
          SET status = 'cancelled', lease_token = NULL, lease_owner = NULL,
              lease_expires_at = NULL, updated_at = clock_timestamp()
        WHERE descendants.job_id = $1
          AND (descendants.stage_key = 'source:synthesis' OR descendants.stage_key LIKE 'source:character:%')
          AND descendants.status <> 'cancelled'
          AND descendants.generation = (
            SELECT max(current.generation)
              FROM authoring_job_stages current
             WHERE current.job_id = descendants.job_id
               AND current.stage_key = descendants.stage_key
          )`,
      [jobId]
    );
  }

  /**
   * The world checkpoint and its active child roster share the claim transaction.
   * Regeneration placeholders from P2.3 are retained only when their assigned
   * application identities still occur in the newly accepted outline.
   */
  async function reconcileOutlineChildren(client: DatabaseClient, job: JobRow, stage: StageRow, output: AuthoringStageOutput): Promise<void> {
    if (output.kind !== "outline") return;
    const desired = new Set(output.outline.seeds.map((seed) => `character:${seed.id}`));
    if (desired.size !== output.outline.seeds.length) throw new TypeError("The durable outline requires unique assigned character identities.");
    // Legacy synchronous-compatible fixtures can carry no seed roster. They do
    // not declare a replacement roster, so preserve already-created children.
    if (desired.size === 0) return;
    const all = await client.query<StageRow>(`SELECT ${STAGE_SELECT} FROM authoring_job_stages WHERE job_id = $1 AND stage_key LIKE 'character:%' FOR UPDATE`, [job.id]);
    const current = currentStagesForRows(all.rows);
    const hasCurrentParent = (candidate: StageRow) => {
      const parents = candidate.parentGenerations as Record<string, unknown>;
      return Number(parents.world) === stage.generation;
    };
    for (const key of desired) {
      const existing = current.find((candidate) => candidate.stageKey === key && hasCurrentParent(candidate));
      if (existing) continue;
      const generations = all.rows.filter((candidate) => candidate.stageKey === key).map((candidate) => candidate.generation);
      const generation = generations.length ? Math.max(...generations) + 1 : 1;
      await client.query(
        `INSERT INTO authoring_job_stages (job_id, owner_user_id, stage_key, generation, parent_generations, status, next_attempt_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'queued', clock_timestamp())`,
        [job.id, job.ownerUserId, key, generation, json({ world: stage.generation })]
      );
    }
    const obsolete = current.filter((candidate) => candidate.stageKey.startsWith("character:") && hasCurrentParent(candidate) && !desired.has(candidate.stageKey) && ["queued", "running", "recoverable"].includes(String(candidate.status)));
    if (obsolete.length) {
      await client.query(
        `UPDATE authoring_job_stages
            SET status = 'cancelled', lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
          WHERE id = ANY($1::uuid[])`,
        [obsolete.map((candidate) => candidate.id)]
      );
    }
  }

  async function reconcileSourceWorldChildren(client: DatabaseClient, job: JobRow, stage: StageRow): Promise<void> {
    const input = authoringSubmitSchema.parse(job.input);
    if (input.kind !== "story_source" || stage.stageKey !== "source:synthesis") return;
    const allStages = await client.query<StageRow>(`SELECT ${STAGE_SELECT} FROM authoring_job_stages WHERE job_id = $1 FOR UPDATE`, [job.id]);
    const selection = reviewedSourceSelection(job, input, allStages.rows);
    if (!selection) throw new TypeError("Source synthesis lost its reviewed selection.");
    const desired = new Set(selection.selectedCharacterFactIds.map((id) => `source:character:${id}`));
    const current = currentStagesForRows(allStages.rows).filter((candidate) => candidate.stageKey.startsWith("source:character:"));
    for (const key of desired) {
      const existing = current.find((candidate) => candidate.stageKey === key && candidate.status !== "cancelled" && Number((candidate.parentGenerations as Record<string, unknown>)["source:synthesis"]) === stage.generation);
      if (existing) continue;
      const generations = allStages.rows.filter((candidate) => candidate.stageKey === key).map((candidate) => candidate.generation);
      await client.query(
        `INSERT INTO authoring_job_stages (job_id, owner_user_id, stage_key, generation, parent_generations, source_review_generation, status, next_attempt_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'queued', clock_timestamp())`,
        [job.id, job.ownerUserId, key, generations.length ? Math.max(...generations) + 1 : 1, json({ "source:synthesis": stage.generation }), selection.reviewGeneration]
      );
    }
  }

  async function lockedView(client: DatabaseClient, jobId: string): Promise<AuthoringJobView> {
    const jobs = await client.query<JobRow>(`SELECT ${JOB_SELECT} FROM authoring_jobs WHERE id = $1`, [jobId]);
    const job = jobs.rows[0];
    if (!job || isDiscardedInput(job.input)) throw new AuthoringRepositoryError("not_found");
    const stages = await client.query<StageRow>(`SELECT ${STAGE_SELECT} FROM authoring_job_stages WHERE job_id = $1 ORDER BY stage_key, generation`, [jobId]);
    return jobView(job, stages.rows);
  }

  function currentStages(rows: readonly StageRow[]): StageRow[] {
    return rows.filter((stage) => !rows.some((other) => other.stageKey === stage.stageKey && other.generation > stage.generation));
  }

  function commandJob(job: JobRow, expectedRevision: number): void {
    if (isDiscardedInput(job.input)) throw new AuthoringRepositoryError("not_found");
    if (job.revision !== expectedRevision) throw new AuthoringRepositoryError("revision_conflict");
  }

  async function requireUnexpired(client: DatabaseClient, jobId: string): Promise<void> {
    const active = await client.query("SELECT 1 FROM authoring_jobs WHERE id = $1 AND expires_at > clock_timestamp()", [jobId]);
    if (active.rowCount !== 1) throw new AuthoringRepositoryError("invalid_state");
  }

  return {
    async findIdempotency(scope, idempotencyKey) {
      const existing = await pool.query<JobRow>(
        `SELECT ${JOB_SELECT} FROM authoring_jobs WHERE owner_user_id = $1 AND idempotency_key = $2`,
        [scope.ownerUserId, idempotencyKey]
      );
      const job = existing.rows[0];
      if (!job) return null;
      if (isDiscardedInput(job.input)) return { requestHash: job.requestHash, job: null };
      const stages = await loadStages([job.id]);
      return { requestHash: job.requestHash, job: jobView(job, stages.get(job.id) ?? []) };
    },
    async submit(scope, rawInput, rawHash) {
      const input = normalizeAuthoringSubmitForAdmission(authoringSubmitSchema.parse(rawInput));
      const hash = requestHash(rawHash);
      const encoded = json(input);
      if (Buffer.byteLength(encoded, "utf8") > MAX_INPUT_BYTES) {
        throw new RangeError("Authoring input exceeds the 2 MiB durable submission limit.");
      }
      const job = await withTransaction(pool, async (client) => {
        // Serialize every owner enqueue before replay lookup and capacity
        // accounting. A same-key replay must win even when the owner is full.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`authoring-active:${scope.ownerUserId}`]);
        const existing = await client.query<JobRow>(
          `SELECT ${JOB_SELECT} FROM authoring_jobs WHERE owner_user_id = $1 AND idempotency_key = $2 FOR UPDATE`,
          [scope.ownerUserId, input.idempotencyKey]
        );
        const replay = existing.rows[0];
        if (replay) {
          if (replay.requestHash !== hash) throw new AuthoringRepositoryError("idempotency_conflict");
          if (isDiscardedInput(replay.input)) throw new AuthoringRepositoryError("invalid_state");
          return replay;
        }
        // The replay check deliberately runs before this count. An existing
        // durable request remains safe to resume even when the owner is at cap.
        const active = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM authoring_jobs
            WHERE owner_user_id = $1 AND expires_at > clock_timestamp()
              AND status = ANY($2::text[]) AND input <> '{"discarded":true}'::jsonb`,
          [scope.ownerUserId, ACTIVE_JOB_STATUSES]
        );
        if ((active.rows[0]?.count ?? 0) >= ACTIVE_JOB_LIMIT) {
          throw new AuthoringRepositoryError("active_job_limit");
        }
        if (input.target.kind === "world_draft") await assertDraftTarget(client, scope, input.target);
        const inserted = await client.query<JobRow>(
          `INSERT INTO authoring_jobs (owner_user_id, kind, target, input, request_hash, idempotency_key)
           VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6)
           ON CONFLICT (owner_user_id, idempotency_key) DO NOTHING
           RETURNING ${JOB_SELECT}`,
          [scope.ownerUserId, input.kind, json(input.target), encoded, hash, input.idempotencyKey]
        );
        const created = inserted.rows[0];
        if (created) {
          if (input.kind === "story_source") {
            const normalized = normalizeSourceDocument(input.name, input.text, created.id);
            const persisted = { ...input, text: normalized.text };
            await client.query("UPDATE authoring_jobs SET input = $2::jsonb, updated_at = clock_timestamp() WHERE id = $1", [created.id, json(persisted)]);
            created.input = persisted;
          }
          await client.query(
            `INSERT INTO authoring_job_stages (job_id, owner_user_id, stage_key)
             VALUES ($1, $2, $3)`,
            [created.id, scope.ownerUserId, stageKey(input)]
          );
          return created;
        }
        const concurrent = await client.query<JobRow>(
          `SELECT ${JOB_SELECT} FROM authoring_jobs WHERE owner_user_id = $1 AND idempotency_key = $2`,
          [scope.ownerUserId, input.idempotencyKey]
        );
        const raced = concurrent.rows[0];
        if (!raced) throw new Error("Authoring idempotency replay was not readable.");
        if (raced.requestHash !== hash) throw new AuthoringRepositoryError("idempotency_conflict");
        if (isDiscardedInput(raced.input)) throw new AuthoringRepositoryError("invalid_state");
        return raced;
      });
      const stages = await loadStages([job.id]);
      return jobView(job, stages.get(job.id) ?? []);
    },

    read: readOne,

    async list(scope, cursor) {
      const after = decodeListCursor(cursor);
      const jobs = await pool.query<JobListRow>(
        `SELECT ${JOB_LIST_SELECT} FROM authoring_jobs
          WHERE owner_user_id = $1
            AND input <> '{"discarded":true}'::jsonb
            AND ($2::timestamptz IS NULL OR created_at < $2::timestamptz OR (created_at = $2::timestamptz AND id < $3::uuid))
          ORDER BY created_at DESC, id DESC LIMIT $4`,
        [scope.ownerUserId, after?.createdAt ?? null, after?.id ?? null, PAGE_SIZE + 1]
      );
      const page = jobs.rows.slice(0, PAGE_SIZE);
      const stageRows = page.length ? await pool.query<StageRow>(`SELECT id, job_id AS "jobId", owner_user_id AS "ownerUserId", stage_key AS "stageKey", generation, parent_generations AS "parentGenerations", status, attempt_count AS "attemptCount", retry_count AS "retryCount", NULL::uuid AS "leaseToken", NULL::timestamptz AS "leaseExpiresAt", NULL::jsonb AS output, output IS NOT NULL AS "hasOutput", failure FROM authoring_job_stages WHERE job_id = ANY($1::uuid[]) ORDER BY stage_key, generation`, [page.map((job) => job.id)]) : { rows: [] as StageRow[] };
      const stages = new Map<string, StageRow[]>();
      for (const stage of stageRows.rows) stages.set(stage.jobId, [...(stages.get(stage.jobId) ?? []), stage]);
      const tail = page.at(-1);
      const next = jobs.rows.length > PAGE_SIZE && tail ? encodeListCursor(tail.createdAt, tail.id) : undefined;
      return { jobs: page.map((job) => metadataListItem(job, stages.get(job.id) ?? [])), ...(next ? { nextCursor: next } : {}) };
    },

    async review(scope, jobId, rawInput) {
      return withTransaction(pool, async (client) => {
        const jobs = await client.query<JobRow>(`SELECT ${JOB_SELECT} FROM authoring_jobs WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`, [jobId, scope.ownerUserId]);
        const job = jobs.rows[0];
        if (!job || isDiscardedInput(job.input)) throw new AuthoringRepositoryError("not_found");
        await requireUnexpired(client, job.id);
        const target = authoringTargetSchema.parse(job.target);
        const input = parseAuthoringCommandForJob({ kind: job.kind as never, target }, "review", rawInput) as AuthoringReview;
        commandJob(job, input.expectedRevision);
        if (!["queued", "running", "awaiting_review", "recoverable"].includes(job.status as string)) throw new AuthoringRepositoryError("invalid_state");
        if ((job.status === "queued" || job.status === "running") && job.reviewedContent === null && input.selectedStageIds.length === 0) throw new AuthoringRepositoryError("invalid_state");
        const request = authoringSubmitSchema.parse(job.input);
        const stages = await client.query<StageRow>(`SELECT ${STAGE_SELECT} FROM authoring_job_stages WHERE job_id = $1 FOR UPDATE`, [job.id]);
        const current = currentStages(stages.rows);
        const characterId = job.kind === "character" && request.kind === "character"
          ? (target.kind === "world_draft" ? target.characterId ?? request.characterId : request.characterId)
            ?? current.find((stage) => stage.stageKey.startsWith("character:"))?.stageKey.slice("character:".length)
          : undefined;
        if (characterId !== undefined && playableCharacterSchema.parse(input.content).id !== characterId) throw new AuthoringRepositoryError("invalid_state");
        const selected = new Set(input.selectedStageIds);
        if (selected.size !== input.selectedStageIds.length || [...selected].some((id) => {
          const stage = current.find((candidate) => candidate.id === id);
          return !stage || stage.status !== "validated" || !hasValidatedOutput(stage) || !parentsAreCurrentAndValidated(stages.rows, stage.parentGenerations);
        })) {
          throw new AuthoringRepositoryError("invalid_state");
        }
        await client.query(
          `UPDATE authoring_jobs SET reviewed_content = $2::jsonb, reviewed_stage_ids = $3::jsonb, review_generation = review_generation + 1,
             revision = revision + 1, last_activity_at = clock_timestamp(), expires_at = clock_timestamp() + interval '7 days', updated_at = clock_timestamp()
           WHERE id = $1`,
          [job.id, json(input.content), json([...new Set(input.selectedStageIds)].sort())]
        );
        return lockedView(client, job.id);
      });
    },

    async apply(scope, jobId, rawInput, rawRequestHash, worlds) {
      const input = rawInput as AuthoringApply;
      const applyHash = requestHash(rawRequestHash);
      return withTransaction(pool, async (client) => {
        // The proposal lock is deliberately taken before the target draft lock.
        const jobs = await client.query<JobRow>(
          `SELECT ${JOB_SELECT} FROM authoring_jobs WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
          [jobId, scope.ownerUserId]
        );
        const job = jobs.rows[0];
        if (!job || isDiscardedInput(job.input)) throw new AuthoringRepositoryError("not_found");

        // Receipt replay is intentionally first: an HTTP retry may carry the
        // pre-apply proposal revision and arrive after normal proposal expiry.
        if (job.applyReceipt !== null && job.applyReceipt !== undefined) {
          const receipt = authoringApplyReceiptSchema.parse(job.applyReceipt);
          if (job.applyKey !== input.idempotencyKey || job.applyHash !== applyHash) {
            throw new AuthoringRepositoryError("idempotency_conflict");
          }
          // Applied jobs use expires_at as their receipt-retention deadline.
          // A seven-day-inactive proposal can replay, but a receipt that has
          // passed its thirty-day deadline cannot outlive cleanup policy.
          await requireUnexpired(client, job.id);
          return receipt;
        }
        await requireUnexpired(client, job.id);
        commandJob(job, input.expectedRevision);
        if (job.status !== "awaiting_review" && job.status !== "recoverable") throw new AuthoringRepositoryError("invalid_state");
        if (job.reviewedContent === null || job.reviewedContent === undefined ||
          stableJson(job.reviewedContent) !== stableJson(input.content)) {
          throw new AuthoringRepositoryError("invalid_state");
        }

        const stages = await client.query<StageRow>(
          `SELECT ${STAGE_SELECT} FROM authoring_job_stages WHERE job_id = $1 AND owner_user_id = $2 FOR UPDATE`,
          [job.id, scope.ownerUserId]
        );
        const current = currentStages(stages.rows).filter((stage) => stage.status !== "cancelled");
        const selected = [...new Set(input.selectedStageIds)].sort();
        const reviewed = Array.isArray(job.reviewedStageIds) ? [...new Set(job.reviewedStageIds.filter((value): value is string => typeof value === "string"))].sort() : [];
        if (!selected.length || selected.length !== input.selectedStageIds.length || stableJson(selected) !== stableJson(reviewed) ||
          selected.some((id) => {
            const stage = current.find((candidate) => candidate.id === id);
            return !stage || stage.status !== "validated" || !hasValidatedOutput(stage) || !parentsAreCurrentAndValidated(stages.rows, stage.parentGenerations);
          })) {
          throw new AuthoringRepositoryError("invalid_state");
        }
        const target = authoringTargetSchema.parse(job.target);
        if (job.kind === "world_concept" && target.kind === "world_draft" && target.characterId !== undefined) throw new AuthoringRepositoryError("invalid_state");
        if (job.kind === "character" && target.kind === "new_world") throw new AuthoringRepositoryError("invalid_state");
        const receiptParts = await runPostgresWorldCampaignCommandWithClient(client, (transaction) =>
          worlds.applyInTransaction(transaction, scope, target, input.content)
        );
        const receipt = authoringApplyReceiptSchema.parse({ jobId: job.id, ...receiptParts });
        await client.query(
          `UPDATE authoring_jobs SET status = 'applied', input = '{"applied":true}'::jsonb, reviewed_content = NULL,
             reviewed_stage_ids = '[]'::jsonb, execution_snapshot = NULL, apply_key = $2, apply_hash = $3, apply_receipt = $4::jsonb,
             revision = revision + 1, last_activity_at = clock_timestamp(), expires_at = clock_timestamp() + interval '30 days', updated_at = clock_timestamp()
           WHERE id = $1`,
          [job.id, input.idempotencyKey, applyHash, json(receipt)]
        );
        await client.query("UPDATE authoring_job_stages SET output = NULL, failure = NULL, updated_at = clock_timestamp() WHERE job_id = $1", [job.id]);
        return receipt;
      });
    },

    async reviewSourceFacts(scope, jobId, rawReview) {
      return withTransaction(pool, async (client) => {
        const jobs = await client.query<JobRow>(`SELECT ${JOB_SELECT} FROM authoring_jobs WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`, [jobId, scope.ownerUserId]);
        const job = jobs.rows[0];
        if (!job || isDiscardedInput(job.input)) throw new AuthoringRepositoryError("not_found");
        if (job.kind !== "story_source") throw new AuthoringRepositoryError("invalid_state");
        await requireUnexpired(client, job.id);
        const review = sourceFactReviewSchema.parse(rawReview);
        commandJob(job, review.expectedRevision);
        if (job.status !== "awaiting_review" && job.status !== "recoverable") throw new AuthoringRepositoryError("invalid_state");
        const stages = await client.query<StageRow>(`SELECT ${STAGE_SELECT} FROM authoring_job_stages WHERE job_id = $1 FOR UPDATE`, [job.id]);
        const detail = sourceDetail(job, authoringSubmitSchema.parse(job.input) as SourceAuthoringInput, stages.rows);
        if (!detail.extractionComplete) throw new AuthoringRepositoryError("invalid_state");
        const priorReview = persistedSourceFactReviewSchema.safeParse(job.sourceReview).data;
        const existingFacts = detail.facts;
        const existingFactById = new Map(existingFacts.map((fact) => [fact.id, fact]));
        const submittedManualIds = review.manualFacts.map((fact) => fact.id);
        if (new Set(submittedManualIds).size !== submittedManualIds.length
          || submittedManualIds.some((id) => existingFactById.has(id))
          || review.rejectedFactIds.some((id) => submittedManualIds.includes(id))
          || review.uncertainFactIds.some((id) => submittedManualIds.includes(id))) {
          throw new AuthoringRepositoryError("invalid_state");
        }
        const manualIdMap = new Map(submittedManualIds.map((id) => [id, `source-fact:manual:${randomUUID()}`]));
        const remapManualReference = (id: string) => manualIdMap.get(id) ?? id;
        const manualFacts = review.manualFacts.map((fact) => ({ ...fact, id: manualIdMap.get(fact.id)!, provenance: "manual" as const, citations: [] }));
        const requestedCandidateIds = new Set([
          ...review.acceptedFactIds,
          ...review.rejectedFactIds,
          ...review.uncertainFactIds,
          ...review.selectedCharacterFactIds,
          ...review.characterIdentityGroups.flatMap((group) => [group.representativeFactId, ...group.factIds])
        ]);
        const persistedCandidateIds = new Set((priorReview?.expansionCandidates ?? []).map((fact) => fact.id));
        const reviewedStageCandidates = detail.facts.filter((fact) => fact.provenance === "invented"
          && !persistedCandidateIds.has(fact.id) && requestedCandidateIds.has(fact.id));
        const finalReview = persistedSourceFactReviewSchema.parse({
          ...review,
          acceptedFactIds: [...review.acceptedFactIds, ...submittedManualIds.filter((id) => !review.acceptedFactIds.includes(id))].map(remapManualReference),
          rejectedFactIds: review.rejectedFactIds.map(remapManualReference),
          uncertainFactIds: review.uncertainFactIds.map(remapManualReference),
          selectedCharacterFactIds: review.selectedCharacterFactIds.map(remapManualReference),
          characterIdentityGroups: review.characterIdentityGroups.map((group) => ({
            representativeFactId: remapManualReference(group.representativeFactId),
            factIds: group.factIds.map(remapManualReference)
          })),
          manualFacts: [...(priorReview?.manualFacts ?? []), ...manualFacts],
          expansionCandidates: [...(priorReview?.expansionCandidates ?? []), ...reviewedStageCandidates]
        });
        const facts = mergeSourceFacts([...existingFacts, ...manualFacts]);
        const factById = new Map(facts.map((fact) => [fact.id, fact]));
        const requestedIds = [
          ...finalReview.acceptedFactIds,
          ...finalReview.rejectedFactIds,
          ...finalReview.uncertainFactIds,
          ...finalReview.selectedCharacterFactIds,
          ...finalReview.characterIdentityGroups.flatMap((group) => [group.representativeFactId, ...group.factIds])
        ];
        if (requestedIds.some((id) => !factById.has(id))) throw new AuthoringRepositoryError("invalid_state");
        if (finalReview.selectedCharacterFactIds.some((id) => factById.get(id)?.kind !== "character")) throw new AuthoringRepositoryError("invalid_state");
        const accepted = finalReview.acceptedFactIds.map((id) => factById.get(id)!);
        const acceptedCharacterIds = new Set(accepted.filter((fact) => fact.kind === "character").map((fact) => fact.id));
        const identityMembership = new Set<string>();
        for (const group of finalReview.characterIdentityGroups) {
          if (group.factIds.some((id) => factById.get(id)?.kind !== "character" || !acceptedCharacterIds.has(id))) {
            throw new AuthoringRepositoryError("invalid_state");
          }
          if (!group.factIds.includes(group.representativeFactId) || !acceptedCharacterIds.has(group.representativeFactId)) {
            throw new AuthoringRepositoryError("invalid_state");
          }
          for (const factId of group.factIds) {
            if (identityMembership.has(factId)) throw new AuthoringRepositoryError("invalid_state");
            identityMembership.add(factId);
          }
          if (factsConflict(group.factIds.map((id) => factById.get(id)!))) throw new AuthoringRepositoryError("invalid_state");
        }
        if (identityMembership.size !== acceptedCharacterIds.size) throw new AuthoringRepositoryError("invalid_state");
        const representatives = new Set(finalReview.characterIdentityGroups.map((group) => group.representativeFactId));
        if (finalReview.selectedCharacterFactIds.some((id) => !representatives.has(id))) throw new AuthoringRepositoryError("invalid_state");
        if (factsConflict(accepted.filter((fact) => fact.kind !== "character"))) throw new AuthoringRepositoryError("invalid_state");
        const persisted = finalReview;
        await client.query(
          `UPDATE authoring_jobs SET source_review = $2::jsonb, review_generation = review_generation + 1,
             revision = revision + 1, last_activity_at = clock_timestamp(), expires_at = clock_timestamp() + interval '7 days', updated_at = clock_timestamp()
           WHERE id = $1`,
          [job.id, json(persisted)]
        );
        await invalidateSourceSynthesisDescendants(client, job.id);
        return lockedView(client, job.id);
      });
    },

    async startSourceSynthesis(scope, jobId, expectedRevision) {
      return withTransaction(pool, async (client) => {
        const jobs = await client.query<JobRow>(`SELECT ${JOB_SELECT} FROM authoring_jobs WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`, [jobId, scope.ownerUserId]);
        const job = jobs.rows[0];
        if (!job || isDiscardedInput(job.input)) throw new AuthoringRepositoryError("not_found");
        if (job.kind !== "story_source") throw new AuthoringRepositoryError("invalid_state");
        await requireUnexpired(client, job.id);
        commandJob(job, expectedRevision);
        if (job.status !== "awaiting_review" && job.status !== "recoverable") throw new AuthoringRepositoryError("invalid_state");
        const review = persistedSourceFactReviewSchema.safeParse(job.sourceReview).data;
        if (!review?.acceptedFactIds.length) throw new AuthoringRepositoryError("choose_source_facts");
        const stages = await client.query<StageRow>(`SELECT ${STAGE_SELECT} FROM authoring_job_stages WHERE job_id = $1 FOR UPDATE`, [job.id]);
        const detail = sourceDetail(job, authoringSubmitSchema.parse(job.input) as SourceAuthoringInput, stages.rows);
        if (!detail.extractionComplete) throw new AuthoringRepositoryError("invalid_state");
        const parents = Object.fromEntries(currentStages(stages.rows)
          .filter((stage) => stage.stageKey.startsWith("source:chunk:") && stage.status === "validated")
          .map((stage) => [stage.stageKey, stage.generation]));
        await client.query(
          `INSERT INTO authoring_job_stages (job_id, owner_user_id, stage_key, generation, parent_generations, source_review_generation, status, next_attempt_at)
           VALUES ($1, $2, 'source:synthesis',
             (SELECT coalesce(max(current.generation), 0) + 1 FROM authoring_job_stages current WHERE current.job_id = $1 AND current.stage_key = 'source:synthesis'),
             $3::jsonb, $4, 'queued', clock_timestamp())`,
          [job.id, scope.ownerUserId, json(parents), job.reviewGeneration]
        );
        await client.query("UPDATE authoring_jobs SET status = 'queued', revision = revision + 1, updated_at = clock_timestamp() WHERE id = $1", [job.id]);
        return lockedView(client, job.id);
      });
    },

    async retry(scope, jobId, stageId, expectedRevision) {
      return withTransaction(pool, async (client) => {
        const jobs = await client.query<JobRow>(`SELECT ${JOB_SELECT} FROM authoring_jobs WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`, [jobId, scope.ownerUserId]);
        const job = jobs.rows[0];
        if (!job) throw new AuthoringRepositoryError("not_found");
        await requireUnexpired(client, job.id);
        commandJob(job, expectedRevision);
        if (job.status !== "awaiting_review" && job.status !== "recoverable") throw new AuthoringRepositoryError("invalid_state");
        const stages = await client.query<StageRow>(`SELECT ${STAGE_SELECT} FROM authoring_job_stages WHERE job_id = $1 AND owner_user_id = $2 FOR UPDATE`, [job.id, scope.ownerUserId]);
        const current = currentStages(stages.rows);
        const source = current.find((stage) => stage.id === stageId);
        if (!source) throw new AuthoringRepositoryError("not_found");
        const idsByKey = new Map(current.map((stage) => [stage.stageKey, stage.id]));
        const lifecycle: AuthoringStageLifecycle[] = current.map((stage) => ({
          id: stage.id,
          key: stage.stageKey,
          generation: stage.generation,
          status: stage.status as AuthoringStageLifecycle["status"],
          attemptCount: stage.attemptCount,
          ...(stage.output === null || stage.output === undefined ? {} : { output: stage.output }),
          explicitRetryGenerations: stage.retryCount,
          dependsOn: Object.keys(stage.parentGenerations as Record<string, unknown>).flatMap((key) => {
            const id = idsByKey.get(key);
            return id === undefined ? [] : [id];
          }),
          parentGenerations: stage.parentGenerations as Record<string, number>
        }));
        let next: AuthoringStageLifecycle[];
        try { next = retryAuthoringStage(lifecycle, stageId, { allowValidated: true }); }
        catch { throw new AuthoringRepositoryError("invalid_state"); }
        for (const replacement of next) {
          const prior = lifecycle.find((stage) => stage.id === replacement.id)!;
          if (replacement.generation === prior.generation) continue;
          const original = current.find((stage) => stage.id === replacement.id)!;
          if (original.status === "running") {
            await client.query("UPDATE authoring_job_stages SET status = 'cancelled', lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = clock_timestamp() WHERE id = $1", [original.id]);
          }
          await client.query(
            `INSERT INTO authoring_job_stages (job_id, owner_user_id, stage_key, generation, parent_generations, status, attempt_count, retry_count, next_attempt_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, 'queued', 0, $6, clock_timestamp())`,
            [job.id, scope.ownerUserId, replacement.key, replacement.generation, json(replacement.parentGenerations ?? {}), replacement.explicitRetryGenerations ?? original.retryCount]
          );
        }
        await client.query(
          `UPDATE authoring_jobs SET status = 'queued', revision = revision + 1,
             last_activity_at = clock_timestamp(), expires_at = clock_timestamp() + interval '7 days', updated_at = clock_timestamp()
           WHERE id = $1`,
          [job.id]
        );
        return lockedView(client, job.id);
      });
    },

    async cancel(scope, jobId, expectedRevision) {
      return withTransaction(pool, async (client) => {
        const jobs = await client.query<JobRow>(`SELECT ${JOB_SELECT} FROM authoring_jobs WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`, [jobId, scope.ownerUserId]);
        const job = jobs.rows[0];
        if (!job || isDiscardedInput(job.input)) throw new AuthoringRepositoryError("not_found");
        await requireUnexpired(client, job.id);
        if (job.status === "cancelled" && (expectedRevision === job.revision || expectedRevision === job.revision - 1)) return lockedView(client, job.id);
        commandJob(job, expectedRevision);
        if (["failed", "applied", "expired"].includes(job.status as string)) throw new AuthoringRepositoryError("invalid_state");
        await client.query(`SELECT id FROM authoring_job_stages WHERE job_id = $1 FOR UPDATE`, [job.id]);
        await client.query(
          `UPDATE authoring_job_stages SET status = 'cancelled', lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
            WHERE job_id = $1 AND generation = (SELECT max(current.generation) FROM authoring_job_stages current WHERE current.job_id = authoring_job_stages.job_id AND current.stage_key = authoring_job_stages.stage_key)
              AND status IN ('queued', 'running', 'recoverable')`,
          [job.id]
        );
        await client.query("UPDATE authoring_jobs SET status = 'cancelled', revision = revision + 1, execution_generation = execution_generation + 1, updated_at = clock_timestamp() WHERE id = $1", [job.id]);
        return lockedView(client, job.id);
      });
    },

    async discard(scope, jobId, expectedRevision) {
      await withTransaction(pool, async (client) => {
        const jobs = await client.query<JobRow>(`SELECT ${JOB_SELECT} FROM authoring_jobs WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`, [jobId, scope.ownerUserId]);
        const job = jobs.rows[0];
        if (!job) throw new AuthoringRepositoryError("not_found");
        await requireUnexpired(client, job.id);
        if (isDiscardedInput(job.input) && (expectedRevision === job.revision || expectedRevision === job.revision - 1)) return;
        commandJob(job, expectedRevision);
        if (job.status === "applied") throw new AuthoringRepositoryError("invalid_state");
        await client.query(`SELECT id FROM authoring_job_stages WHERE job_id = $1 FOR UPDATE`, [job.id]);
        await client.query(
          `UPDATE authoring_job_stages SET status = CASE WHEN status = 'running' THEN 'cancelled' ELSE status END,
             lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL, output = NULL, failure = NULL, updated_at = clock_timestamp()
           WHERE job_id = $1`,
          [job.id]
        );
        await client.query(
          `UPDATE authoring_jobs SET input = '{"discarded":true}'::jsonb, reviewed_content = NULL, execution_snapshot = NULL,
             status = 'cancelled', revision = revision + 1, execution_generation = execution_generation + 1, updated_at = clock_timestamp()
           WHERE id = $1`,
          [job.id]
        );
      });
    },

    async cleanupAuthoring({ batchSize, now = new Date() }) {
      if (!Number.isInteger(batchSize) || batchSize < 1) {
        throw new RangeError("Authoring cleanup batch size must be a positive integer.");
      }
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new TypeError("Authoring cleanup requires a valid cutoff timestamp.");
      }
      const limit = Math.min(batchSize, MAX_CLEANUP_BATCH_SIZE);
      return withTransaction(pool, async (client) => {
        // Lock jobs before their stages. SKIP LOCKED keeps cleanup bounded and
        // lets an active checkpoint finish rather than blocking the lane.
        const candidates = await client.query<JobRow>(
          `SELECT ${JOB_SELECT} FROM authoring_jobs jobs
             WHERE jobs.expires_at <= $1::timestamptz
               AND jobs.status <> 'expired'
             ORDER BY jobs.expires_at, jobs.id
             FOR UPDATE SKIP LOCKED
             LIMIT $2`,
          [now.toISOString(), limit]
        );
        for (const job of candidates.rows) {
          // A running claim is fenced before any payload is cleared. The
          // condition intentionally uses the database clock through the
          // normal claim guard, never the injected test cutoff.
          await client.query(
            `SELECT id FROM authoring_job_stages
              WHERE job_id = $1 AND owner_user_id = $2
              FOR UPDATE`,
            [job.id, job.ownerUserId]
          );
          await client.query(
            `UPDATE authoring_job_stages
                SET status = 'cancelled',
                    lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
                    output = NULL, failure = NULL, updated_at = clock_timestamp()
              WHERE job_id = $1 AND owner_user_id = $2`,
            [job.id, job.ownerUserId]
          );
          await client.query(
            `UPDATE authoring_jobs
                SET status = 'expired', input = '{"expired":true}'::jsonb,
                    reviewed_content = NULL, reviewed_stage_ids = '[]'::jsonb,
                    execution_snapshot = NULL, apply_key = NULL, apply_hash = NULL,
                    apply_receipt = NULL, execution_generation = execution_generation + 1,
                    revision = revision + 1, updated_at = clock_timestamp()
              WHERE id = $1 AND owner_user_id = $2`,
            [job.id, job.ownerUserId]
          );
        }
        return candidates.rows.length;
      });
    },

    async claim(workerId, requestedLeaseSeconds) {
      const seconds = leaseSeconds(requestedLeaseSeconds);
      if (!workerId.trim()) throw new TypeError("Authoring worker ID is required.");
      const claim = await withTransaction(pool, async (client) => {
        const jobs = await client.query<JobRow>(`SELECT ${JOB_SELECT} FROM authoring_jobs jobs WHERE jobs.status IN ('queued','running') AND jobs.expires_at > clock_timestamp() AND EXISTS (SELECT 1 FROM authoring_job_stages stages WHERE stages.job_id = jobs.id AND stages.owner_user_id = jobs.owner_user_id AND stages.generation = (SELECT max(current.generation) FROM authoring_job_stages current WHERE current.job_id = stages.job_id AND current.stage_key = stages.stage_key) AND NOT EXISTS (SELECT 1 FROM jsonb_each_text(stages.parent_generations) dependency LEFT JOIN authoring_job_stages parent ON parent.job_id = stages.job_id AND parent.stage_key = dependency.key AND parent.generation = dependency.value::int AND parent.status = 'validated' AND parent.generation = (SELECT max(current.generation) FROM authoring_job_stages current WHERE current.job_id = parent.job_id AND current.stage_key = parent.stage_key) WHERE parent.id IS NULL) AND (stages.status = 'queued' AND stages.next_attempt_at <= clock_timestamp() OR stages.status = 'running' AND stages.lease_expires_at <= clock_timestamp() AND stages.attempt_count <= 3)) ORDER BY jobs.created_at, jobs.id FOR UPDATE SKIP LOCKED LIMIT 1`);
        const job = jobs.rows[0];
        if (!job) return null;
        const stages = await client.query<StageRow>(`SELECT ${STAGE_SELECT} FROM authoring_job_stages stages WHERE stages.job_id = $1 AND stages.owner_user_id = $2 AND (stages.source_review_generation IS NULL OR stages.source_review_generation = $3) AND stages.generation = (SELECT max(current.generation) FROM authoring_job_stages current WHERE current.job_id = stages.job_id AND current.stage_key = stages.stage_key) AND NOT EXISTS (SELECT 1 FROM jsonb_each_text(stages.parent_generations) dependency LEFT JOIN authoring_job_stages parent ON parent.job_id = stages.job_id AND parent.stage_key = dependency.key AND parent.generation = dependency.value::int AND parent.status = 'validated' AND parent.generation = (SELECT max(current.generation) FROM authoring_job_stages current WHERE current.job_id = parent.job_id AND current.stage_key = parent.stage_key) WHERE parent.id IS NULL) AND ((stages.status = 'queued' AND stages.next_attempt_at <= clock_timestamp()) OR (stages.status = 'running' AND stages.lease_expires_at <= clock_timestamp() AND stages.attempt_count <= 3)) ORDER BY stages.next_attempt_at, stages.created_at, stages.id FOR UPDATE SKIP LOCKED LIMIT 1`, [job.id, job.ownerUserId, job.reviewGeneration]);
        const stage = stages.rows[0];
        if (!stage || !(await parentsAreValidated(client, job.id, stage.parentGenerations))) return null;
        await client.query("UPDATE authoring_job_stages SET status = 'running', attempt_count = attempt_count + 1, lease_token = gen_random_uuid(), lease_owner = $2, lease_expires_at = clock_timestamp() + make_interval(secs => $3::int), started_at = COALESCE(started_at, clock_timestamp()), updated_at = clock_timestamp() WHERE id = $1", [stage.id, workerId, seconds]);
        const row = (await client.query<StageRow>(`SELECT ${STAGE_SELECT} FROM authoring_job_stages WHERE id = $1`, [stage.id])).rows[0]!;
        await client.query("UPDATE authoring_jobs SET status = 'running', last_activity_at = clock_timestamp(), expires_at = clock_timestamp() + interval '7 days', updated_at = clock_timestamp() WHERE id = $1", [job.id]);
        return { jobId: job.id, stageId: row.id, ownerUserId: job.ownerUserId, jobGeneration: job.executionGeneration, stageGeneration: row.generation, leaseToken: row.leaseToken!, leaseExpiresAt: timestamp(row.leaseExpiresAt) };
      });
      if (claim) return claim;
      await withTransaction(pool, async (client) => {
        const jobs = await client.query<JobRow>(`SELECT ${JOB_SELECT} FROM authoring_jobs jobs WHERE jobs.status = 'running' AND EXISTS (SELECT 1 FROM authoring_job_stages stages WHERE stages.job_id = jobs.id AND stages.status = 'running' AND stages.lease_expires_at <= clock_timestamp() AND stages.attempt_count > 3 AND stages.generation = (SELECT max(current.generation) FROM authoring_job_stages current WHERE current.job_id = stages.job_id AND current.stage_key = stages.stage_key)) ORDER BY jobs.created_at, jobs.id FOR UPDATE SKIP LOCKED LIMIT 1`);
        const job = jobs.rows[0];
        if (!job) return;
        const stages = await client.query<StageRow>(`SELECT ${STAGE_SELECT} FROM authoring_job_stages stages WHERE job_id = $1 AND status = 'running' AND lease_expires_at <= clock_timestamp() AND attempt_count > 3 AND generation = (SELECT max(current.generation) FROM authoring_job_stages current WHERE current.job_id = stages.job_id AND current.stage_key = stages.stage_key) ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1`, [job.id]);
        const stage = stages.rows[0];
        if (!stage) return;
        await client.query("UPDATE authoring_job_stages SET status = 'recoverable', lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL, failure = $2::jsonb, updated_at = clock_timestamp() WHERE id = $1", [stage.id, json(projectAuthoringFailure({ code: "authoring_retry_exhausted", stage: stage.stageKey === "world" ? "world" : "character", retryable: false, issues: [] }))]);
        await client.query("UPDATE authoring_jobs SET status = 'recoverable', updated_at = clock_timestamp() WHERE id = $1", [job.id]);
      });
      return null;
    },

    async heartbeat(claim, requestedLeaseSeconds) {
      const seconds = leaseSeconds(requestedLeaseSeconds);
      return (await withCurrentClaim(claim, async (client, _job, stage) => (await client.query("UPDATE authoring_job_stages SET lease_expires_at = clock_timestamp() + make_interval(secs => $2::int), updated_at = clock_timestamp() WHERE id = $1 AND lease_expires_at > clock_timestamp()", [stage.id, seconds])).rowCount === 1)) ?? false;
    },

    async checkpoint(claim, rawOutput) {
      const parsedOutput = authoringStageOutputSchema.parse(rawOutput);
      return (await withCurrentClaim(claim, async (client, job, stage) => {
        const output = validateStageOutput(stage.stageKey, parsedOutput);
        const updated = await client.query("UPDATE authoring_job_stages SET status = 'validated', output = $2::jsonb, failure = NULL, lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL, completed_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1 AND lease_expires_at > clock_timestamp()", [stage.id, json(output)]);
        if (updated.rowCount !== 1) return false;
        if (output.kind === "source_plan") {
          if (output.chunks.length > 200) throw new TypeError("A source authoring job cannot create more than 200 extraction chunks.");
          await client.query("UPDATE authoring_jobs SET source_plan = $2::jsonb WHERE id = $1", [job.id, json({ chunks: output.chunks, planningStageGeneration: stage.generation })]);
          // A regenerated plan invalidates every dependent leaf, including
          // completed output. Keep those immutable rows for audit, but never
          // let their old parent generation remain selectable or claimable.
          await client.query(
            `UPDATE authoring_job_stages children
                SET status = 'cancelled', lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
              WHERE children.job_id = $1 AND children.stage_key LIKE 'source:chunk:%'
                AND children.generation = (SELECT max(current.generation) FROM authoring_job_stages current WHERE current.job_id = children.job_id AND current.stage_key = children.stage_key)`,
            [job.id]
          );
          await invalidateSourceSynthesisDescendants(client, job.id);
          for (const chunk of output.chunks) {
            await client.query(
              `INSERT INTO authoring_job_stages (job_id, owner_user_id, stage_key, generation, parent_generations, status, next_attempt_at)
               VALUES ($1, $2, $3, (SELECT coalesce(max(current.generation), 0) + 1 FROM authoring_job_stages current WHERE current.job_id = $1 AND current.stage_key = $3), $4::jsonb, 'queued', clock_timestamp())`,
              [job.id, job.ownerUserId, `source:chunk:${chunk.id}`, json({ "source:plan": stage.generation })]
            );
          }
        } else {
          if (output.kind === "source_extraction") await invalidateSourceSynthesisDescendants(client, job.id);
          if (output.kind === "source_world" && stage.stageKey === "source:synthesis") {
            await reconcileSourceWorldChildren(client, job, stage);
          } else {
            await reconcileOutlineChildren(client, job, stage, output);
          }
        }
        const complete = await completeCurrentStages(client, job.id);
        await client.query("UPDATE authoring_jobs SET status = $2, last_activity_at = clock_timestamp(), expires_at = clock_timestamp() + interval '7 days', updated_at = clock_timestamp() WHERE id = $1", [job.id, complete ? "awaiting_review" : "running"]);
        return true;
      })) ?? false;
    },

    async splitSourceChunk(claim, chunkId) {
      return (await withCurrentClaim(claim, async (client, job, stage) => {
        if (job.kind !== "story_source" || stage.stageKey !== `source:chunk:${chunkId}`) return false;
        const planValue = typeof job.sourcePlan === "object" && job.sourcePlan !== null && !Array.isArray(job.sourcePlan)
          ? (job.sourcePlan as { chunks?: unknown; splitCount?: unknown; planningStageGeneration?: unknown })
          : undefined;
        if (!planValue || !Array.isArray(planValue.chunks)) return false;
        const parsed = authoringStageOutputSchema.parse({ kind: "source_plan", chunks: planValue.chunks });
        if (parsed.kind !== "source_plan") return false;
        const parent = parsed.chunks.find((chunk) => chunk.id === chunkId);
        if (!parent) return false;
        const cumulative = await client.query<{ count: string }>(
          "SELECT count(DISTINCT stage_key)::text AS count FROM authoring_job_stages WHERE job_id = $1 AND stage_key LIKE 'source:chunk:%'",
          [job.id]
        );
        if (Number(cumulative.rows[0]?.count ?? 0) + 2 > 200) return false;
        const input = authoringSubmitSchema.parse(job.input);
        if (input.kind !== "story_source") return false;
        const children = splitSourceChunk(sourceDocumentFromNormalizedText(input.name, input.text, job.id), parent);
        const planGeneration = typeof planValue.planningStageGeneration === "number" && Number.isInteger(planValue.planningStageGeneration)
          ? planValue.planningStageGeneration
          : 1;
        const cancelled = await client.query(
          "UPDATE authoring_job_stages SET status = 'cancelled', failure = NULL, lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL, completed_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1 AND lease_expires_at > clock_timestamp()",
          [stage.id]
        );
        if (cancelled.rowCount !== 1) return false;
        await client.query(
          "UPDATE authoring_jobs SET source_plan = $2::jsonb, status = 'queued', revision = revision + 1, last_activity_at = clock_timestamp(), expires_at = clock_timestamp() + interval '7 days', updated_at = clock_timestamp() WHERE id = $1",
          [job.id, json({ chunks: [...parsed.chunks.filter((chunk) => chunk.id !== chunkId), ...children], planningStageGeneration: planGeneration, splitCount: Number(planValue.splitCount ?? 0) + 1 })]
        );
        for (const child of children) {
          await client.query(
            `INSERT INTO authoring_job_stages (job_id, owner_user_id, stage_key, parent_generations, status, next_attempt_at)
             VALUES ($1, $2, $3, $4::jsonb, 'queued', clock_timestamp())`,
            [job.id, job.ownerUserId, `source:chunk:${child.id}`, json({ "source:plan": planGeneration })]
          );
        }
        return true;
      })) ?? false;
    },

    async fail(claim, rawFailure) {
      const failure = projectAuthoringFailure(authoringFailureSchema.parse(rawFailure));
      return (await withCurrentClaim(claim, async (client, job, stage) => {
        const retainsPartialWorld = stage.stageKey.startsWith("character:") && (await client.query(
          `SELECT 1 FROM authoring_job_stages world
            WHERE world.job_id = $1 AND world.stage_key = 'world' AND world.status = 'validated'
              AND world.generation = (SELECT max(current.generation) FROM authoring_job_stages current WHERE current.job_id = world.job_id AND current.stage_key = 'world')`,
          [job.id]
        )).rowCount === 1;
        const retainsPartialSource = stage.stageKey.startsWith("source:chunk:") && ((await client.query(
          `SELECT 1 FROM authoring_job_stages source
            WHERE source.job_id = $1 AND source.stage_key LIKE 'source:chunk:%' AND source.status = 'validated'
              AND source.generation = (SELECT max(current.generation) FROM authoring_job_stages current WHERE current.job_id = source.job_id AND current.stage_key = source.stage_key)`,
          [job.id]
        )).rowCount ?? 0) >= 1;
        const stageStatus = failure.retryable ? "recoverable" : "failed";
        const jobStatus = failure.retryable || retainsPartialWorld || retainsPartialSource ? "recoverable" : "failed";
        const updated = await client.query("UPDATE authoring_job_stages SET status = $2, failure = $3::jsonb, lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL, completed_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1 AND lease_expires_at > clock_timestamp()", [stage.id, stageStatus, json(failure)]);
        if (updated.rowCount !== 1) return false;
        await client.query("UPDATE authoring_jobs SET status = $2, last_activity_at = clock_timestamp(), expires_at = clock_timestamp() + interval '7 days', updated_at = clock_timestamp() WHERE id = $1", [job.id, jobStatus]);
        return true;
      })) ?? false;
    },

    async readClaimInput(claim) {
      return (await withCurrentClaim(claim, async (_client, job) => authoringSubmitSchema.parse(job.input))) ?? null;
    },

    async initializeExecutionSnapshot(claim, rawSnapshot) {
      const snapshot = authoringExecutionSnapshotSchema.parse(rawSnapshot);
      return (await withCurrentClaim(claim, async (client, job) => {
        const result = await client.query<{ executionSnapshot: unknown }>("UPDATE authoring_jobs SET execution_snapshot = COALESCE(execution_snapshot, $2::jsonb), updated_at = clock_timestamp() WHERE id = $1 AND EXISTS (SELECT 1 FROM authoring_job_stages WHERE id = $3 AND lease_expires_at > clock_timestamp()) RETURNING execution_snapshot AS \"executionSnapshot\"", [job.id, json(snapshot), claim.stageId]);
        if (!result.rows[0]) return null;
        return authoringExecutionSnapshotSchema.parse(result.rows[0].executionSnapshot);
      })) ?? null;
    },

    async loadClaim(claim) {
      return (await withCurrentClaim(claim, async (client, job, stage) => {
      if (job.executionSnapshot === null || job.executionSnapshot === undefined) return null;
      const parents = await client.query<{ stageKey: string; output: unknown }>(
        `SELECT parent.stage_key AS "stageKey", parent.output FROM authoring_job_stages child
          JOIN LATERAL jsonb_each_text(child.parent_generations) dependency ON true
          JOIN authoring_job_stages parent
            ON parent.job_id = child.job_id AND parent.stage_key = dependency.key
           AND parent.generation = dependency.value::int AND parent.status = 'validated'
         WHERE child.id = $1 ORDER BY parent.stage_key, parent.generation`,
        [stage.id]
      );
      const input = authoringSubmitSchema.parse(job.input);
      const selection = input.kind === "story_source" && (stage.stageKey === "source:synthesis" || stage.stageKey.startsWith("source:character:"))
        ? reviewedSourceSelection(job, input, (await client.query<StageRow>(`SELECT ${STAGE_SELECT} FROM authoring_job_stages WHERE job_id = $1`, [job.id])).rows)
        : null;
      if ((stage.stageKey === "source:synthesis" || stage.stageKey.startsWith("source:character:")) && !selection) return null;
      return {
        input,
        snapshot: authoringExecutionSnapshotSchema.parse(job.executionSnapshot),
        stageKey: stage.stageKey,
        parentOutputs: parents.rows.map((parent) => validateStageOutput(parent.stageKey, parent.output)),
        ...(job.kind === "story_source" && job.sourcePlan !== null && job.sourcePlan !== undefined ? { sourcePlan: job.sourcePlan } : {}),
        ...(selection ? { sourceSelection: selection } : {})
      };
      })) ?? null;
    }
  };
}

/** Owner/revision-scoped draft validation used before first enqueue. It has no publishing capability. */
export function createPostgresAuthoringTargetPort(pool: DatabasePool): AuthoringTargetPort {
  return {
    assertCurrent: async (scope, target) => withTransaction(pool, async (client) => {
      const draft = await client.query<{ revision: number; content: unknown }>(
        `SELECT wd.revision, wd.content FROM worlds w
          JOIN world_drafts wd ON wd.world_id = w.id AND wd.owner_user_id = w.owner_user_id
         WHERE w.id = $1 AND w.owner_user_id = $2 AND w.status <> 'archived'
         FOR KEY SHARE OF w, wd`,
        [target.worldId, scope.ownerUserId]
      );
      const current = draft.rows[0];
      if (!current) throw new AuthoringRepositoryError("not_found");
      if (current.revision !== target.expectedRevision) throw new AuthoringRepositoryError("revision_conflict");
      if (target.characterId !== undefined) {
        const matches = await client.query(
          `SELECT 1 FROM jsonb_array_elements(COALESCE($1::jsonb->'playableCharacters', '[]'::jsonb)) character
            WHERE character->>'id' = $2`,
          [json(current.content), target.characterId]
        );
        if (matches.rowCount !== 1) throw new AuthoringRepositoryError("not_found");
      }
    })
  };
}
