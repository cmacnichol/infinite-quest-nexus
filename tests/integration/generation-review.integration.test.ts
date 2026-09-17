import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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

  afterEach(async () => {
    await pool.query(
      "UPDATE generation_jobs SET status='discarded', lease_owner=NULL, lease_expires_at=NULL WHERE owner_user_id=$1 AND status IN ('queued','assessing','generating','validating','committing','recoverable')",
      [ownerUserId]
    );
  });

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

  async function pendingReview({ pause = true, eligible = false }: { pause?: boolean; eligible?: boolean } = {}) {
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
    const reasons: GenerationReviewCheckpoint["reasons"] = eligible ? ["review_uncertain"] : ["invalid_structure"];
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
      version: 1 as const, reviewId: crypto.randomUUID(), revision: 1, state: "pending" as const, stage: eligible ? "continuity" as const : "structure" as const,
      candidateScope: "main" as const, reasons, operationKind: "append" as const, replacementTurnId: null,
      eligibility: { complete: true, structurallyValid: eligible, mechanicsClean: true, authorityValid: true, stageComplete: true, retryAvailable: true },
      originalCandidate: candidate, gateCandidate: candidate, workingCandidate: candidate,
      originalFindings: reasons, originalFindingsHash: generationReviewFindingsHash(reasons), retryFailure: null, decisionJournal: []
    } satisfies GenerationReviewCheckpoint;
    const scope = { jobId: queued.id, ownerUserId, workerId };
    if (pause) expect(await execution.pauseForReview(scope, checkpoint)).toBe(true);
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

  it("serializes competing eligible Keep and Retry decisions with one durable winner", async () => {
    const fixture = await pendingReview({ eligible: true });
    const repository = commands(); const scope = { ownerUserId, jobId: fixture.queued.id };
    const keep = { reviewId: fixture.checkpoint.reviewId, revision: 1, decision: "keep" as const };
    const retry = { reviewId: fixture.checkpoint.reviewId, revision: 1, decision: "retry" as const };
    const results = await Promise.allSettled([repository.decideReview(scope, keep), repository.decideReview(scope, retry)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winnerIndex = results.findIndex((result) => result.status === "fulfilled");
    const winnerRequest = winnerIndex === 0 ? keep : retry;
    const losingRequest = winnerIndex === 0 ? retry : keep;
    const winner = results[winnerIndex] as PromiseFulfilledResult<Awaited<ReturnType<typeof repository.decideReview>>>;
    const loser = results[1 - winnerIndex] as PromiseRejectedResult;
    expect(loser.reason).toMatchObject({ kind: "conflict" });
    await expect(repository.decideReview(scope, winnerRequest)).resolves.toEqual(winner.value);
    await expect(repository.decideReview(scope, losingRequest)).rejects.toMatchObject({ kind: "conflict" });
    await expect(pool.query<{ status: string; journalSize: number; acceptedTurns: number }>(
      `SELECT j.status, jsonb_array_length(j.orchestration_private->'generationReview'->'decisionJournal')::int AS "journalSize",
              (SELECT count(*)::int FROM turns WHERE campaign_id=j.campaign_id AND accepted_at IS NOT NULL) AS "acceptedTurns"
         FROM generation_jobs j WHERE j.id=$1`, [fixture.queued.id]
    )).resolves.toMatchObject({ rows: [{ status: "queued", journalSize: 1, acceptedTurns: 2 }] });
  });

  it("rejects owner, campaign, base, and protocol checkpoint mismatches without changing the leased job", async () => {
    const fixture = await pendingReview();
    await pool.query("UPDATE generation_jobs SET status='assessing',lease_owner=$2,lease_expires_at=now()+interval '30 seconds' WHERE id=$1", [fixture.queued.id, fixture.scope.workerId]);
    const mutateCandidates = (mutate: (candidate: GenerationReviewCheckpoint["gateCandidate"]) => GenerationReviewCheckpoint["gateCandidate"]) => ({
      ...fixture.checkpoint, reviewId: crypto.randomUUID(), revision: 2,
      gateCandidate: mutate(fixture.checkpoint.gateCandidate), workingCandidate: mutate(fixture.checkpoint.workingCandidate), originalCandidate: mutate(fixture.checkpoint.originalCandidate)
    } as GenerationReviewCheckpoint);
    const foreignOwnerId = crypto.randomUUID();
    const foreignCampaignId = crypto.randomUUID();
    const mismatches = [
      mutateCandidates((candidate) => ({ ...candidate, ownerUserId: foreignOwnerId })),
      mutateCandidates((candidate) => ({ ...candidate, campaignId: foreignCampaignId })),
      mutateCandidates((candidate) => ({ ...candidate,
        baseTurnNumber: candidate.baseTurnNumber + 1, expectedTurnNumber: candidate.expectedTurnNumber + 1,
        baseIdentity: { ...candidate.baseIdentity, baseTurnNumber: candidate.baseIdentity.baseTurnNumber + 1, expectedTurnNumber: candidate.baseIdentity.expectedTurnNumber + 1 }
      })),
      mutateCandidates((candidate) => ({ ...candidate, protocol: { ...candidate.protocol, version: "wrong-protocol" } }))
    ];
    for (const mismatched of mismatches) await expect(fixture.execution.pauseForReview(fixture.scope, mismatched)).resolves.toBe(false);
    await pool.query("UPDATE generation_jobs SET orchestration_private=jsonb_build_object('generationReview', jsonb_build_object('revision', 'corrupt')) WHERE id=$1", [fixture.queued.id]);
    await expect(fixture.execution.pauseForReview(fixture.scope, fixture.checkpoint)).resolves.toBe(false);
    await expect(pool.query<{ status: string; lease_owner: string }>("SELECT status,lease_owner FROM generation_jobs WHERE id=$1", [fixture.queued.id]))
      .resolves.toMatchObject({ rows: [{ status: "assessing", lease_owner: fixture.scope.workerId }] });
  });

  it("retains the first decision receipt through a later review gate", async () => {
    const fixture = await pendingReview();
    const repository = commands(); const scope = { ownerUserId, jobId: fixture.queued.id };
    const first = await repository.decideReview(scope, { reviewId: fixture.checkpoint.reviewId, revision: 1, decision: "retry" });
    await pool.query("UPDATE generation_jobs SET status='assessing',lease_owner=$2,lease_expires_at=now()+interval '30 seconds' WHERE id=$1", [fixture.queued.id, fixture.scope.workerId]);
    const journal = (await pool.query<{ orchestration_private: { generationReview: GenerationReviewCheckpoint } }>("SELECT orchestration_private FROM generation_jobs WHERE id=$1", [fixture.queued.id])).rows[0]!.orchestration_private.generationReview.decisionJournal;
    const second = { ...fixture.checkpoint, reviewId: crypto.randomUUID(), revision: 3, state: "pending" as const, decisionJournal: journal } as GenerationReviewCheckpoint;
    await expect(fixture.execution.pauseForReview(fixture.scope, second)).resolves.toBe(true);
    await expect(repository.decideReview(scope, { reviewId: fixture.checkpoint.reviewId, revision: 1, decision: "retry" })).resolves.toEqual(first);
  });

  it("serializes heartbeat, cancellation, discard, and decision races", async () => {
    const heartbeat = await pendingReview({ pause: false });
    await expect(Promise.allSettled([
      heartbeat.execution.renewLease(heartbeat.scope, 30),
      heartbeat.execution.pauseForReview(heartbeat.scope, heartbeat.checkpoint)
    ])).resolves.toHaveLength(2);
    await expect(pool.query<{ status: string; lease_owner: string | null }>("SELECT status,lease_owner FROM generation_jobs WHERE id=$1", [heartbeat.queued.id]))
      .resolves.toMatchObject({ rows: [{ status: "recoverable", lease_owner: null }] });
    const cancellation = await pendingReview(); const repository = commands(); const scope = { ownerUserId, jobId: cancellation.queued.id };
    const cancelRetry = { reviewId: cancellation.checkpoint.reviewId, revision: 1, decision: "retry" as const };
    const cancellationResults = await Promise.allSettled([cancellation.execution.renewLease(cancellation.scope, 30), repository.cancel(scope), repository.decideReview(scope, cancelRetry)]);
    expect(cancellationResults).toHaveLength(3);
    await expect(repository.getReview(scope)).resolves.toMatchObject({ canKeep: false, canRetry: false });
    const cancellationRow = await pool.query<{ status: string; lease_owner: string | null; journalSize: number; acceptedTurns: number }>(
      `SELECT j.status, j.lease_owner, jsonb_array_length(j.orchestration_private->'generationReview'->'decisionJournal')::int AS "journalSize",
              (SELECT count(*)::int FROM turns WHERE campaign_id=j.campaign_id AND accepted_at IS NOT NULL) AS "acceptedTurns"
         FROM generation_jobs j WHERE j.id=$1`, [cancellation.queued.id]
    );
    expect(cancellationRow.rows).toMatchObject([{ status: "cancelled", lease_owner: null, acceptedTurns: 2 }]);
    const cancelledDecision = cancellationResults[2]!;
    if (cancelledDecision.status === "fulfilled") {
      expect(cancellationRow.rows[0]!.journalSize).toBe(1);
      await expect(repository.decideReview(scope, cancelRetry)).resolves.toEqual(cancelledDecision.value);
    } else {
      expect(cancelledDecision.reason).toMatchObject({ kind: "conflict" });
      expect(cancellationRow.rows[0]!.journalSize).toBe(0);
      await expect(repository.decideReview(scope, cancelRetry)).rejects.toMatchObject({ kind: "conflict" });
    }
    await expect(repository.decideReview(scope, { ...cancelRetry, decision: "keep" })).rejects.toMatchObject({ kind: "conflict" });
    const discard = await pendingReview(); const discardScope = { ownerUserId, jobId: discard.queued.id };
    const discardRetry = { reviewId: discard.checkpoint.reviewId, revision: 1, decision: "retry" as const };
    const discardResults = await Promise.allSettled([repository.discard(discardScope), repository.decideReview(discardScope, discardRetry)]);
    const discardRow = await pool.query<{ status: string; lease_owner: string | null; journalSize: number; acceptedTurns: number }>(
      `SELECT j.status, j.lease_owner, jsonb_array_length(j.orchestration_private->'generationReview'->'decisionJournal')::int AS "journalSize",
              (SELECT count(*)::int FROM turns WHERE campaign_id=j.campaign_id AND accepted_at IS NOT NULL) AS "acceptedTurns"
         FROM generation_jobs j WHERE j.id=$1`, [discard.queued.id]
    );
    expect(discardRow.rows[0]).toMatchObject({ lease_owner: null, acceptedTurns: 2 });
    const discardDecision = discardResults[1]!;
    if (discardDecision.status === "fulfilled") {
      expect(discardResults[0]).toMatchObject({ status: "rejected" });
      expect(discardRow.rows[0]).toMatchObject({ status: "queued", journalSize: 1 });
      await expect(repository.decideReview(discardScope, discardRetry)).resolves.toEqual(discardDecision.value);
    } else {
      expect(discardDecision.reason).toMatchObject({ kind: "conflict" });
      expect(discardResults[0]).toMatchObject({ status: "fulfilled" });
      expect(discardRow.rows[0]).toMatchObject({ status: "discarded", journalSize: 0 });
      await expect(repository.decideReview(discardScope, discardRetry)).rejects.toMatchObject({ kind: "conflict" });
    }
    await expect(repository.decideReview(discardScope, { ...discardRetry, decision: "keep" })).rejects.toMatchObject({ kind: "conflict" });
  });
});
