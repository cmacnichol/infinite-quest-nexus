import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { createDatabasePool, initialOwnerId, withTransaction, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { resolveGenerationAuthoritySnapshot } from "../../packages/database/src/generation-authority.js";
import { loadPostgresChronicleGenerationAuthorityContext } from "../../packages/database/src/chronicle-generation-context.js";
import { planGenerationPromptContext } from "../../services/runtime/src/generation-context-planner.js";
import { estimateContinuityReviewPlanningTokens, prepareContinuityReview } from "../../services/runtime/src/story-continuity-review-adapter.js";
import { bindManifestToProducingRequest } from "../../packages/application/src/memory/continuity-review-checkpoint.js";
import { generationEvidenceManifestSchema } from "../../packages/application/src/memory/generation-context.js";
import { defaultStoryMemoryPolicy, storyMemoryPolicyHash, storyMemoryPolicySchema } from "../../packages/contracts/src/story-memory-policy.js";
import { CAST_STORY_MEMORY_PROMPT_PROTOCOL_VERSION, HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION } from "../../packages/contracts/src/story-prompt.js";
import { CONTINUITY_REVIEW_PROMPT_CATALOG, PROMPT_TEMPLATE_CATALOG } from "../../packages/contracts/src/prompt-library.js";
import { sha256 } from "../../packages/domain/src/index.js";
import { estimatedInputSafetyAllowanceTokens, estimateStoryTokens } from "../../packages/story-engine/src/index.js";

const integration = process.env.TEST_DATABASE_URL ? describe.sequential : describe.skip;

integration("history coverage intent authority", () => {
  let pool: DatabasePool;
  let ownerUserId: string;
  beforeAll(async () => { pool = createDatabasePool(process.env.TEST_DATABASE_URL!, 4); await migrateDatabase(pool, resolve("database/migrations")); ownerUserId = await initialOwnerId(pool); });
  afterEach(async () => { await pool.query("DELETE FROM campaigns"); await pool.query("DELETE FROM world_versions"); await pool.query("DELETE FROM worlds"); });
  afterAll(async () => { await pool?.end(); });

  it("bounds a >20k-turn v5 source read, reports unread coverage, and excludes replacement turn N", async () => {
    const world = await pool.query<{ id: string }>("INSERT INTO worlds(owner_user_id,title) VALUES($1,'Ledger') RETURNING id", [ownerUserId]);
    const version = await pool.query<{ id: string }>("INSERT INTO world_versions(owner_user_id,world_id,version_number,content) VALUES($1,$2,1,'{}') RETURNING id", [ownerUserId, world.rows[0]!.id]);
    const campaign = await pool.query<{ id: string }>("INSERT INTO campaigns(owner_user_id,world_version_id,title,active_turn_number,character_snapshot) VALUES($1,$2,'Ledger',20001,'{}') RETURNING id", [ownerUserId, version.rows[0]!.id]);
    await pool.query("INSERT INTO campaign_state(owner_user_id,campaign_id) VALUES($1,$2)", [ownerUserId, campaign.rows[0]!.id]);
    await pool.query(`INSERT INTO turns(owner_user_id,campaign_id,turn_number,action,narration,input_mode,state_snapshot_private)
      SELECT $1,$2,ordinal,concat('Intent ',ordinal,'.'),concat('Accepted narration ',ordinal,'.'),'action','{}'::jsonb
      FROM generate_series(1,20001) AS ordinal`, [ownerUserId, campaign.rows[0]!.id]);
    const foreignOwner = await pool.query<{ id: string }>("INSERT INTO users(display_name) VALUES('Ledger foreign owner') RETURNING id");
    const foreignWorld = await pool.query<{ id: string }>("INSERT INTO worlds(owner_user_id,title) VALUES($1,'Foreign ledger') RETURNING id", [foreignOwner.rows[0]!.id]);
    const foreignVersion = await pool.query<{ id: string }>("INSERT INTO world_versions(owner_user_id,world_id,version_number,content) VALUES($1,$2,1,'{}') RETURNING id", [foreignOwner.rows[0]!.id, foreignWorld.rows[0]!.id]);
    const foreignCampaign = await pool.query<{ id: string }>("INSERT INTO campaigns(owner_user_id,world_version_id,title,active_turn_number,character_snapshot) VALUES($1,$2,'Foreign ledger',1,'{}') RETURNING id", [foreignOwner.rows[0]!.id, foreignVersion.rows[0]!.id]);
    await pool.query("INSERT INTO campaign_state(owner_user_id,campaign_id) VALUES($1,$2)", [foreignOwner.rows[0]!.id, foreignCampaign.rows[0]!.id]);
    await pool.query("INSERT INTO turns(owner_user_id,campaign_id,turn_number,action,narration,input_mode,state_snapshot_private) VALUES($1,$2,1,'FOREIGN_OWNER_WORLD_CANARY','N','action','{}')", [foreignOwner.rows[0]!.id, foreignCampaign.rows[0]!.id]);
    const siblingCampaign = await pool.query<{ id: string }>("INSERT INTO campaigns(owner_user_id,world_version_id,title,active_turn_number,character_snapshot) VALUES($1,$2,'Sibling ledger',1,'{}') RETURNING id", [ownerUserId, version.rows[0]!.id]);
    await pool.query("INSERT INTO campaign_state(owner_user_id,campaign_id) VALUES($1,$2)", [ownerUserId, siblingCampaign.rows[0]!.id]);
    await pool.query("INSERT INTO turns(owner_user_id,campaign_id,turn_number,action,narration,input_mode,state_snapshot_private) VALUES($1,$2,1,'FOREIGN_CAMPAIGN_CANARY','N','action','{}')", [ownerUserId, siblingCampaign.rows[0]!.id]);
    const siblingWorld = await pool.query<{ id: string }>("INSERT INTO worlds(owner_user_id,title) VALUES($1,'Sibling world ledger') RETURNING id", [ownerUserId]);
    const siblingVersion = await pool.query<{ id: string }>("INSERT INTO world_versions(owner_user_id,world_id,version_number,content) VALUES($1,$2,1,'{}') RETURNING id", [ownerUserId, siblingWorld.rows[0]!.id]);
    const siblingWorldCampaign = await pool.query<{ id: string }>("INSERT INTO campaigns(owner_user_id,world_version_id,title,active_turn_number,character_snapshot) VALUES($1,$2,'Sibling world ledger',1,'{}') RETURNING id", [ownerUserId, siblingVersion.rows[0]!.id]);
    await pool.query("INSERT INTO campaign_state(owner_user_id,campaign_id) VALUES($1,$2)", [ownerUserId, siblingWorldCampaign.rows[0]!.id]);
    await pool.query("INSERT INTO turns(owner_user_id,campaign_id,turn_number,action,narration,input_mode,state_snapshot_private) VALUES($1,$2,1,'FOREIGN_WORLD_CANARY','N','action','{}')", [ownerUserId, siblingWorldCampaign.rows[0]!.id]);

    const startedAt = performance.now();
    let ledgerQueryCount = 0;
    let returnedRawActionBytes = 0;
    const resolved = await withTransaction(pool, async (client) => {
      const query = client.query.bind(client);
      const meteredClient = { query: async (...args: any[]) => {
        const result = await (query as any)(...args);
        if (typeof args[0] === "string" && args[0].includes("CASE WHEN char_length(t.action)")) {
          ledgerQueryCount++;
          returnedRawActionBytes += result.rows.reduce((sum: number, row: { action?: unknown }) => sum + (typeof row.action === "string" ? new TextEncoder().encode(row.action).byteLength : 0), 0);
        }
        return result;
      } };
      return resolveGenerationAuthoritySnapshot(meteredClient as never, {
        ownerUserId, campaignId: campaign.rows[0]!.id, operationKind: "replace_latest", expectedTurnNumber: 20001,
        baseIdentityVersion: "generation-base-v4", captureStoryLedger: true
      });
    });
    const elapsedMs = performance.now() - startedAt;
    // Replacement uses base N-1; the base scene is protected authority, so
    // ledger history remains strictly below it: replacement 20001 has base 20000.
    expect(resolved.storyLedger?.entries.at(-1)?.turnNumber).toBe(19999);
    expect(resolved.storyLedger?.entries).toHaveLength(512);
    expect(resolved.storyLedger?.entries.every((entry) => !/Accepted narration/u.test(entry.direction))).toBe(true);
    expect(resolved.storyLedger?.coverage).toMatchObject({ unreadThroughTurn: 19487, missingTurnCount: 0, filteredDirectionCount: 0, oversizedDirectionCount: 0, loadedRows: 512 });
    expect(resolved.storyLedger?.omittedThroughTurn).toBe(19487);
    expect(ledgerQueryCount).toBe(4);
    expect(returnedRawActionBytes).toBeGreaterThan(0);
    expect(returnedRawActionBytes).toBeLessThan(100_000);
    expect(new TextEncoder().encode(JSON.stringify(resolved.storyLedger?.entries)).byteLength).toBeLessThan(100_000);
    expect(elapsedMs).toBeLessThan(5_000);
    expect(JSON.stringify(resolved.storyLedger)).not.toMatch(/FOREIGN_OWNER_WORLD_CANARY|FOREIGN_CAMPAIGN_CANARY|FOREIGN_WORLD_CANARY/u);
    process.stderr.write(`${JSON.stringify({ historyCoverageAuthorityMetrics: { ledgerQueryCount, returnedRawActionBytes, elapsedMs: Math.round(elapsedMs * 100) / 100 } })}\n`);
  });

  it("distinguishes imported gaps, filtered mechanics, and oversized directions", async () => {
    const world = await pool.query<{ id: string }>("INSERT INTO worlds(owner_user_id,title) VALUES($1,'Ledger gaps') RETURNING id", [ownerUserId]);
    const version = await pool.query<{ id: string }>("INSERT INTO world_versions(owner_user_id,world_id,version_number,content) VALUES($1,$2,1,'{}') RETURNING id", [ownerUserId, world.rows[0]!.id]);
    const campaign = await pool.query<{ id: string }>("INSERT INTO campaigns(owner_user_id,world_version_id,title,active_turn_number,character_snapshot) VALUES($1,$2,'Ledger gaps',6,'{}') RETURNING id", [ownerUserId, version.rows[0]!.id]);
    await pool.query("INSERT INTO campaign_state(owner_user_id,campaign_id) VALUES($1,$2)", [ownerUserId, campaign.rows[0]!.id]);
    const validUnicodeDirection = "\u{1FA84} ".repeat(4_000);
    expect(new TextEncoder().encode(validUnicodeDirection).byteLength).toBe(20_000);
    expect(new TextEncoder().encode(validUnicodeDirection).byteLength).toBeLessThanOrEqual(48_000);
    await pool.query("INSERT INTO turns(owner_user_id,campaign_id,turn_number,action,narration,input_mode,state_snapshot_private) VALUES($1,$2,1,'[roll d20]','N','action','{}'),($1,$2,2,$3,'N','scene','{}'),($1,$2,4,$4,'N','scene','{}'),($1,$2,6,'Current base.','N','action','{}')",
      [ownerUserId, campaign.rows[0]!.id, validUnicodeDirection, "too large ".repeat(2000)]);

    const resolved = await withTransaction(pool, (client) => resolveGenerationAuthoritySnapshot(client, {
      ownerUserId, campaignId: campaign.rows[0]!.id, operationKind: "append", expectedTurnNumber: 7,
      baseIdentityVersion: "generation-base-v4", captureStoryLedger: true, captureRecentWindow: true, recentWindowTurns: 11
    }));
    expect(resolved.storyLedger).toMatchObject({ entries: [{ turnNumber: 2 }], omittedThroughTurn: 4,
      coverage: { unreadThroughTurn: null, missingTurnCount: 1, filteredDirectionCount: 1, oversizedDirectionCount: 1, loadedRows: 3 } });
  });

  it("handles base zero and one and does not mark an exhaustive full page unread", async () => {
    const world = await pool.query<{ id: string }>("INSERT INTO worlds(owner_user_id,title) VALUES($1,'Ledger boundaries') RETURNING id", [ownerUserId]);
    const version = await pool.query<{ id: string }>("INSERT INTO world_versions(owner_user_id,world_id,version_number,content) VALUES($1,$2,1,'{}') RETURNING id", [ownerUserId, world.rows[0]!.id]);
    const zero = await pool.query<{ id: string }>("INSERT INTO campaigns(owner_user_id,world_version_id,title,active_turn_number,character_snapshot) VALUES($1,$2,'Ledger zero',0,'{}') RETURNING id", [ownerUserId, version.rows[0]!.id]);
    await pool.query("INSERT INTO campaign_state(owner_user_id,campaign_id) VALUES($1,$2)", [ownerUserId, zero.rows[0]!.id]);
    const zeroResolved = await withTransaction(pool, (client) => resolveGenerationAuthoritySnapshot(client, { ownerUserId, campaignId: zero.rows[0]!.id,
      operationKind: "append", expectedTurnNumber: 1, baseIdentityVersion: "generation-base-v4", captureStoryLedger: true }));
    expect(zeroResolved.storyLedger).toBeUndefined();

    const one = await pool.query<{ id: string }>("INSERT INTO campaigns(owner_user_id,world_version_id,title,active_turn_number,character_snapshot) VALUES($1,$2,'Ledger one',1,'{}') RETURNING id", [ownerUserId, version.rows[0]!.id]);
    await pool.query("INSERT INTO campaign_state(owner_user_id,campaign_id) VALUES($1,$2)", [ownerUserId, one.rows[0]!.id]);
    await pool.query("INSERT INTO turns(owner_user_id,campaign_id,turn_number,action,narration,input_mode,state_snapshot_private) VALUES($1,$2,1,'Base one.','N','action','{}')", [ownerUserId, one.rows[0]!.id]);
    const oneResolved = await withTransaction(pool, (client) => resolveGenerationAuthoritySnapshot(client, { ownerUserId, campaignId: one.rows[0]!.id,
      operationKind: "append", expectedTurnNumber: 2, baseIdentityVersion: "generation-base-v4", captureStoryLedger: true }));
    expect(oneResolved.storyLedger).toMatchObject({ entries: [], omittedThroughTurn: null, coverage: { unreadThroughTurn: null, missingTurnCount: 0, loadedRows: 0 } });

    const exhaustive = await pool.query<{ id: string }>("INSERT INTO campaigns(owner_user_id,world_version_id,title,active_turn_number,character_snapshot) VALUES($1,$2,'Ledger exhaustive',513,'{}') RETURNING id", [ownerUserId, version.rows[0]!.id]);
    await pool.query("INSERT INTO campaign_state(owner_user_id,campaign_id) VALUES($1,$2)", [ownerUserId, exhaustive.rows[0]!.id]);
    await pool.query(`INSERT INTO turns(owner_user_id,campaign_id,turn_number,action,narration,input_mode,state_snapshot_private)
      SELECT $1,$2,ordinal,concat('Intent ',ordinal,'.'),'N','action','{}'::jsonb FROM generate_series(1,513) AS ordinal`, [ownerUserId, exhaustive.rows[0]!.id]);
    const exhaustiveResolved = await withTransaction(pool, (client) => resolveGenerationAuthoritySnapshot(client, { ownerUserId, campaignId: exhaustive.rows[0]!.id,
      operationKind: "append", expectedTurnNumber: 514, baseIdentityVersion: "generation-base-v4", captureStoryLedger: true }));
    expect(exhaustiveResolved.storyLedger).toMatchObject({ entries: expect.any(Array), omittedThroughTurn: null, coverage: { unreadThroughTurn: null, missingTurnCount: 0, loadedRows: 512 } });
  });

  it("composes the PostgreSQL ledger loader through the exact planner manifest and reviewer serializer", async () => {
    const world = await pool.query<{ id: string }>("INSERT INTO worlds(owner_user_id,title) VALUES($1,'Ledger composition') RETURNING id", [ownerUserId]);
    const version = await pool.query<{ id: string }>("INSERT INTO world_versions(owner_user_id,world_id,version_number,content) VALUES($1,$2,1,$3) RETURNING id", [ownerUserId, world.rows[0]!.id,
      JSON.stringify({ rules: "Keep accepted outcomes distinct from requested actions." })]);
    const campaign = await pool.query<{ id: string }>("INSERT INTO campaigns(owner_user_id,world_version_id,title,active_turn_number,character_snapshot) VALUES($1,$2,'Ledger composition',14,'{}') RETURNING id", [ownerUserId, version.rows[0]!.id]);
    await pool.query("INSERT INTO campaign_state(owner_user_id,campaign_id) VALUES($1,$2)", [ownerUserId, campaign.rows[0]!.id]);
    await pool.query("INSERT INTO turns(owner_user_id,campaign_id,turn_number,action,narration,input_mode,state_snapshot_private) VALUES($1,$2,1,'Ask the keeper to open the gate.','The keeper refuses and the gate remains sealed.','action','{}'),($1,$2,2,'Search for a silver seal.','Mira finds no seal beneath the broken quay.','scene','{}'),($1,$2,3,'Wait beside the gate.','The tide rises around the sealed gate.','action','{}')", [ownerUserId, campaign.rows[0]!.id]);
    await pool.query("INSERT INTO turns(owner_user_id,campaign_id,turn_number,action,narration,input_mode,state_snapshot_private) SELECT $1,$2,turn_number,concat('Continue watch ',turn_number,'.'),concat('The tide marks watch ',turn_number,'.'),'action','{}'::jsonb FROM generate_series(4,14) AS turn_number", [ownerUserId, campaign.rows[0]!.id]);
    const policy = storyMemoryPolicySchema.parse({ ...defaultStoryMemoryPolicy("r3"), continuityReview: "observe" });
    const snapshot = { policy, policyHash: storyMemoryPolicyHash(policy), contextProtocol: HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION,
      castContext: true, promptProtocol: CAST_STORY_MEMORY_PROMPT_PROTOCOL_VERSION, providerConfigurationFingerprint: "a".repeat(64) } as const;
    const legacySnapshot = { policy, policyHash: storyMemoryPolicyHash(policy), castContext: true,
      promptProtocol: CAST_STORY_MEMORY_PROMPT_PROTOCOL_VERSION, providerConfigurationFingerprint: "a".repeat(64) } as const;
    const capturedV4 = await withTransaction(pool, (client) => resolveGenerationAuthoritySnapshot(client, {
      ownerUserId, campaignId: campaign.rows[0]!.id, operationKind: "append", expectedTurnNumber: 15,
      baseIdentityVersion: "generation-base-v4"
    }));
    const legacyContext = await withTransaction(pool, (client) => loadPostgresChronicleGenerationAuthorityContext(client, {
      ownerUserId, campaignId: campaign.rows[0]!.id, worldVersionId: version.rows[0]!.id, operationKind: "append", expectedTurnNumber: 15,
      query: "keeper gate", expectedBaseIdentity: capturedV4.baseIdentity as never,
      // v4 has no history context protocol identity at runtime; the loader's
      // static policy input has not yet been widened for that historical form.
      storyMemoryPolicy: legacySnapshot as typeof snapshot
    }));
    const captured = await withTransaction(pool, (client) => resolveGenerationAuthoritySnapshot(client, {
      ownerUserId, campaignId: campaign.rows[0]!.id, operationKind: "append", expectedTurnNumber: 15,
      baseIdentityVersion: "generation-base-v4", captureStoryLedger: true, captureRecentWindow: true, recentWindowTurns: 11
    }));
    const context = await withTransaction(pool, (client) => loadPostgresChronicleGenerationAuthorityContext(client, {
      ownerUserId, campaignId: campaign.rows[0]!.id, worldVersionId: version.rows[0]!.id, operationKind: "append", expectedTurnNumber: 15,
      query: "keeper gate", expectedBaseIdentity: captured.baseIdentity as never, storyMemoryPolicy: snapshot
    }));
    const provider = { id: "ledger-reviewer", name: "Ledger reviewer", providerRole: "text" as const, providerType: "openai_compatible" as const, model: "ledger-model", baseUrl: "",
      contextWindowTokens: 32_000, maxOutputTokens: 512, temperature: 0, requestTimeoutMs: 1_000, configuration: {},
      async execute() { throw new Error("This composed serializer test must not dispatch a provider request."); } };
    const promptSnapshot = { version: 2,
      templates: Object.fromEntries(Object.entries(PROMPT_TEMPLATE_CATALOG).map(([key, value]) => [key, { content: value.defaultContent, hash: sha256(value.defaultContent), source: "shipped" as const }])),
      continuityReview: Object.fromEntries(Object.entries(CONTINUITY_REVIEW_PROMPT_CATALOG).map(([key, value]) => [key, { content: value.defaultContent, hash: sha256(value.defaultContent), source: "shipped" as const, protocolIdentity: value.protocolIdentity }])) };
    const reviewTokens = (manifest: NonNullable<ReturnType<typeof planGenerationPromptContext>["sourceManifest"]>) => estimateContinuityReviewPlanningTokens({
      provider, manifest, producingRequestHash: manifest.producingRequestHash, promptSnapshot, reviewMode: "observe",
      direction: "Ask the keeper to open the gate.", candidateOutputTokens: provider.maxOutputTokens
    });
    const planned = planGenerationPromptContext(context, provider, "Write a scene.", "Ask the keeper to open the gate.", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "action", 32_000, 31_000,
      "22222222-2222-4222-8222-222222222222", "story_memory", policy, undefined, reviewTokens, 31_000,
      HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION);
    const manifest = generationEvidenceManifestSchema.parse(planned.sourceManifest);
    const review = prepareContinuityReview({ provider, manifest, producingRequestHash: manifest.producingRequestHash,
      promptSnapshot, reviewMode: "observe", direction: "Ask the keeper to open the gate.",
      draft: { narration: "The keeper refuses again.", choices: ["Wait", "Search", "Leave", "Listen"], custom_action_suggestion: "Inspect the quay.", scratchpad: "", tracker_updates: [], image_prompt: "", continuity_summary: "", open_threads: [], canonical_facts: [], superseded_facts: [], canonical_fact_updates: [] } });
    const ledgerEvidence = manifest.entries.filter((entry) => entry.selectionGroup === "ledger");
    const capturedRecentIds = new Set(context.recentTurns?.map((turn) => turn.turnId));
    const sentRecentIds = new Set((planned.promptContext.recentTurns ?? []).map((turn) => turn.sourceId));
    const ledgerTurnIds = ledgerEvidence.map((entry) => entry.source.id);
    const acceptedFirst = await pool.query<{ narration: string }>("SELECT narration FROM turns WHERE campaign_id=$1 AND turn_number=1", [campaign.rows[0]!.id]);

    expect(context.authority.storyLedger?.entries[0]?.direction).toBe("Ask the keeper to open the gate.");
    expect(legacyContext.recentTurns?.length ?? 0).toBeLessThanOrEqual(2);
    expect(acceptedFirst.rows[0]!.narration).toContain("keeper refuses and the gate remains sealed");
    expect(JSON.stringify(context.authority.storyLedger)).not.toContain("keeper refuses and the gate remains sealed");
    expect(planned.storyInput).toContain("storyLedger records earlier player intent, not proof of events.");
    expect(capturedRecentIds.size).toBe(11);
    expect(context.recentTurns?.some((turn) => turn.narration.includes("tide rises around the sealed gate"))).toBe(true);
    expect([...sentRecentIds].every((turnId) => capturedRecentIds.has(turnId))).toBe(true);
    expect(ledgerTurnIds.every((turnId) => !sentRecentIds.has(turnId))).toBe(true);
    expect(ledgerTurnIds.some((turnId) => capturedRecentIds.has(turnId))).toBe(true);
    expect(ledgerEvidence.every((entry) => entry.semanticRole === "player_intent" && entry.canonicalFactId === null)).toBe(true);
    expect(() => bindManifestToProducingRequest(manifest, planned.contextPlan.serializedRequest)).not.toThrow();
    expect(review.body).toContain(manifest.manifestHash);
    expect(review.requestHash).toBe(sha256(review.body));

    // This deliberately holds the captured authority and source inputs fixed.
    // The v4 comparison may therefore prove byte identity; it must never be
    // compared with the unrelated literal Task 0 compatibility fixture.
    const matrixContext = {
      ...context,
      authority: {
        ...context.authority,
        protectedFacts: [{
          id: "33333333-3333-4333-8333-333333333333",
          turnNumber: 2,
          content: "The complete protected fact says the silver seal cannot open a broken gate."
        }]
      },
      candidates: [{
        id: "44444444-4444-4444-8444-444444444444",
        turnId: "44444444-4444-4444-8444-444444444444",
        ordinal: 2,
        kind: "turn_fiction",
        content: "Retrieved accepted narration: the keeper hid the silver seal beneath the quay.",
        tokenEstimate: 20,
        rank: 1
      }] as const
    };
    const legacyMatrixContext = { ...legacyContext, candidates: matrixContext.candidates };
    const legacyMatrixContextWithIgnoredV5Fields = {
      ...legacyMatrixContext,
      authority: { ...legacyMatrixContext.authority, protectedFacts: matrixContext.authority.protectedFacts }
    };
    const budgets = [32_000, 64_000, 128_000, 256_000, 1_000_000, 4_000_000] as const;
    const matrixMetrics: unknown[] = [];
    for (const configuredBudget of budgets) {
      const writer = {
        ...provider,
        id: `matrix-writer-${configuredBudget}`,
        contextWindowTokens: Math.min(configuredBudget, 256_000)
      };
      // Every row deliberately has an enabled, smaller reviewer. The 32k row
      // also establishes that a configured budget cannot override that cap.
      const reviewer = {
        ...provider,
        id: `matrix-reviewer-${configuredBudget}`,
        contextWindowTokens: Math.min(Math.max(16_000, Math.floor(configuredBudget / 2)), 64_000)
      };
      const writerInputLimit = writer.contextWindowTokens - writer.maxOutputTokens;
      const reviewerInputLimit = reviewer.contextWindowTokens;
      const reviewerEstimator = (sourceManifest: NonNullable<ReturnType<typeof planGenerationPromptContext>["sourceManifest"]>) =>
        estimateContinuityReviewPlanningTokens({
          provider: reviewer,
          manifest: sourceManifest,
          producingRequestHash: sourceManifest.producingRequestHash,
          promptSnapshot,
          reviewMode: "observe",
          direction: "Ask the keeper to open the gate.",
          candidateOutputTokens: reviewer.maxOutputTokens
        });
      const v4Legacy = planGenerationPromptContext(legacyMatrixContext, writer, "Write a scene.", "Ask the keeper to open the gate.", [],
        { profile: "brief", minWords: 100, maxWords: 120 }, "action", writer.contextWindowTokens, writerInputLimit,
        "55555555-5555-4555-8555-555555555555", "story_memory", policy, undefined, reviewerEstimator, reviewerInputLimit);
      const v4WithIgnoredV5Fields = planGenerationPromptContext(legacyMatrixContextWithIgnoredV5Fields, writer, "Write a scene.", "Ask the keeper to open the gate.", [],
        { profile: "brief", minWords: 100, maxWords: 120 }, "action", writer.contextWindowTokens, writerInputLimit,
        "55555555-5555-4555-8555-555555555555", "story_memory", policy, undefined, reviewerEstimator, reviewerInputLimit);
      expect(v4WithIgnoredV5Fields.contextPlan.serializedRequest).toBe(v4Legacy.contextPlan.serializedRequest);

      const v5 = planGenerationPromptContext(matrixContext, writer, "Write a scene.", "Ask the keeper to open the gate.", [],
        { profile: "brief", minWords: 100, maxWords: 120 }, "action", writer.contextWindowTokens, writerInputLimit,
        "55555555-5555-4555-8555-555555555555", "story_memory", policy, undefined, reviewerEstimator, reviewerInputLimit,
        HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION);
      const v5Manifest = generationEvidenceManifestSchema.parse(v5.sourceManifest);
      const v5Review = prepareContinuityReview({ provider: reviewer, manifest: v5Manifest,
        producingRequestHash: v5Manifest.producingRequestHash, promptSnapshot, reviewMode: "observe",
        direction: "Ask the keeper to open the gate.",
        draft: { narration: "The keeper refuses again.", choices: ["Wait", "Search", "Leave", "Listen"], custom_action_suggestion: "Inspect the quay.", scratchpad: "", tracker_updates: [], image_prompt: "", continuity_summary: "", open_threads: [], canonical_facts: [], superseded_facts: [], canonical_fact_updates: [] } });
      const writerTokens = estimateStoryTokens(v5.contextPlan.serializedRequest);
      const writerRequired = writerTokens + estimatedInputSafetyAllowanceTokens(writerTokens) + writer.maxOutputTokens;
      const reviewerRequired = v5Review.requestTokens + v5Review.safetyAllowanceTokens + reviewer.maxOutputTokens;
      expect(writerRequired).toBeLessThanOrEqual(writer.contextWindowTokens);
      expect(reviewerRequired).toBeLessThanOrEqual(reviewer.contextWindowTokens);
      expect(reviewer.contextWindowTokens).toBeLessThan(writer.contextWindowTokens);
      expect(() => bindManifestToProducingRequest(v5Manifest, v5.contextPlan.serializedRequest)).not.toThrow();
      expect(v5Review.body).toContain(v5Manifest.manifestHash);
      expect(v5Manifest.entries.some((entry) => entry.selectionGroup === "ledger")).toBe(true);
      expect(v5Manifest.entries.some((entry) => entry.selectionGroup === "recent")).toBe(true);
      expect(v5Manifest.entries.some((entry) => entry.selectionGroup === "retrieved")).toBe(true);
      expect(v5Manifest.entries.some((entry) => entry.canonicalFactId === "33333333-3333-4333-8333-333333333333")).toBe(true);
      expect((v5.layerDiagnostics as any).history?.version).toBe("history-coverage-diagnostics-v1");
      expect(JSON.stringify((v5.layerDiagnostics as any).history)).not.toContain("keeper hid the silver seal");
      matrixMetrics.push({ configuredBudget, writerContextWindowTokens: writer.contextWindowTokens,
        reviewerContextWindowTokens: reviewer.contextWindowTokens, writerBytes: new TextEncoder().encode(v5.contextPlan.serializedRequest).byteLength,
        reviewerBytes: new TextEncoder().encode(v5Review.body).byteLength, writerTokens, reviewerTokens: v5Review.requestTokens,
        writerHeadroom: writer.contextWindowTokens - writerRequired, reviewerHeadroom: reviewer.contextWindowTokens - reviewerRequired,
        selectedLedger: v5Manifest.entries.filter((entry) => entry.selectionGroup === "ledger").length,
        selectedRecent: v5Manifest.entries.filter((entry) => entry.selectionGroup === "recent").length,
        selectedRetrieved: v5Manifest.entries.filter((entry) => entry.selectionGroup === "retrieved").length,
        selectedFacts: v5Manifest.entries.filter((entry) => entry.canonicalFactId === "33333333-3333-4333-8333-333333333333").length,
        measurementTrials: (v5.layerDiagnostics as any).ledgerReservation.measurementTrialCount,
        writerSerializations: (v5.layerDiagnostics as any).ledgerReservation.writerSerializationCount,
        reviewerSerializations: (v5.layerDiagnostics as any).ledgerReservation.reviewerSerializationCount });
    }
    process.stderr.write(`${JSON.stringify({ historyCoveragePreenableMatrix: matrixMetrics })}\n`);
    process.stderr.write(`${JSON.stringify({ historyCoverageCompositionMetrics: { writerBytes: new TextEncoder().encode(planned.contextPlan.serializedRequest).byteLength, reviewerBytes: new TextEncoder().encode(review.body).byteLength, ledgerEntries: ledgerEvidence.length, measurementTrials: (planned.layerDiagnostics as any).ledgerReservation.measurementTrialCount, writerSerializations: (planned.layerDiagnostics as any).ledgerReservation.writerSerializationCount, reviewerSerializations: (planned.layerDiagnostics as any).ledgerReservation.reviewerSerializationCount } })}\n`);
  });
});
