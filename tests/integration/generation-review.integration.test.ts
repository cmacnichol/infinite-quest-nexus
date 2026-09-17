import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresGenerationExecutionRepository } from "../../packages/database/src/generation-execution-repository.js";
import { createPostgresGenerationCommandRepository } from "../../packages/database/src/generation-repository.js";
import { generationReviewFindingsHash, type GenerationReviewCheckpoint } from "../../packages/application/src/generation/review-checkpoint.js";
import { canonicalEvidenceJson } from "../../packages/application/src/memory/generation-context.js";
import { generationRequestSchema, sha256Hex, storyTurnOutputSchema } from "../../packages/contracts/src/index.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { importLegacyStory } from "../helpers/memory-aware-services.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { createProvider, loadPromptSnapshotForTest, providerPromptProtocolVersion, readTurnReportedCostsForTest } from "../helpers/provider-application-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("PostgreSQL generation review persistence", () => {
  let pool: DatabasePool;
  let ownerUserId = "";
  let providerProfileId = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 6);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    providerProfileId = (await createProvider(pool, {
      name: `Generation review ${crypto.randomUUID()}`, providerType: "openai_compatible", providerRole: "text",
      baseUrl: "http://127.0.0.1:9911", defaultModel: "review-test-model", contextWindowTokens: 32768,
      maxOutputTokens: 4096, temperature: 0, enabled: true, configuration: {}
    }, "generation-review-test-secret")).id;
  });

  afterAll(async () => { await pool.end(); });

  function commands() {
    return createPostgresGenerationCommandRepository(pool, {
      resolvePromptSnapshot: (client, scopedOwner, campaignId) => loadPromptSnapshotForTest(client, scopedOwner, campaignId),
      promptProtocolVersion: providerPromptProtocolVersion,
      readTurnReportedCosts: (scopedOwner, _campaignId, turnIds) => readTurnReportedCostsForTest(pool, scopedOwner, [...turnIds])
    });
  }

  async function campaign() {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Generation review ${crypto.randomUUID()}`;
    return importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "generation-review.story", story: fixture }));
  }

  async function pendingReview() {
    const imported = await campaign();
    const queued = await commands().enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse({
      action: "Inspect the review observatory.", providerProfileId, idempotencyKey: crypto.randomUUID(),
      context: { budgetTokens: 16_000, compression: "full", recentTurns: 8 }
    }));
    const execution = createPostgresGenerationExecutionRepository(pool);
    const workerId = `review-worker-${crypto.randomUUID()}`;
    const claim = await execution.claimNext({ workerId, leaseSeconds: 30 });
    if (!claim) throw new Error("Expected review fixture claim.");
    const payload = await execution.loadExecutionPayload({ workerId, leaseSeconds: 30, claim });
    if (!payload) throw new Error("Expected review fixture payload.");
    const world = await pool.query<{ worldId: string }>(
      `SELECT w.id AS "worldId" FROM campaigns c JOIN world_versions v ON v.id = c.world_version_id JOIN worlds w ON w.id = v.world_id WHERE c.id = $1`,
      [imported.campaignId]
    );
    const story = storyTurnOutputSchema.parse({
      narration: "The observatory door opens onto a silent, moonlit archive.", choices: ["Enter the archive.", "Circle the tower.", "Call to the keeper.", "Study the door."],
      custom_action_suggestion: "Examine the moonlit archive.", scratchpad: "", tracker_updates: [], image_prompt: "A moonlit observatory archive.",
      continuity_summary: "The observatory archive has opened.", canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: []
    });
    const reasons: ["invalid_structure"] = ["invalid_structure"];
    const candidate = {
      scope: "main" as const, story, storyHash: sha256Hex(canonicalEvidenceJson(story)), rawOutputReference: null,
      producingRequestHash: "a".repeat(64), producingResponseId: null, sentFactIds: [], ownerUserId, campaignId: imported.campaignId,
      worldId: world.rows[0]!.worldId, worldVersionId: payload.world_version_id ?? null, baseTurnNumber: payload.generation_base_identity.baseTurnNumber,
      expectedTurnNumber: payload.expected_turn_number, policy: {}, policyHash: "b".repeat(64), baseIdentity: payload.generation_base_identity,
      protocol: { version: payload.prompt_protocol_version, promptHash: "c".repeat(64) },
      provider: { type: "openai_compatible", profileId: providerProfileId, configurationHash: "d".repeat(64) },
      resumeDependencies: { generationContext: {}, producingProviderResult: null, stageState: {}, frozenCommitInputs: {}, replacementTarget: null }
    };
    const checkpoint = {
      version: 1 as const, reviewId: crypto.randomUUID(), revision: 1, state: "pending" as const, stage: "structure" as const,
      candidateScope: "main" as const, reasons, operationKind: "append" as const, replacementTurnId: null,
      eligibility: { complete: true, structurallyValid: false, mechanicsClean: true, authorityValid: true, stageComplete: true, retryAvailable: true },
      originalCandidate: candidate, gateCandidate: candidate, workingCandidate: candidate,
      originalFindings: reasons, originalFindingsHash: generationReviewFindingsHash(reasons), retryFailure: null, decisionJournal: []
    } satisfies GenerationReviewCheckpoint;
    const scope = { jobId: queued.id, ownerUserId, workerId };
    expect(await execution.pauseForReview(scope, checkpoint)).toBe(true);
    return { imported, queued, execution, scope, checkpoint };
  }

  it("publishes the complete checkpoint while releasing its lease and blocking ordinary retry", async () => {
    const fixture = await pendingReview();
    const commandsAfterPause = commands();
    const row = await pool.query<{ status: string; lease_owner: string | null; orchestration_private: { generationReview?: unknown } }>(
      "SELECT status,lease_owner,orchestration_private FROM generation_jobs WHERE id=$1", [fixture.queued.id]
    );
    expect(row.rows[0]).toMatchObject({ status: "recoverable", lease_owner: null, orchestration_private: { generationReview: fixture.checkpoint } });
    await expect(fixture.execution.renewLease(fixture.scope, 30)).resolves.toBe(false);
    await expect(fixture.execution.claimNext({ workerId: "other-review-worker", leaseSeconds: 30 })).resolves.toBeNull();
    await expect(commandsAfterPause.retry({ ownerUserId, jobId: fixture.queued.id })).rejects.toMatchObject({ kind: "conflict" });
    await expect(commandsAfterPause.getReview({ ownerUserId, jobId: fixture.queued.id })).resolves.toMatchObject({
      reviewId: fixture.checkpoint.reviewId, revision: 1, state: "pending", narration: fixture.checkpoint.gateCandidate.story?.narration,
      canKeep: false, canRetry: true, choices: fixture.checkpoint.gateCandidate.story?.choices, findings: [{ code: "invalid_structure", message: expect.any(String) }]
    });
    await expect(commandsAfterPause.decideReview({ ownerUserId, jobId: fixture.queued.id }, { reviewId: fixture.checkpoint.reviewId, revision: 1, decision: "keep" })).rejects.toMatchObject({ kind: "conflict" });
    await expect(pool.query("SELECT count(*)::int AS count FROM turns WHERE campaign_id=$1 AND accepted_at IS NOT NULL", [fixture.imported.campaignId]))
      .resolves.toMatchObject({ rows: [{ count: 2 }] });
  });

  it("serializes a review race, replays the winning receipt, and keeps foreign owners out", async () => {
    const fixture = await pendingReview();
    const repository = commands();
    const scope = { ownerUserId, jobId: fixture.queued.id };
    const results = await Promise.allSettled([repository.decideReview(scope, { reviewId: fixture.checkpoint.reviewId, revision: 1, decision: "retry" }), repository.decideReview(scope, { reviewId: fixture.checkpoint.reviewId, revision: 1, decision: "retry" })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    const winner = results.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof repository.decideReview>>> => result.status === "fulfilled")!.value;
    const decision = "retry" as const;
    await expect(repository.decideReview(scope, { reviewId: fixture.checkpoint.reviewId, revision: 1, decision })).resolves.toEqual(winner);
    await expect(repository.decideReview(scope, { reviewId: fixture.checkpoint.reviewId, revision: 1, decision: "keep" })).rejects.toMatchObject({ kind: "conflict" });
    const foreignOwner = (await pool.query<{ id: string }>("INSERT INTO users(display_name) VALUES ('Review foreign owner') RETURNING id")).rows[0]!.id;
    await expect(repository.getReview({ ownerUserId: foreignOwner, jobId: fixture.queued.id })).rejects.toMatchObject({ kind: "not_found" });
    await expect(repository.decideReview({ ownerUserId: foreignOwner, jobId: fixture.queued.id }, { reviewId: fixture.checkpoint.reviewId, revision: 1, decision })).rejects.toMatchObject({ kind: "not_found" });
    await expect(pool.query<{ status: string; lease_owner: string | null }>("SELECT status,lease_owner FROM generation_jobs WHERE id=$1", [fixture.queued.id]))
      .resolves.toMatchObject({ rows: [{ status: "queued", lease_owner: null }] });
    await expect(pool.query<{ journalSize: number }>(
      "SELECT jsonb_array_length(orchestration_private->'generationReview'->'decisionJournal')::int AS \"journalSize\" FROM generation_jobs WHERE id=$1",
      [fixture.queued.id]
    )).resolves.toMatchObject({ rows: [{ journalSize: 1 }] });
  });
});
