import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generationRequestSchema } from "../../packages/contracts/src/generation.js";
import { PROMPT_TEMPLATE_CATALOG, type PromptTemplateKey } from "../../packages/contracts/src/prompt-library.js";
import { createPostgresGenerationExecutionRepository } from "../../packages/database/src/generation-execution-repository.js";
import { createPostgresGenerationCommandRepository } from "../../packages/database/src/generation-repository.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { createGenerationExecutor, type GenerationExecutionCollaborators } from "../../services/runtime/src/generation-executor-adapter.js";
import { callTextProvider, type ProviderRequest } from "../../packages/story-engine/src/providers.js";
import { providerPromptProtocolVersion, createProvider, loadPromptSnapshotForTest, readTurnReportedCostsForTest } from "../helpers/provider-application-fixtures.js";
import { importLegacyStory } from "../helpers/memory-aware-services.js";
import { memoryGeneration } from "../helpers/memory-applications.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import type { StreamingIllustrationConfig } from "../../packages/application/src/illustration/types.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const credentialSecret = "story-only-choice-repair-secret";
const disabledIllustration: StreamingIllustrationConfig = {
  enabled: false, sourcePolicy: "off", matchingScope: "world", confidenceProfile: "balanced", repetitionWindow: 5,
  providerProfileId: null, model: "", size: "1024x1024", aspectRatio: "1:1", quality: "auto", outputFormat: "png",
  maxAttempts: 3, segmentWordCount: 500, imagesPerSegment: 1, segmentPromptMode: "direct", refinementPrompt: "disabled",
  defaultRefinementPrompt: "disabled", updatedAt: null, campaignImageProviderProfileId: null, campaignTextProviderProfileId: null
};

