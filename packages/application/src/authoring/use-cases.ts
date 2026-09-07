import {
  authoringSubmitSchema,
  sourceFactReviewSchema,
  normalizeAuthoringSubmitForAdmission,
  parseAuthoringCommandForJob,
  type AuthoringApply,
  type AuthoringJobView,
  type AuthoringReview,
  type AuthoringSubmit
} from "@infinite-quest/contracts";
import type { OwnerScope } from "../generation/types.js";
import type { AuthoringApplicationDependencies } from "./ports.js";
import {
  AuthoringApplicationError,
  AuthoringRepositoryError,
  type AuthoringApplication,
  type AuthoringSha256
} from "./types.js";

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((child) => child === undefined ? "null" : stableJson(child)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function requireOwner(scope: OwnerScope): void {
  if (!scope.ownerUserId.trim()) throw new AuthoringApplicationError("authoring_owner_scope_required");
}

function requireIdentifier(value: string): void {
  if (!value.trim()) throw new AuthoringApplicationError("authoring_not_found");
}

function requireRevision(value: number): void {
  if (!Number.isInteger(value) || value < 0) throw new AuthoringApplicationError("authoring_revision_conflict");
}

function requestHash(input: AuthoringSubmit, sha256: AuthoringSha256): string {
  const hash = sha256(stableJson(input));
  if (!/^[0-9a-f]{64}$/u.test(hash)) throw new TypeError("Authoring SHA-256 must return a lower-case hex digest.");
  return hash;
}

function applyRequestHash(input: AuthoringApply, sha256: AuthoringSha256): string {
  const hash = sha256(stableJson({
    selectedStageIds: [...input.selectedStageIds].sort(),
    content: input.content
  }));
  if (!/^[0-9a-f]{64}$/u.test(hash)) throw new TypeError("Authoring SHA-256 must return a lower-case hex digest.");
  return hash;
}

function mapRepositoryError(error: unknown): never {
  if (error instanceof RangeError) throw new AuthoringApplicationError("authoring_input_too_large");
  if (error instanceof AuthoringRepositoryError) {
    const code = error.code === "idempotency_conflict"
      ? "authoring_idempotency_conflict"
      : error.code === "revision_conflict"
        ? "authoring_revision_conflict"
      : error.code === "not_found"
          ? "authoring_not_found"
          : error.code === "active_job_limit"
            ? "authoring_active_job_limit"
            : error.code === "choose_source_facts"
              ? "choose_source_facts"
            : "authoring_invalid_state";
    throw new AuthoringApplicationError(code);
  }
  throw error;
}

async function commandJob(dependencies: AuthoringApplicationDependencies, scope: OwnerScope, id: string): Promise<AuthoringJobView> {
  const job = await dependencies.repository.read(scope, id);
  if (!job) throw new AuthoringApplicationError("authoring_not_found");
  return job;
}

/** Provider-free proposal commands. Database adapters own atomic authoritative application. */
export function createAuthoringApplication(dependencies: AuthoringApplicationDependencies): AuthoringApplication {
  return {
    submit: async (scope, rawInput) => {
      requireOwner(scope);
      const input = normalizeAuthoringSubmitForAdmission(authoringSubmitSchema.parse(rawInput));
      const hash = requestHash(input, dependencies.sha256);
      const replay = await dependencies.repository.findIdempotency(scope, input.idempotencyKey);
      if (replay) {
        if (replay.requestHash !== hash) throw new AuthoringApplicationError("authoring_idempotency_conflict");
        if (replay.job) return replay.job;
        throw new AuthoringApplicationError("authoring_invalid_state");
      }
      if (input.kind === "world_concept" && input.target.kind === "world_draft" && input.target.characterId !== undefined) {
        throw new AuthoringApplicationError("authoring_invalid_target");
      }
      if (input.target.kind === "world_draft") {
        try { await dependencies.targets.assertCurrent(scope, input.target); } catch (error) { return mapRepositoryError(error); }
      }
      try {
        return await dependencies.repository.submit(scope, input, hash);
      } catch (error) { return mapRepositoryError(error); }
    },
    get: async (scope, id) => {
      requireOwner(scope);
      requireIdentifier(id);
      return dependencies.repository.read(scope, id);
    },
    list: async (scope, cursor) => {
      requireOwner(scope);
      return dependencies.repository.list(scope, cursor);
    },
    review: async (scope, id, rawInput) => {
      requireOwner(scope);
      requireIdentifier(id);
      const job = await commandJob(dependencies, scope, id);
      const input = parseAuthoringCommandForJob(job, "review", rawInput) as AuthoringReview;
      try { return await dependencies.repository.review(scope, id, input); } catch (error) { return mapRepositoryError(error); }
    },
    reviewSourceFacts: async (scope, id, rawReview) => {
      requireOwner(scope);
      requireIdentifier(id);
      const job = await commandJob(dependencies, scope, id);
      if (job.kind !== "story_source") throw new AuthoringApplicationError("authoring_invalid_state");
      const review = sourceFactReviewSchema.parse(rawReview);
      if (!dependencies.repository.reviewSourceFacts) throw new AuthoringApplicationError("authoring_invalid_state");
      try { return await dependencies.repository.reviewSourceFacts(scope, id, review); } catch (error) { return mapRepositoryError(error); }
    },
    startSourceSynthesis: async (scope, id, expectedRevision) => {
      requireOwner(scope);
      requireIdentifier(id);
      requireRevision(expectedRevision);
      const job = await commandJob(dependencies, scope, id);
      if (job.kind !== "story_source") throw new AuthoringApplicationError("authoring_invalid_state");
      if (!dependencies.repository.startSourceSynthesis) throw new AuthoringApplicationError("authoring_invalid_state");
      try { return await dependencies.repository.startSourceSynthesis(scope, id, expectedRevision); } catch (error) { return mapRepositoryError(error); }
    },
    retry: async (scope, id, stageId, expectedRevision) => {
      requireOwner(scope);
      requireIdentifier(id);
      requireIdentifier(stageId);
      requireRevision(expectedRevision);
      try { return await dependencies.repository.retry(scope, id, stageId, expectedRevision); } catch (error) { return mapRepositoryError(error); }
    },
    cancel: async (scope, id, expectedRevision) => {
      requireOwner(scope);
      requireIdentifier(id);
      requireRevision(expectedRevision);
      try { return await dependencies.repository.cancel(scope, id, expectedRevision); } catch (error) { return mapRepositoryError(error); }
    },
    discard: async (scope, id, expectedRevision) => {
      requireOwner(scope);
      requireIdentifier(id);
      requireRevision(expectedRevision);
      try { await dependencies.repository.discard(scope, id, expectedRevision); } catch (error) { return mapRepositoryError(error); }
    },
    apply: async (scope, id, rawInput) => {
      requireOwner(scope);
      requireIdentifier(id);
      const job = await commandJob(dependencies, scope, id);
      const input = parseAuthoringCommandForJob(job, "apply", rawInput) as AuthoringApply;
      try {
        return await dependencies.repository.apply(scope, id, input, applyRequestHash(input, dependencies.sha256), dependencies.worlds);
      } catch (error) { return mapRepositoryError(error); }
    }
  };
}
