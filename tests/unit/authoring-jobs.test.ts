import { describe, expect, it } from "vitest";
import {
  authoringJobListItemSchema,
  authoringJobViewSchema,
  parseAuthoringCommandForJob,
  authoringStageViewSchema,
  authoringSubmitSchema
} from "../../packages/contracts/src/authoring.js";
import {
  canApplyAuthoringJob,
  canRecoverAuthoringStageLease,
  canRetryAuthoringStage,
  canReviewAuthoringJob,
  canTransitionAuthoringJob,
  isAuthoringStageApplyEligible,
  retryAuthoringStage
} from "../../packages/domain/src/authoring-jobs.js";

const worldContent = {
  world: { title: "Moonlit Roads", genre: "Fantasy", tone: "Hopeful", premise: "Roads move.", backgroundStory: "Cartographers remember.", firstAction: "Follow the new road.", rules: "Maps are promises." },
  playableCharacters: []
};

const playableCharacter = {
  id: "iris",
  name: "Iris",
  characterText: "A patient cartographer."
};

const localWorldContent = {
  ...worldContent,
  playableCharacters: [playableCharacter]
};

describe("authoring job lifecycle", () => {
  it("allows only the declared job transitions", () => {
    expect(canTransitionAuthoringJob("running", "recoverable")).toBe(true);
    expect(canTransitionAuthoringJob("awaiting_review", "applied")).toBe(true);
    expect(canTransitionAuthoringJob("cancelled", "running")).toBe(false);
    expect(canTransitionAuthoringJob("applied", "queued")).toBe(false);
  });

  it("keeps partial results reviewable only until the job reaches a terminal failure", () => {
    expect(canReviewAuthoringJob("recoverable")).toBe(true);
    expect(canApplyAuthoringJob("recoverable")).toBe(true);
    for (const status of ["failed", "cancelled", "applied", "expired"] as const) {
      expect(canReviewAuthoringJob(status)).toBe(false);
      expect(canApplyAuthoringJob(status)).toBe(false);
      expect(canTransitionAuthoringJob(status, "running")).toBe(false);
    }
  });

  it("allows autosave review while work is queued or running but never broadens apply eligibility", () => {
    expect(canReviewAuthoringJob("queued")).toBe(true);
    expect(canReviewAuthoringJob("running")).toBe(true);
    expect(canApplyAuthoringJob("queued")).toBe(false);
    expect(canApplyAuthoringJob("running")).toBe(false);
  });

  it("bounds lease recovery and failed-stage retry generations", () => {
    expect(canRecoverAuthoringStageLease(2)).toBe(true);
    expect(canRecoverAuthoringStageLease(3)).toBe(false);
    expect(canRetryAuthoringStage(2)).toBe(true);
    expect(canRetryAuthoringStage(3)).toBe(false);
  });

  it("explicitly retries an outline generation and supersedes dependent children without disturbing siblings", () => {
    const next = retryAuthoringStage([
      { id: "world", key: "world", generation: 4, status: "validated", attemptCount: 1, explicitRetryGenerations: 2 },
      { id: "iris", key: "character:iris", generation: 2, status: "validated", attemptCount: 1, dependsOn: ["world"], output: { name: "Iris" } },
      { id: "mira", key: "character:mira", generation: 2, status: "validated", attemptCount: 1, dependsOn: ["world"], output: { name: "Mira" } },
      { id: "independent", key: "character:independent", generation: 3, status: "validated", attemptCount: 1 }
    ], "world", { allowValidated: true });

    expect(next).toEqual([
      { id: "world", key: "world", generation: 5, status: "queued", attemptCount: 0, explicitRetryGenerations: 3 },
      { id: "iris", key: "character:iris", generation: 3, status: "queued", attemptCount: 0, dependsOn: ["world"], parentGenerations: { world: 5 }, historicalOutputs: [{ generation: 2, output: { name: "Iris" }, supersededByGeneration: 5 }] },
      { id: "mira", key: "character:mira", generation: 3, status: "queued", attemptCount: 0, dependsOn: ["world"], parentGenerations: { world: 5 }, historicalOutputs: [{ generation: 2, output: { name: "Mira" }, supersededByGeneration: 5 }] },
      { id: "independent", key: "character:independent", generation: 3, status: "validated", attemptCount: 1 }
    ]);
    const replacement = next.find((stage) => stage.id === "iris");
    expect(replacement?.historicalOutputs).toEqual([{ generation: 2, output: { name: "Iris" }, supersededByGeneration: 5 }]);
    expect(isAuthoringStageApplyEligible({ ...replacement!, status: "validated", output: { name: "New Iris" } })).toBe(true);
  });

  it("never retries a validated outline unless regeneration was explicitly selected", () => {
    expect(() => retryAuthoringStage([
      { id: "world", key: "world", generation: 1, status: "validated", attemptCount: 1 }
    ], "world")).toThrow("explicitly selected");
  });

  it("queues an explicitly regenerated outline directly from review", () => {
    expect(canTransitionAuthoringJob("awaiting_review", "queued")).toBe(true);
  });

  it("retries a failed child in a fresh generation without superseding siblings", () => {
    const next = retryAuthoringStage([
      { id: "world", key: "world", generation: 1, status: "validated", attemptCount: 1 },
      { id: "iris", key: "character:iris", generation: 1, status: "failed", attemptCount: 2 },
      { id: "mira", key: "character:mira", generation: 1, status: "validated", attemptCount: 1 }
    ], "iris");

    expect(next).toEqual([
      { id: "world", key: "world", generation: 1, status: "validated", attemptCount: 1 },
      { id: "iris", key: "character:iris", generation: 2, status: "queued", attemptCount: 0, explicitRetryGenerations: 1 },
      { id: "mira", key: "character:mira", generation: 1, status: "validated", attemptCount: 1 }
    ]);
  });

  it("retries a recoverable child to the next generation while preserving validated siblings", () => {
    const next = retryAuthoringStage([
      { id: "world", key: "world", generation: 1, status: "validated", attemptCount: 1 },
      { id: "iris", key: "character:iris", generation: 1, status: "recoverable", attemptCount: 2 },
      { id: "mira", key: "character:mira", generation: 1, status: "validated", attemptCount: 1 }
    ], "iris");

    expect(next).toEqual([
      { id: "world", key: "world", generation: 1, status: "validated", attemptCount: 1 },
      { id: "iris", key: "character:iris", generation: 2, status: "queued", attemptCount: 0, explicitRetryGenerations: 1 },
      { id: "mira", key: "character:mira", generation: 1, status: "validated", attemptCount: 1 }
    ]);
  });

  it("excludes superseded stage output from application while retaining it for review", () => {
    expect(isAuthoringStageApplyEligible({
      id: "world", key: "world", generation: 2, status: "validated", attemptCount: 1
    })).toBe(true);
    expect(isAuthoringStageApplyEligible({
      id: "iris", key: "character:iris", generation: 2, status: "validated", attemptCount: 1,
      historicalOutputs: [{ generation: 1, output: { name: "Old Iris" }, supersededByGeneration: 2 }]
    })).toBe(true);
  });
});

