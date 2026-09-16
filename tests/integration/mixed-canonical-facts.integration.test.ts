import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPostgresChronicleGenerationTransactionPort } from "../../packages/database/src/chronicle-repository.js";
import { buildCanonicalChronicleFacts } from "../../packages/domain/src/chronicle-memory-helpers.js";
import {
  createDatabasePool,
  initialOwnerId,
  type DatabasePool,
  withTransaction
} from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { loadAcceptedGenerationContinuity } from "../../packages/database/src/campaign-continuity-repository.js";
import { resolveGenerationAuthoritySnapshot } from "../../packages/database/src/generation-authority.js";
import { loadPostgresChronicleGenerationAuthorityContext } from "../../packages/database/src/chronicle-generation-context.js";
import { planGenerationPromptContext, sentCanonicalFactIds } from "../../services/runtime/src/generation-executor-adapter.js";
import { serializeProviderRequest } from "../../packages/story-engine/src/provider-request.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe.sequential : describe.skip;

integration("mixed canonical fact persistence", () => {
  let pool: DatabasePool;
  let ownerUserId = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });

  afterEach(async () => {
    await pool.query("DELETE FROM campaigns");
    await pool.query("DELETE FROM world_versions");
    await pool.query("DELETE FROM worlds");
    await pool.query("DELETE FROM users WHERE system_key IS NULL");
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function campaignFixture() {
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id, title) VALUES ($1,$2) RETURNING id",
      [ownerUserId, `Mixed canonical facts ${crypto.randomUUID()}`]
    );
    const version = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id, owner_user_id, version_number, content)
       VALUES ($1,$2,1,$3::jsonb) RETURNING id`,
      [world.rows[0]!.id, ownerUserId, JSON.stringify({ world: { title: "Mixed canonical facts" }, entities: [] })]
    );
    const campaign = await pool.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id, world_version_id, title) VALUES ($1,$2,$3) RETURNING id",
      [ownerUserId, version.rows[0]!.id, "Mixed canonical facts"]
    );
    await pool.query(
      "INSERT INTO campaign_state (campaign_id, owner_user_id) VALUES ($1,$2)",
      [campaign.rows[0]!.id, ownerUserId]
    );
    return { campaignId: campaign.rows[0]!.id, worldVersionId: version.rows[0]!.id };
  }

  it("persists and replays distinct additions alongside structured updates", async () => {
    const fixture = await campaignFixture();
    const first = await pool.query<{ id: string }>(
      `INSERT INTO turns (owner_user_id,campaign_id,turn_number,action,narration,state_snapshot_private)
       VALUES ($1,$2,1,'Inspect the harbor.','The harbor gate remains locked.',$3::jsonb) RETURNING id`,
      [ownerUserId, fixture.campaignId, JSON.stringify({
        canonicalFacts: ["The harbor gate is locked."],
        canonicalFactUpdates: []
      })]
    );
    const lockedFactId = buildCanonicalChronicleFacts({
      campaignId: fixture.campaignId,
      turnId: first.rows[0]!.id,
      canonicalFacts: ["The harbor gate is locked."],
      entityCatalog: []
    })[0]!.id;
    const second = await pool.query<{ id: string }>(
      `INSERT INTO turns (owner_user_id,campaign_id,turn_number,action,narration,state_snapshot_private)
       VALUES ($1,$2,2,'Search beneath the bridge.','A brass key is found as the harbor gate opens.',$3::jsonb) RETURNING id`,
      [ownerUserId, fixture.campaignId, JSON.stringify({
        canonicalFacts: ["The brass key rests beneath the bridge."],
        canonicalFactUpdates: [{
          content: "The harbor gate is open.",
          supersedesFactIds: [lockedFactId]
        }]
      })]
    );
    const transaction = createPostgresChronicleGenerationTransactionPort({
      embeddings: {
        async resolve() { return { status: "unconfigured" as const, resolutionSource: "none" as const, resolvedRole: null }; },
        async load() { throw new Error("not used by canonical fact persistence"); },
        async embed() { throw new Error("not used by canonical fact persistence"); },
        async fingerprint() { throw new Error("not used by canonical fact persistence"); },
        async recordHealth() {},
        async recordCost() { return null; },
        logDiagnostic() {}
      }
    });
    const scope = { ownerUserId, campaignId: fixture.campaignId, worldVersionId: fixture.worldVersionId };

    await withTransaction(pool, async (client) => {
      await transaction.storeDerivedTurnMemories(client, {
        ...scope,
        turnId: first.rows[0]!.id,
        ordinal: 1,
        derived: { canonicalFacts: ["The harbor gate is locked."] }
      });
      await transaction.storeDerivedTurnMemories(client, {
        ...scope,
        turnId: second.rows[0]!.id,
        ordinal: 2,
        derived: {
          canonicalFacts: ["The brass key rests beneath the bridge."],
          canonicalFactUpdates: [{ content: "The harbor gate is open.", supersedesFactIds: [lockedFactId] }]
        }
      });
    });

    const activeFacts = async () => pool.query<{ content: string; superseded_by_fact_id: string | null }>(
      `SELECT content,superseded_by_fact_id FROM campaign_canonical_facts
        WHERE campaign_id=$1 AND valid_until_turn IS NULL ORDER BY source_turn_number,source_fact_index`,
      [fixture.campaignId]
    );
    await expect(activeFacts()).resolves.toMatchObject({ rows: [
      { content: "The harbor gate is open.", superseded_by_fact_id: null },
      { content: "The brass key rests beneath the bridge.", superseded_by_fact_id: null }
    ] });

    await withTransaction(pool, (client) => transaction.rebuildCampaignMemories(client, scope));

    await expect(activeFacts()).resolves.toMatchObject({ rows: [
      { content: "The harbor gate is open.", superseded_by_fact_id: null },
      { content: "The brass key rests beneath the bridge.", superseded_by_fact_id: null }
    ] });
    const canonicalMemory = await pool.query<{ content: string }>(
      `SELECT content FROM chronicle_memories
        WHERE campaign_id=$1 AND memory_kind='canonical_fact' ORDER BY content`,
      [fixture.campaignId]
    );
    expect(canonicalMemory.rows).toHaveLength(1);
    expect(canonicalMemory.rows[0]?.content).toContain("The harbor gate is open.");
    expect(canonicalMemory.rows[0]?.content).toContain("The brass key rests beneath the bridge.");
    const persisted = await pool.query<{ state_snapshot_private: unknown }>("SELECT state_snapshot_private FROM turns WHERE id=$1", [second.rows[0]!.id]);
    const expected = buildCanonicalChronicleFacts({ campaignId: fixture.campaignId, turnId: second.rows[0]!.id,
      canonicalFacts: ["The brass key rests beneath the bridge."],
      canonicalFactUpdates: [{ content: "The harbor gate is open.", supersedesFactIds: [lockedFactId] }], entityCatalog: [] });
    const read = () => withTransaction(pool, (client) => loadAcceptedGenerationContinuity(client, scope, {
      turnId: second.rows[0]!.id, turnNumber: 2, snapshot: persisted.rows[0]!.state_snapshot_private
    }));
    expect((await read()).canonicalFacts).toEqual(expected.map((fact) => ({ id: fact.id, content: fact.content })));
    await pool.query("UPDATE campaigns SET active_turn_number=2 WHERE id=$1", [fixture.campaignId]);
    const request = async () => {
      const context = await withTransaction(pool, async (client) => {
        const input = { ...scope, operationKind: "append" as const, expectedTurnNumber: 3, query: "Inspect the open gate." };
        const frozen = await resolveGenerationAuthoritySnapshot(client, { ...input, baseIdentityVersion: "generation-base-v3" });
        return loadPostgresChronicleGenerationAuthorityContext(client, { ...input, expectedBaseIdentity: frozen.baseIdentity });
      });
      const provider = { id: crypto.randomUUID(), providerType: "openai_compatible", model: "test",
        contextWindowTokens: 32_000, maxOutputTokens: 1_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {} } as never;
      const planned = planGenerationPromptContext(context, provider, "Write a scene.", "Inspect the open gate.", [],
        { profile: "brief", minWords: 100, maxWords: 120 }, "action", 30_000, 30_000, crypto.randomUUID());
      return serializeProviderRequest(provider, { systemPrompt: "Write a scene.", input: planned.storyInput }).body;
    };
    const body = await request();
    expect(body).toContain("The harbor gate is open.");
    expect(sentCanonicalFactIds(body).sort()).toEqual(expected.map((fact) => fact.id).sort());
    expect(sentCanonicalFactIds(body)).not.toContain(lockedFactId);
    await pool.query("UPDATE campaign_canonical_facts SET source_fact_index=9 WHERE id=$1", [expected[0]!.id]);
    expect(sentCanonicalFactIds(await request())).toEqual([expected[1]!.id]);
    await pool.query("UPDATE campaign_canonical_facts SET source_fact_index=0 WHERE id=$1", [expected[0]!.id]);
    await pool.query("UPDATE campaign_canonical_facts SET valid_until_turn=3 WHERE id=$1", [expected[0]!.id]);
    const expired = await withTransaction(pool, (client) => loadAcceptedGenerationContinuity(client, scope,
      { turnId: second.rows[0]!.id, turnNumber: 3, snapshot: persisted.rows[0]!.state_snapshot_private }));
    expect(expired.canonicalFacts.map((fact) => fact.id)).toEqual([null, expected[1]!.id]);
    await pool.query("UPDATE campaign_canonical_facts SET valid_until_turn=NULL WHERE id=$1", [expected[0]!.id]);
    const wrongScope = await withTransaction(pool, (client) => loadAcceptedGenerationContinuity(client,
      { ...scope, worldVersionId: crypto.randomUUID() }, { turnId: second.rows[0]!.id, turnNumber: 2, snapshot: persisted.rows[0]!.state_snapshot_private }));
    expect(wrongScope.canonicalFacts.every((fact) => fact.id === null)).toBe(true);
    const before = await pool.query("SELECT id,content,valid_until_turn,source_turn_id FROM campaign_canonical_facts WHERE campaign_id=$1 ORDER BY id", [fixture.campaignId]);
    await read();
    expect((await pool.query("SELECT id,content,valid_until_turn,source_turn_id FROM campaign_canonical_facts WHERE campaign_id=$1 ORDER BY id", [fixture.campaignId])).rows).toEqual(before.rows);
    await pool.query("DELETE FROM campaign_canonical_facts WHERE id=$1", [expected[0]!.id]);
    expect((await read()).canonicalFacts).toEqual([
      { id: null, content: expected[0]!.content }, { id: expected[1]!.id, content: expected[1]!.content }
    ]);
    const withoutProjection = await request();
    expect(withoutProjection).toContain("The harbor gate is open.");
    expect(sentCanonicalFactIds(withoutProjection)).toEqual([expected[1]!.id]);
  });
});
