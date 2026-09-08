import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  createAuthoringApplication,
  type AuthoringApplicationDependencies,
  type AuthoringRepository
} from "../../../packages/application/src/authoring/index.js";
import type {
  AuthoringApply,
  AuthoringJobListItem,
  AuthoringJobView,
  AuthoringReview,
  AuthoringSubmit
} from "../../../packages/contracts/src/authoring.js";
import type { OwnerScope } from "../../../packages/application/src/generation/types.js";
import { AuthoringRepositoryError } from "../../../packages/application/src/authoring/types.js";
import { worldContentSchema } from "../../../packages/contracts/src/world-library.js";

const owner: OwnerScope = { ownerUserId: "owner-a" };
const foreign: OwnerScope = { ownerUserId: "owner-b" };
const worldContent = worldContentSchema.parse({ world: { title: "Lantern City" }, playableCharacters: [] });

function job(overrides: Partial<AuthoringJobView> = {}): AuthoringJobView {
  return {
    id: "job-1",
    kind: "world_concept",
    revision: 4,
    status: "recoverable",
    target: { kind: "new_world" },
    stages: [
      { id: "stage-success", key: "character:sibling", generation: 1, status: "validated", attemptCount: 1 },
      { id: "stage-failed", key: "character:second", generation: 1, status: "recoverable", attemptCount: 2 }
    ],
    expiresAt: "2026-09-13T00:00:00.000Z",
    canApply: true,
    incomplete: true,
    request: {
      kind: "world_concept",
      idempotencyKey: "test-submit",
      target: { kind: "new_world" },
      prompt: "Make a city where lanterns remember promises."
    },
    ...overrides
  } as AuthoringJobView;
}

/** A stateful typed fake: every owner and revision predicate is exercised by the application tests. */
function repositoryFixture(initial = job()): AuthoringRepository {
  let current: AuthoringJobView | null = structuredClone(initial);
  const idempotency = new Map<string, { hash: string; job: AuthoringJobView }>();
  const belongs = (scope: OwnerScope, id: string) => scope.ownerUserId === owner.ownerUserId && current?.id === id;
  const requireCurrent = (scope: OwnerScope, id: string, revision: number) => {
    if (!belongs(scope, id)) throw new AuthoringRepositoryError("not_found");
    if (current!.revision !== revision) throw new AuthoringRepositoryError("revision_conflict");
  };
  return {
    findIdempotency: async (_scope, key) => {
      const replay = idempotency.get(key);
      return replay ? { requestHash: replay.hash, job: structuredClone(replay.job) } : null;
    },
    submit: async (_scope, input: AuthoringSubmit, hash) => {
      current = { ...current!, target: input.target, request: input } as AuthoringJobView;
      idempotency.set(input.idempotencyKey, { hash, job: structuredClone(current) });
      return structuredClone(current);
    },
    read: async (scope, id) => belongs(scope, id) ? structuredClone(current) : null,
    list: async (scope) => ({ jobs: scope.ownerUserId === owner.ownerUserId && current ? [metadata(current)] : [] }),
    retry: async (scope, id, stageId, expectedRevision) => {
      requireCurrent(scope, id, expectedRevision);
      const stage = current!.stages.find((candidate) => candidate.id === stageId);
      if (!stage || !["recoverable", "failed", "validated"].includes(stage.status)) throw new AuthoringRepositoryError("invalid_state");
      current = {
        ...current!, revision: current!.revision + 1, status: "queued", canApply: false,
        stages: current!.stages.map((candidate) => candidate.id === stageId
          ? { ...candidate, generation: candidate.generation + 1, status: "queued", attemptCount: 0 }
          : candidate)
      } as AuthoringJobView;
      return structuredClone(current);
    },
    review: async (scope, id, input: AuthoringReview) => {
      requireCurrent(scope, id, input.expectedRevision);
      current = { ...current!, revision: current!.revision + 1, reviewedContent: input.content } as AuthoringJobView;
      return structuredClone(current);
    },
    cancel: async (scope, id, expectedRevision) => {
      if (!belongs(scope, id)) throw new AuthoringRepositoryError("not_found");
      if (current!.status === "cancelled" && expectedRevision === current!.revision - 1) return structuredClone(current!);
      requireCurrent(scope, id, expectedRevision);
      current = { ...current!, revision: current!.revision + 1, status: "cancelled", canApply: false } as AuthoringJobView;
      return structuredClone(current);
    },
    discard: async (scope, id, expectedRevision) => {
      requireCurrent(scope, id, expectedRevision);
      current = null;
    },
    apply: async (scope, id, input) => {
      requireCurrent(scope, id, input.expectedRevision);
      return { jobId: id, worldId: "world-1", draftRevision: 1 };
    },
    claim: async () => null,
    heartbeat: async () => false,
    checkpoint: async () => false,
    fail: async () => false
  };
}

