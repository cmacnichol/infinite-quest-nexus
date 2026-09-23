import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { loadPostgresChronicleGenerationCandidates } from "../../packages/database/src/chronicle-context-repository.js";
import { defaultStoryMemoryPolicy, storyMemoryPolicyHash } from "../../packages/contracts/src/story-memory-policy.js";
import type { ChronicleGenerationTransactionDependencies } from "../../packages/database/src/chronicle-repository.js";
import { HISTORICAL_FACT_POOL_SQL, historicalFactAliasPatterns } from "../../packages/database/src/chronicle-historical-fact-pool.js";
import { writeFile } from "node:fs/promises";
import type { CastGenerationSnapshot } from "../../packages/contracts/src/campaign-cast-context.js";

const integration = process.env.TEST_DATABASE_URL ? describe.sequential : describe.skip;
const unavailable = async (): Promise<never> => { throw new Error("This lexical fixture must never call a provider."); };
const dependencies: ChronicleGenerationTransactionDependencies = { embeddings: {
  resolve: unavailable, load: unavailable, embed: unavailable, fingerprint: unavailable,
  recordHealth: unavailable, recordCost: unavailable, logDiagnostic() {}
} };
const policy = defaultStoryMemoryPolicy("r1");
const storyMemoryPolicy = { policy, policyHash: storyMemoryPolicyHash(policy),
  contextProtocol: "current-continuity-v3" as const, promptProtocol: "story-v14-continuity-context" as const,
  providerConfigurationFingerprint: "a".repeat(64) };

