import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { loadVerifiedProtectedFacts } from "../../packages/database/src/campaign-continuity-repository.js";
import { buildCanonicalChronicleFacts } from "../../packages/domain/src/chronicle-memory-helpers.js";

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

  async function fixture() {
    const world = await pool.query<{ id: string }>("INSERT INTO worlds(owner_user_id,title) VALUES($1,$2) RETURNING id", [ownerUserId, `Protected facts ${crypto.randomUUID()}`]);
    const version = await pool.query<{ id: string }>("INSERT INTO world_versions(owner_user_id,world_id,version_number,content) VALUES($1,$2,1,$3::jsonb) RETURNING id", [ownerUserId, world.rows[0]!.id, JSON.stringify({ world: { title: "Protected facts" } })]);
    const campaign = await pool.query<{ id: string }>("INSERT INTO campaigns(owner_user_id,world_version_id,title,active_turn_number) VALUES($1,$2,$3,3) RETURNING id", [ownerUserId, version.rows[0]!.id, "Protected facts"]);
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

  async function load(scope: { campaignId: string; worldVersionId: string }, baseTurnNumber = 3) {
    const client = await pool.connect();
    try { return await loadVerifiedProtectedFacts(client, { ownerUserId, ...scope }, baseTurnNumber); }
    finally { client.release(); }
  }

  it("suppresses stale pre-frontier rows after an empty correction while retaining a later accepted fact without repairing projection", async () => {
    const scope = await fixture();
    const oldSnapshot = { canonicalFacts: ["The old harbor gate is open."], canonicalFactUpdates: [] };
    const oldTurnId = await acceptedTurn(scope.campaignId, 1, oldSnapshot);
    const old = buildCanonicalChronicleFacts({ campaignId: scope.campaignId, turnId: oldTurnId, ...oldSnapshot, entityCatalog: [] })[0]!;
    await insertAcceptedFact(scope, oldTurnId, 1, old);
    await pool.query(`INSERT INTO campaign_state_edits(owner_user_id,campaign_id,revision,effective_turn_number,state_snapshot_private)
      VALUES($1,$2,1,2,$3::jsonb)`, [ownerUserId, scope.campaignId, JSON.stringify({ canonicalFacts: [] })]);
    const laterSnapshot = { canonicalFacts: ["A brass key hangs above the harbor gate."], canonicalFactUpdates: [] };
    const laterTurnId = await acceptedTurn(scope.campaignId, 3, laterSnapshot);
    const later = buildCanonicalChronicleFacts({ campaignId: scope.campaignId, turnId: laterTurnId, ...laterSnapshot, entityCatalog: [] })[0]!;
    await insertAcceptedFact(scope, laterTurnId, 3, later);
    const before = await pool.query("SELECT id,valid_until_turn FROM campaign_canonical_facts WHERE campaign_id=$1 ORDER BY id", [scope.campaignId]);

    const result = await load(scope);

    expect(result.facts).toEqual([{ id: later.id, turnNumber: 3, content: later.content }]);
    expect(result.omittedCount).toBe(1);
    expect(result.candidateRows).toBe(2);
    expect(result.sourceBytes).toBeGreaterThan(0);
    await expect(pool.query("SELECT id,valid_until_turn FROM campaign_canonical_facts WHERE campaign_id=$1 ORDER BY id", [scope.campaignId])).resolves.toMatchObject({ rows: before.rows });
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

  it("bounds unique source bytes once for a fact-dense maximum snapshot", async () => {
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

  it("caps many distinct verified sources by bytes before source materialization", async () => {
    const scope = await fixture();
    for (const turnNumber of [1, 2, 3]) {
      const canonicalFacts = Array.from({ length: 80 }, (_, index) => `Turn ${turnNumber} fact ${index}: ${"y".repeat(3_980)}`);
      const snapshot = { canonicalFacts, canonicalFactUpdates: [] };
      const turnId = await acceptedTurn(scope.campaignId, turnNumber, snapshot);
      const facts = buildCanonicalChronicleFacts({ campaignId: scope.campaignId, turnId, ...snapshot, entityCatalog: [] });
      for (const fact of facts) await insertAcceptedFact(scope, turnId, turnNumber, fact);
    }
    const result = await load(scope);

    expect(result.candidateRows).toBe(240);
    expect(result.sourceBytes).toBeLessThanOrEqual(1_000_000);
    expect(result.facts.length).toBeGreaterThan(0);
    expect(result.facts.length).toBeLessThanOrEqual(240);
    expect(result.omittedCount).toBe(240 - result.facts.length);
  });

  it("withholds foreign, retired, future, mismatched, imported, and missing projection candidates without repairing rows", async () => {
    const scope = await fixture();
    const other = await fixture();
    const snapshot = { canonicalFacts: ["The retained seal is silver.", "The index must match.", "The source text must match.", "The retired fact is gone.", "The missing projection never arrives."], canonicalFactUpdates: [] };
    const turnId = await acceptedTurn(scope.campaignId, 1, snapshot);
    const facts = buildCanonicalChronicleFacts({ campaignId: scope.campaignId, turnId, ...snapshot, entityCatalog: [] });
    await insertAcceptedFact(scope, turnId, 1, facts[0]!);
    await insertAcceptedFact(scope, turnId, 1, { ...facts[1]!, factIndex: 9 });
    await pool.query(`INSERT INTO campaign_canonical_facts(id,owner_user_id,campaign_id,world_version_id,source_turn_id,source_turn_number,source_fact_index,content,normalized_content,valid_from_turn)
      VALUES($1,$2,$3,$4,$5,1,2,'The projection text differs.','the projection text differs.',1)`, [facts[2]!.id, ownerUserId, scope.campaignId, scope.worldVersionId, turnId]);
    await insertAcceptedFact(scope, turnId, 1, facts[3]!);
    await pool.query("UPDATE campaign_canonical_facts SET valid_until_turn=3 WHERE id=$1", [facts[3]!.id]);
    await pool.query(`INSERT INTO campaign_state_edits(owner_user_id,campaign_id,revision,effective_turn_number,state_snapshot_private)
      VALUES($1,$2,1,2,$3::jsonb)`, [ownerUserId, scope.campaignId, JSON.stringify({ canonicalFacts: [{ id: facts[0]!.id, content: facts[0]!.content }] })]);
    const futureSnapshot = { canonicalFacts: ["The future row is not authority yet."], canonicalFactUpdates: [] };
    const futureTurnId = await acceptedTurn(scope.campaignId, 4, futureSnapshot);
    const future = buildCanonicalChronicleFacts({ campaignId: scope.campaignId, turnId: futureTurnId, ...futureSnapshot, entityCatalog: [] })[0]!;
    await pool.query(`INSERT INTO campaign_canonical_facts(id,owner_user_id,campaign_id,world_version_id,source_turn_id,source_turn_number,source_fact_index,content,normalized_content,valid_from_turn)
      VALUES($1,$2,$3,$4,$5,4,0,$6,lower($6),1)`, [future.id, ownerUserId, scope.campaignId, scope.worldVersionId, futureTurnId, future.content]);
    await pool.query(`INSERT INTO campaign_canonical_facts(id,owner_user_id,campaign_id,world_version_id,source_turn_id,source_turn_number,source_fact_index,content,normalized_content,valid_from_turn)
      VALUES($1,$2,$3,$4,$5,1,7,$6,lower($6),1)`, [crypto.randomUUID(), ownerUserId, scope.campaignId, scope.worldVersionId, turnId, "z".repeat(16_001)]);
    const foreignTurnId = await acceptedTurn(other.campaignId, 1, { canonicalFacts: ["Foreign fact."], canonicalFactUpdates: [] });
    const foreign = buildCanonicalChronicleFacts({ campaignId: other.campaignId, turnId: foreignTurnId, canonicalFacts: ["Foreign fact."], entityCatalog: [] })[0]!;
    await insertAcceptedFact(other, foreignTurnId, 1, foreign);
    await pool.query("UPDATE campaign_state SET initial_state_snapshot=$2::jsonb WHERE campaign_id=$1", [scope.campaignId, JSON.stringify({ canonicalFacts: [{ id: null, content: "Imported facts have no protected ID." }] })]);
    const before = await pool.query("SELECT id,content,source_fact_index,valid_until_turn FROM campaign_canonical_facts WHERE campaign_id=$1 ORDER BY id", [scope.campaignId]);

    const result = await load(scope);

    expect(result.facts).toEqual([{ id: facts[0]!.id, turnNumber: 1, content: facts[0]!.content }]);
    expect(result.facts.map((fact) => fact.id)).not.toContain(future.id);
    expect(result.facts.map((fact) => fact.id)).not.toContain(foreign.id);
    expect(result.coverage.futureSourceCount).toBe(1);
    expect(result.coverage.oversizedCandidateCount).toBe(1);
    expect(result.coverage.withheldCandidateCount).toBeGreaterThanOrEqual(4);
    const client = await pool.connect();
    try {
      await expect(loadVerifiedProtectedFacts(client, { ...scope, ownerUserId: crypto.randomUUID() }, 3)).resolves.toMatchObject({ facts: [] });
      await expect(loadVerifiedProtectedFacts(client, { ...scope, ownerUserId, worldVersionId: other.worldVersionId }, 3)).resolves.toMatchObject({ facts: [] });
    } finally { client.release(); }
    await expect(pool.query("SELECT id,content,source_fact_index,valid_until_turn FROM campaign_canonical_facts WHERE campaign_id=$1 ORDER BY id", [scope.campaignId])).resolves.toMatchObject({ rows: before.rows });
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
});
