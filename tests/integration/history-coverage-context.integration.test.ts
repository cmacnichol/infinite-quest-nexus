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
      baseIdentityVersion: "generation-base-v4", captureStoryLedger: true
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
    const campaign = await pool.query<{ id: string }>("INSERT INTO campaigns(owner_user_id,world_version_id,title,active_turn_number,character_snapshot) VALUES($1,$2,'Ledger composition',3,'{}') RETURNING id", [ownerUserId, version.rows[0]!.id]);
    await pool.query("INSERT INTO campaign_state(owner_user_id,campaign_id) VALUES($1,$2)", [ownerUserId, campaign.rows[0]!.id]);
    await pool.query("INSERT INTO turns(owner_user_id,campaign_id,turn_number,action,narration,input_mode,state_snapshot_private) VALUES($1,$2,1,'Ask the keeper to open the gate.','The keeper refuses and the gate remains sealed.','action','{}'),($1,$2,2,'Search for a silver seal.','Mira finds no seal beneath the broken quay.','scene','{}'),($1,$2,3,'Wait beside the gate.','The tide rises around the sealed gate.','action','{}')", [ownerUserId, campaign.rows[0]!.id]);
    const policy = storyMemoryPolicySchema.parse({ ...defaultStoryMemoryPolicy("r3"), continuityReview: "observe" });
    const snapshot = { policy, policyHash: storyMemoryPolicyHash(policy), contextProtocol: HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION,
      castContext: true, promptProtocol: CAST_STORY_MEMORY_PROMPT_PROTOCOL_VERSION, providerConfigurationFingerprint: "a".repeat(64) } as const;
    const captured = await withTransaction(pool, (client) => resolveGenerationAuthoritySnapshot(client, {
      ownerUserId, campaignId: campaign.rows[0]!.id, operationKind: "append", expectedTurnNumber: 4,
      baseIdentityVersion: "generation-base-v4", captureStoryLedger: true
    }));
    const context = await withTransaction(pool, (client) => loadPostgresChronicleGenerationAuthorityContext(client, {
      ownerUserId, campaignId: campaign.rows[0]!.id, worldVersionId: version.rows[0]!.id, operationKind: "append", expectedTurnNumber: 4,
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
    const acceptedFirst = await pool.query<{ narration: string }>("SELECT narration FROM turns WHERE campaign_id=$1 AND turn_number=1", [campaign.rows[0]!.id]);

    expect(context.authority.storyLedger?.entries[0]?.direction).toBe("Ask the keeper to open the gate.");
    expect(acceptedFirst.rows[0]!.narration).toContain("keeper refuses and the gate remains sealed");
    expect(JSON.stringify(context.authority.storyLedger)).not.toContain("keeper refuses and the gate remains sealed");
    expect(planned.storyInput).toContain("storyLedger records earlier player intent, not proof of events.");
    expect(ledgerEvidence).toHaveLength(2);
    expect(ledgerEvidence.every((entry) => entry.semanticRole === "player_intent" && entry.canonicalFactId === null)).toBe(true);
    expect(manifest.entries.some((entry) => entry.semanticRole === "accepted_narration" && entry.content.includes("tide rises around the sealed gate"))).toBe(true);
    expect(() => bindManifestToProducingRequest(manifest, planned.contextPlan.serializedRequest)).not.toThrow();
    expect(review.body).toContain(manifest.manifestHash);
    expect(review.requestHash).toBe(sha256(review.body));
    process.stderr.write(`${JSON.stringify({ historyCoverageCompositionMetrics: { writerBytes: new TextEncoder().encode(planned.contextPlan.serializedRequest).byteLength, reviewerBytes: new TextEncoder().encode(review.body).byteLength, ledgerEntries: ledgerEvidence.length, measurementTrials: (planned.layerDiagnostics as any).ledgerReservation.measurementTrialCount, writerSerializations: (planned.layerDiagnostics as any).ledgerReservation.writerSerializationCount, reviewerSerializations: (planned.layerDiagnostics as any).ledgerReservation.reviewerSerializationCount } })}\n`);
  });
});
