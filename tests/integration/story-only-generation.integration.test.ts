import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generationRequestSchema, generationRetryLatestRequestSchema } from "../../packages/contracts/src/generation.js";
import { generationPolicySnapshotSchema } from "../../packages/contracts/src/campaign-generation-policy.js";
import { PROMPT_TEMPLATE_CATALOG, type PromptTemplateKey } from "../../packages/contracts/src/prompt-library.js";
import { createPostgresGenerationExecutionRepository } from "../../packages/database/src/generation-execution-repository.js";
import { createPostgresGenerationCommandRepository } from "../../packages/database/src/generation-repository.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { createGenerationExecutor, type GenerationExecutionCollaborators } from "../../services/runtime/src/generation-executor-adapter.js";
import { providerPromptProtocolVersion, createProvider, loadPromptSnapshotForTest, readTurnReportedCostsForTest } from "../helpers/provider-application-fixtures.js";
import { importLegacyStory } from "../helpers/memory-aware-services.js";
import { memoryGeneration } from "../helpers/memory-applications.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { DEDICATED_CHUNKED_AUDIT } from "../fixtures/chronicle-retrieval-audits.js";
import type { StreamingIllustrationConfig } from "../../packages/application/src/illustration/types.js";
import { createStoryOnlyFixture, runStoryOnlyFixture } from "../helpers/story-only-generation-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const credentialSecret = "story-only-composed-generation-secret";
const disabledStreamingIllustrationConfig: StreamingIllustrationConfig = {
  enabled: false, sourcePolicy: "off", matchingScope: "world", confidenceProfile: "balanced", repetitionWindow: 5,
  providerProfileId: null, model: "", size: "1024x1024", aspectRatio: "1:1", quality: "auto", outputFormat: "png",
  maxAttempts: 3, segmentWordCount: 500, imagesPerSegment: 1, segmentPromptMode: "direct", refinementPrompt: "disabled",
  defaultRefinementPrompt: "disabled", updatedAt: null, campaignImageProviderProfileId: null, campaignTextProviderProfileId: null
};

