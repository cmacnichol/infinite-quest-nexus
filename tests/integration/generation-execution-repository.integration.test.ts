import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  generationRequestSchema,
  generationRetryLatestRequestSchema,
  storyTurnOutputSchema
} from "../../packages/contracts/src/generation.js";
import { defaultStoryMemoryPolicy, storyMemoryPolicyHash } from "../../packages/contracts/src/story-memory-policy.js";
import { assertContinuityReviewPromptSnapshot } from "../../packages/contracts/src/prompt-library.js";
import { reviewBindingHash } from "../../packages/application/src/memory/continuity-review-checkpoint.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import {
  campaignCharacterProfileUpdateSchema,
  characterProfileSchema
} from "../../packages/contracts/src/world-library.js";
import {
  createPostgresGenerationExecutionRepository,
  type AcceptedGenerationCommit,
  type AcceptedGenerationCommitCollaborators,
  type GenerationLeaseScope
} from "../../packages/database/src/generation-execution-repository.js";
import { createPostgresGenerationCommandRepository } from "../../packages/database/src/generation-repository.js";
import { createPostgresCharacterProfileRepository } from "../../packages/database/src/campaign-transfer-character-repository.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createPostgresWorldCampaignTransactionPort } from "../../packages/database/src/world-campaign-transaction.js";
import { saveStoryMemoryEnrollment } from "../../packages/database/src/story-memory-policy-repository.js";
import { createApiGenerationApplication as composeGeneration } from "../../services/runtime/src/generation-api-composition.js";
import {
  createDatabasePool,
  initialOwnerId,
  type DatabaseClient,
  type DatabasePool
} from "../../packages/database/src/pool.js";
import { readTurnReportedCostsForTest } from "../helpers/provider-application-fixtures.js";
import { importLegacyStory } from "../helpers/memory-aware-services.js";
import { providerPromptProtocolVersion, loadPromptSnapshotForTest } from "../helpers/provider-application-fixtures.js";
import { apiProviderGraph, createProvider } from "../helpers/provider-application-fixtures.js";
import { memoryGeneration } from "../helpers/memory-applications.js";
import { DEDICATED_CHUNKED_AUDIT } from "../fixtures/chronicle-retrieval-audits.js";
import { sha256, stableStringify } from "../../packages/domain/src/index.js";
import { canonicalEvidenceJson } from "../../packages/application/src/memory/generation-context.js";
import { generationReviewFindingsHash, type GenerationReviewCheckpoint } from "../../packages/application/src/generation/review-checkpoint.js";
import { sha256Hex } from "../../packages/contracts/src/hash.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const credentialSecret = "generation-execution-repository-secret";

