import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import {
  createPostgresBoundedCampaignTurnPageAdapter,
  createPostgresCampaignAuthorityAdapters
} from "../../packages/database/src/campaign-state-repository.js";
import {
  createDatabasePool,
  initialOwnerId,
  type DatabasePool
} from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { importLegacyStory } from "../helpers/memory-aware-services.js";
import { memoryGeneration } from "../helpers/memory-applications.js";
import { turnReportedCosts } from "../../services/api/src/cost-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe.sequential : describe.skip;

integration("PostgreSQL campaign sync adapters", () => {
  let pool: DatabasePool;
  let ownerUserId = "";
  const importedFixtures: Array<Readonly<{
    importId: string;
    campaignId: string;
    worldVersionId: string;
    worldId: string;
  }>> = [];
  const providerIds: string[] = [];
  const foreignUserIds: string[] = [];

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  afterEach(async () => {
    const fixtures = [...importedFixtures];
    const createdProviderIds = [...providerIds];
    const createdForeignUserIds = [...foreignUserIds];
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (fixtures.length) {
        await client.query("DELETE FROM imports WHERE id = ANY($1::uuid[])", [fixtures.map(({ importId }) => importId)]);
        await client.query("DELETE FROM campaigns WHERE id = ANY($1::uuid[])", [fixtures.map(({ campaignId }) => campaignId)]);
        await client.query("DELETE FROM world_drafts WHERE world_id = ANY($1::uuid[])", [fixtures.map(({ worldId }) => worldId)]);
        await client.query("DELETE FROM world_versions WHERE id = ANY($1::uuid[])", [fixtures.map(({ worldVersionId }) => worldVersionId)]);
        await client.query("DELETE FROM worlds WHERE id = ANY($1::uuid[])", [fixtures.map(({ worldId }) => worldId)]);
      }
      if (createdProviderIds.length) {
        await client.query("DELETE FROM provider_profiles WHERE id = ANY($1::uuid[])", [createdProviderIds]);
      }
      if (createdForeignUserIds.length) {
        await client.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [createdForeignUserIds]);
      }
      await client.query("COMMIT");
      importedFixtures.splice(0, fixtures.length);
      providerIds.splice(0, createdProviderIds.length);
      foreignUserIds.splice(0, createdForeignUserIds.length);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  function createAdapters() {
    const turnPages = createPostgresBoundedCampaignTurnPageAdapter(pool, { turnReportedCosts });
    return createPostgresCampaignAuthorityAdapters(pool, {
      turnPages,
      memory: memoryGeneration(pool)
    });
  }

  async function createCampaignFixture() {
    const story = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    story.world.title = `Campaign sync ${crypto.randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({
      sourceName: `campaign-sync-${crypto.randomUUID()}.story`,
      story
    }));
    importedFixtures.push(imported);
    return imported;
  }

  async function createProviderFixture() {
    const provider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles (
         owner_user_id, name, provider_type, provider_role, base_url, default_model
       ) VALUES ($1,$2,'openai_compatible','text','http://provider.invalid','fixture-model')
       RETURNING id`,
      [ownerUserId, `Campaign sync provider ${crypto.randomUUID()}`]
    );
    const providerId = provider.rows[0]!.id;
    providerIds.push(providerId);
    return providerId;
  }

  async function createForeignUserFixture(label: string) {
    const foreign = await pool.query<{ id: string }>(
      "INSERT INTO users (display_name, status) VALUES ($1, 'active') RETURNING id",
      [`${label} ${crypto.randomUUID()}`]
    );
    const foreignUserId = foreign.rows[0]!.id;
    foreignUserIds.push(foreignUserId);
    return foreignUserId;
  }

  it("returns typed campaign_not_found outside the explicit owner scope", async () => {
    const imported = await createCampaignFixture();
    const foreignUserId = await createForeignUserFixture("Foreign sync owner");
    const adapters = createAdapters();

    await expect(adapters.transaction.read((transaction) => adapters.sync.readCampaignSyncSnapshot(
      transaction,
      { ownerUserId: foreignUserId, campaignId: imported.campaignId }
    ))).rejects.toMatchObject({ reason: "campaign_not_found" });
  });

  it("keeps campaign runtime state invisible outside the explicit owner scope", async () => {
    const imported = await createCampaignFixture();
    const foreignUserId = await createForeignUserFixture("Foreign state owner");
    const adapters = createAdapters();

    const foreignScope = { ownerUserId: foreignUserId, campaignId: imported.campaignId };
    await expect(adapters.transaction.read((transaction) => adapters.state.getCampaignRuntimeState(
      transaction,
      foreignScope
    ))).rejects.toMatchObject({ reason: "campaign_not_found" });
    await expect(adapters.transaction.command((transaction) => adapters.state.updateCampaignRuntimeState(
      transaction,
      foreignScope,
      {
        expectedTurnNumber: 2,
        expectedRevision: 0,
        continuitySummary: "No foreign state may be written.",
        openThreads: [],
        canonicalFacts: [],
        scratchpad: "",
        trackers: [],
        rpgStats: [],
        eventTriggers: [],
        pendingEventTriggers: []
      }
    ))).resolves.toMatchObject({ ok: false, failure: { reason: "campaign_not_found" } });
    await expect(adapters.transaction.command((transaction) => adapters.campaigns.syncPlayerCampaignConfig(
      transaction,
      foreignScope,
      {
        expectedTurnNumber: 2,
        expectedStateRevision: 0,
        useRpgStats: false,
        suppressEventTriggers: false,
        rpgStats: [],
        eventTriggers: [],
        pendingEventTriggers: []
      }
    ))).resolves.toMatchObject({ ok: false, failure: { reason: "campaign_not_found" } });
  });

  it("keeps rewind authority invisible outside the explicit owner scope", async () => {
    const imported = await createCampaignFixture();
    const foreignUserId = await createForeignUserFixture("Foreign rewind owner");
    const adapters = createAdapters();
    const campaigns = adapters.campaigns;

    await expect(adapters.transaction.command((transaction) => campaigns.rewindCampaign(
      transaction,
      { ownerUserId: foreignUserId, campaignId: imported.campaignId },
      {
        targetTurnNumber: 1,
        expectedCurrentTurnNumber: 2,
        expectedStateRevision: 0
      }
    ))).resolves.toMatchObject({
      ok: false,
      failure: { reason: "campaign_not_found" }
    });
  });

  it("rewinds accepted history and authoritative state when both fences match", async () => {
    const imported = await createCampaignFixture();
    const adapters = createAdapters();
    const campaigns = adapters.campaigns;
    const scope = { ownerUserId, campaignId: imported.campaignId };
    const before = await adapters.transaction.read((transaction) =>
      adapters.state.getCampaignRuntimeState(transaction, scope));
    const target = await adapters.transaction.read((transaction) =>
      adapters.state.getCampaignRuntimeState(transaction, scope, 1));

    const rewound = await adapters.transaction.command((transaction) => campaigns.rewindCampaign(
      transaction,
      scope,
      {
        targetTurnNumber: 1,
        expectedCurrentTurnNumber: before.activeTurnNumber,
        expectedStateRevision: before.revision
      }
    ));

    expect(rewound).toMatchObject({
      ok: true,
      value: {
        campaignId: imported.campaignId,
        activeTurnNumber: 1,
        discardedTurnCount: 1,
        stateSnapshot: {
          scratchpad: target.scratchpad,
          trackers: target.trackers,
          rpgStats: target.rpgStats,
          eventTriggers: target.eventTriggers,
          pendingEventTriggers: target.pendingEventTriggers
        }
      }
    });
    await expect(pool.query<{
      activeTurnNumber: number;
      revision: number;
      turnNumbers: number[];
    }>(
      `SELECT c.active_turn_number AS "activeTurnNumber", cs.revision,
              array_agg(t.turn_number ORDER BY t.turn_number)::int[] AS "turnNumbers"
         FROM campaigns c
         JOIN campaign_state cs ON cs.campaign_id = c.id AND cs.owner_user_id = c.owner_user_id
         JOIN turns t ON t.campaign_id = c.id AND t.owner_user_id = c.owner_user_id
        WHERE c.id = $1 AND c.owner_user_id = $2
        GROUP BY c.active_turn_number, cs.revision`,
      [imported.campaignId, ownerUserId]
    )).resolves.toMatchObject({
      rows: [{ activeTurnNumber: 1, revision: before.revision + 1, turnNumbers: [1] }]
    });
  });

  it("rejects stale rewind fences without mutating history or state", async () => {
    const imported = await createCampaignFixture();
    const adapters = createAdapters();
    const campaigns = adapters.campaigns;
    const scope = { ownerUserId, campaignId: imported.campaignId };
    const before = await adapters.transaction.read((transaction) =>
      adapters.state.getCampaignRuntimeState(transaction, scope));

    const staleTurn = await adapters.transaction.command((transaction) => campaigns.rewindCampaign(
      transaction,
      scope,
      {
        targetTurnNumber: 1,
        expectedCurrentTurnNumber: before.activeTurnNumber - 1,
        expectedStateRevision: before.revision
      }
    ));
    expect(staleTurn).toEqual({
      ok: false,
      failure: {
        reason: "active_turn_changed",
        details: {
          campaignId: imported.campaignId,
          expectedTurnNumber: before.activeTurnNumber - 1,
          actualTurnNumber: before.activeTurnNumber
        }
      }
    });

    const staleRevision = await adapters.transaction.command((transaction) => campaigns.rewindCampaign(
      transaction,
      scope,
      {
        targetTurnNumber: 1,
        expectedCurrentTurnNumber: before.activeTurnNumber,
        expectedStateRevision: before.revision + 1
      }
    ));
    expect(staleRevision).toEqual({
      ok: false,
      failure: {
        reason: "state_revision_changed",
        details: {
          campaignId: imported.campaignId,
          expectedStateRevision: before.revision + 1,
          actualStateRevision: before.revision
        }
      }
    });
    await expect(pool.query<{
      activeTurnNumber: number;
      revision: number;
      turnCount: number;
    }>(
      `SELECT c.active_turn_number AS "activeTurnNumber", cs.revision,
              count(t.id)::int AS "turnCount"
         FROM campaigns c
         JOIN campaign_state cs ON cs.campaign_id = c.id AND cs.owner_user_id = c.owner_user_id
         JOIN turns t ON t.campaign_id = c.id AND t.owner_user_id = c.owner_user_id
        WHERE c.id = $1 AND c.owner_user_id = $2
        GROUP BY c.active_turn_number, cs.revision`,
      [imported.campaignId, ownerUserId]
    )).resolves.toMatchObject({
      rows: [{ activeTurnNumber: before.activeTurnNumber, revision: before.revision, turnCount: 2 }]
    });
  });

  it("loads validated current, historical, and effective edited campaign state", async () => {
    const imported = await createCampaignFixture();
    const adapters = createAdapters();
    const scope = { ownerUserId, campaignId: imported.campaignId };
    const current = await adapters.transaction.read((transaction) =>
      adapters.state.getCampaignRuntimeState(transaction, scope));
    const historical = await adapters.transaction.read((transaction) =>
      adapters.state.getCampaignRuntimeState(transaction, scope, 1));

    expect(current).toMatchObject({
      campaignId: imported.campaignId,
      activeTurnNumber: 2,
      viewedTurnNumber: 2,
      isCurrent: true,
      revision: 0
    });
    expect(current.updatedAt).toBeInstanceOf(Date);
    expect(historical).toMatchObject({
      campaignId: imported.campaignId,
      activeTurnNumber: 2,
      viewedTurnNumber: 1,
      isCurrent: false,
      revision: 0
    });
    expect(historical.updatedAt).toBeInstanceOf(Date);

    const corrected = await adapters.transaction.command((transaction) =>
      adapters.state.updateCampaignRuntimeState(transaction, scope, {
        expectedTurnNumber: current.activeTurnNumber,
        expectedRevision: current.revision,
        continuitySummary: "The beacon now burns with a steady blue flame.",
        openThreads: ["Learn who restored the beacon."],
        canonicalFacts: current.canonicalFacts,
        scratchpad: current.scratchpad,
        trackers: current.trackers,
        rpgStats: current.rpgStats,
        eventTriggers: current.eventTriggers,
        pendingEventTriggers: current.pendingEventTriggers
      }));
    expect(corrected).toMatchObject({ ok: true, value: { revision: 1 } });

    const edit = await adapters.transaction.read((transaction) =>
      adapters.state.loadEffectiveCampaignStateEdit(transaction, scope));
    expect(edit).toMatchObject({
      revision: 1,
      effectiveTurnNumber: 2,
      snapshot: {
        continuitySummary: "The beacon now burns with a steady blue flame.",
        openThreads: ["Learn who restored the beacon."]
      }
    });
    expect(edit.updatedAt).toBeInstanceOf(Date);
  });

  it("retains snapshot-only canonical facts across current and historical reads and later corrections", async () => {
    const imported = await createCampaignFixture();
    const adapters = createAdapters();
    const scope = { ownerUserId, campaignId: imported.campaignId };
    const historicalFact = "The old bell rang only at moonrise.";
    const currentFact = "The restored beacon burns with a steady blue flame.";
    await pool.query(
      `UPDATE turns
          SET state_snapshot_private = jsonb_set(
            state_snapshot_private,
            '{canonicalFacts}',
            CASE turn_number WHEN 1 THEN $3::jsonb ELSE $4::jsonb END
          )
        WHERE owner_user_id = $1 AND campaign_id = $2 AND turn_number IN (1, 2)`,
      [ownerUserId, imported.campaignId, JSON.stringify([historicalFact]), JSON.stringify([currentFact])]
    );
    await pool.query(
      "DELETE FROM campaign_canonical_facts WHERE owner_user_id = $1 AND campaign_id = $2",
      [ownerUserId, imported.campaignId]
    );

    const current = await adapters.transaction.read((transaction) =>
      adapters.state.getCampaignRuntimeState(transaction, scope));
    const historical = await adapters.transaction.read((transaction) =>
      adapters.state.getCampaignRuntimeState(transaction, scope, 1));
    expect(current.canonicalFacts).toEqual([{ id: null, content: currentFact }]);
    expect(historical.canonicalFacts).toEqual([{ id: null, content: historicalFact }]);

    const corrected = await adapters.transaction.command((transaction) =>
      adapters.state.updateCampaignRuntimeState(transaction, scope, {
        expectedTurnNumber: current.activeTurnNumber,
        expectedRevision: current.revision,
        continuitySummary: "The beacon keeper has returned to the tower.",
        openThreads: current.openThreads,
        canonicalFacts: current.canonicalFacts,
        scratchpad: current.scratchpad,
        trackers: current.trackers,
        rpgStats: current.rpgStats,
        eventTriggers: current.eventTriggers,
        pendingEventTriggers: current.pendingEventTriggers
      }));
    expect(corrected).toMatchObject({
      ok: true,
      value: { canonicalFacts: [{ id: expect.any(String), content: currentFact }] }
    });
    await expect(pool.query<{ canonicalFacts: unknown }>(
      `SELECT state_snapshot_private->'canonicalFacts' AS "canonicalFacts"
         FROM campaign_state_edits
        WHERE owner_user_id = $1 AND campaign_id = $2
        ORDER BY revision DESC LIMIT 1`,
      [ownerUserId, imported.campaignId]
    )).resolves.toMatchObject({
      rows: [{ canonicalFacts: [{ id: expect.any(String), content: currentFact }] }]
    });
  });

  it("updates campaign state only when both turn and state-revision fences match", async () => {
    const imported = await createCampaignFixture();
    const adapters = createAdapters();
    const scope = { ownerUserId, campaignId: imported.campaignId };
    const before = await adapters.transaction.read((transaction) =>
      adapters.state.getCampaignRuntimeState(transaction, scope));
    const acceptedBefore = await pool.query<{ state_snapshot_private: unknown }>(
      `SELECT state_snapshot_private FROM turns
        WHERE owner_user_id = $1 AND campaign_id = $2 AND turn_number = $3`,
      [ownerUserId, imported.campaignId, before.activeTurnNumber]
    );
    const request = {
      expectedTurnNumber: before.activeTurnNumber,
      expectedRevision: before.revision,
      continuitySummary: "The keeper has opened the lower stair.",
      openThreads: ["Search the flooded vault."],
      canonicalFacts: before.canonicalFacts,
      scratchpad: "The old lens remains hidden beneath the stair.",
      trackers: before.trackers,
      rpgStats: before.rpgStats,
      eventTriggers: before.eventTriggers,
      pendingEventTriggers: before.pendingEventTriggers
    };

    const updated = await adapters.transaction.command((transaction) =>
      adapters.state.updateCampaignRuntimeState(transaction, scope, request));
    expect(updated).toMatchObject({
      ok: true,
      value: {
        campaignId: imported.campaignId,
        activeTurnNumber: before.activeTurnNumber,
        revision: before.revision + 1,
        continuitySummary: request.continuitySummary
      }
    });
    expect(updated.ok && updated.value.updatedAt).toBeInstanceOf(Date);

    const staleRevision = await adapters.transaction.command((transaction) =>
      adapters.state.updateCampaignRuntimeState(transaction, scope, {
        ...request,
        continuitySummary: "This stale edit must never persist."
      }));
    expect(staleRevision).toEqual({
      ok: false,
      failure: {
        reason: "state_revision_changed",
        details: {
          campaignId: imported.campaignId,
          expectedStateRevision: before.revision,
          actualStateRevision: before.revision + 1
        }
      }
    });

    const staleTurn = await adapters.transaction.command((transaction) =>
      adapters.state.updateCampaignRuntimeState(transaction, scope, {
        ...request,
        expectedTurnNumber: before.activeTurnNumber - 1,
        expectedRevision: before.revision + 1
      }));
    expect(staleTurn).toEqual({
      ok: false,
      failure: {
        reason: "active_turn_changed",
        details: {
          campaignId: imported.campaignId,
          expectedTurnNumber: before.activeTurnNumber - 1,
          actualTurnNumber: before.activeTurnNumber
        }
      }
    });

    const acceptedAfter = await pool.query<{ state_snapshot_private: unknown }>(
      `SELECT state_snapshot_private FROM turns
        WHERE owner_user_id = $1 AND campaign_id = $2 AND turn_number = $3`,
      [ownerUserId, imported.campaignId, before.activeTurnNumber]
    );
    expect(acceptedAfter.rows[0]?.state_snapshot_private).toEqual(acceptedBefore.rows[0]?.state_snapshot_private);
    await expect(pool.query<{ revision: number }>(
      "SELECT revision FROM campaign_state WHERE owner_user_id = $1 AND campaign_id = $2",
      [ownerUserId, imported.campaignId]
    )).resolves.toMatchObject({ rows: [{ revision: before.revision + 1 }] });
  });

  it("rolls back invalid nested campaign-state corrections without partial writes", async () => {
    const imported = await createCampaignFixture();
    const adapters = createAdapters();
    const scope = { ownerUserId, campaignId: imported.campaignId };
    const before = await adapters.transaction.read((transaction) =>
      adapters.state.getCampaignRuntimeState(transaction, scope));

    await expect(adapters.transaction.command((transaction) =>
      adapters.state.updateCampaignRuntimeState(transaction, scope, {
        expectedTurnNumber: before.activeTurnNumber,
        expectedRevision: before.revision,
        continuitySummary: before.continuitySummary,
        openThreads: before.openThreads,
        canonicalFacts: before.canonicalFacts,
        scratchpad: before.scratchpad,
        trackers: [{ id: "", name: 9, value: {}, rules: [] }],
        rpgStats: before.rpgStats,
        eventTriggers: before.eventTriggers,
        pendingEventTriggers: before.pendingEventTriggers
      } as never))).rejects.toMatchObject({ kind: "invalid_request", reason: "invalid_transition" });

    const after = await pool.query<{ revision: number; trackers: unknown }>(
      `SELECT revision, trackers FROM campaign_state
        WHERE owner_user_id = $1 AND campaign_id = $2`,
      [ownerUserId, imported.campaignId]
    );
    expect(after.rows[0]).toMatchObject({ revision: before.revision, trackers: before.trackers });
    await expect(pool.query(
      "SELECT id FROM campaign_state_edits WHERE owner_user_id = $1 AND campaign_id = $2",
      [ownerUserId, imported.campaignId]
    )).resolves.toMatchObject({ rowCount: 0 });
  });

  it("rejects a malformed persisted state snapshot at the database boundary", async () => {
    const imported = await createCampaignFixture();
    const adapters = createAdapters();
    await pool.query(
      `UPDATE turns SET state_snapshot_private = '"invalid-state-snapshot"'::jsonb
        WHERE owner_user_id = $1 AND campaign_id = $2 AND turn_number = 2`,
      [ownerUserId, imported.campaignId]
    );

    await expect(adapters.transaction.read((transaction) =>
      adapters.state.getCampaignRuntimeState(transaction, {
        ownerUserId,
        campaignId: imported.campaignId
      }))).rejects.toMatchObject({ kind: "unavailable", reason: "invalid_transition" });
  });

  it("syncs player configuration only when turn and state-revision fences match", async () => {
    const imported = await createCampaignFixture();
    const adapters = createAdapters();
    const scope = { ownerUserId, campaignId: imported.campaignId };
    const before = await adapters.transaction.read((transaction) =>
      adapters.state.getCampaignRuntimeState(transaction, scope));
    const request = {
      expectedTurnNumber: before.activeTurnNumber,
      expectedStateRevision: before.revision,
      useRpgStats: true,
      suppressEventTriggers: true,
      rpgStats: [{ id: "resolve", name: "Resolve", value: 7, note: "Steady" }],
      eventTriggers: [],
      pendingEventTriggers: []
    };

    const synchronized = await adapters.transaction.command((transaction) =>
      adapters.campaigns.syncPlayerCampaignConfig(transaction, scope, request));
    expect(synchronized).toEqual({
      ok: true,
      value: {
        campaignId: imported.campaignId,
        activeTurnNumber: before.activeTurnNumber,
        synchronized: true
      }
    });
    const saved = await pool.query<{
      legacy_settings: Record<string, unknown>;
      revision: number;
      rpg_stats: unknown;
    }>(
      `SELECT c.legacy_settings, cs.revision, cs.rpg_stats
         FROM campaigns c
         JOIN campaign_state cs ON cs.campaign_id = c.id AND cs.owner_user_id = c.owner_user_id
        WHERE c.id = $1 AND c.owner_user_id = $2`,
      [imported.campaignId, ownerUserId]
    );
    expect(saved.rows[0]).toMatchObject({
      legacy_settings: { useRpgStats: true, suppressEventTriggers: true },
      revision: before.revision + 1,
      rpg_stats: request.rpgStats
    });

    const stale = await adapters.transaction.command((transaction) =>
      adapters.campaigns.syncPlayerCampaignConfig(transaction, scope, {
        ...request,
        useRpgStats: false,
        suppressEventTriggers: false
      }));
    expect(stale).toEqual({
      ok: false,
      failure: {
        reason: "state_revision_changed",
        details: {
          campaignId: imported.campaignId,
          expectedStateRevision: before.revision,
          actualStateRevision: before.revision + 1
        }
      }
    });
    const staleTurn = await adapters.transaction.command((transaction) =>
      adapters.campaigns.syncPlayerCampaignConfig(transaction, scope, {
        ...request,
        expectedTurnNumber: before.activeTurnNumber - 1,
        expectedStateRevision: before.revision + 1,
        useRpgStats: false,
        suppressEventTriggers: false
      }));
    expect(staleTurn).toEqual({
      ok: false,
      failure: {
        reason: "active_turn_changed",
        details: {
          campaignId: imported.campaignId,
          expectedTurnNumber: before.activeTurnNumber - 1,
          actualTurnNumber: before.activeTurnNumber
        }
      }
    });
    const afterStale = await pool.query<{ legacy_settings: Record<string, unknown>; revision: number }>(
      `SELECT c.legacy_settings, cs.revision
         FROM campaigns c
         JOIN campaign_state cs ON cs.campaign_id = c.id AND cs.owner_user_id = c.owner_user_id
        WHERE c.id = $1 AND c.owner_user_id = $2`,
      [imported.campaignId, ownerUserId]
    );
    expect(afterStale.rows[0]).toMatchObject({
      legacy_settings: { useRpgStats: true, suppressEventTriggers: true },
      revision: before.revision + 1
    });
  });

  it("returns raw-Date sync sources and delegates changed windows to the bounded reader", async () => {
    const imported = await createCampaignFixture();
    const adapters = createAdapters();
    const scope = { ownerUserId, campaignId: imported.campaignId };

    const snapshot = await adapters.transaction.read((transaction) =>
      adapters.sync.readCampaignSyncSnapshot(transaction, scope));
    expect(snapshot.syncToken).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.projection.campaign.updatedAt).toBeInstanceOf(Date);
    expect(snapshot.projection).toMatchObject({
      id: imported.campaignId,
      campaign: { id: imported.campaignId, activeTurnNumber: 2 },
      playerConfig: { useRpgStats: false, suppressEventTriggers: false },
      pendingGeneration: null
    });

    const latest = await adapters.turnPages.readTurnPage(scope, { before: undefined, limit: 1 });
    expect(latest.turns.map((turn) => turn.turnNumber)).toEqual([2]);
    expect(latest.nextCursor).toEqual(expect.any(String));
    const earlier = await adapters.turnPages.readTurnPage(scope, { before: latest.nextCursor!, limit: 1 });
    expect(earlier.turns.map((turn) => turn.turnNumber)).toEqual([1]);
  });

  it("preserves the established owner-scoped reported cost in normal and sync turn pages", async () => {
    const imported = await createCampaignFixture();
    const adapters = createAdapters();
    const scope = { ownerUserId, campaignId: imported.campaignId };
    const turn = await pool.query<{ id: string }>(
      "SELECT id FROM turns WHERE owner_user_id = $1 AND campaign_id = $2 AND turn_number = 2",
      [ownerUserId, imported.campaignId]
    );
    const turnId = turn.rows[0]!.id;
    await pool.query(
      `INSERT INTO provider_cost_events (
         owner_user_id, campaign_id, turn_id, provider_type, category, operation,
         requested_model, resolved_model, amount, currency, usage_metadata
       ) VALUES ($1,$2,$3,'openai_compatible','story','story_turn','fixture-model',
                 'fixture-model',0.125,'USD','{}'::jsonb)`,
      [ownerUserId, imported.campaignId, turnId]
    );
    const expectedCost = {
      amount: "0.125000000000",
      currency: "USD",
      byCategory: { story: "0.125000000000", image: "0", memory: "0" }
    };

    expect((await turnReportedCosts(pool, ownerUserId, [turnId])).get(turnId)).toEqual(expectedCost);
    const syncPage = await adapters.turnPages.readTurnPage(scope, { before: undefined, limit: 1 });
    expect(syncPage.turns[0]?.reportedCost).toEqual(expectedCost);
  });

  it("rejects malformed persisted playable characters at the database boundary", async () => {
    const imported = await createCampaignFixture();
    const adapters = createAdapters();
    await pool.query(
      `UPDATE world_versions
          SET content = jsonb_set(content, '{playableCharacters}',
            '[{"id":"","name":7,"characterText":false}]'::jsonb)
        WHERE id = (SELECT world_version_id FROM campaigns WHERE id = $1 AND owner_user_id = $2)`,
      [imported.campaignId, ownerUserId]
    );

    await expect(adapters.transaction.read((transaction) => adapters.sync.readCampaignSyncSnapshot(
      transaction,
      { ownerUserId, campaignId: imported.campaignId }
    ))).rejects.toMatchObject({ kind: "unavailable", reason: "invalid_transition" });
  });

  it("rejects other malformed persisted nested sync data without returning a partial projection", async () => {
    const imported = await createCampaignFixture();
    const adapters = createAdapters();
    await pool.query(
      `UPDATE campaign_state
          SET trackers = '[{"id":"","name":9,"value":{},"rules":[]}]'::jsonb
        WHERE campaign_id = $1 AND owner_user_id = $2`,
      [imported.campaignId, ownerUserId]
    );

    await expect(adapters.transaction.read((transaction) => adapters.sync.readCampaignSyncSnapshot(
      transaction,
      { ownerUserId, campaignId: imported.campaignId }
    ))).rejects.toMatchObject({ kind: "unavailable", reason: "invalid_transition" });
  });

  it("retains zero recovery attempts when the result turn is outside the bounded recovery window", async () => {
    const imported = await createCampaignFixture();
    const adapters = createAdapters();
    await pool.query("DELETE FROM turns WHERE campaign_id = $1 AND owner_user_id = $2", [imported.campaignId, ownerUserId]);
    await pool.query(
      `INSERT INTO turns (owner_user_id, campaign_id, turn_number, action, narration)
       SELECT $1, $2, turn_number, 'Action ' || turn_number, 'Narration ' || turn_number
         FROM generate_series(1, 55) AS turn_number`,
      [ownerUserId, imported.campaignId]
    );
    await pool.query(
      "UPDATE campaigns SET active_turn_number = 55 WHERE id = $1 AND owner_user_id = $2",
      [imported.campaignId, ownerUserId]
    );
    const providerId = await createProviderFixture();
    const resultTurn = await pool.query<{ id: string }>(
      "SELECT id FROM turns WHERE owner_user_id = $1 AND campaign_id = $2 AND turn_number = 1",
      [ownerUserId, imported.campaignId]
    );
    const resultTurnId = resultTurn.rows[0]?.id;
    if (!resultTurnId) throw new Error("Expected an out-of-window result-turn fixture.");
    const recovery = await pool.query<{ id: string }>(
      `INSERT INTO generation_jobs (
         owner_user_id, campaign_id, provider_profile_id, idempotency_key, expected_turn_number,
         action, operation_kind, status, attempts, result_turn_id, completed_at
       ) VALUES ($1,$2,$3,$4,56,'Recovered with no retry','append','completed',0,$5,now())
       RETURNING id`,
      [ownerUserId, imported.campaignId, providerId, crypto.randomUUID(), resultTurnId]
    );

    const snapshot = await adapters.transaction.read((transaction) => adapters.sync.readCampaignSyncSnapshot(
      transaction,
      { ownerUserId, campaignId: imported.campaignId }
    ));
    expect(snapshot.projection.generationRecovery).toEqual({
      id: recovery.rows[0]!.id,
      status: "completed",
      expectedTurnNumber: 56,
      attempts: 0,
      errorCode: null,
      errorMessage: null,
      resultTurnId,
      operationKind: "append",
      replacementTurnId: null
    });
  });

  it("rejects a persisted zero expected turn through the typed-safe application error", async () => {
    const imported = await createCampaignFixture();
    const adapters = createAdapters();
    const providerId = await createProviderFixture();
    const jobId = crypto.randomUUID();
    const client = await pool.connect();
    let corruptedJobCommitted = false;
    try {
      await client.query("BEGIN");
      await client.query(
        "ALTER TABLE generation_jobs DROP CONSTRAINT generation_jobs_expected_turn_number_check"
      );
      await client.query(
        `INSERT INTO generation_jobs (
           id, owner_user_id, campaign_id, provider_profile_id, idempotency_key,
           expected_turn_number, action, operation_kind, status
         ) VALUES ($1,$2,$3,$4,$5,0,'Invalid persisted turn','append','queued')`,
        [jobId, ownerUserId, imported.campaignId, providerId, crypto.randomUUID()]
      );
      await client.query(
        `ALTER TABLE generation_jobs
           ADD CONSTRAINT generation_jobs_expected_turn_number_check
           CHECK (expected_turn_number > 0) NOT VALID`
      );
      await client.query("COMMIT");
      corruptedJobCommitted = true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    try {
      await expect(adapters.transaction.read((transaction) => adapters.sync.readCampaignSyncSnapshot(
        transaction,
        { ownerUserId, campaignId: imported.campaignId }
      ))).rejects.toMatchObject({ kind: "unavailable", reason: "invalid_transition" });
    } finally {
      if (corruptedJobCommitted) {
        await pool.query("DELETE FROM generation_jobs WHERE id = $1", [jobId]);
        await pool.query(
          "ALTER TABLE generation_jobs VALIDATE CONSTRAINT generation_jobs_expected_turn_number_check"
        );
      }
    }
  });
});