integration("Historical fact candidate lanes", () => {
  let pool: DatabasePool;
  let ownerUserId: string;
  beforeAll(async () => {
    pool = createDatabasePool(process.env.TEST_DATABASE_URL!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });
  afterAll(async () => { await pool?.end(); });

  async function fixture(count = 320) {
    const world = await pool.query<{ id: string }>("INSERT INTO worlds(owner_user_id,title) VALUES($1,'Historical fixture') RETURNING id", [ownerUserId]);
    const version = await pool.query<{ id: string }>("INSERT INTO world_versions(owner_user_id,world_id,version_number,content) VALUES($1,$2,1,$3) RETURNING id", [ownerUserId, world.rows[0]!.id,
      JSON.stringify({ world: { title: "Fixture" }, entities: [{ id: "zephyra", name: "Zephyra", aliases: ["Blue Keeper"], kind: "character" }] })]);
    const campaign = await pool.query<{ id: string }>("INSERT INTO campaigns(owner_user_id,world_version_id,title,active_turn_number) VALUES($1,$2,'Fixture',3) RETURNING id", [ownerUserId, version.rows[0]!.id]);
    const scope = { ownerUserId, campaignId: campaign.rows[0]!.id, worldVersionId: version.rows[0]!.id };
    await pool.query("INSERT INTO campaign_state(owner_user_id,campaign_id) VALUES($1,$2)", [ownerUserId, scope.campaignId]);
    await pool.query("INSERT INTO turns(owner_user_id,campaign_id,turn_number,action,narration) SELECT $1,$2,n,'Wait','The courtyard is quiet.' FROM generate_series(1,3) n", [ownerUserId, scope.campaignId]);
    await pool.query(`INSERT INTO campaign_canonical_facts(id,owner_user_id,campaign_id,world_version_id,source_turn_id,source_turn_number,source_fact_index,content,normalized_content,valid_from_turn)
      SELECT gen_random_uuid(),$1,$2,$3,t.id,2,n,'Unrelated lantern number ' || n,'unrelated lantern number ' || n,2
      FROM turns t CROSS JOIN generate_series(1,$4::integer) n WHERE t.campaign_id=$2 AND t.turn_number=2`, [ownerUserId, scope.campaignId, scope.worldVersionId, count]);
    const fact = async (content: string, index: number, ids: string[] = [], ordinal = 1) => {
      const result = await pool.query<{ id: string }>(`INSERT INTO campaign_canonical_facts(id,owner_user_id,campaign_id,world_version_id,source_turn_id,source_turn_number,source_fact_index,content,normalized_content,valid_from_turn,entity_ids)
        SELECT gen_random_uuid(),$1,$2,$3,id,$7,$5,$4,lower($4),$7,$6::text[] FROM turns WHERE campaign_id=$2 AND turn_number=$7 RETURNING id`,
      [ownerUserId, scope.campaignId, scope.worldVersionId, content, index, ids, ordinal]);
      return result.rows[0]!.id;
    };
    const read = async (query: string, enrolled = true, cutoff = 3, castSnapshot?: CastGenerationSnapshot) => {
      const client = await pool.connect();
      try { return await loadPostgresChronicleGenerationCandidates(client, { ...scope, query, throughTurnNumber: cutoff, retrievalBudgetTokens: 32_000,
        ...(enrolled ? { storyMemoryPolicy: castSnapshot ? { ...storyMemoryPolicy, castContext: true,
          promptProtocol: "story-v17-campaign-cast", contextProtocol: "current-continuity-v4" } : storyMemoryPolicy } : {}),
        ...(castSnapshot ? { castSnapshot } : {}) }, dependencies, { useSavepoints: false }); }
      finally { client.release(); }
    };
    return { ...scope, fact, read };
  }

  it("retrieves older cast-name facts through a captured alias with stale derived entity IDs", async () => {
    const value = await fixture(500);
    const wanted = await value.fact("Mara hides the silver compass.", 0);
    const foreign = await fixture();
    const foreignFact = await foreign.fact("Mara hides a foreign campaign secret.", 0);
    const characterId = crypto.randomUUID();
    const cast: CastGenerationSnapshot = { version: "cast-context-v1", scope: { ownerUserId, campaignId: value.campaignId }, worldVersionId: value.worldVersionId,
      revision: 1, boundary: { turnNumber: 3, timelineRevision: 0 }, coverageStartTurn: 1, trackedThroughTurn: 3, discoveryStatus: "current",
      characters: [{ id: characterId, name: "Mara", aliases: ["The Watcher"], origin: { kind: "manual" }, profile: {}, pinned: false, ignored: false,
        revision: 1, firstObservedTurn: 1, lastObservedTurn: 1 }], details: [{ characterId, observations: [], overrides: [] }] };
    const result = await value.read("Ask The Watcher", true, 3, cast);
    expect(result.candidates.map((candidate) => candidate.id)).toContain(wanted);
    expect(result.candidates.map((candidate) => candidate.id)).not.toContain(foreignFact);
    expect((await value.read("Ask The Watcher")).candidates.map((candidate) => candidate.id)).not.toContain(wanted);
    await expect(value.read("Ask The Watcher", true, 3, { ...cast, scope: { ...cast.scope, campaignId: foreign.campaignId } })).rejects.toThrow(/cast/i);
    await expect(value.read("Ask The Watcher", true, 2, cast)).rejects.toThrow(/cast/i);
    expect((await pool.query("SELECT entity_ids FROM campaign_canonical_facts WHERE id=$1", [wanted])).rows[0].entity_ids).toEqual([]);
    const otherId = crypto.randomUUID();
    const ambiguous = { ...cast, characters: [...cast.characters, { ...cast.characters[0]!, id: otherId, name: "Sera" }],
      details: [...cast.details, { characterId: otherId, observations: [], overrides: [] }] };
    expect((await value.read("Ask The Watcher", true, 3, ambiguous)).candidates.map((candidate) => candidate.id)).not.toContain(wanted);
    ambiguous.characters[1]!.ignored = true;
    expect((await value.read("Ask The Watcher", true, 3, ambiguous)).candidates.map((candidate) => candidate.id)).not.toContain(wanted);
    await pool.query("INSERT INTO turns(owner_user_id,campaign_id,turn_number,action,narration) SELECT $1,$2,n,'Wait',CASE WHEN n=77 THEN 'Mara conceals the silver compass.' ELSE 'The courtyard is quiet.' END FROM generate_series(4,500) n", [ownerUserId, value.campaignId]);
    await pool.query("UPDATE campaigns SET active_turn_number=500 WHERE id=$1", [value.campaignId]);
    await pool.query(`INSERT INTO chronicle_memories(owner_user_id,campaign_id,world_version_id,turn_id,memory_kind,ordinal,content,token_estimate,importance,entities,entity_ids,metadata)
      SELECT $1,$2,$3,id,'turn_fiction',turn_number,narration,10,0.5,'{}','{}','{}' FROM turns WHERE campaign_id=$2`, [ownerUserId, value.campaignId, value.worldVersionId]);
    const laterCast = { ...cast, boundary: { ...cast.boundary, turnNumber: 500 }, trackedThroughTurn: 500 };
    expect((await value.read("Ask The Watcher", true, 500, laterCast)).candidates.some((candidate) => candidate.ordinal === 77 && candidate.kind === "turn_fiction")).toBe(true);
    expect((await value.read("Ask The Watcher", true, 500)).candidates.some((candidate) => candidate.ordinal === 77 && candidate.kind === "turn_fiction")).toBe(false);
  });

  it("recalls old exact and entity-linked facts before 300 newer distractors, preserving legacy calibration", async () => {
    const value = await fixture();
    const exact = await value.fact("The obsidian covenant seals the northern vault.", 0);
    const linked = await value.fact("Her only sibling remains imprisoned beneath the river.", 1, ["world:zephyra"]);
    const query = "Find Zephyra and investigate the obsidian covenant.";
    const legacy = await value.read(query, false);
    expect(legacy.candidates.map((candidate) => candidate.id)).not.toContain(exact);
    const current = await value.read(query);
    expect(current.candidates.map((candidate) => candidate.id)).toEqual(expect.arrayContaining([exact, linked]));
    expect(current.candidates).toHaveLength(256);
    expect(new Set(current.candidates.map((candidate) => candidate.id)).size).toBe(256);
  });

  it("uses historical validity and excludes future facts without a derived rebuild", async () => {
    const value = await fixture();
    const old = await value.fact("The obsidian covenant remains binding.", 0);
    const future = await value.fact("The obsidian covenant is dissolved.", 0, [], 3);
    await pool.query("UPDATE campaign_canonical_facts SET valid_until_turn=3,superseded_by_fact_id=$2 WHERE id=$1", [old, future]);
    expect((await value.read("obsidian covenant", true, 2)).candidates.map((candidate) => candidate.id)).toContain(old);
    const currentIds = (await value.read("obsidian covenant")).candidates.map((candidate) => candidate.id);
    expect(currentIds).toContain(future);
    expect(currentIds).not.toContain(old);
  });

  it("recognizes only unambiguous whole aliases without adding entity identities", async () => {
    const value = await fixture();
    const alias = await value.fact("The Blue Keeper protects the ruined observatory.", 0);
    const partial = await value.fact("The Blue Keeperette is an unrelated boat.", 1);
    const unicode = await value.fact("守り手 watches the distant bridge.", 2);
    const ambiguous = await value.fact("The Twin remains by the wall.", 3);
    const catalog = [
      { id: "world:zephyra", displayName: "Zephyra", aliases: ["Blue Keeper"], kind: "character", source: "world" as const },
      { id: "world:akira", displayName: "アキラ", aliases: ["守り手"], kind: "character", source: "world" as const },
      { id: "world:twin1", displayName: "Twin", aliases: [], kind: "character", source: "world" as const },
      { id: "world:twin2", displayName: "Twin", aliases: [], kind: "character", source: "world" as const }
    ];
    const rows = await pool.query<{ id: string; entity_ids: string[]; metadata: { historicalEntityMatch: boolean } }>(HISTORICAL_FACT_POOL_SQL,
      [ownerUserId, value.campaignId, value.worldVersionId, 3, 256, ["Blue Keeper Twin 守り手"], catalog.map((entity) => entity.id),
        historicalFactAliasPatterns(catalog, catalog.map((entity) => entity.id)), null]);
    const byId = new Map(rows.rows.map((row) => [row.id, row]));
    expect(byId.get(alias)?.metadata.historicalEntityMatch).toBe(true);
    expect(byId.get(unicode)?.metadata.historicalEntityMatch).toBe(true);
    expect(byId.get(partial)?.metadata.historicalEntityMatch).toBe(false);
    expect(byId.get(ambiguous)?.metadata.historicalEntityMatch).toBe(false);
    expect(byId.get(alias)?.entity_ids).toEqual([]);
    expect((await value.read("Find Zephyra")).candidates.map((candidate) => candidate.id)).toContain(alias);
  });

  it("fills exhausted lanes deterministically and keeps scopes isolated", async () => {
    const value = await fixture();
    const other = await fixture(0);
    const foreign = await other.fact("The obsidian covenant has a secret foreign clause.", 0);
    const first = await value.read("");
    expect(first.candidates).toHaveLength(256);
    expect((await value.read("")).candidates).toEqual(first.candidates);
    expect((await value.read("obsidian covenant")).candidates.map((candidate) => candidate.id)).not.toContain(foreign);
    const wrongOwner = await pool.query(HISTORICAL_FACT_POOL_SQL, [crypto.randomUUID(), value.campaignId, value.worldVersionId, 3, 256, ["lantern"], [], [], null]);
    const wrongWorld = await pool.query(HISTORICAL_FACT_POOL_SQL, [ownerUserId, value.campaignId, other.worldVersionId, 3, 256, ["lantern"], [], [], null]);
    expect(wrongOwner.rows).toEqual([]);
    expect(wrongWorld.rows).toEqual([]);
  });

  it("reserves an explicitly requested source turn without widening the cutoff", async () => {
    const value = await fixture();
    const target = await value.fact("The old crest carries a forgotten meaning.", 0);
    const future = await value.fact("The future crest has another meaning.", 0, [], 3);
    expect((await value.read("Recall accepted turn 1", true, 2)).candidates.map((candidate) => candidate.id)).toContain(target);
    expect((await value.read("Recall accepted turn 3", true, 2)).candidates.map((candidate) => candidate.id)).not.toContain(future);
  });

  it("retains valid correction-created facts and respects their later deletion", async () => {
    const value = await fixture();
    const id = crypto.randomUUID();
    const edit = await pool.query<{ id: string }>("INSERT INTO campaign_state_edits(owner_user_id,campaign_id,revision,effective_turn_number,state_snapshot_private) VALUES($1,$2,1,0,'{}') RETURNING id", [ownerUserId, value.campaignId]);
    await pool.query(`INSERT INTO campaign_canonical_facts(id,owner_user_id,campaign_id,world_version_id,source_turn_id,source_state_edit_id,source_turn_number,source_fact_index,content,normalized_content,valid_from_turn)
      VALUES($1,$2,$3,$4,NULL,$5,0,0,'The obsidian covenant was explicitly corrected.','the obsidian covenant was explicitly corrected.',0)`,
      [id, ownerUserId, value.campaignId, value.worldVersionId, edit.rows[0]!.id]);
    expect((await value.read("obsidian covenant")).candidates.map((candidate) => candidate.id)).toContain(id);
    await pool.query("UPDATE campaign_canonical_facts SET valid_until_turn=2 WHERE id=$1", [id]);
    expect((await value.read("obsidian covenant")).candidates.map((candidate) => candidate.id)).not.toContain(id);
  });

  it.skipIf(process.env.RUN_HISTORICAL_FACT_BENCHMARK !== "1")("measures fixed isolated 1k/10k/100k pools", async () => {
    const measurements: unknown[] = [];
    for (const size of [1_000, 10_000, 100_000]) {
      const value = await fixture(size);
      await value.fact("The obsidian covenant seals the northern vault.", 0);
      await pool.query("ANALYZE campaign_canonical_facts");
      const parameters = [ownerUserId, value.campaignId, value.worldVersionId, 3, 256, ["obsidian covenant"], [], [], null];
      let legacySql = "";
      let legacyParameters: unknown[] = [];
      const client = await pool.connect();
      try {
        const observed = new Proxy(client, { get(target, member) {
          if (member === "query") return (statement: string, values?: unknown[]) => {
            if (statement.includes("FROM campaign_canonical_facts")) { legacySql = statement; legacyParameters = values ?? []; }
            return target.query(statement, values);
          };
          const memberValue = Reflect.get(target, member);
          return typeof memberValue === "function" ? memberValue.bind(target) : memberValue;
        } });
        await loadPostgresChronicleGenerationCandidates(observed, { ownerUserId, campaignId: value.campaignId, worldVersionId: value.worldVersionId,
          query: "obsidian covenant", throughTurnNumber: 3, retrievalBudgetTokens: 32_000 }, dependencies, { useSavepoints: false });
      } finally { client.release(); }
      expect(legacySql).toContain("ORDER BY source_turn_number DESC");
      for (const [implementation, sql, values] of [["legacy", legacySql, legacyParameters], ["balanced", HISTORICAL_FACT_POOL_SQL, parameters]] as const) {
        const timings: number[] = [];
        for (let iteration = 0; iteration < 20; iteration += 1) {
          const start = performance.now();
          const result = await pool.query(sql, values);
          timings.push(performance.now() - start);
          expect(result.rows).toHaveLength(256);
        }
        const plan = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, values);
        measurements.push({ implementation, rows: size + 1, samples: 20, p95Milliseconds: timings.sort((a, b) => a - b)[18], explain: plan.rows[0] });
      }
    }
    const environment = await pool.query("SELECT version() AS postgres_version");
    if (process.env.HISTORICAL_FACT_BENCHMARK_OUTPUT) await writeFile(process.env.HISTORICAL_FACT_BENCHMARK_OUTPUT,
      JSON.stringify({ environment: environment.rows[0], measurements }, null, 2));
  }, 120_000);
});