describe("durable authoring public contracts", () => {
  it.each(["world_concept", "character"] as const)("P28-F3 retains the exact %s review selection only in the detail contract", kind => {
    const common = { id: "job", revision: 4, kind, status: "awaiting_review", target: { kind: "new_world" }, stages: [],
      expiresAt: "2026-09-13T00:00:00.000Z", canApply: false, incomplete: false };
    const detail = { ...common, reviewedContent: kind === "world_concept" ? worldContent : playableCharacter, reviewedStageIds: ["current-selected"] };
    expect(authoringJobViewSchema.parse(detail).reviewedStageIds).toEqual(["current-selected"]);
    expect(authoringJobViewSchema.parse({ ...detail, reviewedStageIds: [] }).reviewedStageIds).toEqual([]);
    expect(authoringJobListItemSchema.safeParse({ ...common, reviewedStageIds: ["current-selected"] }).success).toBe(false);
    expect(authoringJobListItemSchema.parse(common)).not.toHaveProperty("reviewedStageIds");
  });

  it("accepts incomplete manual world content for a character proposal", () => {
    expect(authoringSubmitSchema.parse({
      kind: "character",
      idempotencyKey: "new-character",
      target: { kind: "new_world" },
      prompt: "Create a navigator.",
      content: worldContent
    })).toMatchObject({ kind: "character", content: { playableCharacters: [] } });
  });

  it("accepts a local new-world character edit only when its selected ID belongs to the submitted roster", () => {
    expect(authoringSubmitSchema.parse({
      kind: "character",
      idempotencyKey: "edit-local-character",
      target: { kind: "new_world" },
      characterId: "iris",
      prompt: "Make Iris more cautious.",
      content: localWorldContent
    })).toMatchObject({ characterId: "iris" });
    expect(() => authoringSubmitSchema.parse({
      kind: "character",
      idempotencyKey: "missing-local-character",
      target: { kind: "new_world" },
      characterId: "mira",
      prompt: "Make Mira more cautious.",
      content: localWorldContent
    })).toThrow();
  });

  it("rejects a character identity that conflicts with its draft target", () => {
    expect(() => authoringSubmitSchema.parse({
      kind: "character",
      idempotencyKey: "edit-character",
      target: { kind: "world_draft", worldId: "world-1", expectedRevision: 4, characterId: "iris" },
      characterId: "mira",
      prompt: "Rewrite the guidance.",
      content: worldContent
    })).toThrow();
  });

  it("requires a persisted draft revision when targeting an existing world", () => {
    expect(() => authoringSubmitSchema.parse({
      kind: "world_concept",
      idempotencyKey: "regenerate-world",
      target: { kind: "world_draft", worldId: "world-1", expectedRevision: 0 },
      prompt: "Rewrite the coast."
    })).toThrow();
  });

  it("rejects caller-supplied ownership and provider fields", () => {
    expect(() => authoringSubmitSchema.parse({
      kind: "world_concept",
      idempotencyKey: "world-concept",
      target: { kind: "new_world" },
      prompt: "Create a coast.",
      ownerId: "caller-controlled",
      providerApiKey: "secret"
    })).toThrow();
  });

  it("requires result and reviewed content to match the job kind", () => {
    const common = {
      id: "job-1", revision: 2, status: "awaiting_review", target: { kind: "new_world" },
      stages: [], expiresAt: "2026-09-13T00:00:00.000Z", canApply: true, incomplete: true
    };
    expect(authoringJobViewSchema.parse({ ...common, kind: "world_concept", result: worldContent, reviewedContent: worldContent })).toMatchObject({ kind: "world_concept" });
    expect(() => authoringJobViewSchema.parse({ ...common, kind: "world_concept", result: playableCharacter })).toThrow();
    expect(authoringJobViewSchema.parse({ ...common, kind: "character", result: playableCharacter, reviewedContent: playableCharacter })).toMatchObject({ kind: "character" });
  });

  it("keeps proposal content out of strict list projections", () => {
    const listItem = {
      id: "job-1", kind: "world_concept", revision: 2, status: "awaiting_review", target: { kind: "new_world" },
      stages: [], expiresAt: "2026-09-13T00:00:00.000Z", canApply: true, incomplete: true
    };
    expect(authoringJobListItemSchema.parse(listItem)).toEqual(listItem);
    expect(() => authoringJobListItemSchema.parse({ ...listItem, result: worldContent })).toThrow();
  });

  it("binds untagged review and apply content to the contextual job kind", () => {
    const review = { expectedRevision: 2, content: playableCharacter, selectedStageIds: ["world"] };
    const apply = { ...review, idempotencyKey: "apply-world" };
    const worldJob = { kind: "world_concept" as const, target: { kind: "new_world" as const } };
    const characterJob = { kind: "character" as const, target: { kind: "new_world" as const } };

    expect(() => parseAuthoringCommandForJob(worldJob, "review", review)).toThrow();
    expect(() => parseAuthoringCommandForJob(characterJob, "apply", { ...apply, content: worldContent })).toThrow();
    expect(parseAuthoringCommandForJob(worldJob, "apply", { ...apply, content: worldContent })).toMatchObject({ content: worldContent });
    expect(parseAuthoringCommandForJob(characterJob, "review", review)).toMatchObject({ content: playableCharacter });
  });

  it("keeps durable stage keys separate from Patch 1 error-stage labels", () => {
    expect(authoringStageViewSchema.parse({
      id: "stage-iris", key: "character:iris", generation: 1, status: "recoverable", attemptCount: 2,
      failure: { code: "authoring_conflict", stage: "character", retryable: false, issues: [] }
    })).toMatchObject({ key: "character:iris", failure: { stage: "character" } });
    expect(() => authoringStageViewSchema.parse({
      id: "stage-world", key: "world", generation: 1, status: "failed", attemptCount: 1,
      failure: { code: "authoring_retry_exhausted", stage: "outline", retryable: false, issues: [] }
    })).toThrow();
  });
});