function metadata(value: AuthoringJobView): AuthoringJobListItem {
  const { request: _request, reviewedContent: _reviewed, result: _result, ...item } = value;
  return item as AuthoringJobListItem;
}

function dependencies(repository = repositoryFixture()): AuthoringApplicationDependencies {
  return {
    repository,
    sha256: vi.fn((value: string) => createHash("sha256").update(value).digest("hex")),
    targets: { assertCurrent: vi.fn(async () => undefined) },
    worlds: { applyInTransaction: vi.fn() }
  };
}

describe("authoring application use cases", () => {
  it("retries only the selected recoverable child and preserves validated siblings", async () => {
    const application = createAuthoringApplication(dependencies());

    const retried = await application.retry(owner, "job-1", "stage-failed", 4);

    expect(retried.stages.find((stage) => stage.id === "stage-success")?.status).toBe("validated");
    expect(retried.stages.find((stage) => stage.key === "character:second")?.generation).toBe(2);
  });

  it("cancels twice with the original revision without a second state mutation", async () => {
    const application = createAuthoringApplication(dependencies());

    const cancelled = await application.cancel(owner, "job-1", 4);
    const replay = await application.cancel(owner, "job-1", 4);

    expect(cancelled).toMatchObject({ status: "cancelled", revision: 5 });
    expect(replay).toEqual(cancelled);
  });

  it("rejects an obsolete revision before changing a proposal", async () => {
    const application = createAuthoringApplication(dependencies());

    await expect(application.retry(owner, "job-1", "stage-failed", 3))
      .rejects.toMatchObject({ code: "authoring_revision_conflict" });
  });

  it("returns owner-only detail, metadata-only lists, and a distinct reviewed-content revision", async () => {
    const application = createAuthoringApplication(dependencies());

    await expect(application.get(owner, "job-1")).resolves.toMatchObject({ request: { prompt: "Make a city where lanterns remember promises." } });
    await expect(application.list(owner)).resolves.toEqual({ jobs: [expect.not.objectContaining({ request: expect.anything(), reviewedContent: expect.anything() })] });
    await expect(application.review(owner, "job-1", {
      expectedRevision: 4,
      content: worldContent,
      selectedStageIds: ["stage-success"]
    })).resolves.toMatchObject({ revision: 5, reviewedContent: worldContent });
  });

  it("replays an identical normalized submission and rejects a changed request using the same idempotency key", async () => {
    const application = createAuthoringApplication(dependencies());
    const first = {
      kind: "world_concept" as const,
      idempotencyKey: "normalized-replay",
      target: { kind: "new_world" as const },
      prompt: "  Build a remembered city.  "
    };

    const accepted = await application.submit(owner, first);
    const replay = await application.submit(owner, { ...first, prompt: "Build a remembered city." });
    await expect(application.submit(owner, { ...first, prompt: "Build a different city." }))
      .rejects.toMatchObject({ code: "authoring_idempotency_conflict" });

    expect(replay).toEqual(accepted);
  });

  it("hashes omitted and undefined optional request fields as the same persisted JSON", async () => {
    const application = createAuthoringApplication(dependencies());
    const first = {
      kind: "character" as const,
      idempotencyKey: "undefined-normalization",
      target: { kind: "new_world" as const },
      prompt: "Draft a character.",
      content: worldContent
    };

    const accepted = await application.submit(owner, first);
    const replay = await application.submit(owner, { ...first, characterId: undefined });

    expect(replay).toEqual(accepted);
  });

  it("admits source authoring through the durable provider-free command boundary", async () => {
    const repository = repositoryFixture();
    const submit = vi.spyOn(repository, "submit");
    const fixture = dependencies(repository);
    const application = createAuthoringApplication(fixture);

    await application.submit(owner, {
      kind: "story_source",
      idempotencyKey: "source-not-yet-admitted",
      target: { kind: "new_world" },
      name: "chapter.txt",
      text: "A source chapter.",
      mode: "faithful",
      boundaryParagraphId: "paragraph:0",
      instructions: ""
    });

    expect(submit).toHaveBeenCalledWith(owner, expect.objectContaining({ kind: "story_source", name: "chapter.txt" }), expect.stringMatching(/^[0-9a-f]{64}$/u));
  });

  it("canonicalizes an existing-draft character identity before admission and hashing", async () => {
    const fixture = dependencies();
    const application = createAuthoringApplication(fixture);
    const base = {
      kind: "character" as const,
      idempotencyKey: "existing-draft-character",
      target: { kind: "world_draft" as const, worldId: "world-1", expectedRevision: 3 },
      prompt: "Improve the selected character.",
      content: worldContent
    };

    const topLevel = await application.submit(owner, { ...base, characterId: "hero" });
    const nested = await application.submit(owner, { ...base, target: { ...base.target, characterId: "hero" } });
    const both = await application.submit(owner, { ...base, target: { ...base.target, characterId: "hero" }, characterId: "hero" });

    expect(topLevel.target).toEqual({ kind: "world_draft", worldId: "world-1", expectedRevision: 3, characterId: "hero" });
    expect(nested).toEqual(topLevel);
    expect(both).toEqual(topLevel);
    expect(fixture.targets.assertCurrent).toHaveBeenCalledWith(owner, topLevel.target);
  });

  it("preserves an explicit new-world local-parent character identity", async () => {
    const application = createAuthoringApplication(dependencies());
    const localContent = worldContentSchema.parse({ world: { title: "Local parent" }, playableCharacters: [{ ...worldContentSchema.parse({ world: { title: "Character" }, playableCharacters: [] }).playableCharacters[0], id: "hero", name: "Hero", characterText: "A local hero." }] });
    const submitted = await application.submit(owner, {
      kind: "character",
      idempotencyKey: "local-parent-character",
      target: { kind: "new_world" },
      prompt: "Improve the local character.",
      content: localContent,
      characterId: "hero"
    });

    expect(submitted.request).toMatchObject({ target: { kind: "new_world" }, characterId: "hero" });
  });

  it("does not expose or mutate a foreign owner's proposal", async () => {
    const application = createAuthoringApplication(dependencies());

    await expect(application.get(foreign, "job-1")).resolves.toBeNull();
    await expect(application.retry(foreign, "job-1", "stage-failed", 4))
      .rejects.toMatchObject({ code: "authoring_not_found" });
  });

  it("delegates a parsed apply command to the provider-free atomic application port", async () => {
    const fixture = dependencies();
    const application = createAuthoringApplication(fixture);
    const before = await application.get(owner, "job-1");

    await expect(application.apply(owner, "job-1", {
      expectedRevision: 4,
      idempotencyKey: "apply-test",
      selectedStageIds: [],
      content: worldContent
    } as unknown as AuthoringApply)).resolves.toMatchObject({ jobId: "job-1", worldId: "world-1" });

    await expect(application.get(owner, "job-1")).resolves.toEqual(before);
    expect(Object.keys(fixture)).toEqual(["repository", "sha256", "targets", "worlds"]);
  });

  it("rejects a world concept that names a character-only target before enqueue", async () => {
    const fixture = dependencies();
    const application = createAuthoringApplication(fixture);

    await expect(application.submit(owner, {
      kind: "world_concept",
      idempotencyKey: "bad-world-target",
      target: { kind: "world_draft", worldId: "world-1", expectedRevision: 1, characterId: "hero" },
      prompt: "Do not queue this."
    })).rejects.toMatchObject({ code: "authoring_invalid_target" });
    expect(fixture.targets.assertCurrent).not.toHaveBeenCalled();
  });

  it("maps a typed target revision conflict before submitting a draft proposal", async () => {
    const fixture = dependencies();
    fixture.targets.assertCurrent = vi.fn(async () => { throw new AuthoringRepositoryError("revision_conflict"); });
    const application = createAuthoringApplication(fixture);

    await expect(application.submit(owner, {
      kind: "character",
      idempotencyKey: "stale-target",
      target: { kind: "world_draft", worldId: "world-1", expectedRevision: 1 },
      prompt: "Draft a character.",
      content: worldContent
    })).rejects.toMatchObject({ code: "authoring_revision_conflict" });
  });
});