integration("PostgreSQL generation execution repository", () => {
  let pool: DatabasePool;
  let ownerUserId = "";
  let providerProfileId = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 6);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    providerProfileId = (await createProvider(pool, {
      name: `Generation execution repository ${crypto.randomUUID()}`,
      providerType: "openai_compatible",
      providerRole: "text",
      baseUrl: "http://127.0.0.1:9911",
      defaultModel: "execution-repository-model",
      contextWindowTokens: 32768,
      maxOutputTokens: 4096,
      temperature: 0,
      enabled: true,
      configuration: {}
    }, credentialSecret)).id;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function campaign() {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Generation execution repository ${crypto.randomUUID()}`;
    return importLegacyStory(pool, storyImportRequestSchema.parse({
      sourceName: "generation-execution-repository.story",
      story: fixture
    }));
  }

  function commands() {
    return createPostgresGenerationCommandRepository(pool, {
      resolvePromptSnapshot: (client, scopeOwnerUserId, campaignId) =>
        loadPromptSnapshotForTest(client, scopeOwnerUserId, campaignId),
      promptProtocolVersion: providerPromptProtocolVersion,
      readTurnReportedCosts: (scopeOwnerUserId, _campaignId, turnIds) =>
        readTurnReportedCostsForTest(pool, scopeOwnerUserId, [...turnIds])
    });
  }

  function enrolledPolicyCommands(capability: "r1" | "r2" = "r1") {
    const policy = defaultStoryMemoryPolicy(capability);
    return createPostgresGenerationCommandRepository(pool, {
      resolvePromptSnapshot: (client, scopeOwnerUserId, campaignId) =>
        loadPromptSnapshotForTest(client, scopeOwnerUserId, campaignId),
      promptProtocolVersion: providerPromptProtocolVersion,
      readTurnReportedCosts: (scopeOwnerUserId, _campaignId, turnIds) =>
        readTurnReportedCostsForTest(pool, scopeOwnerUserId, [...turnIds]),
      resolveStoryMemoryPolicySnapshot: async () => ({
        policy,
        policyHash: storyMemoryPolicyHash(policy),
        contextProtocol: "current-continuity-v3",
        promptProtocol: "story-v14-continuity-context",
        providerConfigurationFingerprint: "a".repeat(64)
      })
    });
  }

  async function queue(campaignId: string, action: string) {
    return commands().enqueueAppend(
      { ownerUserId, campaignId },
      generationRequestSchema.parse({
        action,
        providerProfileId,
        idempotencyKey: crypto.randomUUID(),
        context: { budgetTokens: 16_000, compression: "full", recentTurns: 8 }
      })
    );
  }

  async function queueEnrolledPolicy(campaignId: string, action: string, capability: "r1" | "r2" = "r1") {
    return enrolledPolicyCommands(capability).enqueueAppend(
      { ownerUserId, campaignId },
      generationRequestSchema.parse({
        action, providerProfileId, idempotencyKey: crypto.randomUUID(),
        context: { budgetTokens: 16_000, compression: "full", recentTurns: 8 }
      })
    );
  }

  function supersedingStory(supersedesFactIds: readonly string[]) {
    return storyTurnOutputSchema.parse({
      narration: "The observatory's true purpose becomes clear beneath the moon.",
      choices: ["Enter.", "Wait.", "Study the gate.", "Call the keeper."],
      custom_action_suggestion: "Inspect the observatory lens.",
      scratchpad: "The observatory now serves as a night refuge.",
      tracker_updates: [],
      image_prompt: "A moonlit observatory.",
      continuity_summary: "The observatory's purpose is known.",
      canonical_facts: ["The observatory is a night refuge."],
      superseded_facts: [],
      canonical_fact_updates: [{
        content: "The observatory is a night refuge.",
        supersedes_fact_ids: [...supersedesFactIds]
      }],
      open_threads: ["Learn who built the observatory."]
    });
  }

  async function readyAcceptedCommit(campaignId: string, workerId: string) {
    const queued = await queue(campaignId, "Inspect the canonical fact observatory.");
    const repository = createPostgresGenerationExecutionRepository(pool);
    const claim = await repository.claimNext({ workerId, leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);
    const scope = { jobId: queued.id, ownerUserId, workerId };
    const job = await repository.loadExecutionPayload({ workerId, leaseSeconds: 30, claim: claim! });
    if (!job) throw new Error("Expected a committing canonical-fact job.");
    expect(await repository.markGenerating(scope)).toBe(true);
    expect(await repository.markValidating(scope)).toBe(true);
    expect(await repository.markCommitting(scope)).toBe(true);
    return { repository, scope, job };
  }

  async function readyFinalKeepCommit(campaignId: string, workerId: string, story = supersedingStory([])) {
    await saveStoryMemoryEnrollment(pool, { ownerUserId, campaignId }, { capability: "r3", reviewMode: "enforce" }, { installedCapability: "r3", enforceEnabled: true });
    const application = composeGeneration(pool, apiProviderGraph(pool, credentialSecret).generation, undefined, { installedCapability: "r3", enforceEnabled: true });
    const queued = await application.enqueueAppend(
      { ownerUserId, campaignId },
      generationRequestSchema.parse({
        action: "Keep the reviewed observatory outcome.", providerProfileId, idempotencyKey: crypto.randomUUID(),
        context: { budgetTokens: 16_000, compression: "full", recentTurns: 8 }
      })
    );
    const repository = createPostgresGenerationExecutionRepository(pool);
    const claim = await repository.claimNext({ workerId, leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);
    const scope = { jobId: queued.id, ownerUserId, workerId };
    const job = await repository.loadExecutionPayload({ workerId, leaseSeconds: 30, claim: claim! });
    if (!job) throw new Error("Expected an enforce-review generation payload.");
    expect(await repository.markGenerating(scope)).toBe(true);
    expect(await repository.markValidating(scope)).toBe(true);
    expect(await repository.markCommitting(scope)).toBe(true);
    const row = await pool.query<{ world_id: string }>(
      "SELECT wv.world_id FROM campaigns c JOIN world_versions wv ON wv.id=c.world_version_id WHERE c.id=$1",
      [campaignId]
    );
    const policy = (job.context_options as unknown as { storyMemoryPolicy: {
      policy: Record<string, unknown>;
      policyHash: string;
      providerConfigurationFingerprint: string;
    } }).storyMemoryPolicy;
    const prompts = assertContinuityReviewPromptSnapshot(job.prompt_snapshot, "enforce");
    const responseId = crypto.randomUUID();
    const candidate = {
      scope: "final" as const, story, storyHash: sha256Hex(canonicalEvidenceJson(story)), rawOutputReference: null,
      producingRequestHash: "a".repeat(64), producingResponseId: responseId, sentFactIds: [],
      ownerUserId, campaignId, worldId: row.rows[0]!.world_id, worldVersionId: job.world_version_id!,
      baseTurnNumber: job.generation_base_identity.baseTurnNumber, expectedTurnNumber: job.generation_base_identity.expectedTurnNumber,
      policy: policy.policy, policyHash: policy.policyHash, baseIdentity: job.generation_base_identity,
      protocol: { version: job.prompt_protocol_version, promptHash: prompts.continuityReview!.review.hash },
      provider: { type: "openai_compatible", profileId: providerProfileId, configurationHash: policy.providerConfigurationFingerprint },
      resumeDependencies: { generationContext: {}, producingProviderResult: null, stageState: {}, frozenCommitInputs: {}, replacementTarget: null }
    };
    const reasons: GenerationReviewCheckpoint["reasons"] = ["narrative_conflict"];
    const checkpoint: GenerationReviewCheckpoint = {
      version: 1, reviewId: crypto.randomUUID(), revision: 2, state: "decided", stage: "continuity", candidateScope: "final", reasons,
      operationKind: "append", replacementTurnId: null,
      eligibility: { complete: true, structurallyValid: true, mechanicsClean: true, authorityValid: true, stageComplete: true, retryAvailable: true },
      originalCandidate: candidate, gateCandidate: candidate, workingCandidate: candidate,
      originalFindings: reasons, originalFindingsHash: generationReviewFindingsHash(reasons), retryFailure: null,
      decisionJournal: [{
        reviewId: crypto.randomUUID(), revision: 1, actorUserId: ownerUserId, decision: "keep", decidedAt: "2026-09-17T04:00:00.000Z",
        candidateScope: "final", candidateHash: candidate.storyHash, findingsHash: generationReviewFindingsHash(reasons), nextStage: null,
        offeredCandidate: candidate, offeredReasons: reasons,
        actionReceipt: { jobId: queued.id, status: "queued", operationKind: "append", replacementTurnId: null }
      }]
    };
    checkpoint.decisionJournal[0]!.reviewId = checkpoint.reviewId;
    await pool.query("UPDATE generation_jobs SET orchestration_private=orchestration_private || $2::jsonb WHERE id=$1", [queued.id, JSON.stringify({
      generationReview: checkpoint,
      validatedMainDraft: {
        draftHash: "d".repeat(64), story, requestPayloadHash: candidate.producingRequestHash,
        response: { responseId }
      }
    })]);
    return { repository, scope, job, story, checkpoint, campaignId, responseId };
  }

  async function insertCanonicalFact(input: Readonly<{
    ownerUserId?: string;
    campaignId: string;
    worldVersionId: string;
    content: string;
    validFromTurn: number;
    validUntilTurn?: number | null;
  }>) {
    const factOwnerUserId = input.ownerUserId ?? ownerUserId;
    const source = await pool.query<{ id: string; turn_number: number }>(
      `SELECT id,turn_number FROM turns
        WHERE owner_user_id=$1 AND campaign_id=$2
        ORDER BY turn_number,id LIMIT 1`,
      [factOwnerUserId, input.campaignId]
    );
    const sourceTurn = source.rows[0];
    if (!sourceTurn) throw new Error("Expected a source turn for the canonical-fact fixture.");
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO campaign_canonical_facts (
         id,owner_user_id,campaign_id,world_version_id,source_turn_id,source_turn_number,
         source_fact_index,content,normalized_content,valid_from_turn,valid_until_turn
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, factOwnerUserId, input.campaignId, input.worldVersionId, sourceTurn.id, sourceTurn.turn_number,
        10_000 + Math.floor(Math.random() * 1_000_000), input.content, input.content.toLowerCase(),
        input.validFromTurn, input.validUntilTurn ?? null]
    );
    return id;
  }

  async function insertCampaignWithSourceTurn(input: Readonly<{
    ownerUserId: string;
    worldVersionId: string;
    title: string;
  }>) {
    const campaignResult = await pool.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id,world_version_id,title) VALUES ($1,$2,$3) RETURNING id",
      [input.ownerUserId, input.worldVersionId, input.title]
    );
    const campaignId = campaignResult.rows[0]?.id;
    if (!campaignId) throw new Error("Expected a scoped campaign fixture.");
    await pool.query("INSERT INTO campaign_state (campaign_id,owner_user_id) VALUES ($1,$2)", [campaignId, input.ownerUserId]);
    await pool.query(
      `INSERT INTO turns (owner_user_id,campaign_id,turn_number,action,narration,state_snapshot_private)
       VALUES ($1,$2,1,'Scope fixture action.','Scope fixture narration.','{}'::jsonb)`,
      [input.ownerUserId, campaignId]
    );
    return campaignId;
  }

  async function foreignScopeFact() {
    const foreignOwner = await pool.query<{ id: string }>(
      "INSERT INTO users (display_name) VALUES ('Canonical fact foreign owner') RETURNING id"
    );
    const foreignOwnerUserId = foreignOwner.rows[0]?.id;
    if (!foreignOwnerUserId) throw new Error("Expected a foreign owner fixture.");
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id,title) VALUES ($1,'Canonical fact foreign world') RETURNING id",
      [foreignOwnerUserId]
    );
    const worldId = world.rows[0]?.id;
    if (!worldId) throw new Error("Expected a foreign world fixture.");
    const version = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id,owner_user_id,version_number,content)
       VALUES ($1,$2,1,$3::jsonb) RETURNING id`,
      [worldId, foreignOwnerUserId, JSON.stringify({ world: { title: "Canonical fact foreign world" }, entities: [] })]
    );
    const worldVersionId = version.rows[0]?.id;
    if (!worldVersionId) throw new Error("Expected a foreign world-version fixture.");
    const campaignId = await insertCampaignWithSourceTurn({
      ownerUserId: foreignOwnerUserId,
      worldVersionId,
      title: "Canonical fact foreign campaign"
    });
    const id = await insertCanonicalFact({
      ownerUserId: foreignOwnerUserId,
      campaignId,
      worldVersionId,
      content: "The foreign observatory is a lighthouse.",
      validFromTurn: 1
    });
    return { id, ownerUserId: foreignOwnerUserId, campaignId };
  }

  async function alternateWorldVersion(worldVersionId: string) {
    const version = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id,owner_user_id,version_number,content)
       SELECT world_id,owner_user_id,version_number + 1,$2::jsonb
         FROM world_versions WHERE id=$1 AND owner_user_id=$3
       RETURNING id`,
      [worldVersionId, JSON.stringify({ world: { title: "Canonical fact alternate world version" }, entities: [] }), ownerUserId]
    );
    const alternate = version.rows[0]?.id;
    if (!alternate) throw new Error("Expected an alternate world-version fixture.");
    return alternate;
  }

  function acceptedCommitInput(input: Readonly<{
    scope: GenerationLeaseScope;
    job: AcceptedGenerationCommit["job"];
    story: ReturnType<typeof supersedingStory>;
    responseId?: string;
    sentFactIds?: readonly string[];
  }>): AcceptedGenerationCommit {
    return {
      scope: input.scope,
      job: input.job,
      story: input.story,
      provider: {
        id: providerProfileId,
        name: "Execution repository provider",
        providerType: "openai_compatible",
        model: "execution-repository-model"
      },
      response: {
        content: JSON.stringify(input.story),
        responseId: input.responseId ?? crypto.randomUUID(),
        finishReason: "stop",
        outputLimited: false,
        modelInstanceId: "execution-repository-instance",
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        reportedCost: null,
        rawMetadata: {}
      },
      contextFingerprint: "canonical-fact-authorization-context",
      contextDiagnostics: { retrieval: { selectedMemoryCount: 0 } },
      ...(input.sentFactIds ? { sentFactIds: input.sentFactIds } : {}),
      chronicleRetrieval: DEDICATED_CHUNKED_AUDIT,
      inputs: input.job.orchestration_inputs,
      orchestration: {},
      fictionAction: input.job.action,
      collaborators: {
        memory: memoryGeneration(pool),
        illustration: {
          enqueueAcceptedTurnIllustrationSegments: async () => []
        } as unknown as AcceptedGenerationCommitCollaborators["illustration"],
        attributeGenerationCostsToTurn: async () => undefined
      },
      onIllustrationEnqueueError: () => undefined
    };
  }

  it("commits an enforced final Keep only for its exact stored candidate and preserves failed targets", async () => {
    const imported = await campaign();
    const accepted = await readyFinalKeepCommit(imported.campaignId, "final-keep-accepted-worker");
    await expect(accepted.repository.commitAcceptedTurn(acceptedCommitInput({
      scope: accepted.scope, job: accepted.job, story: accepted.story, responseId: accepted.responseId
    }))).resolves.toMatchObject({ turnId: expect.any(String) });
    await expect(pool.query<{ accepted_turns: number }>(
      "SELECT count(*)::int AS accepted_turns FROM turns WHERE campaign_id=$1 AND accepted_at IS NOT NULL",
      [imported.campaignId]
    )).resolves.toMatchObject({ rows: [{ accepted_turns: 3 }] });
    await expect(pool.query<{ model_metadata: Record<string, unknown> }>(
      "SELECT model_metadata FROM turns WHERE campaign_id=$1 ORDER BY turn_number DESC LIMIT 1", [imported.campaignId]
    )).resolves.toMatchObject({ rows: [expect.objectContaining({ model_metadata: expect.objectContaining({
      reviewAcceptance: expect.objectContaining({ disposition: "accepted_by_user", originalVerdict: "unavailable", originalReasonCodes: ["narrative_conflict"] })
    }) })] });

    const changedCampaign = await campaign();
    const changedCandidate = await readyFinalKeepCommit(changedCampaign.campaignId, "final-keep-changed-worker");
    const differentStory = storyTurnOutputSchema.parse({ ...changedCandidate.story, narration: "A different candidate reaches the observatory at dawn." });
    await expect(changedCandidate.repository.commitAcceptedTurn(acceptedCommitInput({
      scope: changedCandidate.scope, job: changedCandidate.job, story: differentStory
    }))).rejects.toMatchObject({ code: "generation_review_acceptance_unavailable" });

    const missingCampaign = await campaign();
    const missingReceipt = await readyFinalKeepCommit(missingCampaign.campaignId, "final-keep-missing-worker");
    await pool.query("UPDATE generation_jobs SET orchestration_private=orchestration_private || jsonb_build_object('generationReview',$2::jsonb) WHERE id=$1", [
      missingReceipt.scope.jobId, JSON.stringify({ ...missingReceipt.checkpoint, decisionJournal: [] })
    ]);
    await expect(missingReceipt.repository.commitAcceptedTurn(acceptedCommitInput({
      scope: missingReceipt.scope, job: missingReceipt.job, story: missingReceipt.story
    }))).rejects.toMatchObject({ code: "generation_review_acceptance_unavailable" });

    const mechanicsCampaign = await campaign();
    const mechanicsLeak = await readyFinalKeepCommit(mechanicsCampaign.campaignId, "final-keep-mechanics-worker");
    const contaminated = storyTurnOutputSchema.parse({ ...mechanicsLeak.story, narration: "The keeper rolls a die beneath the observatory moon." });
    const contaminatedCandidate = { ...mechanicsLeak.checkpoint.gateCandidate, story: contaminated, storyHash: sha256Hex(canonicalEvidenceJson(contaminated)) };
    const contaminatedCheckpoint = {
      ...mechanicsLeak.checkpoint,
      originalCandidate: contaminatedCandidate,
      gateCandidate: contaminatedCandidate,
      workingCandidate: contaminatedCandidate,
      decisionJournal: mechanicsLeak.checkpoint.decisionJournal.map((entry) => ({ ...entry, candidateHash: contaminatedCandidate.storyHash, offeredCandidate: contaminatedCandidate }))
    };
    await pool.query("UPDATE generation_jobs SET orchestration_private=orchestration_private || jsonb_build_object('generationReview',$2::jsonb) WHERE id=$1", [
      mechanicsLeak.scope.jobId, JSON.stringify(contaminatedCheckpoint)
    ]);
    await expect(mechanicsLeak.repository.commitAcceptedTurn(acceptedCommitInput({
      scope: mechanicsLeak.scope, job: mechanicsLeak.job, story: contaminated
    }))).rejects.toMatchObject({ code: "mechanics_leak" });

    const staleCampaign = await campaign();
    const stale = await readyFinalKeepCommit(staleCampaign.campaignId, "final-keep-stale-worker");
    await pool.query("UPDATE campaigns SET character_profile_revision=character_profile_revision+1 WHERE id=$1", [staleCampaign.campaignId]);
    await expect(stale.repository.commitAcceptedTurn(acceptedCommitInput({
      scope: stale.scope, job: stale.job, story: stale.story, responseId: stale.responseId
    }))).rejects.toMatchObject({ code: "stale_campaign" });
    await expect(pool.query<{ result_turn_id: string | null }>("SELECT result_turn_id FROM generation_jobs WHERE id=$1", [stale.scope.jobId]))
      .resolves.toMatchObject({ rows: [{ result_turn_id: null }] });
  });

  it("binds final Keep protocol identity to the locked job snapshot rather than executor memory", async () => {
    const changedVersionCampaign = await campaign();
    const changedVersion = await readyFinalKeepCommit(changedVersionCampaign.campaignId, "final-keep-protocol-version-worker");
    await pool.query("UPDATE generation_jobs SET prompt_protocol_version='substituted-protocol' WHERE id=$1", [changedVersion.scope.jobId]);
    await expect(changedVersion.repository.commitAcceptedTurn(acceptedCommitInput({
      scope: changedVersion.scope, job: changedVersion.job, story: changedVersion.story, responseId: changedVersion.responseId
    }))).rejects.toMatchObject({ code: "generation_review_acceptance_unavailable" });

    const changedSnapshotCampaign = await campaign();
    const changedSnapshot = await readyFinalKeepCommit(changedSnapshotCampaign.campaignId, "final-keep-protocol-snapshot-worker");
    const stored = await pool.query<{ prompt_snapshot: Record<string, unknown> }>(
      "SELECT prompt_snapshot FROM generation_jobs WHERE id=$1", [changedSnapshot.scope.jobId]
    );
    const promptSnapshot = structuredClone(stored.rows[0]!.prompt_snapshot) as {
      continuityReview: { review: { content: string; hash: string } };
    };
    promptSnapshot.continuityReview.review.content = "A frozen replacement continuity review prompt.";
    promptSnapshot.continuityReview.review.hash = sha256(promptSnapshot.continuityReview.review.content);
    await pool.query("UPDATE generation_jobs SET prompt_snapshot=$2::jsonb WHERE id=$1", [
      changedSnapshot.scope.jobId, JSON.stringify(promptSnapshot)
    ]);
    await expect(changedSnapshot.repository.commitAcceptedTurn(acceptedCommitInput({
      scope: changedSnapshot.scope, job: changedSnapshot.job, story: changedSnapshot.story, responseId: changedSnapshot.responseId
    }))).rejects.toMatchObject({ code: "generation_review_acceptance_unavailable" });
  });

  async function installActiveMainKeep(
    keep: Awaited<ReturnType<typeof readyFinalKeepCommit>>,
    preservesPrefix: boolean,
    supersedeWithFinalRetry = false
  ) {
    const mainStory = storyTurnOutputSchema.parse({
      ...keep.story,
      narration: "The keeper reaches the observatory before the morning bell."
    });
    const finalStory = storyTurnOutputSchema.parse({
      ...keep.story,
      narration: preservesPrefix
        ? `${mainStory.narration} The bell answers with a single clear note.`
        : "A replacement narrator skips the kept observatory arrival."
    });
    const mainRequestHash = "b".repeat(64);
    const requestBody = JSON.stringify({ input: "{}" });
    const finalRequestHash = sha256Hex(requestBody);
    const draftHash = "d".repeat(64);
    const mainCandidate = {
      ...keep.checkpoint.gateCandidate,
      scope: "main" as const,
      story: mainStory,
      storyHash: sha256Hex(canonicalEvidenceJson(mainStory)),
      producingRequestHash: mainRequestHash,
      producingResponseId: "kept-main-provider-response"
    };
    const finalCandidate = {
      ...keep.checkpoint.gateCandidate,
      story: finalStory,
      storyHash: sha256Hex(canonicalEvidenceJson(finalStory)),
      producingRequestHash: finalRequestHash,
      producingResponseId: keep.responseId
    };
    const mainReceipt = {
      ...keep.checkpoint.decisionJournal[0]!, reviewId: crypto.randomUUID(), candidateScope: "main" as const,
      candidateHash: mainCandidate.storyHash, offeredCandidate: mainCandidate
    };
    const finalReceipt = {
      ...keep.checkpoint.decisionJournal[0]!, candidateHash: finalCandidate.storyHash, offeredCandidate: finalCandidate
    };
    const retryReceipt = {
      ...finalReceipt, reviewId: crypto.randomUUID(), decision: "retry" as const, nextStage: "continuity" as const
    };
    const checkpoint = {
      ...keep.checkpoint,
      originalCandidate: finalCandidate,
      gateCandidate: finalCandidate,
      workingCandidate: finalCandidate,
      decisionJournal: supersedeWithFinalRetry ? [mainReceipt, retryReceipt] : [mainReceipt, finalReceipt]
    } as GenerationReviewCheckpoint;
    const manifest = {
      version: "generation-evidence-v1" as const, attemptId: crypto.randomUUID(), producingRequestHash: finalRequestHash,
      entries: [], requiredReviewEvidenceIds: [] as string[]
    };
    const manifestHash = sha256Hex(canonicalEvidenceJson(manifest));
    const normalBinding = {
      draftHash: sha256Hex(stableStringify(finalStory)), producingRequestHash: finalRequestHash, manifestHash,
      auxiliaryRequestHashes: [] as string[],
      providerConfigurationHash: finalCandidate.provider.configurationHash,
      promptHash: finalCandidate.protocol.promptHash, promptProtocol: "story-continuity-review-v1" as const,
      policyHash: finalCandidate.policyHash
    };
    await pool.query(
      "UPDATE generation_jobs SET orchestration_private=orchestration_private || $2::jsonb WHERE id=$1",
      [keep.scope.jobId, JSON.stringify({
        generationReview: checkpoint,
        validatedMainDraft: {
          draftHash, story: mainStory, requestPayloadHash: mainRequestHash,
          response: { responseId: "kept-main-provider-response" }
        },
        extension: {
          story: finalStory, finalStoryHash: stableStringify(finalStory), producingAttempt: 1,
          producingOperation: "event_extension", validatedMainDraftHash: draftHash,
          producingRequestPayloadHash: finalRequestHash, producingRequestBody: requestBody, sentFactIds: []
        },
        sourceEvidenceManifest: { ...manifest, manifestHash },
        ...(supersedeWithFinalRetry ? {
          continuityReview: {
            version: 1, mode: "enforce", binding: normalBinding, bindingHash: reviewBindingHash(normalBinding),
            status: "completed", verdict: "pass", reviewRequestHash: "e".repeat(64),
            result: { version: "story-continuity-review-v1", verdict: "pass", findings: [] }
          }
        } : {})
      })]
    );
    return finalStory;
  }

  it("preserves an active main Keep prefix through a provenance-bound extension", async () => {
    const preservedCampaign = await campaign();
    const preserved = await readyFinalKeepCommit(preservedCampaign.campaignId, "main-keep-prefix-worker");
    const preservedStory = await installActiveMainKeep(preserved, true);
    await expect(preserved.repository.commitAcceptedTurn(acceptedCommitInput({
      scope: preserved.scope, job: preserved.job, story: preservedStory, responseId: preserved.responseId
    }))).resolves.toMatchObject({ turnId: expect.any(String) });

    const rewrittenCampaign = await campaign();
    const rewritten = await readyFinalKeepCommit(rewrittenCampaign.campaignId, "main-keep-rewrite-worker");
    const rewrittenStory = await installActiveMainKeep(rewritten, false);
    await expect(rewritten.repository.commitAcceptedTurn(acceptedCommitInput({
      scope: rewritten.scope, job: rewritten.job, story: rewrittenStory, responseId: rewritten.responseId
    }))).rejects.toMatchObject({ code: "generation_review_acceptance_unavailable" });

    const supersededCampaign = await campaign();
    const superseded = await readyFinalKeepCommit(supersededCampaign.campaignId, "main-keep-superseded-worker");
    const supersededStory = await installActiveMainKeep(superseded, false, true);
    await expect(superseded.repository.commitAcceptedTurn(acceptedCommitInput({
      scope: superseded.scope, job: superseded.job, story: supersededStory, responseId: superseded.responseId
    }))).resolves.toMatchObject({ turnId: expect.any(String) });
  });

  it("fails closed when a persisted main Keep checkpoint cannot be parsed", async () => {
    const imported = await campaign();
    const mainKeep = await readyFinalKeepCommit(imported.campaignId, "malformed-main-keep-worker");
    const rewrittenStory = await installActiveMainKeep(mainKeep, false, true);
    await pool.query("UPDATE generation_jobs SET orchestration_private=jsonb_set(orchestration_private,'{generationReview}',$2::jsonb) WHERE id=$1", [
      mainKeep.scope.jobId, JSON.stringify({ malformed: true })
    ]);
    await expect(mainKeep.repository.commitAcceptedTurn(acceptedCommitInput({
      scope: mainKeep.scope, job: mainKeep.job, story: rewrittenStory, responseId: mainKeep.responseId
    }))).rejects.toMatchObject({ code: "generation_review_acceptance_unavailable" });
  });

  async function acceptedAndChronicleSnapshot(
    campaignId: string,
    factScopes: readonly Readonly<{ ownerUserId: string; campaignId: string }>[] = [{ ownerUserId, campaignId }]
  ) {
    const campaignScopes = [...new Map(factScopes.map((scope) => [`${scope.ownerUserId}:${scope.campaignId}`, scope])).values()];
    const [turns, memories, campaignStateResults, factResults] = await Promise.all([
      pool.query<{ id: string; turn_number: number; narration: string }>(
        `SELECT id,turn_number,narration FROM turns
          WHERE owner_user_id=$1 AND campaign_id=$2 ORDER BY turn_number,id`,
        [ownerUserId, campaignId]
      ),
      pool.query<{ id: string; turn_id: string | null; memory_kind: string; content: string }>(
        `SELECT id,turn_id,memory_kind,content FROM chronicle_memories
          WHERE owner_user_id=$1 AND campaign_id=$2 ORDER BY id`,
        [ownerUserId, campaignId]
      ),
      Promise.all(campaignScopes.map((scope) => pool.query<{ campaign_id: string; state: unknown }>(
        `SELECT campaign_id,to_jsonb(cs) AS state
           FROM campaign_state cs
          WHERE campaign_id=$1`,
        [scope.campaignId]
      ))),
      Promise.all(campaignScopes.map((scope) => pool.query<{
        id: string;
        owner_user_id: string;
        campaign_id: string;
        content: string;
        valid_from_turn: number;
        valid_until_turn: number | null;
        superseded_by_fact_id: string | null;
      }>(
        `SELECT id,owner_user_id,campaign_id,content,valid_from_turn,valid_until_turn,superseded_by_fact_id
           FROM campaign_canonical_facts
          WHERE owner_user_id=$1 AND campaign_id=$2
          ORDER BY id`,
        [scope.ownerUserId, scope.campaignId]
      )))
    ]);
    return {
      turns: turns.rows,
      memories: memories.rows,
      campaignStates: campaignStateResults.flatMap((result) => result.rows),
      facts: factResults.flatMap((result) => result.rows)
    };
  }

  async function turnVersionSnapshot(campaignId: string) {
    const result = await pool.query<{
      id: string;
      xmin: string;
      model_metadata: Record<string, unknown>;
    }>(
      `SELECT id, xmin::text AS xmin, model_metadata
         FROM turns
        WHERE owner_user_id = $1 AND campaign_id = $2
        ORDER BY turn_number, id`,
      [ownerUserId, campaignId]
    );
    return result.rows;
  }

  function attemptInput(scope: GenerationLeaseScope, attemptNumber = 1) {
    return {
      ...scope,
      attemptNumber,
      recoveryKind: "initial",
      requestMetadata: { model: "execution-repository-model" },
      responseMetadata: { outputLimited: false },
      providerResponseId: crypto.randomUUID(),
      finishReason: "stop",
      rawOutput: "A safe fictional response.",
      validationErrors: [],
      overwrite: true
    };
  }

  async function recordAttemptRaceState(
    settled: () => boolean,
    blockerPid: number
  ): Promise<"blocked" | "settled" | "timeout"> {
    for (let index = 0; index < 500; index += 1) {
      if (settled()) return "settled";
      const activity = await pool.query<{ blocked: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND query LIKE '%INSERT INTO generation_attempts%'
              AND wait_event_type = 'Lock'
              AND $1 = ANY(pg_blocking_pids(pid))
         ) AS blocked`,
        [blockerPid]
      );
      if (activity.rows[0]?.blocked) return "blocked";
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
    }
    return "timeout";
  }

  it("hydrates a frozen story-only policy without deriving it from current campaign settings", async () => {
    const imported = await campaign();
    await pool.query("UPDATE campaigns SET turn_control_style='flexible_scene' WHERE id=$1", [imported.campaignId]);
    const queued = await commands().enqueueAppend(
      { ownerUserId, campaignId: imported.campaignId },
      generationRequestSchema.parse({
        action: "Set the scene at the observatory.",
        providerProfileId,
        idempotencyKey: crypto.randomUUID(),
        requestedInputMode: "scene",
        resolvedInputMode: "scene",
        inputModeSource: "explicit",
        context: { budgetTokens: 16_000, compression: "full", recentTurns: 8 }
      })
    );
    await pool.query("UPDATE campaigns SET turn_control_style='flexible_action' WHERE id=$1", [imported.campaignId]);
    const repository = createPostgresGenerationExecutionRepository(pool);
    const claim = await repository.claimNext({ workerId: "story-only-hydration-worker", leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);

    const payload = await repository.loadExecutionPayload({ workerId: "story-only-hydration-worker", leaseSeconds: 30, claim: claim! });

    expect(payload?.generation_policy).toMatchObject({
      version: 1,
      playMode: "story_only",
      turnControlStyle: "flexible_scene",
      protocolVersion: "story-only-v1"
    });
    expect(payload?.requested_input_mode).toBe("scene");
    expect(payload?.resolved_input_mode).toBe("scene");
  });

  it("preserves authority-locked dormant mechanics and persists Story Direction policy on acceptance", async () => {
    const imported = await campaign();
    const rpgStats = { legacy: "rpg", unknownField: { retained: true } };
    const eventTriggers = [{ legacy: "event", count: 9, unknownField: true }];
    const pendingEventTriggers = [{ legacy: "pending", source: "old", unknownField: [1, 2, 3] }];
    await pool.query("UPDATE campaigns SET turn_control_style='flexible_scene' WHERE id=$1", [imported.campaignId]);
    await pool.query(
      `UPDATE campaign_state SET rpg_stats=$2::jsonb,event_triggers=$3::jsonb,pending_event_triggers=$4::jsonb
        WHERE campaign_id=$1 AND owner_user_id=$5`,
      [imported.campaignId, JSON.stringify(rpgStats), JSON.stringify(eventTriggers), JSON.stringify(pendingEventTriggers), ownerUserId]
    );
    const queued = await commands().enqueueAppend(
      { ownerUserId, campaignId: imported.campaignId },
      generationRequestSchema.parse({
        action: "Set the observatory scene.", providerProfileId, idempotencyKey: crypto.randomUUID(),
        requestedInputMode: "scene", resolvedInputMode: "scene", inputModeSource: "explicit",
        context: { budgetTokens: 16_000, compression: "full", recentTurns: 8 }
      })
    );
    const repository = createPostgresGenerationExecutionRepository(pool);
    const claim = await repository.claimNext({ workerId: "story-only-locked-mechanics-worker", leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);
    const scope = { jobId: queued.id, ownerUserId, workerId: "story-only-locked-mechanics-worker" };
    const job = await repository.loadExecutionPayload({ workerId: scope.workerId, leaseSeconds: 30, claim: claim! });
    if (!job) throw new Error("Expected a Story Direction payload.");
    expect(await repository.markGenerating(scope)).toBe(true);
    expect(await repository.markValidating(scope)).toBe(true);
    expect(await repository.markCommitting(scope)).toBe(true);
    expect(job.generation_policy?.playMode).toBe("story_only");

    const committed = await repository.commitAcceptedTurn(acceptedCommitInput({
      scope,
      job,
      story: supersedingStory([])
    }));

    await expect(pool.query<{
      rpg_stats: unknown;
      event_triggers: unknown;
      pending_event_triggers: unknown;
    }>(
      "SELECT rpg_stats,event_triggers,pending_event_triggers FROM campaign_state WHERE campaign_id=$1 AND owner_user_id=$2",
      [imported.campaignId, ownerUserId]
    )).resolves.toMatchObject({ rows: [{ rpg_stats: rpgStats, event_triggers: eventTriggers, pending_event_triggers: pendingEventTriggers }] });
    await expect(pool.query<{
      generation_policy: Record<string, unknown> | null;
      state_snapshot_private: Record<string, unknown>;
      model_metadata: Record<string, unknown>;
    }>(
      "SELECT generation_policy,state_snapshot_private,model_metadata FROM turns WHERE id=$1",
      [committed.turnId]
    )).resolves.toMatchObject({ rows: [expect.objectContaining({
      generation_policy: expect.objectContaining({ playMode: "story_only" }),
      state_snapshot_private: expect.objectContaining({ rpgStats, eventTriggers, pendingEventTriggers }),
      model_metadata: expect.objectContaining({ generationPolicy: expect.objectContaining({ playMode: "story_only" }) })
    })] });
  });

  it("persists SQL NULL policy for an accepted historical legacy job", async () => {
    const imported = await campaign();
    const queued = await queue(imported.campaignId, "Accept a historical legacy job.");
    await pool.query("UPDATE generation_jobs SET generation_policy=NULL WHERE id=$1", [queued.id]);
    const repository = createPostgresGenerationExecutionRepository(pool);
    const claim = await repository.claimNext({ workerId: "historical-null-policy-worker", leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);
    const scope = { jobId: queued.id, ownerUserId, workerId: "historical-null-policy-worker" };
    const job = await repository.loadExecutionPayload({ workerId: scope.workerId, leaseSeconds: 30, claim: claim! });
    if (!job) throw new Error("Expected a historical legacy payload.");
    expect(job.generation_policy).toBeNull();
    expect(await repository.markGenerating(scope)).toBe(true);
    expect(await repository.markValidating(scope)).toBe(true);
    expect(await repository.markCommitting(scope)).toBe(true);
    const committed = await repository.commitAcceptedTurn(acceptedCommitInput({
      scope,
      job,
      story: supersedingStory([])
    }));
    await expect(pool.query<{ is_sql_null: boolean }>(
      "SELECT generation_policy IS NULL AS is_sql_null FROM turns WHERE id=$1",
      [committed.turnId]
    )).resolves.toMatchObject({ rows: [{ is_sql_null: true }] });
  });

  it("replaces a Story Direction turn from its base while preserving current locked mechanics", async () => {
    const imported = await campaign();
    const actionCommit = await readyAcceptedCommit(imported.campaignId, "replacement-action-worker");
    const actionTurn = await actionCommit.repository.commitAcceptedTurn(acceptedCommitInput({
      scope: actionCommit.scope,
      job: actionCommit.job,
      story: supersedingStory([])
    }));
    const baseMechanics = {
      rpgStats: [{ source: "replacement-base", value: "obsolete" }],
      eventTriggers: [{ source: "replacement-base", phase: "before" }],
      pendingEventTriggers: [{ source: "replacement-base", phase: "pending" }]
    };
    const currentRpgStats = { source: "replacement-current", unknownField: { retained: true } };
    const currentEventTriggers = [{ source: "replacement-current", phase: "before", unknownField: { retained: true } }];
    const currentPendingEventTriggers = [{ source: "replacement-current", phase: "pending", unknownField: ["kept"] }];
    await pool.query(
      `UPDATE turns
          SET state_snapshot_private = state_snapshot_private || jsonb_build_object(
            'rpgStats',$4::jsonb,'eventTriggers',$5::jsonb,'pendingEventTriggers',$6::jsonb
          )
        WHERE campaign_id=$1 AND owner_user_id=$2 AND turn_number=$3`,
      [
        imported.campaignId,
        ownerUserId,
        actionCommit.job.expected_turn_number - 1,
        JSON.stringify(baseMechanics.rpgStats),
        JSON.stringify(baseMechanics.eventTriggers),
        JSON.stringify(baseMechanics.pendingEventTriggers)
      ]
    );
    await pool.query("UPDATE campaigns SET turn_control_style='flexible_scene' WHERE id=$1", [imported.campaignId]);
    await pool.query(
      `UPDATE campaign_state
          SET rpg_stats=$3::jsonb,event_triggers=$4::jsonb,pending_event_triggers=$5::jsonb
        WHERE campaign_id=$1 AND owner_user_id=$2`,
      [
        imported.campaignId,
        ownerUserId,
        JSON.stringify(currentRpgStats),
        JSON.stringify(currentEventTriggers),
        JSON.stringify(currentPendingEventTriggers)
      ]
    );
    const queued = await commands().enqueueReplacement(
      { ownerUserId, campaignId: imported.campaignId },
      generationRetryLatestRequestSchema.parse({
        action: "Replace the observatory scene with its repaired continuity.",
        providerProfileId,
        idempotencyKey: crypto.randomUUID(),
        expectedCurrentTurnNumber: actionCommit.job.expected_turn_number,
        requestedInputMode: "scene",
        resolvedInputMode: "scene",
        inputModeSource: "explicit",
        context: { budgetTokens: 16_000, compression: "full", recentTurns: 8 }
      })
    );
    const repository = createPostgresGenerationExecutionRepository(pool);
    const workerId = "story-only-replacement-locked-mechanics-worker";
    const claim = await repository.claimNext({ workerId, leaseSeconds: 30 });
    expect(claim).toMatchObject({ jobId: queued.id, operationKind: "replace_latest" });
    const scope = { jobId: queued.id, ownerUserId, workerId };
    const job = await repository.loadExecutionPayload({ workerId, leaseSeconds: 30, claim: claim! });
    if (!job) throw new Error("Expected a Story Direction replacement payload.");
    await expect(pool.query<{ input_mode: string; generation_policy: Record<string, unknown> | null }>(
      "SELECT input_mode,generation_policy FROM turns WHERE id=$1",
      [actionTurn.turnId]
    )).resolves.toMatchObject({ rows: [expect.objectContaining({
      input_mode: "action",
      generation_policy: expect.objectContaining({ playMode: "legacy" })
    })] });
    expect(job.generation_policy).toMatchObject({ playMode: "story_only" });
    expect(job.base_state_private).toMatchObject(baseMechanics);
    expect(job.base_state_private.eventTriggers).not.toEqual(currentEventTriggers);
    expect(await repository.markGenerating(scope)).toBe(true);
    expect(await repository.markValidating(scope)).toBe(true);
    expect(await repository.markCommitting(scope)).toBe(true);
    const story = storyTurnOutputSchema.parse({
      ...supersedingStory([]),
      narration: "The repaired observatory scene preserves the keeper's warning.",
      continuity_summary: "The repaired scene keeps the keeper's warning in view.",
      canonical_facts: ["The keeper's warning remains true after the repair."],
      canonical_fact_updates: [{
        content: "The keeper's warning remains true after the repair.",
        supersedes_fact_ids: []
      }],
      open_threads: ["Learn why the keeper gave the warning."],
      tracker_updates: [{ name: "Observatory repair", value: "complete" }]
    });
    const committed = await repository.commitAcceptedTurn(acceptedCommitInput({ scope, job, story }));

    await expect(pool.query<{
      rpg_stats: unknown;
      event_triggers: unknown;
      pending_event_triggers: unknown;
    }>(
      "SELECT rpg_stats,event_triggers,pending_event_triggers FROM campaign_state WHERE campaign_id=$1 AND owner_user_id=$2",
      [imported.campaignId, ownerUserId]
    )).resolves.toMatchObject({ rows: [{
      rpg_stats: currentRpgStats,
      event_triggers: currentEventTriggers,
      pending_event_triggers: currentPendingEventTriggers
    }] });
    await expect(pool.query<{
      narration: string;
      generation_policy: Record<string, unknown> | null;
      state_snapshot_private: Record<string, unknown>;
    }>(
      "SELECT narration,generation_policy,state_snapshot_private FROM turns WHERE id=$1",
      [committed.turnId]
    )).resolves.toMatchObject({ rows: [expect.objectContaining({
      narration: story.narration,
      generation_policy: expect.objectContaining({ playMode: "story_only" }),
      state_snapshot_private: expect.objectContaining({
        rpgStats: currentRpgStats,
        eventTriggers: currentEventTriggers,
        pendingEventTriggers: currentPendingEventTriggers,
        continuitySummary: story.continuity_summary,
        canonicalFacts: story.canonical_facts,
        openThreads: story.open_threads,
        trackers: expect.arrayContaining([expect.objectContaining({ name: "Observatory repair", value: "complete" })])
      })
    })] });
    await expect(pool.query<{ content: string }>(
      `SELECT content FROM campaign_canonical_facts
        WHERE campaign_id=$1 AND owner_user_id=$2 AND content=$3`,
      [imported.campaignId, ownerUserId, story.canonical_facts[0]]
    )).resolves.toMatchObject({ rows: [{ content: story.canonical_facts[0] }] });
    await expect(pool.query<{ id: string; state_snapshot_private: Record<string, unknown> }>(
      "SELECT id,state_snapshot_private FROM turns WHERE campaign_id=$1 AND owner_user_id=$2 AND turn_number=$3",
      [imported.campaignId, ownerUserId, actionCommit.job.expected_turn_number]
    )).resolves.toMatchObject({ rows: [expect.objectContaining({
      id: committed.turnId,
      state_snapshot_private: expect.objectContaining({ openThreads: story.open_threads })
    })] });
  });

  it("retains legacy string event rules in worker inputs without mutating stored history", async () => {
    const imported = await campaign();
    const rule = "When the keeper arrives, light the lantern.";
    const structured = { id: "gate", label: "Gate", timing: "after", condition: "The gate closes.",
      effect: "The keeper waves.", addTextAfter: false, triggeredCount: 2,
      lastTriggeredTurn: 2, lastTriggeredAt: "2026-08-30T12:00:00Z" };
    await pool.query("UPDATE campaign_state SET event_triggers=$2 WHERE campaign_id=$1", [imported.campaignId, JSON.stringify([rule, structured])]);
    const originalTurns = await turnVersionSnapshot(imported.campaignId);
    const queued = await queue(imported.campaignId, "Approach the keeper.");
    const repository = createPostgresGenerationExecutionRepository(pool);
    const claim = await repository.claimNext({ workerId: "trigger-worker", leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);
    const payload = await repository.loadExecutionPayload({ workerId: "trigger-worker", leaseSeconds: 30, claim: claim! });
    expect(payload?.orchestration_inputs.eventTriggers).toEqual([{
      id: "world-event-1", label: "World event 1", timing: "before", condition: rule, effect: rule,
      addTextAfter: false, triggeredCount: 0, lastTriggeredTurn: null, lastTriggeredAt: null
    }, structured]);
    expect(await turnVersionSnapshot(imported.campaignId)).toEqual(originalTurns);
    expect((await pool.query("SELECT event_triggers FROM campaign_state WHERE campaign_id=$1", [imported.campaignId])).rows[0].event_triggers).toEqual([rule, structured]);
    await pool.query("UPDATE generation_jobs SET status='discarded' WHERE id=$1", [queued.id]);
  });

  it("claims a minimal job once and reclaims an expired lease without an initial-owner lookup", async () => {
    const imported = await campaign();
    const queued = await queueEnrolledPolicy(imported.campaignId, "Open the lease observatory.");
    const repository = createPostgresGenerationExecutionRepository(pool);

    const claims = await Promise.all([
      repository.claimNext({ workerId: "worker-a", leaseSeconds: 30 }),
      repository.claimNext({ workerId: "worker-b", leaseSeconds: 30 })
    ]);
    const claimed = claims.find((value) => value?.jobId === queued.id);

    expect(claimed).toEqual({
      jobId: queued.id,
      ownerUserId,
      campaignId: imported.campaignId,
      providerProfileId,
      expectedTurnNumber: 3,
      attempts: 1,
      operationKind: "append",
      replacementTurnId: null
    });
    expect(claims.filter((value) => value?.jobId === queued.id)).toHaveLength(1);

    await pool.query(
      "UPDATE generation_jobs SET status = 'generating', lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [queued.id]
    );
    const reclaimed = await repository.claimNext({ workerId: "worker-c", leaseSeconds: 45 });
    expect(reclaimed).toMatchObject({ jobId: queued.id, ownerUserId, attempts: 2 });

    await expect(repository.loadExecutionPayload({
      workerId: "worker-a",
      leaseSeconds: 30,
      claim: claimed!
    })).resolves.toBeNull();
    await expect(repository.loadExecutionPayload({
      workerId: "worker-c",
      leaseSeconds: 45,
      claim: reclaimed!
    })).resolves.toMatchObject({
      id: queued.id,
      owner_user_id: ownerUserId,
      campaign_id: imported.campaignId,
      attempts: 2,
      generation_base_identity: { version: "generation-base-v3" }
    });
  });

  it("guards payload loading by durable owner, lease owner, and assessing state", async () => {
    const imported = await campaign();
    const queued = await queue(imported.campaignId, "Inspect the guarded payload archive.");
    const repository = createPostgresGenerationExecutionRepository(pool);
    const claim = await repository.claimNext({ workerId: "guard-worker", leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);

    await expect(repository.loadExecutionPayload({
      workerId: "guard-worker",
      leaseSeconds: 30,
      claim: { ...claim!, ownerUserId: crypto.randomUUID() }
    })).resolves.toBeNull();

    await commands().cancel({ ownerUserId, jobId: queued.id });
    await expect(repository.loadExecutionPayload({
      workerId: "guard-worker",
      leaseSeconds: 30,
      claim: claim!
    })).resolves.toBeNull();
  });

  it("does not load a claimed job after its snapshotted authority base changes", async () => {
    const imported = await campaign();
    const queued = await queue(imported.campaignId, "Fence a changed authority base.");
    const repository = createPostgresGenerationExecutionRepository(pool);
    const claim = await repository.claimNext({ workerId: "authority-fence-worker", leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);
    const promptBefore = (await pool.query<{
      prompt_snapshot: Record<string, unknown>;
      prompt_protocol_version: string;
    }>(
      "SELECT prompt_snapshot, prompt_protocol_version FROM generation_jobs WHERE id = $1",
      [queued.id]
    )).rows[0]!;

    await pool.query(
      `UPDATE campaign_state
          SET scratchpad_private = 'A correction changed the generation base.', revision = revision + 1
        WHERE campaign_id = $1 AND owner_user_id = $2`,
      [imported.campaignId, ownerUserId]
    );

    await expect(repository.loadExecutionPayload({
      workerId: "authority-fence-worker",
      leaseSeconds: 30,
      claim: claim!
    })).resolves.toBeNull();
    await expect(pool.query<{
      status: string;
      error_code: string | null;
      error_message: string | null;
      recovery_metadata: Record<string, unknown>;
      prompt_snapshot: Record<string, unknown>;
      prompt_protocol_version: string;
      lease_owner: string | null;
      lease_expires_at: string | null;
    }>(
      `SELECT status, error_code, error_message, recovery_metadata, prompt_snapshot, prompt_protocol_version,
              lease_owner, lease_expires_at
         FROM generation_jobs WHERE id = $1`,
      [queued.id]
    )).resolves.toMatchObject({ rows: [{
      status: "recoverable",
      error_code: "generation_authority_stale",
      error_message: "Campaign changed before generation could start.",
      recovery_metadata: { reason: "generation_authority_stale" },
      prompt_snapshot: promptBefore.prompt_snapshot,
      prompt_protocol_version: promptBefore.prompt_protocol_version,
      lease_owner: null,
      lease_expires_at: null
    }] });
  });

  it("marks an enrolled v3 attempt recoverable after an out-of-band profile edit and revert", async () => {
    const imported = await campaign();
    const queued = await queueEnrolledPolicy(imported.campaignId, "Defend the v3 profile authority.");
    const repository = createPostgresGenerationExecutionRepository(pool);
    const claim = await repository.claimNext({ workerId: "profile-fence-worker", leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);
    const original = (await pool.query<{ character_profile: unknown }>(
      "SELECT character_profile FROM campaigns WHERE id=$1 AND owner_user_id=$2",
      [imported.campaignId, ownerUserId]
    )).rows[0]!.character_profile;

    // Defensive stale-data simulation. Normal profile writes are rejected while this job is active.
    await pool.query(
      `UPDATE campaigns
          SET character_profile=$3::jsonb, character_profile_revision=character_profile_revision + 1
        WHERE id=$1 AND owner_user_id=$2`,
      [imported.campaignId, ownerUserId, JSON.stringify({ name: "Out-of-band Mira", profile: { story: { role: "Changed" } } })]
    );
    if (original === null) {
      await pool.query(
        `UPDATE campaigns
            SET character_profile=NULL, character_profile_revision=character_profile_revision + 1
          WHERE id=$1 AND owner_user_id=$2`,
        [imported.campaignId, ownerUserId]
      );
    } else {
      await pool.query(
        `UPDATE campaigns
            SET character_profile=$3::jsonb, character_profile_revision=character_profile_revision + 1
          WHERE id=$1 AND owner_user_id=$2`,
        [imported.campaignId, ownerUserId, JSON.stringify(original)]
      );
    }

    await expect(repository.loadExecutionPayload({
      workerId: "profile-fence-worker", leaseSeconds: 30, claim: claim!
    })).resolves.toBeNull();
    await expect(pool.query(
      "SELECT status,error_code,recovery_metadata FROM generation_jobs WHERE id=$1",
      [queued.id]
    )).resolves.toMatchObject({ rows: [{
      status: "recoverable", error_code: "generation_authority_stale",
      recovery_metadata: { reason: "generation_authority_stale" }
    }] });
  });

  it("marks an enrolled v3 attempt recoverable when a non-null persisted profile is malformed", async () => {
    const imported = await campaign();
    const queued = await queueEnrolledPolicy(imported.campaignId, "Fail closed for a malformed character authority.");
    const repository = createPostgresGenerationExecutionRepository(pool);
    const claim = await repository.claimNext({ workerId: "malformed-profile-fence-worker", leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);

    // This direct SQL mutation represents corrupted persisted authority. A null profile remains a supported fallback.
    await pool.query(
      "UPDATE campaigns SET character_profile='{\"name\":\"Incomplete\"}'::jsonb WHERE id=$1 AND owner_user_id=$2",
      [imported.campaignId, ownerUserId]
    );

    await expect(repository.loadExecutionPayload({
      workerId: "malformed-profile-fence-worker", leaseSeconds: 30, claim: claim!
    })).resolves.toBeNull();
    await expect(pool.query(
      "SELECT status,error_code,recovery_metadata FROM generation_jobs WHERE id=$1",
      [queued.id]
    )).resolves.toMatchObject({ rows: [{
      status: "recoverable", error_code: "generation_checkpoint_incompatible",
      recovery_metadata: { reason: "authoritative_context_invalid", field: "character_profile" }
    }] });
  });

  it("keeps the existing narration-correction source fence for an enrolled v3 attempt", async () => {
    const imported = await campaign();
    const queued = await queueEnrolledPolicy(imported.campaignId, "Fence a corrected accepted narration.");
    const repository = createPostgresGenerationExecutionRepository(pool);
    const claim = await repository.claimNext({ workerId: "narration-correction-fence-worker", leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);
    const baseTurn = (await pool.query<{ id: string; narration: string }>(
      `SELECT id,narration FROM turns
        WHERE campaign_id=$1 AND owner_user_id=$2 AND turn_number=2`,
      [imported.campaignId, ownerUserId]
    )).rows[0];
    if (!baseTurn) throw new Error("Expected the accepted base turn for narration correction.");

    // Defensive stale-data simulation. Accepted narration corrections use their append-only repository path in normal work.
    await pool.query(
      `INSERT INTO turn_narration_corrections (
         owner_user_id,campaign_id,turn_id,revision,narration,previous_effective_narration_hash,
         reason,source,created_by_user_id
       ) VALUES ($1,$2,$3,1,$4,$5,'Fence source revision','administrative',$1)`,
      [ownerUserId, imported.campaignId, baseTurn.id,
        "The corrected base narration changes the next-turn authority.", sha256(baseTurn.narration)]
    );

    await expect(repository.loadExecutionPayload({
      workerId: "narration-correction-fence-worker", leaseSeconds: 30, claim: claim!
    })).resolves.toBeNull();
    await expect(pool.query(
      "SELECT status,error_code,recovery_metadata FROM generation_jobs WHERE id=$1",
      [queued.id]
    )).resolves.toMatchObject({ rows: [{
      status: "recoverable", error_code: "generation_authority_stale",
      recovery_metadata: { reason: "generation_authority_stale" }
    }] });
  });

  it("allows discard, a revision-checked profile edit, and a newly enrolled v3 enqueue", async () => {
    const imported = await campaign();
    const queued = await queueEnrolledPolicy(imported.campaignId, "Recover the profile authority workflow.");
    const execution = createPostgresGenerationExecutionRepository(pool);
    const workerId = "discard-edit-enqueue-worker";
    const claim = await execution.claimNext({ workerId, leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);
    await expect(execution.markRecoverable({
      jobId: queued.id, ownerUserId, workerId,
      providerResponseId: null, providerFinishReason: null,
      errorCode: "synthetic_recoverable", errorMessage: "Fixture recovery.", recoveryMetadata: {}
    })).resolves.toBe(true);
    await expect(enrolledPolicyCommands().discard({ ownerUserId, jobId: queued.id }))
      .resolves.toMatchObject({ status: "discarded" });

    const profiles = createPostgresCharacterProfileRepository();
    const transactions = createPostgresWorldCampaignTransactionPort(pool);
    const profile = characterProfileSchema.parse({ story: { role: "Edited after discard" } });
    const current = (await pool.query<{ character_profile_revision: number }>(
      "SELECT character_profile_revision FROM campaigns WHERE id=$1 AND owner_user_id=$2",
      [imported.campaignId, ownerUserId]
    )).rows[0];
    if (!current) throw new Error("Expected the campaign profile revision after discard.");
    await expect(transactions.command((transaction) => profiles.updateCampaignCharacterProfile(
      transaction,
      { ownerUserId, campaignId: imported.campaignId },
      campaignCharacterProfileUpdateSchema.parse({
        expectedRevision: current.character_profile_revision,
        name: "Recovered authority", profile, editSource: "manual"
      })
    ))).resolves.toMatchObject({ ok: true, value: {
      revision: current.character_profile_revision + 1, name: "Recovered authority"
    } });

    const requeued = await queueEnrolledPolicy(imported.campaignId, "Queue using the revised authority.");
    await expect(pool.query<{ generation_base_identity: Record<string, unknown> }>(
      "SELECT generation_base_identity FROM generation_jobs WHERE id=$1 AND owner_user_id=$2",
      [requeued.id, ownerUserId]
    )).resolves.toMatchObject({ rows: [{ generation_base_identity: {
      version: "generation-base-v3", characterProfileRevision: current.character_profile_revision + 1
    } }] });
    await expect(enrolledPolicyCommands().cancel({ ownerUserId, jobId: requeued.id }))
      .resolves.toMatchObject({ status: "cancelled" });
  });

  it("refuses to commit an enrolled v3 attempt after an out-of-band profile change", async () => {
    const imported = await campaign();
    const queued = await queueEnrolledPolicy(imported.campaignId, "Commit only the frozen profile authority.");
    const repository = createPostgresGenerationExecutionRepository(pool);
    const workerId = "profile-commit-fence-worker";
    const claim = await repository.claimNext({ workerId, leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);
    const scope = { jobId: queued.id, ownerUserId, workerId };
    const job = await repository.loadExecutionPayload({ workerId, leaseSeconds: 30, claim: claim! });
    if (!job) throw new Error("Expected a loaded enrolled policy job.");
    await expect(repository.markGenerating(scope)).resolves.toBe(true);
    await expect(repository.markValidating(scope)).resolves.toBe(true);
    await expect(repository.markCommitting(scope)).resolves.toBe(true);

    // Defensive stale-data simulation after capture, distinct from supported profile editing.
    await pool.query(
      `UPDATE campaigns
          SET character_profile=$3::jsonb, character_profile_revision=character_profile_revision + 1
        WHERE id=$1 AND owner_user_id=$2`,
      [imported.campaignId, ownerUserId, JSON.stringify({ name: "Changed after capture", profile: { story: { role: "Changed" } } })]
    );
    await expect(repository.commitAcceptedTurn(acceptedCommitInput({
      scope, job, story: supersedingStory([])
    }))).rejects.toMatchObject({ code: "stale_campaign" });
    await expect(pool.query("SELECT status FROM generation_jobs WHERE id=$1", [queued.id]))
      .resolves.toMatchObject({ rows: [{ status: "committing" }] });
  });

  it.each(["load", "commit"])("fences a corrected R2 predecessor at %s using the enqueue snapshot", async (phase) => {
    const imported = await campaign();
    const queued = await queueEnrolledPolicy(imported.campaignId, "Bind the direct recent history.", "r2");
    const frozen = await pool.query<{ generation_base_identity: { recentWindowFingerprint?: string } }>("SELECT generation_base_identity FROM generation_jobs WHERE id=$1", [queued.id]);
    expect(frozen.rows[0]!.generation_base_identity.recentWindowFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    const repository = createPostgresGenerationExecutionRepository(pool);
    const workerId = `recent-${phase}-fence-worker`;
    const claim = await repository.claimNext({ workerId, leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);
    const scope = { jobId: queued.id, ownerUserId, workerId };
    const job = phase === "commit" ? await repository.loadExecutionPayload({ workerId, leaseSeconds: 30, claim: claim! }) : null;
    if (phase === "commit") {
      expect(job).not.toBeNull();
      await repository.markGenerating(scope); await repository.markValidating(scope); await repository.markCommitting(scope);
    }
    const predecessor = await pool.query<{ id: string; narration: string }>(
      "SELECT t.id,t.narration FROM turns t JOIN campaigns c ON c.id=t.campaign_id WHERE t.campaign_id=$1 AND t.turn_number=c.active_turn_number-1", [imported.campaignId]);
    expect(predecessor.rows).toHaveLength(1);
    await pool.query(`INSERT INTO turn_narration_corrections(owner_user_id,campaign_id,turn_id,revision,narration,previous_effective_narration_hash,reason,source,created_by_user_id)
      VALUES($1,$2,$3,1,'Corrected recent history.', $4,'Fence test','administrative',$1)`,
    [ownerUserId, imported.campaignId, predecessor.rows[0]!.id, sha256(predecessor.rows[0]!.narration)]);
    if (phase === "load") {
      await expect(repository.loadExecutionPayload({ workerId, leaseSeconds: 30, claim: claim! })).resolves.toBeNull();
      expect((await pool.query("SELECT error_code FROM generation_jobs WHERE id=$1", [queued.id])).rows[0]).toMatchObject({ error_code: "generation_authority_stale" });
    } else {
      await expect(repository.commitAcceptedTurn(acceptedCommitInput({ scope, job: job!, story: supersedingStory([]) }))).rejects.toMatchObject({ code: "stale_campaign" });
    }
  });

  it("applies lease and phase mutations only to the claimed owner, worker, and source state", async () => {
    const imported = await campaign();
    const queued = await queue(imported.campaignId, "Trace the durable phase corridor.");
    const repository = createPostgresGenerationExecutionRepository(pool);
    const claim = await repository.claimNext({ workerId: "phase-worker", leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);
    const scope = { jobId: queued.id, ownerUserId, workerId: "phase-worker" };

    await expect(repository.renewLease(scope, 60)).resolves.toBe(true);
    await expect(repository.renewLease({ ...scope, workerId: "foreign-worker" }, 60)).resolves.toBe(false);
    await expect(repository.saveOrchestration(scope, { roll: null })).resolves.toBe(true);
    await expect(repository.markGenerating(scope)).resolves.toBe(true);
    await expect(repository.markGenerating(scope)).resolves.toBe(false);
    await expect(repository.recordAttempt(attemptInput(scope))).resolves.toBeUndefined();
    await expect(repository.recordAttempt(attemptInput({
      ...scope,
      workerId: "foreign-worker"
    }, 2))).rejects.toMatchObject({ code: "generation_cancelled" });
    await expect(repository.savePartialNarration(scope, "A safe fictional preview.")).resolves.toBe(true);
    await expect(repository.saveStreamingSegments(scope, { provisionalSetId: null })).resolves.toBe(true);
    await expect(repository.markValidating(scope)).resolves.toBe(true);
    await expect(repository.markCommitting(scope)).resolves.toBe(true);
    await expect(repository.markFailed({
      ...scope,
      errorCode: "generation_failed",
      errorMessage: "The story could not be generated.",
      recoveryMetadata: { transportError: false },
      lastFailureDiagnostic: {
        version: 1, category: "provider_timeout", code: "provider_request_timeout", phase: "story_generation",
        attemptNumber: 1, occurredAt: "2026-09-18T00:00:00.000Z"
      }
    })).resolves.toBe(true);
    await expect(repository.markFailed({
      ...scope,
      errorCode: "generation_failed",
      errorMessage: "The story could not be generated.",
      recoveryMetadata: {}
    })).resolves.toBe(false);

    await expect(pool.query<{
      status: string;
      partial_output: string | null;
      orchestration_private: Record<string, unknown>;
      streaming_segments_state: Record<string, unknown>;
    }>(
      `SELECT status, partial_output, orchestration_private, streaming_segments_state
         FROM generation_jobs WHERE id = $1`,
      [queued.id]
    )).resolves.toMatchObject({ rows: [{
      status: "failed",
      partial_output: "A safe fictional preview.",
      orchestration_private: { roll: null, lastFailureDiagnostic: {
        version: 1, category: "provider_timeout", code: "provider_request_timeout", phase: "story_generation",
        attemptNumber: 1, occurredAt: "2026-09-18T00:00:00.000Z"
      } },
      streaming_segments_state: { provisionalSetId: null }
    }] });
    await expect(pool.query<{ attempt_number: number }>(
      "SELECT attempt_number FROM generation_attempts WHERE generation_job_id = $1",
      [queued.id]
    )).resolves.toMatchObject({ rows: [{ attempt_number: 1 }] });
  });

  it("queues chunk work after accepting a turn without rewriting the accepted row", async () => {
    const imported = await campaign();
    const earlierTurns = await turnVersionSnapshot(imported.campaignId);
    const queued = await queue(imported.campaignId, "Open the chunk lifecycle observatory.");
    const repository = createPostgresGenerationExecutionRepository(pool);
    const claim = await repository.claimNext({ workerId: "chunk-lifecycle-worker", leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);
    const scope = { jobId: queued.id, ownerUserId, workerId: "chunk-lifecycle-worker" };
    const job = await repository.loadExecutionPayload({
      workerId: scope.workerId,
      leaseSeconds: 30,
      claim: claim!
    });
    if (!job) throw new Error("Expected the accepted-turn lifecycle payload.");
    expect(await repository.markGenerating(scope)).toBe(true);
    expect(await repository.markValidating(scope)).toBe(true);
    expect(await repository.markCommitting(scope)).toBe(true);
    const baseMemory = memoryGeneration(pool);
    let acceptedDuringEnqueue: {
      id: string;
      narration: string;
      xmin: string;
      ctid: string;
    } | null = null;
    const enqueueChunkIndex = vi.fn(async (
      database: DatabaseClient,
      memoryScope: Parameters<AcceptedGenerationCommitCollaborators["memory"]["enqueueChunkIndex"]>[1]
    ) => {
      acceptedDuringEnqueue = (await database.query<{
        id: string;
        narration: string;
        xmin: string;
        ctid: string;
      }>(
        `SELECT id,narration,xmin::text AS xmin,ctid::text AS ctid
           FROM turns WHERE owner_user_id=$1 AND campaign_id=$2
           ORDER BY turn_number DESC LIMIT 1`,
        [memoryScope.ownerUserId, memoryScope.campaignId]
      )).rows[0] ?? null;
      return baseMemory.enqueueChunkIndex(database, memoryScope);
    });
    const story = storyTurnOutputSchema.parse({
      narration: "The chunk lifecycle observatory opens beneath a quiet moon.",
      choices: ["Enter.", "Wait.", "Study the gate.", "Call the keeper."],
      custom_action_suggestion: "Inspect the observatory lens.",
      scratchpad: "The observatory is open.",
      tracker_updates: [],
      image_prompt: "A quiet moonlit observatory.",
      continuity_summary: "The observatory has opened.",
      canonical_facts: ["The observatory is open."],
      superseded_facts: [],
      canonical_fact_updates: [],
      open_threads: ["Learn who opened the observatory."]
    });
    const committed = await repository.commitAcceptedTurn({
      scope,
      job,
      story,
      provider: {
        id: providerProfileId,
        name: "Execution repository provider",
        providerType: "openai_compatible",
        model: "execution-repository-model"
      },
      response: {
        content: JSON.stringify(story),
        responseId: crypto.randomUUID(),
        finishReason: "stop",
        outputLimited: false,
        modelInstanceId: "execution-repository-instance",
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        reportedCost: null,
        rawMetadata: {}
      },
      contextFingerprint: "task-11-context-fingerprint",
      contextDiagnostics: { retrieval: { selectedMemoryCount: 4, fallbackReason: "chunk_index_not_ready" } },
      chronicleRetrieval: DEDICATED_CHUNKED_AUDIT,
      inputs: job.orchestration_inputs,
      orchestration: {},
      fictionAction: job.action,
      collaborators: {
        memory: { ...baseMemory, enqueueChunkIndex },
        illustration: {
          enqueueAcceptedTurnIllustrationSegments: async () => []
        } as unknown as AcceptedGenerationCommitCollaborators["illustration"],
        attributeGenerationCostsToTurn: async () => undefined
      },
      onIllustrationEnqueueError: () => undefined
    });

    expect(enqueueChunkIndex).toHaveBeenCalledOnce();
    expect(enqueueChunkIndex).toHaveBeenCalledWith(expect.anything(), {
      ownerUserId,
      campaignId: imported.campaignId,
      worldVersionId: imported.worldVersionId
    });
    expect(acceptedDuringEnqueue).toMatchObject({
      id: committed.turnId,
      narration: story.narration,
      xmin: expect.any(String),
      ctid: expect.any(String)
    });
    await expect(pool.query(
      "SELECT id,narration,xmin::text AS xmin,ctid::text AS ctid FROM turns WHERE id=$1",
      [committed.turnId]
    )).resolves.toMatchObject({ rows: [acceptedDuringEnqueue] });
    const stored = await pool.query<{ model_metadata: Record<string, unknown> }>(
      "SELECT model_metadata FROM turns WHERE id = $1",
      [committed.turnId]
    );
    expect(stored.rows[0]?.model_metadata).toMatchObject({
      chronicleRetrieval: DEDICATED_CHUNKED_AUDIT,
      contextDiagnostics: { retrieval: { selectedMemoryCount: 4, fallbackReason: "chunk_index_not_ready" } }
    });
    expect(await turnVersionSnapshot(imported.campaignId)).toEqual([
      ...earlierTurns,
      expect.objectContaining({ id: committed.turnId })
    ]);
  });

  it("fulfills an older pending occurrence exactly once when its fiction is accepted", async () => {
    const imported = await campaign();
    const { repository, scope, job } = await readyAcceptedCommit(imported.campaignId, "pending-fulfillment-worker");
    const trigger = {
      id: "observatory-bell", label: "Observatory bell", timing: "after" as const,
      condition: "The keeper arrives.", effect: "The bell rings.", addTextAfter: false,
      triggeredCount: 2, lastTriggeredTurn: null, lastTriggeredAt: null
    };
    const pending = {
      id: "observatory-bell-pending", sourceTriggerId: trigger.id, name: trigger.label,
      timing: "after" as const, condition: trigger.condition, effect: trigger.effect,
      instructions: "The bell rings.", reason: "", sourceTurn: job.expected_turn_number - 1, addTextAfter: false
    };
    const input = acceptedCommitInput({ scope, job, story: supersedingStory([]) });
    input.story.narration = "The observatory bell rings as the keeper enters.";
    await repository.commitAcceptedTurn({
      ...input,
      inputs: { ...job.orchestration_inputs, eventTriggers: [trigger], pendingEventTriggers: [pending] },
      orchestration: { beforeEvents: [pending, pending], afterEvents: [] }
    });
    const state = await pool.query<{ event_triggers: unknown; pending_event_triggers: unknown }>(
      "SELECT event_triggers, pending_event_triggers FROM campaign_state WHERE campaign_id=$1 AND owner_user_id=$2",
      [imported.campaignId, ownerUserId]
    );
    expect(state.rows[0]?.event_triggers).toEqual([
      { ...trigger, triggeredCount: 3, lastTriggeredTurn: pending.sourceTurn, lastTriggeredAt: expect.any(String) }
    ]);
    expect(state.rows[0]?.pending_event_triggers).toEqual([]);
  });

  it("keeps a final event story accepted when its illustration finalization enqueue fails", async () => {
    const imported = await campaign();
    const { repository, scope, job } = await readyAcceptedCommit(imported.campaignId, "event-finalization-worker");
    const finalStory = supersedingStory([]);
    finalStory.narration = "The observatory bell rings after the keeper's final warning.";
    const acceptedDuringIllustration = vi.fn(async (
      database: DatabaseClient,
      _scope: unknown,
      request: { generationJobId?: string } | undefined,
    ) => {
      expect(request).toMatchObject({ generationJobId: job.id });
      const result = await database.query<{ narration: string }>(
        "SELECT narration FROM turns WHERE campaign_id=$1 AND owner_user_id=$2 ORDER BY turn_number DESC LIMIT 1",
        [imported.campaignId, ownerUserId]
      );
      expect(result.rows[0]?.narration).toBe(finalStory.narration);
      throw new Error("synthetic illustration finalization fault");
    });
    const onIllustrationEnqueueError = vi.fn();

    const committed = await repository.commitAcceptedTurn({
      ...acceptedCommitInput({ scope, job, story: finalStory }),
      orchestration: {
        validatedMainDraft: { draftHash: "validated-main-draft-fixture" } as never,
        afterEvents: [],
        extension: {
          story: finalStory,
          finalStoryHash: stableStringify(finalStory),
          producingAttempt: job.attempts,
          producingOperation: "event_extension",
          validatedMainDraftHash: "validated-main-draft-fixture",
          producingRequestPayloadHash: "extension-request-fixture",
          sentFactIds: []
        }
      },
      collaborators: {
        memory: memoryGeneration(pool),
        illustration: {
          enqueueAcceptedTurnIllustrationSegments: acceptedDuringIllustration
        } as unknown as AcceptedGenerationCommitCollaborators["illustration"],
        attributeGenerationCostsToTurn: async () => undefined
      },
      onIllustrationEnqueueError
    });

    expect(acceptedDuringIllustration).toHaveBeenCalledOnce();
    expect(onIllustrationEnqueueError).toHaveBeenCalledOnce();
    await expect(pool.query("SELECT narration FROM turns WHERE id=$1", [committed.turnId]))
      .resolves.toMatchObject({ rows: [{ narration: finalStory.narration }] });
    await expect(pool.query("SELECT status FROM generation_jobs WHERE id=$1", [job.id]))
      .resolves.toMatchObject({ rows: [{ status: "completed" }] });
  });

  it("rejects malformed retrieval audit before inserting a turn or touching earlier accepted rows", async () => {
    const imported = await campaign();
    const earlierTurns = await turnVersionSnapshot(imported.campaignId);
    const queued = await queue(imported.campaignId, "Refuse malformed Chronicle audit metadata.");
    const repository = createPostgresGenerationExecutionRepository(pool);
    const claim = await repository.claimNext({ workerId: "malformed-audit-worker", leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);
    const scope = { jobId: queued.id, ownerUserId, workerId: "malformed-audit-worker" };
    const job = await repository.loadExecutionPayload({
      workerId: scope.workerId,
      leaseSeconds: 30,
      claim: claim!
    });
    if (!job) throw new Error("Expected a claimed job for malformed audit rejection.");
    expect(await repository.markGenerating(scope)).toBe(true);
    expect(await repository.markValidating(scope)).toBe(true);
    expect(await repository.markCommitting(scope)).toBe(true);
    const story = storyTurnOutputSchema.parse({
      narration: "The malformed record must not become an accepted turn.",
      choices: ["Wait.", "Leave.", "Inspect the archive.", "Call the keeper."],
      custom_action_suggestion: "Study the archive seal.",
      scratchpad: "No turn was accepted.",
      tracker_updates: [],
      image_prompt: "A sealed archive.",
      continuity_summary: "The archive remains sealed.",
      canonical_facts: ["The archive remains sealed."],
      superseded_facts: [],
      canonical_fact_updates: [],
      open_threads: ["Determine why the archive rejected the record."]
    });
    const malformedAudit = {
      ...DEDICATED_CHUNKED_AUDIT,
      provider: { ...DEDICATED_CHUNKED_AUDIT.provider, resolutionSource: "none" }
    };

    await expect(repository.commitAcceptedTurn({
      scope,
      job,
      story,
      provider: {
        id: providerProfileId,
        name: "Execution repository provider",
        providerType: "openai_compatible",
        model: "execution-repository-model"
      },
      response: {
        content: JSON.stringify(story),
        responseId: crypto.randomUUID(),
        finishReason: "stop",
        outputLimited: false,
        modelInstanceId: "execution-repository-instance",
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        reportedCost: null,
        rawMetadata: {}
      },
      contextFingerprint: "malformed-audit-context-fingerprint",
      contextDiagnostics: { retrieval: { selectedMemoryCount: 0 } },
      chronicleRetrieval: malformedAudit,
      inputs: job.orchestration_inputs,
      orchestration: {},
      fictionAction: job.action,
      collaborators: {
        memory: memoryGeneration(pool),
        illustration: {
          enqueueAcceptedTurnIllustrationSegments: async () => []
        } as unknown as AcceptedGenerationCommitCollaborators["illustration"],
        attributeGenerationCostsToTurn: async () => undefined
      },
      onIllustrationEnqueueError: () => undefined
    } as unknown as Parameters<typeof repository.commitAcceptedTurn>[0])).rejects.toThrow();

    expect(await turnVersionSnapshot(imported.campaignId)).toEqual(earlierTurns);
  });

  it("does not overwrite attempt metadata after cancellation wins the row-lock race", async () => {
    const imported = await campaign();
    const queued = await queue(imported.campaignId, "Cancel the stale attempt recorder.");
    const repository = createPostgresGenerationExecutionRepository(pool);
    const claim = await repository.claimNext({ workerId: "cancelled-attempt-worker", leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);
    const scope = {
      jobId: queued.id,
      ownerUserId,
      workerId: "cancelled-attempt-worker"
    };
    await expect(repository.recordAttempt(attemptInput(scope))).resolves.toBeUndefined();
    const cancellation = await pool.connect();
    let settled = false;
    let attemptOutcome: Promise<{ status: "resolved" } | { status: "rejected"; error: unknown }> | undefined;
    try {
      await cancellation.query("BEGIN");
      const blockerPid = (await cancellation.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid"
      )).rows[0]!.pid;
      await cancellation.query(
        `UPDATE generation_jobs
            SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL
          WHERE id = $1 AND owner_user_id = $2`,
        [queued.id, ownerUserId]
      );
      attemptOutcome = repository.recordAttempt({
        ...attemptInput(scope),
        responseMetadata: { outputLimited: true },
        rawOutput: "Stale output that must not overwrite the admitted attempt."
      }).then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error })
      ).finally(() => { settled = true; });

      expect(await recordAttemptRaceState(() => settled, blockerPid)).toBe("blocked");
      await cancellation.query("COMMIT");
    } finally {
      await cancellation.query("ROLLBACK").catch(() => undefined);
      cancellation.release();
    }

    await expect(attemptOutcome).resolves.toMatchObject({
      status: "rejected",
      error: { code: "generation_cancelled" }
    });
    await expect(pool.query(
      "SELECT raw_output FROM generation_attempts WHERE generation_job_id = $1",
      [queued.id]
    )).resolves.toMatchObject({ rows: [{ raw_output: "A safe fictional response." }] });
  });

  it("rejects an expired attempt recorder before it writes private attempt data", async () => {
    const imported = await campaign();
    const queued = await queue(imported.campaignId, "Reclaim the stale attempt recorder.");
    const repository = createPostgresGenerationExecutionRepository(pool);
    const claim = await repository.claimNext({ workerId: "expired-attempt-worker", leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);
    const staleScope = {
      jobId: queued.id,
      ownerUserId,
      workerId: "expired-attempt-worker"
    };
    await expect(repository.markGenerating(staleScope)).resolves.toBe(true);
    await pool.query(
      "UPDATE generation_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [queued.id]
    );

    const reclaim = await pool.connect();
    let settled = false;
    let attemptOutcome: Promise<{ status: "resolved" } | { status: "rejected"; error: unknown }> | undefined;
    try {
      await reclaim.query("BEGIN");
      const blockerPid = (await reclaim.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid"
      )).rows[0]!.pid;
      const reclaimed = await reclaim.query<{ id: string }>(
        `UPDATE generation_jobs
            SET status = 'assessing', attempts = attempts + 1,
                lease_owner = 'replacement-attempt-worker',
                lease_expires_at = now() + interval '30 seconds'
          WHERE id = $1 AND owner_user_id = $2
            AND status = 'generating' AND lease_expires_at < now()
          RETURNING id`,
        [queued.id, ownerUserId]
      );
      expect(reclaimed.rows).toEqual([{ id: queued.id }]);
      attemptOutcome = repository.recordAttempt(attemptInput(staleScope)).then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error })
      ).finally(() => { settled = true; });

      expect(await recordAttemptRaceState(() => settled, blockerPid)).toBe("settled");
      await reclaim.query("COMMIT");
    } finally {
      await reclaim.query("ROLLBACK").catch(() => undefined);
      reclaim.release();
    }

    await expect(attemptOutcome).resolves.toMatchObject({
      status: "rejected",
      error: { code: "generation_cancelled" }
    });
    await expect(pool.query(
      "SELECT id FROM generation_attempts WHERE generation_job_id = $1",
      [queued.id]
    )).resolves.toMatchObject({ rows: [] });
  });

  it("accepts a supersession only for an active same-campaign fact rendered to the provider", async () => {
    const imported = await campaign();
    const { repository, scope, job } = await readyAcceptedCommit(imported.campaignId, "visible-fact-worker");
    const visibleFactId = await insertCanonicalFact({
      campaignId: imported.campaignId,
      worldVersionId: imported.worldVersionId,
      content: "The observatory is a lighthouse.",
      validFromTurn: 1
    });
    const before = await acceptedAndChronicleSnapshot(imported.campaignId);
    const story = supersedingStory([visibleFactId]);

    const committed = await repository.commitAcceptedTurn(acceptedCommitInput({
      scope,
      job,
      story,
      sentFactIds: [visibleFactId]
    }));

    const superseded = await pool.query<{
      valid_until_turn: number | null;
      superseded_by_fact_id: string | null;
    }>(
      `SELECT valid_until_turn,superseded_by_fact_id FROM campaign_canonical_facts
        WHERE owner_user_id=$1 AND campaign_id=$2 AND id=$3`,
      [ownerUserId, imported.campaignId, visibleFactId]
    );
    const after = await acceptedAndChronicleSnapshot(imported.campaignId);
    expect(committed.turnId).toEqual(expect.any(String));
    expect(superseded.rows).toEqual([{
      valid_until_turn: job.expected_turn_number,
      superseded_by_fact_id: expect.any(String)
    }]);
    expect(after.turns).toEqual([
      ...before.turns,
      expect.objectContaining({ id: committed.turnId, narration: story.narration })
    ]);
    expect(after.memories).toContainEqual(expect.objectContaining({
      memory_kind: "canonical_fact",
      content: expect.stringContaining("night refuge")
    }));
  });

  it.each([
    "omitted same-campaign fact",
    "foreign-owner fact",
    "other-campaign same-owner same-world fact",
    "other-world-version same-owner same-campaign fact",
    "future fact",
    "expired fact",
    "duplicate-content different-ID fact",
    "forged prompt fact ID"
  ])("rejects a %s without accepting a turn or mutating Chronicle", async (caseName) => {
    const imported = await campaign();
    const { repository, scope, job } = await readyAcceptedCommit(
      imported.campaignId,
      `rejected-fact-${caseName.replaceAll(/[^a-z]+/giu, "-")}`
    );
    const activeFactId = await insertCanonicalFact({
      campaignId: imported.campaignId,
      worldVersionId: imported.worldVersionId,
      content: "The observatory is a lighthouse.",
      validFromTurn: 1
    });
    let supersededFactId = activeFactId;
    let sentFactIds: readonly string[] | undefined = [activeFactId];
    const factScopes: Array<{ ownerUserId: string; campaignId: string }> = [{
      ownerUserId,
      campaignId: imported.campaignId
    }];

    if (caseName === "omitted same-campaign fact") {
      sentFactIds = undefined;
    } else if (caseName === "foreign-owner fact") {
      // The campaign/world-version composite foreign keys prohibit a foreign
      // owner on this campaign. Use a fully valid foreign-owned graph instead.
      const foreignFact = await foreignScopeFact();
      supersededFactId = foreignFact.id;
      factScopes.push({
        ownerUserId: foreignFact.ownerUserId,
        campaignId: foreignFact.campaignId
      });
      sentFactIds = [supersededFactId];
    } else if (caseName === "other-campaign same-owner same-world fact") {
      const otherCampaignId = await insertCampaignWithSourceTurn({
        ownerUserId,
        worldVersionId: imported.worldVersionId,
        title: "Canonical fact same-world campaign decoy"
      });
      supersededFactId = await insertCanonicalFact({
        campaignId: otherCampaignId,
        worldVersionId: imported.worldVersionId,
        content: "The other observatory is a lighthouse.",
        validFromTurn: 1
      });
      factScopes.push({ ownerUserId, campaignId: otherCampaignId });
      sentFactIds = [supersededFactId];
    } else if (caseName === "other-world-version same-owner same-campaign fact") {
      const otherWorldVersionId = await alternateWorldVersion(imported.worldVersionId);
      supersededFactId = await insertCanonicalFact({
        campaignId: imported.campaignId,
        worldVersionId: otherWorldVersionId,
        content: "The alternate observatory is a lighthouse.",
        validFromTurn: 1
      });
      sentFactIds = [supersededFactId];
    } else if (caseName === "future fact") {
      supersededFactId = await insertCanonicalFact({
        campaignId: imported.campaignId,
        worldVersionId: imported.worldVersionId,
        content: "The observatory will be a lighthouse.",
        validFromTurn: job.expected_turn_number
      });
      sentFactIds = [supersededFactId];
    } else if (caseName === "expired fact") {
      supersededFactId = await insertCanonicalFact({
        campaignId: imported.campaignId,
        worldVersionId: imported.worldVersionId,
        content: "The observatory was a lighthouse.",
        validFromTurn: 1,
        validUntilTurn: job.expected_turn_number - 1
      });
      sentFactIds = [supersededFactId];
    } else if (caseName === "duplicate-content different-ID fact") {
      supersededFactId = await insertCanonicalFact({
        campaignId: imported.campaignId,
        worldVersionId: imported.worldVersionId,
        content: "The observatory is a lighthouse.",
        validFromTurn: 1
      });
    } else if (caseName === "forged prompt fact ID") {
      supersededFactId = crypto.randomUUID();
    }

    const before = await acceptedAndChronicleSnapshot(imported.campaignId, factScopes);
    await expect(repository.commitAcceptedTurn(acceptedCommitInput({
      scope,
      job,
      story: supersedingStory([supersededFactId]),
      ...(sentFactIds ? { sentFactIds } : {})
    }))).rejects.toMatchObject({ code: "invalid_fact_supersession" });
    expect(await acceptedAndChronicleSnapshot(imported.campaignId, factScopes)).toEqual(before);
  });
});
