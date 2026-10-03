import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, withTransaction, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { loadCurrentContinuityCorrection, loadVerifiedProtectedFacts, verifyCapturedOptionalGenerationFacts } from "../../packages/database/src/campaign-continuity-repository.js";
import { buildCanonicalChronicleFacts } from "../../packages/domain/src/chronicle-memory-helpers.js";
import { resolveGenerationAuthoritySnapshot } from "../../packages/database/src/generation-authority.js";
import { loadPostgresChronicleGenerationAuthorityContext, loadPostgresChronicleGenerationCandidatesContext } from "../../packages/database/src/chronicle-generation-context.js";
import { defaultStoryMemoryPolicy, storyMemoryPolicyHash } from "../../packages/contracts/src/story-memory-policy.js";
import { CAST_STORY_MEMORY_PROMPT_PROTOCOL_VERSION, HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION } from "../../packages/contracts/src/story-prompt.js";
import { generationEvidenceManifestSchema } from "../../packages/application/src/memory/generation-context.js";

import { planGenerationPromptContext } from "../../services/runtime/src/generation-context-planner.js";
import { serializeProviderRequest } from "../../packages/story-engine/src/index.js";

const integration = process.env.TEST_DATABASE_URL ? describe.sequential : describe.skip;

integration("verified protected-fact authority", () => {
  let pool: DatabasePool;
  let ownerUserId = "";

  beforeAll(async () => {
    pool = createDatabasePool(process.env.TEST_DATABASE_URL!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });

  afterEach(async () => {
    await pool.query("DELETE FROM campaigns");
    await pool.query("DELETE FROM world_versions");
    await pool.query("DELETE FROM worlds");
  });

  afterAll(async () => { await pool?.end(); });

  async function fixture(activeTurnNumber = 3) {
    const world = await pool.query<{ id: string }>("INSERT INTO worlds(owner_user_id,title) VALUES($1,$2) RETURNING id", [ownerUserId, `Protected facts ${crypto.randomUUID()}`]);
    const version = await pool.query<{ id: string }>("INSERT INTO world_versions(owner_user_id,world_id,version_number,content) VALUES($1,$2,1,$3::jsonb) RETURNING id", [ownerUserId, world.rows[0]!.id, JSON.stringify({ world: { title: "Protected facts" } })]);
    const campaign = await pool.query<{ id: string }>("INSERT INTO campaigns(owner_user_id,world_version_id,title,active_turn_number) VALUES($1,$2,$3,$4) RETURNING id", [ownerUserId, version.rows[0]!.id, "Protected facts", activeTurnNumber]);
    await pool.query("INSERT INTO campaign_state(owner_user_id,campaign_id) VALUES($1,$2)", [ownerUserId, campaign.rows[0]!.id]);
    return { campaignId: campaign.rows[0]!.id, worldVersionId: version.rows[0]!.id };
  }

  async function acceptedTurn(campaignId: string, turnNumber: number, snapshot: unknown) {
    return (await pool.query<{ id: string }>(`INSERT INTO turns(owner_user_id,campaign_id,turn_number,action,narration,state_snapshot_private,accepted_at)
      VALUES($1,$2,$3,'Wait.','The harbor is quiet.',$4::jsonb,now()) RETURNING id`, [ownerUserId, campaignId, turnNumber, JSON.stringify(snapshot)])).rows[0]!.id;
  }

  async function insertAcceptedFact(scope: { campaignId: string; worldVersionId: string }, turnId: string, turnNumber: number, fact: { id: string; factIndex: number; content: string }) {
    await pool.query(`INSERT INTO campaign_canonical_facts(id,owner_user_id,campaign_id,world_version_id,source_turn_id,source_turn_number,source_fact_index,content,normalized_content,valid_from_turn)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,lower($8),$6)`, [fact.id, ownerUserId, scope.campaignId, scope.worldVersionId, turnId, turnNumber, fact.factIndex, fact.content]);
  }

  async function insertChronicleFact(scope: { campaignId: string; worldVersionId: string }, turnId: string, turnNumber: number, fact: { id: string; content: string }) {
    await pool.query(`INSERT INTO chronicle_memories(id,owner_user_id,campaign_id,world_version_id,turn_id,memory_kind,ordinal,content,token_estimate,importance,entities,metadata)
      VALUES($1,$2,$3,$4,$5,'canonical_fact',$6,$7,32,1,ARRAY[]::text[],'{}'::jsonb)`,
    [fact.id, ownerUserId, scope.campaignId, scope.worldVersionId, turnId, turnNumber, fact.content]);
  }

  async function planV5Request(scope: { campaignId: string; worldVersionId: string }, expectedTurnNumber: number, query: string) {
    const policy = defaultStoryMemoryPolicy("r3");
    const storyMemoryPolicy = { policy, policyHash: storyMemoryPolicyHash(policy), contextProtocol: HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION,
      castContext: true, promptProtocol: CAST_STORY_MEMORY_PROMPT_PROTOCOL_VERSION, providerConfigurationFingerprint: "c".repeat(64) } as const;
    const scopeWithProtocol = { ownerUserId, ...scope, operationKind: "append" as const, expectedTurnNumber, query, storyMemoryPolicy };
    const frozen = await withTransaction(pool, (client) => resolveGenerationAuthoritySnapshot(client, {
      ...scopeWithProtocol, baseIdentityVersion: "generation-base-v4", captureRecentWindow: true, recentWindowTurns: 11,
      captureStoryLedger: true, captureProtectedFacts: true
    }));
    const authority = await withTransaction(pool, (client) => loadPostgresChronicleGenerationAuthorityContext(client, {
      ...scopeWithProtocol, expectedBaseIdentity: frozen.baseIdentity
    }));
    const provider = { id: "v5-protected-facts-writer", name: "V5 protected facts writer", providerRole: "text" as const,
      providerType: "openai_compatible" as const, model: "deterministic-test", baseUrl: "http://fixture.invalid/v1",
      contextWindowTokens: 32_000, maxOutputTokens: 512, temperature: 0, requestTimeoutMs: 1_000, configuration: {} };
    const plan = (context: typeof authority) => planGenerationPromptContext(context, provider, "System", "Continue the story.", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "action", 32_000, 31_488,
      "77777777-7777-4777-8777-777777777777", "story_memory", policy, undefined, undefined, undefined,
      HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION);
    const reservationPlan = plan({ ...authority, candidates: [] });
    const reservation = { recentTurnIds: reservationPlan.promptContext.recentTurns?.map((turn) => turn.sourceId) ?? [],
      protectedFactIds: reservationPlan.promptContext.protectedFacts?.map((fact) => fact.id) ?? [] };
    const client = await pool.connect();
    let retrieved;
    try {
      retrieved = await loadPostgresChronicleGenerationCandidatesContext(client, { ...scopeWithProtocol, retrievalBudgetTokens: 30_000 },
        authority, {} as never, reservation, { useSavepoints: false });
    } finally { client.release(); }
    const planned = plan(retrieved);
    const requestBody = serializeProviderRequest(provider, { systemPrompt: "System", input: planned.storyInput }).body;
    const manifest = generationEvidenceManifestSchema.parse(planned.sourceManifest);
    return { authority, retrieved, planned, requestBody, manifest };
  }

  async function load(scope: { campaignId: string; worldVersionId: string }, baseTurnNumber = 3) {
    const client = await pool.connect();
    try { return await loadVerifiedProtectedFacts(client, { ownerUserId, ...scope }, baseTurnNumber); }
    finally { client.release(); }
  }

  async function loadCorrection(scope: { campaignId: string; worldVersionId: string }, complete = false) {
    const client = await pool.connect();
    try { return await loadCurrentContinuityCorrection(client, { ownerUserId, ...scope }, 3, complete ? { complete: true } : {}); }
    finally { client.release(); }
  }

  it("suppresses stale pre-frontier rows after an empty correction while retaining a later accepted fact without repairing projection", async () => {
    const scope = await fixture();
    const oldSnapshot = { canonicalFacts: ["The old harbor gate is open."], canonicalFactUpdates: [] };
    const oldTurnId = await acceptedTurn(scope.campaignId, 1, oldSnapshot);
    const old = buildCanonicalChronicleFacts({ campaignId: scope.campaignId, turnId: oldTurnId, ...oldSnapshot, entityCatalog: [] })[0]!;
    await insertAcceptedFact(scope, oldTurnId, 1, old);
    await insertChronicleFact(scope, oldTurnId, 1, old);
    await pool.query(`INSERT INTO campaign_state_edits(owner_user_id,campaign_id,revision,effective_turn_number,state_snapshot_private)
      VALUES($1,$2,1,2,$3::jsonb)`, [ownerUserId, scope.campaignId, JSON.stringify({ continuitySummary: "", scratchpad: "", openThreads: [],
      canonicalFacts: [], trackers: [], rpgStats: [], eventTriggers: [], pendingEventTriggers: [] })]);
    const laterSnapshot = { canonicalFacts: ["A brass key hangs above the harbor gate."], canonicalFactUpdates: [] };
    const laterTurnId = await acceptedTurn(scope.campaignId, 3, laterSnapshot);
    const later = buildCanonicalChronicleFacts({ campaignId: scope.campaignId, turnId: laterTurnId, ...laterSnapshot, entityCatalog: [] })[0]!;
    await insertAcceptedFact(scope, laterTurnId, 3, later);
    await insertChronicleFact(scope, laterTurnId, 3, later);
    const before = await pool.query("SELECT id,valid_until_turn FROM campaign_canonical_facts WHERE campaign_id=$1 ORDER BY id", [scope.campaignId]);

    const result = await load(scope);

    expect(result.facts).toEqual([{ id: later.id, turnNumber: 3, content: later.content }]);
    expect(result.omittedCount).toBe(1);
    expect(result.candidateRows).toBe(2);
    expect(result.sourceBytes).toBeGreaterThan(0);
    await expect(pool.query("SELECT id,valid_until_turn FROM campaign_canonical_facts WHERE campaign_id=$1 ORDER BY id", [scope.campaignId])).resolves.toMatchObject({ rows: before.rows });

    const composed = await planV5Request(scope, 4, "Recall the old harbor gate and tell me why it was opened.");
    expect(composed.authority.authority.storyLedger).toBeDefined();
    expect(composed.authority.authority.protectedFacts.some((fact) => fact.id === old.id)).toBe(false);
    expect(composed.retrieved.candidates.some((candidate) => candidate.id === old.id)).toBe(false);
    expect(composed.requestBody).not.toContain(old.content);
    expect(composed.manifest.entries.some((entry) => entry.canonicalFactId === old.id)).toBe(false);
  });

  it("captures a nonempty correction frontier before the base and retains it through a later accepted turn", async () => {
    const scope = await fixture();
    const staleSnapshot = { canonicalFacts: ["The stale harbor watch remains."], canonicalFactUpdates: [] };
    const staleTurnId = await acceptedTurn(scope.campaignId, 1, staleSnapshot);
    const stale = buildCanonicalChronicleFacts({ campaignId: scope.campaignId, turnId: staleTurnId, ...staleSnapshot, entityCatalog: [] })[0]!;
    await insertAcceptedFact(scope, staleTurnId, 1, stale);
    const retainedId = crypto.randomUUID();
    const retainedContent = "The corrected harbor watch stands at the west gate.";
    const correction = await pool.query<{ id: string }>(`INSERT INTO campaign_state_edits(owner_user_id,campaign_id,revision,effective_turn_number,state_snapshot_private)
      VALUES($1,$2,1,2,$3::jsonb) RETURNING id`, [ownerUserId, scope.campaignId, JSON.stringify({
        continuitySummary: "The corrected harbor watch remains in force.", scratchpad: "", openThreads: [],
        canonicalFacts: [{ id: retainedId, content: retainedContent }], trackers: [], rpgStats: [], eventTriggers: [], pendingEventTriggers: []
      })]);
    await pool.query(`INSERT INTO campaign_canonical_facts(id,owner_user_id,campaign_id,world_version_id,source_state_edit_id,source_turn_number,source_fact_index,content,normalized_content,valid_from_turn)
      VALUES($1,$2,$3,$4,$5,2,0,$6,lower($6),2)`, [retainedId, ownerUserId, scope.campaignId, scope.worldVersionId, correction.rows[0]!.id, retainedContent]);
    await acceptedTurn(scope.campaignId, 3, { canonicalFacts: [], canonicalFactUpdates: [] });
    const policy = defaultStoryMemoryPolicy("r3");
    const storyMemoryPolicy = { policy, policyHash: storyMemoryPolicyHash(policy), contextProtocol: HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION,
      castContext: true, promptProtocol: CAST_STORY_MEMORY_PROMPT_PROTOCOL_VERSION, providerConfigurationFingerprint: "a".repeat(64) } as const;

    const authority = await withTransaction(pool, async (client) => {
      const frozen = await resolveGenerationAuthoritySnapshot(client, { ownerUserId, ...scope, operationKind: "append", expectedTurnNumber: 4,
        baseIdentityVersion: "generation-base-v4", captureRecentWindow: true, recentWindowTurns: 11,
        captureStoryLedger: true, captureProtectedFacts: true });
      return loadPostgresChronicleGenerationAuthorityContext(client, { ownerUserId, ...scope, operationKind: "append", expectedTurnNumber: 4,
        query: "harbor watch", expectedBaseIdentity: frozen.baseIdentity, storyMemoryPolicy });
    });
    expect(authority.authority.optionalFactFrontier).toMatchObject({
      stateEditId: correction.rows[0]!.id, effectiveTurnNumber: 2, facts: [{ id: retainedId, content: retainedContent }]
    });
    const client = await pool.connect();
    try {
      await expect(verifyCapturedOptionalGenerationFacts(client, { ownerUserId, ...scope }, 3, [stale.id, retainedId],
        authority.authority.optionalFactFrontier)).resolves.toEqual([retainedId]);
    } finally { client.release(); }
  });

  it("captures all 910 correction facts from a frontier larger than one megabyte", async () => {
    const scope = await fixture();
    await acceptedTurn(scope.campaignId, 3, { canonicalFacts: [], canonicalFactUpdates: [] });
    const facts = Array.from({ length: 910 }, (_, index) => ({ id: crypto.randomUUID(), content: `Harbor record ${index}: ${"x".repeat(1_200)}` }));
    const edit = await pool.query<{ id: string }>(`INSERT INTO campaign_state_edits(owner_user_id,campaign_id,revision,effective_turn_number,state_snapshot_private)
      VALUES($1,$2,1,3,$3::jsonb) RETURNING id`, [ownerUserId, scope.campaignId, JSON.stringify({
        continuitySummary: "", scratchpad: "", openThreads: [], canonicalFacts: facts,
        trackers: [], rpgStats: [], eventTriggers: [], pendingEventTriggers: []
      })]);
    await pool.query(`INSERT INTO campaign_canonical_facts
      (id,owner_user_id,campaign_id,world_version_id,source_state_edit_id,source_turn_number,source_fact_index,content,normalized_content,valid_from_turn)
      SELECT (fact.value->>'id')::uuid,$1,$2,$3,$4,3,(fact.ordinality-1)::integer,
        fact.value->>'content',lower(fact.value->>'content'),3
      FROM jsonb_array_elements($5::jsonb) WITH ORDINALITY fact(value,ordinality)`,
      [ownerUserId, scope.campaignId, scope.worldVersionId, edit.rows[0]!.id, JSON.stringify(facts)]);
    const result = await load(scope);
    expect(result.facts).toHaveLength(910);
    expect(result.facts).toEqual(facts.map((fact) => ({ ...fact, turnNumber: 3 })));
    expect(result).toMatchObject({ candidateRows: 910, omittedCount: 0, sourceLimitReached: false });
    expect(result.sourceBytes).toBeGreaterThan(1_000_000);
    const policy = defaultStoryMemoryPolicy("r3");
    const storyMemoryPolicy = { policy, policyHash: storyMemoryPolicyHash(policy), contextProtocol: HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION,
      castContext: true, promptProtocol: CAST_STORY_MEMORY_PROMPT_PROTOCOL_VERSION, providerConfigurationFingerprint: "a".repeat(64) } as const;
    const captured = await withTransaction(pool, async (client) => {
      const frozen = await resolveGenerationAuthoritySnapshot(client, { ownerUserId, ...scope, operationKind: "append", expectedTurnNumber: 4,
        baseIdentityVersion: "generation-base-v4", captureRecentWindow: true, recentWindowTurns: 11,
        captureStoryLedger: true, captureProtectedFacts: true });
      return loadPostgresChronicleGenerationAuthorityContext(client, { ownerUserId, ...scope, operationKind: "append", expectedTurnNumber: 4,
        query: "harbor", expectedBaseIdentity: frozen.baseIdentity, storyMemoryPolicy });
    });
    expect(captured.authority.optionalFactFrontier?.facts).toEqual(facts);
    expect(captured.authority.protectedFacts).toHaveLength(910);
    expect(captured.authority.currentContinuity.canonicalFacts).toEqual(facts);
    const frozenCapture = JSON.stringify(captured);
    const sourceBefore = await pool.query("SELECT state_snapshot_private FROM campaign_state_edits WHERE id=$1", [edit.rows[0]!.id]);
    const provider = { id: "test-provider", name: "Test provider", providerRole: "text", baseUrl: "http://127.0.0.1:1", providerType: "openai_compatible", model: "test-model", contextWindowTokens: 6_100,
      maxOutputTokens: 100, temperature: 0, requestTimeoutMs: 1_000, configuration: {},
      async execute(): Promise<never> { throw new Error("Planning must not dispatch a provider request."); } } as const;
    const planned = planGenerationPromptContext(captured, provider, "System", "Continue", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "scene", 6_000, 6_000, "fact-budget-test", "story_memory",
      policy, undefined, undefined, undefined, HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION);
    const body = JSON.parse(serializeProviderRequest(provider, { systemPrompt: "System", input: planned.storyInput }).body);
    const sent = JSON.parse(body.messages.find((message: { role: string }) => message.role === "user").content).authoritative_context;
    const selected = sent.protectedFacts as { id: string; content: string; turnNumber: number }[];
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.length).toBeLessThan(910);
    expect(selected).toEqual(facts.slice(-selected.length).map((fact) => ({ ...fact, turnNumber: 3 })));
    expect(sent.currentContinuity.canonicalFacts).toEqual([]);
    for (const fact of selected) expect(planned.storyInput.split(fact.content)).toHaveLength(2);
    expect(planned.storyInput).not.toContain(facts[0]!.content);
    expect(planned.contextPlan.contextTokens).toBeLessThanOrEqual(6_000);
    expect(planned.contextPlan.requestTokens + planned.contextPlan.safetyAllowanceTokens).toBeLessThanOrEqual(6_000);
    expect(JSON.stringify(captured)).toBe(frozenCapture);
    expect((await pool.query("SELECT state_snapshot_private FROM campaign_state_edits WHERE id=$1", [edit.rows[0]!.id])).rows).toEqual(sourceBefore.rows);

    expect((await pool.query("SELECT id FROM campaign_canonical_facts WHERE campaign_id=$1", [scope.campaignId])).rows).toHaveLength(910);
  });

  it("accepts a turn-zero correction fact only when its complete correction source verifies", async () => {
    const scope = await fixture();
    const factId = crypto.randomUUID();
    const content = "The corrected harbor charter forbids midnight crossings.";
    const edit = await pool.query<{ id: string }>(`INSERT INTO campaign_state_edits(owner_user_id,campaign_id,revision,effective_turn_number,state_snapshot_private)
      VALUES($1,$2,1,0,$3::jsonb) RETURNING id`, [ownerUserId, scope.campaignId, JSON.stringify({ canonicalFacts: [{ id: factId, content }] })]);
    await pool.query(`INSERT INTO campaign_canonical_facts(id,owner_user_id,campaign_id,world_version_id,source_state_edit_id,source_turn_number,source_fact_index,content,normalized_content,valid_from_turn)
      VALUES($1,$2,$3,$4,$5,0,0,$6,lower($6),0)`, [factId, ownerUserId, scope.campaignId, scope.worldVersionId, edit.rows[0]!.id, content]);

    await expect(load(scope)).resolves.toMatchObject({
      facts: [{ id: factId, turnNumber: 0, content }], omittedCount: 0
    });
  });

  it("accounts for unique source bytes once for a fact-dense accepted snapshot", async () => {
    const scope = await fixture();
    const canonicalFacts = Array.from({ length: 100 }, (_, index) => `Fact ${index}: ${"x".repeat(3_990)}`);
    const snapshot = { canonicalFacts, canonicalFactUpdates: [] };
    const turnId = await acceptedTurn(scope.campaignId, 1, snapshot);
    const facts = buildCanonicalChronicleFacts({ campaignId: scope.campaignId, turnId, ...snapshot, entityCatalog: [] });
    for (const fact of facts) await insertAcceptedFact(scope, turnId, 1, fact);
    const startedAt = performance.now();
    const result = await load(scope);
    const elapsedMs = Math.round((performance.now() - startedAt) * 100) / 100;

    expect(result.facts).toHaveLength(100);
    expect(result.candidateRows).toBe(100);
    expect(result.sourceBytes).toBeGreaterThan(390_000);
    expect(result.sourceBytes).toBeLessThan(500_000);
    expect(elapsedMs).toBeLessThan(5_000);
    process.stderr.write(`${JSON.stringify({ protectedFactSourceMetrics: { candidateRows: result.candidateRows, sourceBytes: result.sourceBytes, elapsedMs } })}\n`);
  });

  it("retains all verified sources when aggregate source bytes exceed one megabyte", async () => {
    const scope = await fixture();
    for (const turnNumber of [1, 2, 3]) {
      const canonicalFacts = Array.from({ length: 100 }, (_, index) => `Turn ${turnNumber} fact ${index}: ${"y".repeat(3_980)}`);
      const snapshot = { canonicalFacts, canonicalFactUpdates: [] };
      const turnId = await acceptedTurn(scope.campaignId, turnNumber, snapshot);
      const facts = buildCanonicalChronicleFacts({ campaignId: scope.campaignId, turnId, ...snapshot, entityCatalog: [] });
      for (const fact of facts) await insertAcceptedFact(scope, turnId, turnNumber, fact);
    }
    const result = await load(scope);

    expect(result.candidateRows).toBe(300);
    expect(result.sourceBytes).toBeGreaterThan(1_000_000);
    expect(result.facts).toHaveLength(300);
    expect(result.omittedCount).toBe(0);
  });

  it("retains verified older facts beyond 512 candidates while excluding invalid newer sources", async () => {
    const scope = await fixture();
    const oldSnapshot = { canonicalFacts: ["The old moon lens is silver.", "Its sibling lens is blue."], canonicalFactUpdates: [] };
    const oldTurnId = await acceptedTurn(scope.campaignId, 1, oldSnapshot);
    const [oldFact, sibling] = buildCanonicalChronicleFacts({ campaignId: scope.campaignId, turnId: oldTurnId, ...oldSnapshot, entityCatalog: [] });
    await insertAcceptedFact(scope, oldTurnId, 1, oldFact!);
    await insertAcceptedFact(scope, oldTurnId, 1, sibling!);
    const newerTurnId = await acceptedTurn(scope.campaignId, 2, { canonicalFacts: [], canonicalFactUpdates: [] });
    await pool.query(`INSERT INTO campaign_canonical_facts
      (id,owner_user_id,campaign_id,world_version_id,source_turn_id,source_turn_number,source_fact_index,content,normalized_content,valid_from_turn)
      SELECT gen_random_uuid(),$1,$2,$3,$4,2,n,'newer distractor ' || n, 'newer distractor ' || n,2
        FROM generate_series(1,513) n`, [ownerUserId, scope.campaignId, scope.worldVersionId, newerTurnId]);
    const capturedFrontier = { stateEditId: crypto.randomUUID(), effectiveTurnNumber: 0, facts: [] };

    expect((await load(scope)).facts.map((fact) => fact.id)).toEqual([oldFact!.id, sibling!.id]);
    const client = await pool.connect();
    try {
      await expect(verifyCapturedOptionalGenerationFacts(client, { ownerUserId, ...scope }, 3,
        [oldFact!.id, sibling!.id], capturedFrontier)).resolves.toEqual(expect.arrayContaining([oldFact!.id, sibling!.id]));
    } finally { client.release(); }
  });

  it("withholds foreign, retired, future, mismatched, imported, and missing projection candidates without repairing rows", async () => {
    const scope = await fixture(10);
    const other = await fixture();
    const seedFact = async (turnNumber: number, sourceContent: string, storedContent = sourceContent,
      options: { factIndex?: number; validFromTurn?: number; validUntilTurn?: number } = {}) => {
      const snapshot = { canonicalFacts: [sourceContent], canonicalFactUpdates: [] };
      const turnId = await acceptedTurn(scope.campaignId, turnNumber, snapshot);
      const fact = buildCanonicalChronicleFacts({ campaignId: scope.campaignId, turnId, ...snapshot, entityCatalog: [] })[0]!;
      await insertAcceptedFact(scope, turnId, turnNumber, { ...fact, factIndex: options.factIndex ?? 0, content: storedContent });
      if (options.validFromTurn !== undefined || options.validUntilTurn !== undefined) {
        await pool.query("UPDATE campaign_canonical_facts SET valid_from_turn=COALESCE($2,valid_from_turn), valid_until_turn=$3 WHERE id=$1",
          [fact.id, options.validFromTurn ?? null, options.validUntilTurn ?? null]);
      }
      await insertChronicleFact(scope, turnId, turnNumber, { id: fact.id, content: storedContent });
      return { ...fact, content: storedContent, turnId };
    };
    const corrected = await seedFact(1, "The moon vault old seal was explicitly erased.");
    const badIndex = await seedFact(2, "The moon vault index seal has a bad source index.", undefined, { factIndex: 9 });
    const badText = await seedFact(3, "The moon vault source seal matches its accepted turn.", "The moon vault forged seal has different source text.");
    const inactive = await seedFact(4, "The moon vault inactive seal has expired.", undefined, { validUntilTurn: 10 });
    const future = await seedFact(5, "The moon vault future seal is not active yet.", undefined, { validFromTurn: 11 });
    const missingTurnId = await acceptedTurn(scope.campaignId, 6, { canonicalFacts: [], canonicalFactUpdates: [] });
    const missing = { id: crypto.randomUUID(), content: "The moon vault missing-source seal is invalid." };
    await pool.query(`INSERT INTO campaign_canonical_facts(id,owner_user_id,campaign_id,world_version_id,source_turn_id,source_turn_number,source_fact_index,content,normalized_content,valid_from_turn)
      VALUES($1,$2,$3,$4,$5,6,0,$6,lower($6),6)`, [missing.id, ownerUserId, scope.campaignId, scope.worldVersionId, missingTurnId, missing.content]);
    await insertChronicleFact(scope, missingTurnId, 6, missing);
    await pool.query(`INSERT INTO campaign_canonical_facts(id,owner_user_id,campaign_id,world_version_id,source_turn_id,source_turn_number,source_fact_index,content,normalized_content,valid_from_turn)
      VALUES($1,$2,$3,$4,$5,6,1,$6,lower($6),6)`, [crypto.randomUUID(), ownerUserId, scope.campaignId, scope.worldVersionId, missingTurnId, "z".repeat(16_001)]);
    await acceptedTurn(scope.campaignId, 7, { canonicalFacts: [], canonicalFactUpdates: [] });
    await acceptedTurn(scope.campaignId, 8, { canonicalFacts: [], canonicalFactUpdates: [] });
    await pool.query(`INSERT INTO campaign_state_edits(owner_user_id,campaign_id,revision,effective_turn_number,state_snapshot_private)
      VALUES($1,$2,1,8,$3::jsonb)`, [ownerUserId, scope.campaignId, JSON.stringify({ continuitySummary: "", scratchpad: "", openThreads: [],
      canonicalFacts: [], trackers: [], rpgStats: [], eventTriggers: [], pendingEventTriggers: [] })]);
    const importedText = "The moon vault imported seal has no accepted source ID.";
    await pool.query("UPDATE campaign_state SET initial_state_snapshot=$2::jsonb WHERE campaign_id=$1",
      [scope.campaignId, JSON.stringify({ canonicalFacts: [{ id: null, content: importedText }] })]);
    const retained = await seedFact(9, "The moon vault retained seal remains secure.");
    await acceptedTurn(scope.campaignId, 10, { canonicalFacts: [], canonicalFactUpdates: [] });
    const foreignSnapshot = { canonicalFacts: ["The moon vault foreign seal is a canary."], canonicalFactUpdates: [] };
    const foreignTurnId = await acceptedTurn(other.campaignId, 1, foreignSnapshot);
    const foreign = buildCanonicalChronicleFacts({ campaignId: other.campaignId, turnId: foreignTurnId, ...foreignSnapshot, entityCatalog: [] })[0]!;
    await insertAcceptedFact(other, foreignTurnId, 1, foreign);
    const before = await pool.query("SELECT id,content,source_turn_id,source_state_edit_id,source_fact_index,valid_from_turn,valid_until_turn FROM campaign_canonical_facts WHERE campaign_id=$1 ORDER BY id", [scope.campaignId]);
    const turnsBefore = await pool.query("SELECT turn_number,state_snapshot_private FROM turns WHERE campaign_id=$1 ORDER BY turn_number", [scope.campaignId]);
    const correctionsBefore = await pool.query("SELECT id,state_snapshot_private FROM campaign_state_edits WHERE campaign_id=$1 ORDER BY revision", [scope.campaignId]);
    const campaignStateBefore = await pool.query("SELECT initial_state_snapshot FROM campaign_state WHERE campaign_id=$1", [scope.campaignId]);

    const result = await load(scope, 10);

    expect(result.facts).toEqual([{ id: retained.id, turnNumber: 9, content: retained.content }]);
    expect(result.facts.map((fact) => fact.id)).not.toContain(future.id);
    expect(result.facts.map((fact) => fact.id)).not.toContain(foreign.id);
    expect(result.coverage.futureSourceCount).toBe(0);
    expect(result.coverage.oversizedCandidateCount).toBe(1);
    expect(result.coverage.withheldCandidateCount).toBe(5);
    const client = await pool.connect();
    try {
      await expect(loadVerifiedProtectedFacts(client, { ...scope, ownerUserId: crypto.randomUUID() }, 10)).resolves.toMatchObject({ facts: [] });
      await expect(loadVerifiedProtectedFacts(client, { ...scope, ownerUserId, worldVersionId: other.worldVersionId }, 10)).resolves.toMatchObject({ facts: [] });
    } finally { client.release(); }
    await expect(pool.query("SELECT id,content,source_turn_id,source_state_edit_id,source_fact_index,valid_from_turn,valid_until_turn FROM campaign_canonical_facts WHERE campaign_id=$1 ORDER BY id", [scope.campaignId])).resolves.toMatchObject({ rows: before.rows });

    const composed = await planV5Request(scope, 11, "Recall every moon vault seal and its current condition.");
    expect(composed.authority.authority.optionalFactFrontier).toMatchObject({ effectiveTurnNumber: 8, facts: [] });
    const withheld = [corrected, badIndex, badText, inactive, future, missing, { id: foreign.id, content: foreign.content }];
    for (const fact of withheld) {
      expect(composed.retrieved.candidates.some((candidate) => candidate.id === fact.id)).toBe(false);
      expect(composed.requestBody).not.toContain(fact.content);
      expect(composed.manifest.entries.some((entry) => entry.canonicalFactId === fact.id)).toBe(false);
    }
    expect(composed.requestBody).toContain(retained.content);
    expect(composed.requestBody).not.toContain(importedText);
    expect(composed.manifest.entries.some((entry) => entry.content === importedText)).toBe(false);
    const sourceAfter = await pool.query("SELECT id,content,source_turn_id,source_state_edit_id,source_fact_index,valid_from_turn,valid_until_turn FROM campaign_canonical_facts WHERE campaign_id=$1 ORDER BY id", [scope.campaignId]);
    expect(sourceAfter.rows).toEqual(before.rows);
    expect((await pool.query("SELECT turn_number,state_snapshot_private FROM turns WHERE campaign_id=$1 ORDER BY turn_number", [scope.campaignId])).rows).toEqual(turnsBefore.rows);
    expect((await pool.query("SELECT id,state_snapshot_private FROM campaign_state_edits WHERE campaign_id=$1 ORDER BY revision", [scope.campaignId])).rows).toEqual(correctionsBefore.rows);
    expect((await pool.query("SELECT initial_state_snapshot FROM campaign_state WHERE campaign_id=$1", [scope.campaignId])).rows).toEqual(campaignStateBefore.rows);
  });

  it("withholds explicit-ID accepted and correction facts when only their source indices are tampered", async () => {
    const acceptedScope = await fixture();
    const acceptedId = crypto.randomUUID();
    const acceptedContent = "The explicit accepted fact keeps its source slot.";
    const acceptedTurnId = await acceptedTurn(acceptedScope.campaignId, 1, { canonicalFacts: [{ id: acceptedId, content: acceptedContent }], canonicalFactUpdates: [] });
    await pool.query(`INSERT INTO campaign_canonical_facts(id,owner_user_id,campaign_id,world_version_id,source_turn_id,source_turn_number,source_fact_index,content,normalized_content,valid_from_turn)
      VALUES($1,$2,$3,$4,$5,1,1,$6,lower($6),1)`, [acceptedId, ownerUserId, acceptedScope.campaignId, acceptedScope.worldVersionId, acceptedTurnId, acceptedContent]);
    const correctionScope = await fixture();
    const correctionId = crypto.randomUUID();
    const correctionContent = "The explicit correction fact keeps its source slot.";
    const edit = await pool.query<{ id: string }>(`INSERT INTO campaign_state_edits(owner_user_id,campaign_id,revision,effective_turn_number,state_snapshot_private)
      VALUES($1,$2,1,0,$3::jsonb) RETURNING id`, [ownerUserId, correctionScope.campaignId, JSON.stringify({ canonicalFacts: [{ id: correctionId, content: correctionContent }] })]);
    await pool.query(`INSERT INTO campaign_canonical_facts(id,owner_user_id,campaign_id,world_version_id,source_state_edit_id,source_turn_number,source_fact_index,content,normalized_content,valid_from_turn)
      VALUES($1,$2,$3,$4,$5,0,1,$6,lower($6),0)`, [correctionId, ownerUserId, correctionScope.campaignId, correctionScope.worldVersionId, edit.rows[0]!.id, correctionContent]);

    await expect(load(acceptedScope)).resolves.toMatchObject({ facts: [] });
    await expect(load(correctionScope)).resolves.toMatchObject({ facts: [] });
  });

  it("retains reordered correction IDs from their original source while withholding a tampered new correction ID", async () => {
    const scope = await fixture();
    const removedId = crypto.randomUUID();
    const retainedId = crypto.randomUUID();
    const newId = crypto.randomUUID();
    const removedContent = "The discarded harbor watch no longer applies.";
    const retainedContent = "The retained harbor watch stays in force.";
    const newContent = "The new correction has a tampered source slot.";
    const sourceSnapshot = { canonicalFacts: [
      { id: removedId, content: removedContent },
      { id: retainedId, content: retainedContent }
    ], canonicalFactUpdates: [] };
    const sourceTurnId = await acceptedTurn(scope.campaignId, 1, sourceSnapshot);
    await insertAcceptedFact(scope, sourceTurnId, 1, { id: removedId, content: removedContent, factIndex: 0 });
    await insertAcceptedFact(scope, sourceTurnId, 1, { id: retainedId, content: retainedContent, factIndex: 1 });
    const correctionSnapshot = {
      continuitySummary: "", scratchpad: "", openThreads: [], trackers: [], rpgStats: [], eventTriggers: [], pendingEventTriggers: [],
      canonicalFacts: [{ id: retainedId, content: retainedContent }, { id: newId, content: newContent }]
    };
    const correction = await pool.query<{ id: string }>(`INSERT INTO campaign_state_edits(owner_user_id,campaign_id,revision,effective_turn_number,state_snapshot_private)
      VALUES($1,$2,1,3,$3::jsonb) RETURNING id`, [ownerUserId, scope.campaignId, JSON.stringify(correctionSnapshot)]);
    await pool.query("UPDATE campaign_canonical_facts SET valid_until_turn=3 WHERE id=$1", [removedId]);
    await pool.query(`INSERT INTO campaign_canonical_facts(id,owner_user_id,campaign_id,world_version_id,source_state_edit_id,source_turn_number,source_fact_index,content,normalized_content,valid_from_turn)
      VALUES($1,$2,$3,$4,$5,3,7,$6,lower($6),3)`, [newId, ownerUserId, scope.campaignId, scope.worldVersionId, correction.rows[0]!.id, newContent]);
    const before = await pool.query("SELECT id,source_turn_id,source_state_edit_id,source_fact_index,valid_until_turn FROM campaign_canonical_facts WHERE campaign_id=$1 ORDER BY id", [scope.campaignId]);

    await expect(loadCorrection(scope)).resolves.toMatchObject({
      canonicalFacts: [{ id: retainedId, content: retainedContent }, { id: newId, content: newContent }]
    });
    await expect(loadCorrection(scope, true)).resolves.toMatchObject({
      canonicalFacts: [{ id: retainedId, content: retainedContent }, { id: null, content: newContent }]
    });
    await expect(load(scope)).resolves.toMatchObject({
      facts: [{ id: retainedId, turnNumber: 1, content: retainedContent }]
    });
    await expect(pool.query("SELECT id,source_turn_id,source_state_edit_id,source_fact_index,valid_until_turn FROM campaign_canonical_facts WHERE campaign_id=$1 ORDER BY id", [scope.campaignId])).resolves.toMatchObject({ rows: before.rows });
  });
});