integration("Story Direction composed PostgreSQL generation", () => {
  let pool: DatabasePool;
  let ownerUserId = "";
  let providerProfileId = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 6);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    providerProfileId = (await createProvider(pool, {
      name: `Story Direction composed ${crypto.randomUUID()}`,
      providerType: "openai_compatible", providerRole: "text", baseUrl: "http://127.0.0.1:9911",
      defaultModel: "story-only-composed-model", contextWindowTokens: 32_768, maxOutputTokens: 4_096,
      temperature: 0, enabled: true, configuration: {}
    }, credentialSecret)).id;
  });

  afterAll(async () => { await pool.end(); });

  it.each([
    ["clean", ["story_generation"], true],
    ["events_configured", ["story_generation"], true],
    ["choice_repair", ["story_generation", "story_choice_repair"], true],
    ["invalid_narration", ["story_generation", "story_recovery"], false],
    ["output_limited", ["story_generation"], false],
    ["lease_reclaim", ["story_generation"], true]
  ] as const)("runs the %s benchmark fixture against an owned dedicated child database", async (scenario, operations, committed) => {
    const fixture = await createStoryOnlyFixture({ playMode: "story_only", scenario });
    try {
      const result = await runStoryOnlyFixture(fixture);
      expect(result.operations).toEqual(operations);
      expect(result.committed).toBe(committed);
      if (scenario === "events_configured") {
        expect(JSON.parse(result.afterState).state.pending_event_triggers)
          .toEqual(JSON.parse(result.beforeState).state.pending_event_triggers);
      }
      if (scenario === "invalid_narration" || scenario === "output_limited") {
        expect(result.failures).toBe(0);
        expect(result.committed).toBe(false);
      }
      if (scenario === "lease_reclaim") expect(JSON.parse(result.afterState).turns).toHaveLength(2);
    } finally {
      await fixture.close();
    }
  }, 60_000);

  it.each([
    ["legacy_action", ["story_generation"]],
    ["legacy_scene", ["story_generation", "scene_coverage_validation"]],
    ["legacy_events", ["event_trigger_before", "story_generation"]]
  ] as const)("captures the actual %s comparison operation sequence", async (playMode, operations) => {
    const fixture = await createStoryOnlyFixture({ playMode, scenario: "clean" });
    try {
      const result = await runStoryOnlyFixture(fixture);
      expect(result.committed).toBe(true);
      expect(result.operations).toEqual(operations);
      expect(result.failures).toBe(0);
    } finally {
      await fixture.close();
    }
  }, 60_000);

  async function campaign() {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Story Direction composed ${crypto.randomUUID()}`;
    return importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "story-only-composed.story", story: fixture }));
  }

  function commands() {
    return createPostgresGenerationCommandRepository(pool, {
      resolvePromptSnapshot: (client, scopeOwnerUserId, campaignId) => loadPromptSnapshotForTest(client, scopeOwnerUserId, campaignId),
      promptProtocolVersion: providerPromptProtocolVersion,
      readTurnReportedCosts: (scopeOwnerUserId, _campaignId, turnIds) => readTurnReportedCostsForTest(pool, scopeOwnerUserId, [...turnIds])
    });
  }

  function story() {
    return JSON.stringify({
      narration: "Rain turns the observatory glass silver as Mara opens the west door.",
      choices: ["Enter the observatory.", "Call for the keeper.", "Study the wet threshold.", "Circle the tower."],
      custom_action_suggestion: "Ask why the lantern is burning.", scratchpad: "Mara opened the west door.",
      tracker_updates: [{ name: "west door", value: "open" }], image_prompt: "Rainy moonlit observatory doorway.",
      continuity_summary: "Mara opened the west door in the rain.", canonical_facts: ["The west door is open."],
      superseded_facts: [], canonical_fact_updates: [], open_threads: ["Find the missing keeper."]
    });
  }

  function collaborators(operations: string[], requests: string[], imageEnqueues: { count: number }, imageFailure = false, beforeResponse?: () => Promise<void>, systemPrompts?: string[]): GenerationExecutionCollaborators {
    const provider = {
      id: providerProfileId, name: "Synthetic story-only provider", providerRole: "text" as const,
      providerType: "openai_compatible" as const, model: "story-only-composed-model", contextWindowTokens: 32_768,
      maxOutputTokens: 4_096, temperature: 0, requestTimeoutMs: 1_000, configuration: {},
      execute: async (request: { input?: string; systemPrompt?: string }) => {
        requests.push(String(request.input));
        systemPrompts?.push(String(request.systemPrompt));
        await beforeResponse?.();
        return { content: story(), responseId: crypto.randomUUID(), finishReason: "stop", outputLimited: false,
          modelInstanceId: "synthetic-story-only", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, reportedCost: null, rawMetadata: {} };
      }
    };
    return {
      memory: memoryGeneration(pool, credentialSecret),
      illustration: {
        loadStreamingIllustrationConfig: async () => disabledStreamingIllustrationConfig,
        createProvisionalSet: async () => null,
        createProvisionalSegment: async () => false,
        promoteProvisionalSet: async () => undefined,
        orphanProvisionalSet: async () => undefined,
        enqueueAcceptedTurnIllustrationSegments: async () => {
          imageEnqueues.count += 1;
          if (imageFailure) throw new Error("synthetic illustration endpoint unavailable");
          return null;
        }
      } as GenerationExecutionCollaborators["illustration"],
      loadTextExecution: async () => provider,
      promptFromSnapshot: (snapshot, key) => {
        const entry = (snapshot as Record<string, { content?: string }> | undefined)?.[key as PromptTemplateKey];
        return entry?.content ?? PROMPT_TEMPLATE_CATALOG[key].defaultContent;
      },
      recordProfileCost: async (_database, _profile, attribution) => {
        operations.push(attribution.operation);
        return null;
      },
      attributeGenerationCostsToTurn: async () => undefined
    };
  }

  async function enqueueStoryOnly(campaignId: string) {
    await pool.query("UPDATE campaigns SET turn_control_style='flexible_scene' WHERE id=$1 AND owner_user_id=$2", [campaignId, ownerUserId]);
    return commands().enqueueAppend({ ownerUserId, campaignId }, generationRequestSchema.parse({
      action: "Set the rain-soaked observatory scene.", providerProfileId, idempotencyKey: crypto.randomUUID(),
      requestedInputMode: "scene", resolvedInputMode: "scene", inputModeSource: "explicit",
      context: { budgetTokens: 16_000, compression: "full", recentTurns: 8 }
    }));
  }

  async function enqueueStoryOnlyReplacement(campaignId: string, expectedCurrentTurnNumber: number) {
    await pool.query("UPDATE campaigns SET turn_control_style='flexible_scene' WHERE id=$1 AND owner_user_id=$2", [campaignId, ownerUserId]);
    return commands().enqueueReplacement({ ownerUserId, campaignId }, generationRetryLatestRequestSchema.parse({
      action: "Replace the rain-soaked observatory scene.", providerProfileId, idempotencyKey: crypto.randomUUID(),
      expectedCurrentTurnNumber, requestedInputMode: "scene", resolvedInputMode: "scene", inputModeSource: "explicit",
      context: { budgetTokens: 16_000, compression: "full", recentTurns: 8 }
    }));
  }

  it("uses one story operation, preserves dormant mechanics, and commits scoped fiction when illustration enqueue fails", async () => {
    const primary = await campaign();
    const foreign = await campaign();
    const mechanics = {
      rpgStats: [{ id: "courage", name: "Courage", value: 43, note: "PRIVATE_STAT_CANARY" }],
      eventTriggers: [
        { id: "before", label: "Before omen", timing: "before", condition: "PRIVATE_BEFORE_CANARY", effect: "A bell waits.", addTextAfter: false, triggeredCount: 0, lastTriggeredTurn: null, lastTriggeredAt: null },
        { id: "after", label: "After omen", timing: "after", condition: "PRIVATE_AFTER_CANARY", effect: "The lantern fades.", addTextAfter: true, triggeredCount: 0, lastTriggeredTurn: null, lastTriggeredAt: null }
      ],
      pending: [{ id: "pending", sourceTriggerId: "before", name: "Pending omen", timing: "before", condition: "", effect: "", instructions: "PRIVATE_PENDING_CANARY", reason: "awaiting fiction", sourceTurn: 1 }]
    };
    await pool.query(
      `UPDATE campaign_state SET rpg_stats=$2::jsonb,event_triggers=$3::jsonb,pending_event_triggers=$4::jsonb
        WHERE campaign_id=$1 AND owner_user_id=$5`,
      [primary.campaignId, JSON.stringify(mechanics.rpgStats), JSON.stringify(mechanics.eventTriggers), JSON.stringify(mechanics.pending), ownerUserId]
    );
    const foreignBefore = await pool.query("SELECT to_jsonb(campaign_state) AS state FROM campaign_state WHERE campaign_id=$1", [foreign.campaignId]);
    const queued = await enqueueStoryOnly(primary.campaignId);
    const repository = createPostgresGenerationExecutionRepository(pool);
    const firstClaim = await repository.claimNext({ workerId: "story-only-composed-worker", leaseSeconds: 30 });
    expect(firstClaim?.jobId).toBe(queued.id);
    expect(await repository.claimNext({ workerId: "competing-story-only-worker", leaseSeconds: 30 })).toBeNull();
    const operations: string[] = [];
    const requests: string[] = [];
    const imageEnqueues = { count: 0 };
    const executor = createGenerationExecutor({ pool, repository, collaborators: collaborators(operations, requests, imageEnqueues, true) });

    await expect(executor.execute({ workerId: "story-only-composed-worker", leaseSeconds: 30, claim: firstClaim! })).resolves.toBe(true);

    expect(operations).toEqual(["story_generation"]);
    expect(requests).toHaveLength(1);
    expect(imageEnqueues.count).toBe(1);
    expect(requests[0]).not.toContain("PRIVATE_STAT_CANARY");
    expect(requests[0]).not.toContain("PRIVATE_BEFORE_CANARY");
    expect(requests[0]).not.toContain("PRIVATE_AFTER_CANARY");
    expect(requests[0]).not.toContain("PRIVATE_PENDING_CANARY");
    expect(requests[0]).not.toContain("rpg_stats");
    const accepted = await pool.query<{
      narration: string; choices: unknown; generation_policy: { playMode?: string } | null;
      model_metadata: { generationPolicy?: { playMode?: string } } | null; private: { rpgStats?: unknown; eventTriggers?: unknown; pendingEventTriggers?: unknown };
    }>(`SELECT t.narration,t.choices,t.generation_policy,t.model_metadata,t.state_snapshot_private AS private FROM generation_jobs j
          JOIN turns t ON t.id=j.result_turn_id AND t.owner_user_id=j.owner_user_id
         WHERE j.campaign_id=$1 AND j.id=$2`, [primary.campaignId, queued.id]);
    expect(accepted.rows).toHaveLength(1);
    expect(accepted.rows[0]).toMatchObject({ narration: expect.stringContaining("observatory glass"), choices: expect.any(Array),
      generation_policy: { playMode: "story_only" }, model_metadata: { generationPolicy: { playMode: "story_only" } },
      private: { rpgStats: mechanics.rpgStats, eventTriggers: mechanics.eventTriggers, pendingEventTriggers: mechanics.pending } });
    expect((accepted.rows[0]?.choices as unknown[])).toHaveLength(4);
    await expect(pool.query("SELECT rpg_stats,event_triggers,pending_event_triggers FROM campaign_state WHERE campaign_id=$1", [primary.campaignId]))
      .resolves.toMatchObject({ rows: [{ rpg_stats: mechanics.rpgStats, event_triggers: mechanics.eventTriggers, pending_event_triggers: mechanics.pending }] });
    await expect(pool.query("SELECT to_jsonb(campaign_state) AS state FROM campaign_state WHERE campaign_id=$1", [foreign.campaignId]))
      .resolves.toEqual(foreignBefore);
    await expect(pool.query("SELECT status FROM generation_jobs WHERE id=$1", [queued.id])).resolves.toMatchObject({ rows: [{ status: "completed" }] });
  }, 60_000);

  it("replaces a Story-only turn from corrected continuity without changing dormant mechanics or other turns", async () => {
    const imported = await campaign();
    const target = await pool.query<{ id: string; turn_number: number }>(
      "SELECT id,turn_number FROM turns WHERE campaign_id=$1 ORDER BY turn_number DESC LIMIT 1", [imported.campaignId]
    );
    const replacementTarget = target.rows[0]!;
    const baseTurnNumber = replacementTarget.turn_number - 1;
    const factId = crypto.randomUUID();
    const mechanics = {
      rpgStats: [{ id: "composure", name: "Composure", value: 47, note: "REPLACEMENT_PRIVATE_STAT" }],
      eventTriggers: [{ id: "replacement-before", label: "Replacement omen", timing: "before", condition: "REPLACEMENT_PRIVATE_EVENT", effect: "A bell waits.", addTextAfter: false, triggeredCount: 0, lastTriggeredTurn: null, lastTriggeredAt: null }],
      pending: [{ id: "replacement-pending", sourceTriggerId: "replacement-before", name: "Pending replacement omen", timing: "before", condition: "", effect: "", instructions: "REPLACEMENT_PRIVATE_PENDING", reason: "awaiting fiction", sourceTurn: 1 }]
    };
    const corrected = {
      continuitySummary: "CORRECTED_CONTINUITY: the keeper already extinguished the west lantern.",
      scratchpad: "Corrected observatory continuity.",
      openThreads: ["Explain the extinguished lantern."],
      canonicalFacts: [{ id: factId, content: "CORRECTED_CANON: the west lantern is extinguished." }],
      trackers: [{ id: "lantern", name: "West lantern", value: "extinguished" }],
      rpgStats: mechanics.rpgStats,
      eventTriggers: mechanics.eventTriggers,
      pendingEventTriggers: mechanics.pending
    };
    await pool.query(
      `UPDATE campaign_state SET rpg_stats=$2::jsonb,event_triggers=$3::jsonb,pending_event_triggers=$4::jsonb
        WHERE campaign_id=$1 AND owner_user_id=$5`,
      [imported.campaignId, JSON.stringify(mechanics.rpgStats), JSON.stringify(mechanics.eventTriggers), JSON.stringify(mechanics.pending), ownerUserId]
    );
    const dormantBefore = await pool.query<{ rpgStats: string; eventTriggers: string; pendingEventTriggers: string }>(
      `SELECT rpg_stats::text AS "rpgStats",event_triggers::text AS "eventTriggers",pending_event_triggers::text AS "pendingEventTriggers"
         FROM campaign_state WHERE campaign_id=$1 AND owner_user_id=$2`, [imported.campaignId, ownerUserId]
    );
    await pool.query(
      `INSERT INTO campaign_state_edits (owner_user_id,campaign_id,effective_turn_number,revision,state_snapshot_private,changed_fields)
       VALUES ($1,$2,$3,1,$4::jsonb,$5::jsonb)`,
      [ownerUserId, imported.campaignId, baseTurnNumber, JSON.stringify(corrected), JSON.stringify(["continuitySummary", "canonicalFacts", "rpgStats", "eventTriggers", "pendingEventTriggers"])]
    );
    const turnsBefore = await pool.query<{ id: string; turn_number: number; row: unknown }>(
      "SELECT id,turn_number,to_jsonb(turn_row) AS row FROM turns turn_row WHERE campaign_id=$1 ORDER BY turn_number,id", [imported.campaignId]
    );
    const queued = await enqueueStoryOnlyReplacement(imported.campaignId, replacementTarget.turn_number);
    const queuedPolicy = (await pool.query<{ generation_policy: unknown }>(
      "SELECT generation_policy FROM generation_jobs WHERE id=$1", [queued.id]
    )).rows[0]!.generation_policy;
    const repository = createPostgresGenerationExecutionRepository(pool);
    const claim = await repository.claimNext({ workerId: "story-only-replacement-worker", leaseSeconds: 30 });
    expect(claim).toMatchObject({ jobId: queued.id, operationKind: "replace_latest" });
    const operations: string[] = [];
    const requests: string[] = [];
    const systemPrompts: string[] = [];
    const executor = createGenerationExecutor({ pool, repository, collaborators: collaborators(operations, requests, { count: 0 }, false, undefined, systemPrompts) });

    await expect(executor.execute({ workerId: "story-only-replacement-worker", leaseSeconds: 30, claim: claim! })).resolves.toBe(true);

    expect(operations).toEqual(["story_generation"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain(corrected.continuitySummary);
    expect(requests[0]).toContain(factId);
    expect(requests[0]).toContain(corrected.canonicalFacts[0]!.content);
    expect(requests[0]).not.toContain("REPLACEMENT_PRIVATE_STAT");
    expect(requests[0]).not.toContain("REPLACEMENT_PRIVATE_EVENT");
    expect(requests[0]).not.toContain("REPLACEMENT_PRIVATE_PENDING");
    await expect(pool.query<{ rpgStats: string; eventTriggers: string; pendingEventTriggers: string }>(
      `SELECT rpg_stats::text AS "rpgStats",event_triggers::text AS "eventTriggers",pending_event_triggers::text AS "pendingEventTriggers"
         FROM campaign_state WHERE campaign_id=$1 AND owner_user_id=$2`, [imported.campaignId, ownerUserId]
    )).resolves.toEqual(dormantBefore);
    const turnsAfter = await pool.query<{ id: string; turn_number: number; row: unknown }>(
      "SELECT id,turn_number,to_jsonb(turn_row) AS row FROM turns turn_row WHERE campaign_id=$1 ORDER BY turn_number,id", [imported.campaignId]
    );
    expect(turnsAfter.rows).toHaveLength(turnsBefore.rows.length);
    expect(turnsAfter.rows.filter((turn) => turn.turn_number !== replacementTarget.turn_number))
      .toEqual(turnsBefore.rows.filter((turn) => turn.turn_number !== replacementTarget.turn_number));
    const acceptedReplacement = await pool.query<{ id: string; generation_policy: unknown }>(
      `SELECT t.id,t.generation_policy FROM generation_jobs j JOIN turns t ON t.id=j.result_turn_id
        WHERE j.id=$1 AND j.campaign_id=$2`, [queued.id, imported.campaignId]
    );
    expect(acceptedReplacement.rows).toHaveLength(1);
    expect(acceptedReplacement.rows[0]!.id).not.toBe(replacementTarget.id);
    expect(acceptedReplacement.rows[0]!.generation_policy).toEqual(queuedPolicy);
  }, 60_000);

  it("executes a queued Story-only policy after the campaign setting changes before claim", async () => {
    const imported = await campaign();
    const queued = await enqueueStoryOnly(imported.campaignId);
    const queuedPolicy = generationPolicySnapshotSchema.parse((await pool.query<{ generation_policy: unknown }>(
      "SELECT generation_policy FROM generation_jobs WHERE id=$1", [queued.id]
    )).rows[0]!.generation_policy);
    expect(queuedPolicy).toMatchObject({
      playMode: "story_only", turnControlStyle: "flexible_scene", protocolVersion: "story-only-v1"
    });
    if (queuedPolicy.playMode !== "story_only") throw new Error("Expected the queued policy to be Story-only.");
    expect(queuedPolicy.prompts.systemSupplement).not.toBe("");
    await pool.query(
      `UPDATE campaign_state SET event_triggers=$2::jsonb WHERE campaign_id=$1 AND owner_user_id=$3`,
      [imported.campaignId, JSON.stringify([{
        id: "frozen-policy-before", label: "Frozen policy omen", timing: "before", condition: "always evaluate",
        effect: "A bell waits.", addTextAfter: false, triggeredCount: 0, lastTriggeredTurn: null, lastTriggeredAt: null
      }]), ownerUserId]
    );
    await pool.query("UPDATE campaigns SET turn_control_style='flexible_action' WHERE id=$1 AND owner_user_id=$2", [imported.campaignId, ownerUserId]);
    const repository = createPostgresGenerationExecutionRepository(pool);
    const claim = await repository.claimNext({ workerId: "story-only-policy-race-worker", leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);
    const operations: string[] = [];
    const requests: string[] = [];
    const systemPrompts: string[] = [];
    const executor = createGenerationExecutor({ pool, repository, collaborators: collaborators(operations, requests, { count: 0 }, false, undefined, systemPrompts) });

    await expect(executor.execute({ workerId: "story-only-policy-race-worker", leaseSeconds: 30, claim: claim! })).resolves.toBe(true);

    expect(operations).toEqual(["story_generation"]);
    expect(requests).toHaveLength(1);
    expect(systemPrompts).toHaveLength(1);
    expect(systemPrompts[0]).toContain(queuedPolicy.prompts.systemSupplement);
    const acceptedPolicy = await pool.query<{ generation_policy: unknown }>(
      `SELECT t.generation_policy FROM generation_jobs j JOIN turns t ON t.id=j.result_turn_id WHERE j.id=$1`, [queued.id]
    );
    expect(acceptedPolicy.rows[0]!.generation_policy).toEqual(queuedPolicy);
  }, 60_000);

  it("does not expose or mutate foreign-owner and foreign-campaign canaries during Story-only execution", async () => {
    const selected = await campaign();
    const foreignOwner = (await pool.query<{ id: string }>(
      "INSERT INTO users (display_name) VALUES ($1) RETURNING id", [`Story-only foreign owner ${crypto.randomUUID()}`]
    )).rows[0]!.id;
    const foreignWorld = (await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id,title) VALUES ($1,$2) RETURNING id", [foreignOwner, "Story-only foreign world"]
    )).rows[0]!.id;
    const foreignVersion = (await pool.query<{ id: string }>(
      "INSERT INTO world_versions (world_id,owner_user_id,version_number,content) VALUES ($1,$2,1,$3::jsonb) RETURNING id",
      [foreignWorld, foreignOwner, JSON.stringify({ world: { title: "Story-only foreign world", rules: "" }, entities: [] })]
    )).rows[0]!.id;
    const foreignCampaign = (await pool.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id,world_version_id,title) VALUES ($1,$2,$3) RETURNING id", [foreignOwner, foreignVersion, "Story-only foreign campaign"]
    )).rows[0]!.id;
    await pool.query(
      "INSERT INTO campaign_state (campaign_id,owner_user_id,scratchpad_private,trackers) VALUES ($1,$2,$3,$4::jsonb)",
      [foreignCampaign, foreignOwner, "FOREIGN_STATE_CANARY", JSON.stringify([{ id: "foreign", name: "Foreign state", value: "FOREIGN_STATE_CANARY" }])]
    );
    const foreignTurn = (await pool.query<{ id: string }>(
      "INSERT INTO turns (owner_user_id,campaign_id,turn_number,narration) VALUES ($1,$2,1,$3) RETURNING id", [foreignOwner, foreignCampaign, "FOREIGN_TURN_CANARY"]
    )).rows[0]!.id;
    await pool.query("UPDATE campaigns SET active_turn_number=1 WHERE id=$1 AND owner_user_id=$2", [foreignCampaign, foreignOwner]);
    await pool.query(
      `INSERT INTO chronicle_memories (owner_user_id,campaign_id,world_version_id,turn_id,memory_kind,ordinal,content,token_estimate)
       VALUES ($1,$2,$3,$4,'campaign_summary',1,'FOREIGN_CHRONICLE_CANARY',4)`, [foreignOwner, foreignCampaign, foreignVersion, foreignTurn]
    );
    await pool.query(
      `INSERT INTO campaign_canonical_facts
       (id,owner_user_id,campaign_id,world_version_id,source_turn_id,source_turn_number,source_fact_index,content,normalized_content,valid_from_turn)
       VALUES ($1,$2,$3,$4,$5,1,0,'FOREIGN_CANONICAL_CANARY','foreign_canonical_canary',1)`,
      [crypto.randomUUID(), foreignOwner, foreignCampaign, foreignVersion, foreignTurn]
    );
    const foreignBefore = await pool.query<{ state: unknown; memories: unknown; facts: unknown }>(
      `SELECT (SELECT to_jsonb(state_row) FROM campaign_state state_row WHERE campaign_id=$1) AS state,
              (SELECT jsonb_agg(to_jsonb(memory_row) ORDER BY id) FROM chronicle_memories memory_row WHERE campaign_id=$1) AS memories,
              (SELECT jsonb_agg(to_jsonb(fact_row) ORDER BY id) FROM campaign_canonical_facts fact_row WHERE campaign_id=$1) AS facts`, [foreignCampaign]
    );
    const queued = await enqueueStoryOnly(selected.campaignId);
    const repository = createPostgresGenerationExecutionRepository(pool);
    const claim = await repository.claimNext({ workerId: "story-only-owner-isolation-worker", leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);
    const operations: string[] = [];
    const requests: string[] = [];
    const systemPrompts: string[] = [];
    const executor = createGenerationExecutor({ pool, repository, collaborators: collaborators(operations, requests, { count: 0 }, false, undefined, systemPrompts) });

    await expect(executor.execute({ workerId: "story-only-owner-isolation-worker", leaseSeconds: 30, claim: claim! })).resolves.toBe(true);

    expect(operations).toEqual(["story_generation"]);
    expect(requests).toHaveLength(1);
    expect(systemPrompts).toHaveLength(1);
    for (const canary of ["FOREIGN_STATE_CANARY", "FOREIGN_CHRONICLE_CANARY", "FOREIGN_CANONICAL_CANARY"]) {
      expect(requests[0]).not.toContain(canary);
      expect(systemPrompts[0]).not.toContain(canary);
    }
    await expect(pool.query<{ state: unknown; memories: unknown; facts: unknown }>(
      `SELECT (SELECT to_jsonb(state_row) FROM campaign_state state_row WHERE campaign_id=$1) AS state,
              (SELECT jsonb_agg(to_jsonb(memory_row) ORDER BY id) FROM chronicle_memories memory_row WHERE campaign_id=$1) AS memories,
              (SELECT jsonb_agg(to_jsonb(fact_row) ORDER BY id) FROM campaign_canonical_facts fact_row WHERE campaign_id=$1) AS facts`, [foreignCampaign]
    )).resolves.toEqual(foreignBefore);
  }, 60_000);

  it("rejects an incompatible dormant mechanics checkpoint before any provider dispatch", async () => {
    const imported = await campaign();
    const queued = await enqueueStoryOnly(imported.campaignId);
    await pool.query("UPDATE generation_jobs SET orchestration_private=$2::jsonb WHERE id=$1", [queued.id, JSON.stringify({ beforeEvents: [{ id: "old-event" }] })]);
    const repository = createPostgresGenerationExecutionRepository(pool);
    const claim = await repository.claimNext({ workerId: "story-only-checkpoint-worker", leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);
    const operations: string[] = [];
    const executor = createGenerationExecutor({ pool, repository, collaborators: collaborators(operations, [], { count: 0 }) });
    await expect(executor.execute({ workerId: "story-only-checkpoint-worker", leaseSeconds: 30, claim: claim! })).resolves.toBe(true);
    expect(operations).toEqual([]);
    await expect(pool.query<{ status: string; error_code: string | null }>("SELECT status,error_code FROM generation_jobs WHERE id=$1", [queued.id]))
      .resolves.toMatchObject({ rows: [{ status: "recoverable", error_code: "generation_checkpoint_incompatible" }] });
  }, 60_000);

  it("cannot accept a cancelled in-flight Story Direction lease", async () => {
    const imported = await campaign();
    const before = await pool.query<{ state: unknown; turns: unknown }>(
      `SELECT (SELECT to_jsonb(state_row) FROM campaign_state state_row WHERE campaign_id=$1) AS state,
              (SELECT jsonb_agg(to_jsonb(turn_row) ORDER BY turn_number,id) FROM turns turn_row WHERE campaign_id=$1) AS turns`,
      [imported.campaignId]
    );
    const queued = await enqueueStoryOnly(imported.campaignId);
    const repository = createPostgresGenerationExecutionRepository(pool);
    const claim = await repository.claimNext({ workerId: "story-only-cancel-worker", leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);
    let started!: () => void;
    let release!: () => void;
    const providerStarted = new Promise<void>((resolve) => { started = resolve; });
    const providerRelease = new Promise<void>((resolve) => { release = resolve; });
    const executor = createGenerationExecutor({
      pool, repository,
      collaborators: collaborators([], [], { count: 0 }, false, async () => { started(); await providerRelease; })
    });
    const executing = executor.execute({ workerId: "story-only-cancel-worker", leaseSeconds: 30, claim: claim! });
    await providerStarted;
    await commands().cancel({ ownerUserId, jobId: queued.id });
    release();
    await expect(executing).resolves.toBe(true);
    await expect(pool.query<{ status: string; result_turn_id: string | null }>(
      "SELECT status,result_turn_id FROM generation_jobs WHERE id=$1", [queued.id]
    )).resolves.toMatchObject({ rows: [{ status: "cancelled", result_turn_id: null }] });
    await expect(pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM generation_jobs WHERE campaign_id=$1 AND result_turn_id IS NOT NULL", [imported.campaignId]
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });
    await expect(pool.query<{ state: unknown; turns: unknown }>(
      `SELECT (SELECT to_jsonb(state_row) FROM campaign_state state_row WHERE campaign_id=$1) AS state,
              (SELECT jsonb_agg(to_jsonb(turn_row) ORDER BY turn_number,id) FROM turns turn_row WHERE campaign_id=$1) AS turns`,
      [imported.campaignId]
    )).resolves.toEqual(before);
  }, 60_000);

  it("reclaims a saved Story Direction draft without a second narration dispatch", async () => {
    const imported = await campaign();
    const turnsBefore = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM turns WHERE campaign_id=$1", [imported.campaignId]);
    const queued = await enqueueStoryOnly(imported.campaignId);
    const repository = createPostgresGenerationExecutionRepository(pool);
    const firstClaim = await repository.claimNext({ workerId: "story-only-draft-worker-a", leaseSeconds: 30 });
    expect(firstClaim?.jobId).toBe(queued.id);
    let expired = false;
    const firstRepository = {
      ...repository,
      saveOrchestration: async (scope: Parameters<typeof repository.saveOrchestration>[0], value: Parameters<typeof repository.saveOrchestration>[1]) => {
        const saved = await repository.saveOrchestration(scope, value);
        if (!expired && value.validatedMainDraft) {
          expired = true;
          await pool.query("UPDATE generation_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [queued.id]);
        }
        return saved;
      }
    };
    const operations: string[] = [];
    const firstExecutor = createGenerationExecutor({ pool, repository: firstRepository, collaborators: collaborators(operations, [], { count: 0 }) });
    await expect(firstExecutor.execute({ workerId: "story-only-draft-worker-a", leaseSeconds: 30, claim: firstClaim! })).resolves.toBe(true);
    expect(operations).toEqual(["story_generation"]);
    const reclaimed = await repository.claimNext({ workerId: "story-only-draft-worker-b", leaseSeconds: 30 });
    expect(reclaimed?.jobId).toBe(queued.id);
    const secondExecutor = createGenerationExecutor({ pool, repository, collaborators: collaborators(operations, [], { count: 0 }) });
    await expect(secondExecutor.execute({ workerId: "story-only-draft-worker-b", leaseSeconds: 30, claim: reclaimed! })).resolves.toBe(true);
    expect(operations).toEqual(["story_generation"]);
    await expect(pool.query<{ count: string; narration: string; response: string | null; expected: number; turn: number }>(
      `SELECT (SELECT count(*)::text FROM turns WHERE campaign_id=j.campaign_id) AS count,t.narration,
              j.provider_response_id AS response,j.expected_turn_number AS expected,t.turn_number AS turn
         FROM generation_jobs j JOIN turns t ON t.id=j.result_turn_id WHERE j.id=$1`, [queued.id]
    )).resolves.toMatchObject({ rows: [{ count: String(Number(turnsBefore.rows[0]!.count) + 1),
      narration: "Rain turns the observatory glass silver as Mara opens the west door.", response: expect.any(String), expected: 3, turn: 3 }] });
  }, 60_000);

  it("fences duplicate executors to one accepted Story Direction turn", async () => {
    const imported = await campaign();
    const turnsBefore = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM turns WHERE campaign_id=$1", [imported.campaignId]);
    const queued = await enqueueStoryOnly(imported.campaignId);
    const repository = createPostgresGenerationExecutionRepository(pool);
    const claim = await repository.claimNext({ workerId: "story-only-duplicate-worker", leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);
    let started!: () => void;
    let release!: () => void;
    const providerStarted = new Promise<void>((resolve) => { started = resolve; });
    const providerRelease = new Promise<void>((resolve) => { release = resolve; });
    const operations: string[] = [];
    const executor = createGenerationExecutor({
      pool, repository,
      collaborators: collaborators(operations, [], { count: 0 }, false, async () => { started(); await providerRelease; })
    });
    const first = executor.execute({ workerId: "story-only-duplicate-worker", leaseSeconds: 30, claim: claim! });
    await providerStarted;
    const second = executor.execute({ workerId: "story-only-duplicate-worker", leaseSeconds: 30, claim: claim! });
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([true, false]);
    expect(operations).toEqual(["story_generation"]);
    await expect(pool.query<{ count: string; expected: number; turn: number }>(
      `SELECT (SELECT count(*)::text FROM turns WHERE campaign_id=j.campaign_id) AS count,
              j.expected_turn_number AS expected,t.turn_number AS turn
         FROM generation_jobs j JOIN turns t ON t.id=j.result_turn_id WHERE j.id=$1`, [queued.id]
    )).resolves.toMatchObject({ rows: [{ count: String(Number(turnsBefore.rows[0]!.count) + 1), expected: 3, turn: 3 }] });
  }, 60_000);
});