integration("Story Direction choice repair PostgreSQL workflow", () => {
  let pool: DatabasePool;
  let ownerUserId = "";
  let providerProfileId = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 6);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    providerProfileId = (await createProvider(pool, {
      name: `Story Direction choice repair ${crypto.randomUUID()}`, providerType: "openai_compatible", providerRole: "text",
      baseUrl: "http://127.0.0.1:9911", defaultModel: "story-only-choice-repair-model", contextWindowTokens: 32_768,
      maxOutputTokens: 4_096, temperature: 0, enabled: true, configuration: {}
    }, credentialSecret)).id;
  });

  afterAll(async () => { await pool.end(); });

  async function campaign() {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Story Direction choice repair ${crypto.randomUUID()}`;
    return importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "story-only-choice-repair.story", story: fixture }));
  }

  function commands() {
    return createPostgresGenerationCommandRepository(pool, {
      resolvePromptSnapshot: (client, scopeOwnerUserId, campaignId) => loadPromptSnapshotForTest(client, scopeOwnerUserId, campaignId),
      promptProtocolVersion: providerPromptProtocolVersion,
      readTurnReportedCosts: (scopeOwnerUserId, _campaignId, turnIds) => readTurnReportedCostsForTest(pool, scopeOwnerUserId, [...turnIds])
    });
  }

  function output(choices: unknown, suggestion = "Ask why the lantern is burning.") {
    return JSON.stringify({
      narration: "Rain turns the observatory glass silver as Mara opens the west door.", choices,
      custom_action_suggestion: suggestion, scratchpad: "Mara opened the west door.",
      tracker_updates: [{ name: "west door", value: "open" }], image_prompt: "Rainy moonlit observatory doorway.",
      continuity_summary: "Mara opened the west door in the rain.", canonical_facts: ["The west door is open."],
      superseded_facts: [], canonical_fact_updates: [], open_threads: ["Find the missing keeper."]
    });
  }

  function validRepair(extra: Record<string, unknown> = {}) {
    return JSON.stringify({
      choices: ["Enter the observatory.", "Call for the keeper.", "Study the wet threshold.", "Circle the tower."],
      custom_action_suggestion: "Ask why the lantern is burning.", ...extra
    });
  }

  function collaborators(
    responses: Array<{ content: string; outputLimited?: boolean; responseId?: string }>, operations: string[], requests: string[],
    limits: { contextWindowTokens: number; maxOutputTokens: number } = { contextWindowTokens: 32_768, maxOutputTokens: 4_096 },
    repairTransport?: { calls: number; responseFormatBodies?: string[] }
  ): GenerationExecutionCollaborators {
    const provider = {
      id: providerProfileId, name: "Synthetic choice-repair provider", providerRole: "text" as const,
      providerType: "openai_compatible" as const, model: "story-only-choice-repair-model", ...limits,
      baseUrl: "http://127.0.0.1:9911", temperature: 0, requestTimeoutMs: 1_000, configuration: {},
      execute: async (request: ProviderRequest) => {
        requests.push(String(request.input));
        if (repairTransport && requests.length === 2) {
          return callTextProvider(provider, request, {
            fetch: async (_profile, _operation, _url, init) => {
              repairTransport.calls += 1;
              repairTransport.responseFormatBodies?.push(String(init?.body));
              if (repairTransport.responseFormatBodies && repairTransport.calls === 1) {
                return new Response(JSON.stringify({ error: { message: "response_format unsupported" } }), { status: 400 });
              }
              return new Response(JSON.stringify({ choices: [{ message: { content: validRepair() }, finish_reason: "stop" }], id: "unexpected-repair-transport" }), { status: 200 });
            },
            validateSdkEndpoint: async () => undefined,
            close: async () => undefined
          });
        }
        const next = responses.shift();
        if (!next) throw new Error("unexpected synthetic provider dispatch");
        return { content: next.content, responseId: next.responseId ?? crypto.randomUUID(), finishReason: next.outputLimited ? "length" : "stop",
          outputLimited: next.outputLimited ?? false, modelInstanceId: "synthetic-choice-repair",
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, reportedCost: null, rawMetadata: {} };
      }
    };
    return {
      memory: memoryGeneration(pool, credentialSecret),
      illustration: { loadStreamingIllustrationConfig: async () => disabledIllustration, createProvisionalSet: async () => null,
        createProvisionalSegment: async () => false, promoteProvisionalSet: async () => undefined, orphanProvisionalSet: async () => undefined,
        enqueueAcceptedTurnIllustrationSegments: async () => null } as GenerationExecutionCollaborators["illustration"],
      loadTextExecution: async () => provider,
      promptFromSnapshot: (snapshot, key) => (snapshot as Record<string, { content?: string }> | undefined)?.[key as PromptTemplateKey]?.content
        ?? PROMPT_TEMPLATE_CATALOG[key].defaultContent,
      recordProfileCost: async (_database, _profile, attribution) => { operations.push(attribution.operation); return null; },
      attributeGenerationCostsToTurn: async () => undefined
    };
  }

  async function enqueue(campaignId: string) {
    await pool.query("UPDATE campaigns SET turn_control_style='flexible_scene' WHERE id=$1 AND owner_user_id=$2", [campaignId, ownerUserId]);
    return commands().enqueueAppend({ ownerUserId, campaignId }, generationRequestSchema.parse({
      action: "Set the rain-soaked observatory scene.", providerProfileId, idempotencyKey: crypto.randomUUID(),
      requestedInputMode: "scene", resolvedInputMode: "scene", inputModeSource: "explicit",
      context: { budgetTokens: 16_000, compression: "full", recentTurns: 8 }
    }));
  }

  async function execute(jobId: string, workerId: string, responses: Array<{ content: string; outputLimited?: boolean; responseId?: string }>, operations: string[], requests: string[]) {
    const repository = createPostgresGenerationExecutionRepository(pool);
    const claim = await repository.claimNext({ workerId, leaseSeconds: 30 });
    expect(claim?.jobId).toBe(jobId);
    const executor = createGenerationExecutor({ pool, repository, collaborators: collaborators(responses, operations, requests) });
    await expect(executor.execute({ workerId, leaseSeconds: 30, claim: claim! })).resolves.toBe(true);
    return repository;
  }

  async function campaignCounts(campaignId: string) {
    const result = await pool.query<{ turns: string; memories: string; jobs: string; state: unknown }>(
      `SELECT (SELECT count(*)::text FROM turns WHERE campaign_id=$1) AS turns,
              (SELECT count(*)::text FROM chronicle_memories WHERE campaign_id=$1) AS memories,
              (SELECT count(*)::text FROM chronicle_jobs WHERE campaign_id=$1) AS jobs,
              (SELECT to_jsonb(s) FROM campaign_state s WHERE campaign_id=$1) AS state`, [campaignId]);
    return result.rows[0]!;
  }

  async function seedCanonicalFact(campaignId: string) {
    const campaignRow = await pool.query<{ worldVersionId: string; turnId: string; turnNumber: number }>(
      `SELECT c.world_version_id AS "worldVersionId", t.id AS "turnId", t.turn_number AS "turnNumber"
         FROM campaigns c JOIN turns t ON t.campaign_id=c.id AND t.turn_number=c.active_turn_number
        WHERE c.id=$1 AND c.owner_user_id=$2`, [campaignId, ownerUserId]
    );
    const source = campaignRow.rows[0]!;
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO campaign_canonical_facts
         (id,owner_user_id,campaign_id,world_version_id,source_turn_id,source_turn_number,source_fact_index,content,normalized_content,valid_from_turn)
       VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,$6) RETURNING id`,
      [crypto.randomUUID(), ownerUserId, campaignId, source.worldVersionId, source.turnId, source.turnNumber,
        "The keeper's lantern burns above the west door.", "the keeper's lantern burns above the west door."]
    );
    return inserted.rows[0]!.id;
  }

  async function persistedValidatedRepair(workerId: string) {
    const imported = await campaign();
    const queued = await enqueue(imported.campaignId);
    const repository = createPostgresGenerationExecutionRepository(pool);
    const claim = await repository.claimNext({ workerId, leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);
    let interrupted = false;
    const interruptingRepository = { ...repository, saveOrchestration: async (scope: Parameters<typeof repository.saveOrchestration>[0], value: Parameters<typeof repository.saveOrchestration>[1]) => {
      const saved = await repository.saveOrchestration(scope, value);
      if (!interrupted && value.choiceRepair?.status === "validated") {
        interrupted = true;
        await pool.query("UPDATE generation_jobs SET status='recoverable', lease_owner=NULL, lease_expires_at=NULL WHERE id=$1", [queued.id]);
      }
      return saved;
    } };
    const initialOperations: string[] = [];
    const executor = createGenerationExecutor({ pool, repository: interruptingRepository, collaborators: collaborators(
      [{ content: output(["Enter.", "Enter.", "Wait.", "Speak."]) }, { content: validRepair() }], initialOperations, []
    ) });
    await expect(executor.execute({ workerId, leaseSeconds: 30, claim: claim! })).resolves.toBe(true);
    expect(initialOperations).toEqual(["story_generation", "story_choice_repair"]);
    const stored = await pool.query<{ orchestration: { choiceRepair: Record<string, unknown> } }>(
      "SELECT orchestration_private AS orchestration FROM generation_jobs WHERE id=$1", [queued.id]
    );
    return { imported, queued, repository, choiceRepair: stored.rows[0]!.orchestration.choiceRepair };
  }

  async function persistedPendingRepair(workerId: string) {
    const imported = await campaign();
    const before = await campaignCounts(imported.campaignId);
    const queued = await enqueue(imported.campaignId);
    const repository = createPostgresGenerationExecutionRepository(pool);
    const operations: string[] = [];
    await execute(queued.id, workerId, [
      { content: "{not valid JSON", responseId: "pending-recovery-rejected" },
      { content: output(["Enter the observatory.", " enter the observatory. ", "Wait beneath the eaves.", "Speak to the keeper."], "\uff33\uff50\uff45\uff41\uff4b\uff0e"), responseId: "pending-recovery-duplicate" }
    ], operations, []);
    expect(operations).toEqual(["story_generation", "story_recovery"]);
    const stored = await pool.query<{ orchestration: { choiceRepair: Record<string, unknown> } }>(
      "SELECT orchestration_private AS orchestration FROM generation_jobs WHERE id=$1", [queued.id]
    );
    expect(stored.rows[0]!.orchestration.choiceRepair.status).toBe("pending");
    return { imported, before, queued, repository, choiceRepair: stored.rows[0]!.orchestration.choiceRepair };
  }

  it("repairs duplicate choices once while preserving every non-choice field and original authority", async () => {
    const imported = await campaign();
    const sourceFactId = await seedCanonicalFact(imported.campaignId);
    const queued = await enqueue(imported.campaignId);
    const operations: string[] = [];
    const requests: string[] = [];
    const main = JSON.parse(output(["Enter.", "Enter.", "Wait.", "Speak."])) as Record<string, unknown>;
    main.canonical_facts = ["The keeper's lantern is dark above the west door."];
    main.superseded_facts = [];
    main.canonical_fact_updates = [{ content: "The keeper's lantern is dark above the west door.", supersedes_fact_ids: [sourceFactId] }];
    main.open_threads = ["Find the missing keeper.", "Learn why the lantern went dark."];
    await execute(queued.id, "choice-repair-main", [
      { content: JSON.stringify(main), responseId: "main-choice-repair-response" },
      { content: validRepair({
        choices: ["Enter beneath the dark lantern.", "Call for the keeper in the rain.", "Study the extinguished lantern.", "Circle the tower for another door."],
        custom_action_suggestion: "Trace why the keeper's lantern went dark."
      }), responseId: "repair-choice-repair-response" }
    ], operations, requests);

    expect(operations).toEqual(["story_generation", "story_choice_repair"]);
    expect(requests).toHaveLength(2);
    expect(requests[1]).not.toContain("scratchpad");
    expect(requests[1]).not.toContain("tracker_updates");
    expect(requests[1]).not.toContain("image_prompt");
    expect(requests[1]).not.toMatch(/roll|dice|check|stat|score|modifier|difficulty/iu);
    await expect(pool.query<{ narration: string; choices: string[]; suggestion: string; imagePrompt: string; state: unknown; response: string; metadata: { responseId?: string } }>(
      `SELECT t.narration,t.choices,t.custom_action_suggestion AS suggestion,t.image_prompt AS "imagePrompt",t.state_snapshot_private AS state,
              j.provider_response_id AS response,t.model_metadata AS metadata
         FROM generation_jobs j JOIN turns t ON t.id=j.result_turn_id WHERE j.id=$1`, [queued.id]
    )).resolves.toMatchObject({ rows: [{ narration: "Rain turns the observatory glass silver as Mara opens the west door.",
      choices: ["Enter beneath the dark lantern.", "Call for the keeper in the rain.", "Study the extinguished lantern.", "Circle the tower for another door."],
      suggestion: "Trace why the keeper's lantern went dark.", imagePrompt: "Rainy moonlit observatory doorway.",
      response: "main-choice-repair-response", metadata: { responseId: "main-choice-repair-response" },
      state: { scratchpad: "Mara opened the west door.", trackers: [{ name: "west door", value: "open" }],
        continuitySummary: "Mara opened the west door in the rain.",
        canonicalFacts: ["The keeper's lantern is dark above the west door."],
        supersededFacts: [],
        canonicalFactUpdates: [{ content: "The keeper's lantern is dark above the west door.", supersedesFactIds: [sourceFactId] }],
        openThreads: ["Find the missing keeper.", "Learn why the lantern went dark."] } }] });
    const sourceFact = await pool.query<{ content: string; valid_until_turn: number | null }>(
      "SELECT content,valid_until_turn FROM campaign_canonical_facts WHERE id=$1", [sourceFactId]
    );
    expect(sourceFact.rows).toEqual([{ content: "The keeper's lantern burns above the west door.", valid_until_turn: expect.any(Number) }]);
  }, 60_000);

  it.each([
    ["malformed JSON", "{not valid JSON"],
    ["schema-invalid output", JSON.stringify({ narration: "The observatory door opens beneath the rain." })],
    ["mechanics-bearing output", JSON.stringify({
      ...JSON.parse(output(["Enter the observatory.", "Call for the keeper.", "Study the threshold.", "Circle the tower."])),
      narration: "Mara rolls a die before opening the observatory door."
    })],
    ["output-limited normalized duplicate choices", "{not-valid-json", true],
    ["three recovered choices", "{not-valid-json", false, output(["Enter.", "Wait.", "Speak."])],
    ["missing recovered choices", "{not-valid-json", false, output(undefined)],
    ["empty recovered suggestion", "{not-valid-json", false, output(["Enter.", "Wait.", "Speak.", "Observe."], "")],
    ["mechanics in recovered choices", "{not-valid-json", false, output(["Roll a d20.", "Wait.", "Speak.", "Observe."])],
    ["output-limited three recovered choices", "{not-valid-json", true, output(["Enter.", "Wait.", "Speak."])]
  ])("keeps a recovered Story Direction draft pending when %s leaves invalid choices", async (_caseName, rejected, recoveredOutputLimited = false, recoveredContent?: string) => {
    const imported = await campaign();
    const sourceFactId = await seedCanonicalFact(imported.campaignId);
    const before = await campaignCounts(imported.campaignId);
    const queued = await enqueue(imported.campaignId);
    const operations: string[] = [];
    const requests: string[] = [];
    const duplicateRecovered = recoveredContent ?? output([
      "Enter the observatory.",
      " enter the observatory. ",
      "Wait beneath the eaves.",
      "Speak to the keeper."
    ], "\uff33\uff50\uff45\uff41\uff4b\uff0e");

    await execute(queued.id, `choice-repair-generic-${crypto.randomUUID()}`, [
      { content: rejected, responseId: "generic-recovery-rejected" },
      { content: duplicateRecovered, responseId: "generic-recovery-duplicate", outputLimited: recoveredOutputLimited }
    ], operations, requests);

    expect(operations).toEqual(["story_generation", "story_recovery"]);
    expect(requests).toHaveLength(2);
    expect(await campaignCounts(imported.campaignId)).toEqual(before);
    const saved = await pool.query<{
      status: string;
      errorCode: string | null;
      resultTurnId: string | null;
      policy: { playMode?: string; turnControlStyle?: string };
      orchestration: { choiceRepair?: Record<string, unknown> };
    }>(`SELECT status,error_code AS "errorCode",result_turn_id AS "resultTurnId",
                 generation_policy AS policy,orchestration_private AS orchestration
          FROM generation_jobs WHERE id=$1`, [queued.id]);
    expect(saved.rows).toMatchObject([{
      status: "recoverable", errorCode: "invalid_schema", resultTurnId: null,
      policy: { playMode: "story_only", turnControlStyle: "flexible_scene" },
      orchestration: { choiceRepair: {
        status: "pending", originalResponse: { responseId: "generic-recovery-duplicate" },
        base: { narration: "Rain turns the observatory glass silver as Mara opens the west door." }
      } }
    }]);
    const pendingCheckpoint = saved.rows[0]!.orchestration.choiceRepair!;
    expect(pendingCheckpoint.originalRequestBody).not.toBe("");
    expect(pendingCheckpoint.originalRequestPayloadHash).toEqual(expect.any(String));
    expect(pendingCheckpoint.originalSentFactIds).toEqual([sourceFactId]);

    await commands().retry({ ownerUserId, jobId: queued.id });
    const retryOperations: string[] = [];
    const retryRequests: string[] = [];
    await execute(queued.id, `choice-repair-generic-retry-${crypto.randomUUID()}`, [
      { content: validRepair(), responseId: "generic-recovery-choice-repair" }
    ], retryOperations, retryRequests);
    await expect(pool.query("SELECT status,error_code FROM generation_jobs WHERE id=$1", [queued.id]))
      .resolves.toMatchObject({ rows: [{ status: "completed", error_code: null }] });
    expect(retryOperations).toEqual(["story_choice_repair"]);
    expect(retryRequests).toHaveLength(1);
    await expect(pool.query<{ status: string; resultTurnId: string; responseId: string; narration: string; facts: string[]; orchestration: { choiceRepair: Record<string, unknown> } }>(
      `SELECT j.status,j.result_turn_id AS "resultTurnId",j.provider_response_id AS "responseId",
              t.narration,
              (SELECT coalesce(jsonb_agg(f.content ORDER BY f.source_fact_index), '[]'::jsonb)
                 FROM campaign_canonical_facts f WHERE f.source_turn_id=t.id) AS facts,
              j.orchestration_private AS orchestration
         FROM generation_jobs j JOIN turns t ON t.id=j.result_turn_id WHERE j.id=$1`, [queued.id]
    )).resolves.toMatchObject({ rows: [{ status: "completed", resultTurnId: expect.any(String),
      responseId: "generic-recovery-duplicate", narration: "Rain turns the observatory glass silver as Mara opens the west door.",
      facts: ["The west door is open."] }] });
    const acceptedCheckpoint = (await pool.query<{ orchestration: { choiceRepair: Record<string, unknown> } }>(
      "SELECT orchestration_private AS orchestration FROM generation_jobs WHERE id=$1", [queued.id]
    )).rows[0]!.orchestration.choiceRepair;
    expect(acceptedCheckpoint).toMatchObject({
      originalRequestBody: pendingCheckpoint.originalRequestBody,
      originalRequestPayloadHash: pendingCheckpoint.originalRequestPayloadHash,
      originalSentFactIds: pendingCheckpoint.originalSentFactIds,
      originalResponse: pendingCheckpoint.originalResponse
    });
  }, 60_000);

  it("does not let a pending recovered choice repair dispatch on lease reclaim before an explicit retry", async () => {
    const fixture = await persistedPendingRepair("choice-repair-pending-reclaim-a");
    await pool.query(
      "UPDATE generation_jobs SET status='queued',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",
      [fixture.queued.id]
    );
    const reclaimed = await fixture.repository.claimNext({ workerId: "choice-repair-pending-reclaim-b", leaseSeconds: 30 });
    expect(reclaimed?.jobId).toBe(fixture.queued.id);
    const operations: string[] = [];
    const requests: string[] = [];
    await expect(createGenerationExecutor({ pool, repository: fixture.repository, collaborators: collaborators([], operations, requests) })
      .execute({ workerId: "choice-repair-pending-reclaim-b", leaseSeconds: 30, claim: reclaimed! })).resolves.toBe(true);
    expect(operations).toEqual([]);
    expect(requests).toEqual([]);
    expect(await campaignCounts(fixture.imported.campaignId)).toEqual(fixture.before);
    await expect(pool.query("SELECT status,error_code,result_turn_id FROM generation_jobs WHERE id=$1", [fixture.queued.id]))
      .resolves.toMatchObject({ rows: [{ status: "recoverable", error_code: "automatic_repair_consumed", result_turn_id: null }] });
  }, 60_000);

  it("fails closed when a pending recovered choice-repair checkpoint is tampered", async () => {
    const fixture = await persistedPendingRepair("choice-repair-pending-tamper-a");
    const tampered = structuredClone(fixture.choiceRepair);
    (tampered.base as Record<string, unknown>).narration = "Tampered recovered narration.";
    await pool.query("UPDATE generation_jobs SET orchestration_private=$2::jsonb WHERE id=$1", [fixture.queued.id, JSON.stringify({ choiceRepair: tampered })]);
    await commands().retry({ ownerUserId, jobId: fixture.queued.id });
    const claimed = await fixture.repository.claimNext({ workerId: "choice-repair-pending-tamper-b", leaseSeconds: 30 });
    expect(claimed?.jobId).toBe(fixture.queued.id);
    const operations: string[] = [];
    const requests: string[] = [];
    await expect(createGenerationExecutor({ pool, repository: fixture.repository, collaborators: collaborators([], operations, requests) })
      .execute({ workerId: "choice-repair-pending-tamper-b", leaseSeconds: 30, claim: claimed! })).resolves.toBe(true);
    expect(operations).toEqual([]);
    expect(requests).toEqual([]);
    expect(await campaignCounts(fixture.imported.campaignId)).toEqual(fixture.before);
    await expect(pool.query("SELECT status,error_code,result_turn_id FROM generation_jobs WHERE id=$1", [fixture.queued.id]))
      .resolves.toMatchObject({ rows: [{ status: "recoverable", error_code: "generation_checkpoint_incompatible", result_turn_id: null }] });
  }, 60_000);

  it("fails closed when a pending recovered choice-repair checkpoint is malformed", async () => {
    const fixture = await persistedPendingRepair("choice-repair-pending-malformed-a");
    const malformed = structuredClone(fixture.choiceRepair);
    malformed.repairRequestPayloadHash = "";
    await pool.query("UPDATE generation_jobs SET orchestration_private=$2::jsonb WHERE id=$1", [fixture.queued.id, JSON.stringify({ choiceRepair: malformed })]);
    await commands().retry({ ownerUserId, jobId: fixture.queued.id });
    const claimed = await fixture.repository.claimNext({ workerId: "choice-repair-pending-malformed-b", leaseSeconds: 30 });
    expect(claimed?.jobId).toBe(fixture.queued.id);
    const operations: string[] = [];
    const requests: string[] = [];
    await expect(createGenerationExecutor({ pool, repository: fixture.repository, collaborators: collaborators([], operations, requests) })
      .execute({ workerId: "choice-repair-pending-malformed-b", leaseSeconds: 30, claim: claimed! })).resolves.toBe(false);
    expect(operations).toEqual([]);
    expect(requests).toEqual([]);
    expect(await campaignCounts(fixture.imported.campaignId)).toEqual(fixture.before);
    await expect(pool.query("SELECT status,error_code,result_turn_id FROM generation_jobs WHERE id=$1", [fixture.queued.id]))
      .resolves.toMatchObject({ rows: [{ status: "recoverable", error_code: "generation_checkpoint_incompatible", result_turn_id: null }] });
  }, 60_000);

  it("fails an oversized protected choice-repair request before repair transport or authoritative writes", async () => {
    const imported = await campaign();
    const before = await campaignCounts(imported.campaignId);
    const queued = await enqueue(imported.campaignId);
    const oversized = JSON.parse(output(["Enter.", "Enter.", "Wait.", "Speak."])) as Record<string, unknown>;
    oversized.narration = "🕯️".repeat(2_000);
    const operations: string[] = [];
    const requests: string[] = [];
    const repairTransport = { calls: 0 };
    const repository = createPostgresGenerationExecutionRepository(pool);
    const claim = await repository.claimNext({ workerId: "choice-repair-oversized", leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);
    const executor = createGenerationExecutor({ pool, repository, collaborators: collaborators(
      [{ content: JSON.stringify(oversized) }], operations, requests,
      { contextWindowTokens: 9_000, maxOutputTokens: 4_096 }, repairTransport
    ) });
    await expect(executor.execute({ workerId: "choice-repair-oversized", leaseSeconds: 30, claim: claim! })).resolves.toBe(true);
    expect(operations).toEqual(["story_generation"]);
    expect(requests).toHaveLength(2);
    expect(repairTransport.calls).toBe(0);
    expect(await campaignCounts(imported.campaignId)).toEqual(before);
    await expect(pool.query("SELECT status,error_code,result_turn_id FROM generation_jobs WHERE id=$1", [queued.id]))
      .resolves.toMatchObject({ rows: [{ status: "recoverable", error_code: "context_budget_exceeded", result_turn_id: null }] });
  }, 60_000);

  it("keeps turn, Chronicle, and campaign state unchanged when a strict repair carries extra fields", async () => {
    const imported = await campaign();
    const before = await campaignCounts(imported.campaignId);
    const queued = await enqueue(imported.campaignId);
    const operations: string[] = [];
    await execute(queued.id, "choice-repair-extra", [{ content: output(["Enter.", "Enter.", "Wait.", "Speak."]) }, { content: validRepair({ narration: "malicious replacement" }) }], operations, []);
    const after = await campaignCounts(imported.campaignId);
    expect(operations).toEqual(["story_generation", "story_choice_repair"]);
    expect(after).toEqual(before);
    await expect(pool.query("SELECT status,error_code,result_turn_id FROM generation_jobs WHERE id=$1", [queued.id]))
      .resolves.toMatchObject({ rows: [{ status: "recoverable", error_code: "invalid_schema", result_turn_id: null }] });
  }, 60_000);

  it("uses commands.retry after output-limited Story Direction output and never accepts a limited duplicate-choice draft", async () => {
    const imported = await campaign();
    const first = await enqueue(imported.campaignId);
    await execute(first.id, "choice-repair-limited-main", [{ content: output(["Enter.", "Enter.", "Wait.", "Speak."]), outputLimited: true }], [], []);
    await expect(pool.query("SELECT status,error_code,result_turn_id FROM generation_jobs WHERE id=$1", [first.id]))
      .resolves.toMatchObject({ rows: [{ status: "recoverable", error_code: "output_limit", result_turn_id: null }] });
    await commands().retry({ ownerUserId, jobId: first.id });
    await execute(first.id, "choice-repair-limited-main-retry", [{ content: output(["Enter.", "Listen.", "Wait.", "Speak."]) }], [], []);
    const second = await enqueue(imported.campaignId);
    await execute(second.id, "choice-repair-limited-repair", [{ content: output(["Enter.", "Enter.", "Wait.", "Speak."]) }, { content: validRepair(), outputLimited: true }], [], []);
    await expect(pool.query("SELECT id,status,error_code,result_turn_id FROM generation_jobs WHERE id = ANY($1::uuid[]) ORDER BY id", [[first.id, second.id]]))
      .resolves.toMatchObject({ rows: expect.arrayContaining([
        expect.objectContaining({ id: first.id, status: "completed", error_code: null, result_turn_id: expect.any(String) }),
        expect.objectContaining({ id: second.id, status: "recoverable", error_code: "invalid_schema", result_turn_id: null })
      ]) });
  }, 60_000);

  it("reclaims a saved valid choice repair after a lease crash without any provider dispatch", async () => {
    const imported = await campaign();
    const queued = await enqueue(imported.campaignId);
    const repository = createPostgresGenerationExecutionRepository(pool);
    const firstClaim = await repository.claimNext({ workerId: "choice-repair-crash-a", leaseSeconds: 30 });
    expect(firstClaim?.jobId).toBe(queued.id);
    let expired = false;
    const expiringRepository = { ...repository, saveOrchestration: async (scope: Parameters<typeof repository.saveOrchestration>[0], value: Parameters<typeof repository.saveOrchestration>[1]) => {
      const saved = await repository.saveOrchestration(scope, value);
      if (!expired && value.choiceRepair?.status === "validated") {
        expired = true;
        await pool.query("UPDATE generation_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [queued.id]);
      }
      return saved;
    } };
    const firstOperations: string[] = [];
    const firstExecutor = createGenerationExecutor({ pool, repository: expiringRepository, collaborators: collaborators(
      [{ content: output(["Enter.", "Enter.", "Wait.", "Speak."]) }, { content: validRepair() }], firstOperations, []
    ) });
    await expect(firstExecutor.execute({ workerId: "choice-repair-crash-a", leaseSeconds: 30, claim: firstClaim! })).resolves.toBe(true);
    expect(firstOperations).toEqual(["story_generation", "story_choice_repair"]);
    const reclaimed = await repository.claimNext({ workerId: "choice-repair-crash-b", leaseSeconds: 30 });
    expect(reclaimed?.jobId).toBe(queued.id);
    const secondOperations: string[] = [];
    const secondRequests: string[] = [];
    const secondExecutor = createGenerationExecutor({ pool, repository, collaborators: collaborators([], secondOperations, secondRequests) });
    await expect(secondExecutor.execute({ workerId: "choice-repair-crash-b", leaseSeconds: 30, claim: reclaimed! })).resolves.toBe(true);
    expect(secondOperations).toEqual([]);
    expect(secondRequests).toEqual([]);
    await expect(pool.query("SELECT status,result_turn_id FROM generation_jobs WHERE id=$1", [queued.id]))
      .resolves.toMatchObject({ rows: [{ status: "completed", result_turn_id: expect.any(String) }] });
  }, 60_000);

  it.each(["lease", "retry"] as const)("persists the actual response-format fallback repair body and resumes it after %s recovery without dispatch", async (recovery) => {
    const imported = await campaign();
    const queued = await enqueue(imported.campaignId);
    const repository = createPostgresGenerationExecutionRepository(pool);
    const firstClaim = await repository.claimNext({ workerId: "choice-repair-fallback-a", leaseSeconds: 30 });
    expect(firstClaim?.jobId).toBe(queued.id);
    let interrupted = false;
    const interruptingRepository = { ...repository, saveOrchestration: async (scope: Parameters<typeof repository.saveOrchestration>[0], value: Parameters<typeof repository.saveOrchestration>[1]) => {
      const saved = await repository.saveOrchestration(scope, value);
      if (!interrupted && value.choiceRepair?.status === "validated") {
        interrupted = true;
        if (recovery === "lease") {
          await pool.query("UPDATE generation_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [queued.id]);
        } else {
          await pool.query("UPDATE generation_jobs SET status='recoverable', lease_owner=NULL, lease_expires_at=NULL WHERE id=$1", [queued.id]);
        }
      }
      return saved;
    } };
    const wire = { calls: 0, responseFormatBodies: [] as string[] };
    const initial = createGenerationExecutor({ pool, repository: interruptingRepository, collaborators: collaborators(
      [{ content: output(["Enter.", "Enter.", "Wait.", "Speak."]), responseId: "fallback-main-response" }], [], [], undefined, wire
    ) });
    await expect(initial.execute({ workerId: "choice-repair-fallback-a", leaseSeconds: 30, claim: firstClaim! })).resolves.toBe(true);
    expect(wire.calls).toBe(2);
    expect(wire.responseFormatBodies[0]).toContain("response_format");
    expect(wire.responseFormatBodies[1]).not.toContain("response_format");
    const stored = await pool.query<{ repair: { repairRequestBody: string; repairRequestPayloadHash: string; repairResponseFormat: string } }>(
      "SELECT orchestration_private->'choiceRepair' AS repair FROM generation_jobs WHERE id=$1", [queued.id]
    );
    expect(stored.rows[0]!.repair).toMatchObject({ repairRequestBody: wire.responseFormatBodies[1], repairResponseFormat: "none" });
    expect(stored.rows[0]!.repair.repairRequestPayloadHash).toBe(createHash("sha256").update(wire.responseFormatBodies[1]!).digest("hex"));
    if (recovery === "retry") {
      await commands().retry({ ownerUserId, jobId: queued.id });
    }
    const reclaimed = await repository.claimNext({ workerId: "choice-repair-fallback-b", leaseSeconds: 30 });
    expect(reclaimed?.jobId).toBe(queued.id);
    const operations: string[] = [];
    const requests: string[] = [];
    await expect(createGenerationExecutor({ pool, repository, collaborators: collaborators([], operations, requests) })
      .execute({ workerId: "choice-repair-fallback-b", leaseSeconds: 30, claim: reclaimed! })).resolves.toBe(true);
    expect(operations).toEqual([]);
    expect(requests).toEqual([]);
    await expect(pool.query<{ status: string; response: string | null }>(
      "SELECT j.status,j.provider_response_id AS response FROM generation_jobs j WHERE j.id=$1", [queued.id]
    )).resolves.toMatchObject({ rows: [{ status: "completed", response: "fallback-main-response" }] });
  }, 60_000);

  it("fails closed on a tampered choice-repair checkpoint before main dispatch", async () => {
    const imported = await campaign();
    const queued = await enqueue(imported.campaignId);
    await pool.query("UPDATE generation_jobs SET orchestration_private=$2::jsonb WHERE id=$1", [queued.id, JSON.stringify({ choiceRepair: { version: 1, status: "validated" } })]);
    const operations: string[] = [];
    const repository = createPostgresGenerationExecutionRepository(pool);
    const claim = await repository.claimNext({ workerId: "choice-repair-tamper", leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);
    const requests: string[] = [];
    const executor = createGenerationExecutor({ pool, repository, collaborators: collaborators([{ content: output([]) }], operations, requests) });
    await expect(executor.execute({ workerId: "choice-repair-tamper", leaseSeconds: 30, claim: claim! })).resolves.toBe(false);
    expect(operations).toEqual([]);
    expect(requests).toEqual([]);
    await expect(pool.query("SELECT status,error_code FROM generation_jobs WHERE id=$1", [queued.id]))
      .resolves.toMatchObject({ rows: [{ status: "recoverable", error_code: "generation_checkpoint_incompatible" }] });
  }, 60_000);

  it("uses commands.retry to commit a saved valid choice repair without consuming another provider quota", async () => {
    const imported = await campaign();
    const queued = await enqueue(imported.campaignId);
    const repository = createPostgresGenerationExecutionRepository(pool);
    const firstClaim = await repository.claimNext({ workerId: "choice-repair-retry-a", leaseSeconds: 30 });
    expect(firstClaim?.jobId).toBe(queued.id);
    let expired = false;
    const interruptingRepository = { ...repository, saveOrchestration: async (scope: Parameters<typeof repository.saveOrchestration>[0], value: Parameters<typeof repository.saveOrchestration>[1]) => {
      const saved = await repository.saveOrchestration(scope, value);
      if (!expired && value.choiceRepair?.status === "validated") {
        expired = true;
        await pool.query("UPDATE generation_jobs SET status='recoverable', lease_owner=NULL, lease_expires_at=NULL WHERE id=$1", [queued.id]);
      }
      return saved;
    } };
    const initialOperations: string[] = [];
    const initialExecutor = createGenerationExecutor({ pool, repository: interruptingRepository, collaborators: collaborators(
      [{ content: output(["Enter.", "Enter.", "Wait.", "Speak."]) }, { content: validRepair() }], initialOperations, []
    ) });
    await expect(initialExecutor.execute({ workerId: "choice-repair-retry-a", leaseSeconds: 30, claim: firstClaim! })).resolves.toBe(true);
    expect(initialOperations).toEqual(["story_generation", "story_choice_repair"]);
    await commands().retry({ ownerUserId, jobId: queued.id });
    const resumedOperations: string[] = [];
    const resumedRequests: string[] = [];
    const resumedClaim = await repository.claimNext({ workerId: "choice-repair-retry-b", leaseSeconds: 30 });
    expect(resumedClaim?.jobId).toBe(queued.id);
    const resumedExecutor = createGenerationExecutor({ pool, repository, collaborators: collaborators([], resumedOperations, resumedRequests) });
    await expect(resumedExecutor.execute({ workerId: "choice-repair-retry-b", leaseSeconds: 30, claim: resumedClaim! })).resolves.toBe(true);
    expect(resumedOperations).toEqual([]);
    expect(resumedRequests).toEqual([]);
    await expect(pool.query("SELECT status,result_turn_id FROM generation_jobs WHERE id=$1", [queued.id]))
      .resolves.toMatchObject({ rows: [{ status: "completed", result_turn_id: expect.any(String) }] });
  }, 60_000);

  it("fails closed for each independently tampered field of a real validated choice-repair checkpoint", async () => {
    const cases: Array<{ name: string; mutate: (repair: Record<string, unknown>) => void }> = [
      { name: "originalSentFactIds", mutate: (repair) => { repair.originalSentFactIds = ["invented-fact-id"]; } },
      { name: "base", mutate: (repair) => { (repair.base as Record<string, unknown>).narration = "Tampered base narration."; } },
      { name: "result", mutate: (repair) => { (repair.fields as Record<string, unknown>).choices = ["One.", "Two.", "Three.", "Four."]; } },
      { name: "request", mutate: (repair) => { repair.repairRequestPayloadHash = "tampered-repair-request-hash"; } },
      { name: "request body", mutate: (repair) => { repair.repairRequestBody = "{}"; repair.repairRequestPayloadHash = createHash("sha256").update("{}").digest("hex"); } },
      { name: "request variant", mutate: (repair) => { repair.repairResponseFormat = "none"; } },
      { name: "policy", mutate: (repair) => { repair.policyIdentity = "tampered-policy-identity"; } },
      { name: "response", mutate: (repair) => {
        const response = repair.originalResponse as Record<string, unknown>;
        const content = JSON.parse(String(response.content)) as Record<string, unknown>;
        content.narration = "Tampered original response narration.";
        response.content = JSON.stringify(content);
      } }
    ];
    for (const entry of cases) {
      const fixture = await persistedValidatedRepair(`choice-repair-tamper-seed-${entry.name}`);
      const repair = structuredClone(fixture.choiceRepair);
      entry.mutate(repair);
      const before = await campaignCounts(fixture.imported.campaignId);
      await pool.query("UPDATE generation_jobs SET orchestration_private=$2::jsonb WHERE id=$1", [fixture.queued.id, JSON.stringify({ choiceRepair: repair })]);
      await commands().retry({ ownerUserId, jobId: fixture.queued.id });
      const requests: string[] = [];
      const operations: string[] = [];
      const claim = await fixture.repository.claimNext({ workerId: `choice-repair-tamper-run-${entry.name}`, leaseSeconds: 30 });
      expect(claim?.jobId, entry.name).toBe(fixture.queued.id);
      const executor = createGenerationExecutor({ pool, repository: fixture.repository, collaborators: collaborators([], operations, requests) });
      await expect(executor.execute({ workerId: `choice-repair-tamper-run-${entry.name}`, leaseSeconds: 30, claim: claim! }), entry.name).resolves.toBe(true);
      expect(operations, entry.name).toEqual([]);
      expect(requests, entry.name).toEqual([]);
      expect(await campaignCounts(fixture.imported.campaignId), entry.name).toEqual(before);
      await expect(pool.query("SELECT status,error_code,result_turn_id FROM generation_jobs WHERE id=$1", [fixture.queued.id]), entry.name)
        .resolves.toMatchObject({ rows: [{ status: "recoverable", error_code: "generation_checkpoint_incompatible", result_turn_id: null }] });
    }
  }, 120_000);

  it("does not redispatch main or repair after a crash with only the dispatched choice-repair checkpoint", async () => {
    const imported = await campaign();
    const queued = await enqueue(imported.campaignId);
    const repository = createPostgresGenerationExecutionRepository(pool);
    const firstClaim = await repository.claimNext({ workerId: "choice-repair-dispatched-a", leaseSeconds: 30 });
    expect(firstClaim?.jobId).toBe(queued.id);
    let interrupted = false;
    const crashingRepository = { ...repository, saveOrchestration: async (scope: Parameters<typeof repository.saveOrchestration>[0], value: Parameters<typeof repository.saveOrchestration>[1]) => {
      const saved = await repository.saveOrchestration(scope, value);
      if (!interrupted && value.choiceRepair?.status === "dispatched") {
        interrupted = true;
        await pool.query("UPDATE generation_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [queued.id]);
      }
      return saved;
    } };
    const firstOperations: string[] = [];
    const firstExecutor = createGenerationExecutor({ pool, repository: crashingRepository, collaborators: collaborators(
      [{ content: output(["Enter.", "Enter.", "Wait.", "Speak."]) }, { content: validRepair() }], firstOperations, []
    ) });
    await expect(firstExecutor.execute({ workerId: "choice-repair-dispatched-a", leaseSeconds: 30, claim: firstClaim! })).resolves.toBe(true);
    expect(firstOperations).toEqual(["story_generation", "story_choice_repair"]);
    const before = await campaignCounts(imported.campaignId);
    const reclaimed = await repository.claimNext({ workerId: "choice-repair-dispatched-b", leaseSeconds: 30 });
    expect(reclaimed?.jobId).toBe(queued.id);
    const requests: string[] = [];
    const operations: string[] = [];
    const reclaimer = createGenerationExecutor({ pool, repository, collaborators: collaborators([], operations, requests) });
    await expect(reclaimer.execute({ workerId: "choice-repair-dispatched-b", leaseSeconds: 30, claim: reclaimed! })).resolves.toBe(true);
    expect(operations).toEqual([]);
    expect(requests).toEqual([]);
    expect(await campaignCounts(imported.campaignId)).toEqual(before);
    await expect(pool.query("SELECT status,error_code,result_turn_id FROM generation_jobs WHERE id=$1", [queued.id]))
      .resolves.toMatchObject({ rows: [{ status: "recoverable", error_code: "automatic_repair_consumed", result_turn_id: null }] });
    await commands().retry({ ownerUserId, jobId: queued.id });
    const retried = await repository.claimNext({ workerId: "choice-repair-dispatched-c", leaseSeconds: 30 });
    expect(retried?.jobId).toBe(queued.id);
    const retryRequests: string[] = [];
    const retryOperations: string[] = [];
    const retryExecutor = createGenerationExecutor({ pool, repository, collaborators: collaborators([], retryOperations, retryRequests) });
    await expect(retryExecutor.execute({ workerId: "choice-repair-dispatched-c", leaseSeconds: 30, claim: retried! })).resolves.toBe(true);
    expect(retryOperations).toEqual([]);
    expect(retryRequests).toEqual([]);
    expect(await campaignCounts(imported.campaignId)).toEqual(before);
    await expect(pool.query("SELECT status,error_code,result_turn_id FROM generation_jobs WHERE id=$1", [queued.id]))
      .resolves.toMatchObject({ rows: [{ status: "recoverable", error_code: "automatic_repair_consumed", result_turn_id: null }] });
  }, 60_000);
});
