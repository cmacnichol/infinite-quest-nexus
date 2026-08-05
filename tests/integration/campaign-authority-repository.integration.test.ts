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
import { turnReportedCosts } from "../../services/runtime/src/provider-cost-adapter.js";

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
  const generationJobIds: string[] = [];
  const imageJobIds: string[] = [];
  const resolutionJobIds: string[] = [];
  const chronicleJobIds: string[] = [];
  const stateEditIds: string[] = [];
  const checkpointIds: string[] = [];
  const memoryIds: string[] = [];
  const branchCampaignIds: string[] = [];

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
    const createdGenerationJobIds = [...generationJobIds];
    const createdImageJobIds = [...imageJobIds];
    const createdResolutionJobIds = [...resolutionJobIds];
    const createdChronicleJobIds = [...chronicleJobIds];
    const createdStateEditIds = [...stateEditIds];
    const createdCheckpointIds = [...checkpointIds];
    const createdMemoryIds = [...memoryIds];
    const createdBranchCampaignIds = [...branchCampaignIds];
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (createdResolutionJobIds.length) {
        await client.query("DELETE FROM illustration_resolution_jobs WHERE id = ANY($1::uuid[])", [createdResolutionJobIds]);
      }
      if (createdImageJobIds.length) {
        await client.query("DELETE FROM image_jobs WHERE id = ANY($1::uuid[])", [createdImageJobIds]);
      }
      if (createdCheckpointIds.length) {
        await client.query("DELETE FROM summary_checkpoints WHERE id = ANY($1::uuid[])", [createdCheckpointIds]);
      }
      if (createdMemoryIds.length) {
        await client.query("DELETE FROM chronicle_memories WHERE id = ANY($1::uuid[])", [createdMemoryIds]);
      }
      if (createdStateEditIds.length) {
        await client.query("DELETE FROM campaign_state_edits WHERE id = ANY($1::uuid[])", [createdStateEditIds]);
      }
      if (createdChronicleJobIds.length) {
        await client.query("DELETE FROM chronicle_jobs WHERE id = ANY($1::uuid[])", [createdChronicleJobIds]);
      }
      if (createdGenerationJobIds.length) {
        await client.query("DELETE FROM generation_jobs WHERE id = ANY($1::uuid[])", [createdGenerationJobIds]);
      }
      if (createdBranchCampaignIds.length) {
        await client.query("DELETE FROM campaigns WHERE id = ANY($1::uuid[])", [createdBranchCampaignIds]);
      }
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
      generationJobIds.splice(0, createdGenerationJobIds.length);
      imageJobIds.splice(0, createdImageJobIds.length);
      resolutionJobIds.splice(0, createdResolutionJobIds.length);
      chronicleJobIds.splice(0, createdChronicleJobIds.length);
      stateEditIds.splice(0, createdStateEditIds.length);
      checkpointIds.splice(0, createdCheckpointIds.length);
      memoryIds.splice(0, createdMemoryIds.length);
      branchCampaignIds.splice(0, createdBranchCampaignIds.length);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  function createAdapters(memory = memoryGeneration(pool)) {
    const turnPages = createPostgresBoundedCampaignTurnPageAdapter(pool, { turnReportedCosts });
    return createPostgresCampaignAuthorityAdapters(pool, {
      turnPages,
      memory
    });
  }

  async function authoritySnapshot(campaignId: string) {
    const snapshot = await pool.query<{
      activeTurnNumber: number;
      revision: number;
      turns: unknown;
      stateEdits: unknown;
      checkpoints: unknown;
      memories: unknown;
      chronicleJobs: unknown;
      generationJobs: unknown;
      imageJobs: unknown;
      resolutionJobs: unknown;
    }>(
      `SELECT c.active_turn_number AS "activeTurnNumber", cs.revision,
              coalesce((SELECT jsonb_agg(jsonb_build_array(id, turn_number) ORDER BY turn_number)
                          FROM turns WHERE campaign_id = c.id AND owner_user_id = c.owner_user_id), '[]') AS turns,
              coalesce((SELECT jsonb_agg(jsonb_build_array(id, effective_turn_number, revision) ORDER BY revision)
                          FROM campaign_state_edits WHERE campaign_id = c.id AND owner_user_id = c.owner_user_id), '[]') AS "stateEdits",
              coalesce((SELECT jsonb_agg(jsonb_build_array(id, through_turn) ORDER BY through_turn, id)
                          FROM summary_checkpoints WHERE campaign_id = c.id AND owner_user_id = c.owner_user_id), '[]') AS checkpoints,
              coalesce((SELECT jsonb_agg(jsonb_build_array(id, turn_id, memory_kind) ORDER BY ordinal, id)
                          FROM chronicle_memories WHERE campaign_id = c.id AND owner_user_id = c.owner_user_id), '[]') AS memories,
              coalesce((SELECT jsonb_agg(jsonb_build_array(id, status, job_type) ORDER BY id)
                          FROM chronicle_jobs WHERE campaign_id = c.id AND owner_user_id = c.owner_user_id), '[]') AS "chronicleJobs",
              coalesce((SELECT jsonb_agg(jsonb_build_array(id, status, expected_turn_number, operation_kind, replacement_turn_id, result_turn_id) ORDER BY id)
                          FROM generation_jobs WHERE campaign_id = c.id AND owner_user_id = c.owner_user_id), '[]') AS "generationJobs",
              coalesce((SELECT jsonb_agg(jsonb_build_array(id, status, turn_id) ORDER BY id)
                          FROM image_jobs WHERE campaign_id = c.id AND owner_user_id = c.owner_user_id), '[]') AS "imageJobs",
              coalesce((SELECT jsonb_agg(jsonb_build_array(id, status, turn_id) ORDER BY id)
                          FROM illustration_resolution_jobs WHERE campaign_id = c.id AND owner_user_id = c.owner_user_id), '[]') AS "resolutionJobs"
         FROM campaigns c
         JOIN campaign_state cs ON cs.campaign_id = c.id AND cs.owner_user_id = c.owner_user_id
        WHERE c.id = $1 AND c.owner_user_id = $2`,
      [campaignId, ownerUserId]
    );
    return snapshot.rows[0];
  }

  async function branchSourceSnapshot(campaignId: string) {
    const snapshot = await pool.query<{
      campaign: Record<string, unknown>;
      state: Record<string, unknown>;
      turns: unknown;
      generationJobs: unknown;
    }>(
      `SELECT to_jsonb(c) AS campaign, to_jsonb(cs) AS state,
              coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.turn_number)
                          FROM turns t
                         WHERE t.campaign_id = c.id AND t.owner_user_id = c.owner_user_id), '[]') AS turns,
              coalesce((SELECT jsonb_agg(to_jsonb(g) ORDER BY g.created_at, g.id)
                          FROM generation_jobs g
                         WHERE g.campaign_id = c.id AND g.owner_user_id = c.owner_user_id), '[]') AS "generationJobs"
         FROM campaigns c
         JOIN campaign_state cs ON cs.campaign_id = c.id AND cs.owner_user_id = c.owner_user_id
        WHERE c.id = $1 AND c.owner_user_id = $2`,
      [campaignId, ownerUserId]
    );
    return snapshot.rows[0];
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

  it("keeps branch authority invisible outside the explicit owner scope", async () => {
    const imported = await createCampaignFixture();
    const foreignUserId = await createForeignUserFixture("Foreign branch owner");
    const adapters = createAdapters();

    await expect(adapters.transaction.command((transaction) => adapters.campaigns.branchCampaign(
      transaction,
      { ownerUserId: foreignUserId, campaignId: imported.campaignId },
      {
        targetTurnNumber: 1,
        expectedCurrentTurnNumber: 2
      }
    ))).resolves.toMatchObject({
      ok: false,
      failure: { reason: "campaign_not_found" }
    });
  });

  it("creates an owner-scoped branch with durable lineage while leaving its source unchanged", async () => {
    const imported = await createCampaignFixture();
    const adapters = createAdapters();
    const scope = { ownerUserId, campaignId: imported.campaignId };
    await pool.query(
      `UPDATE campaign_state
          SET import_provenance = $3
        WHERE owner_user_id = $1 AND campaign_id = $2`,
      [ownerUserId, imported.campaignId, JSON.stringify({
        world: { source: "branch-matrix-world" },
        story: { source: "branch-matrix-story" }
      })]
    );
    const sourceBefore = await branchSourceSnapshot(imported.campaignId);
    const targetState = await adapters.transaction.read((transaction) =>
      adapters.state.getCampaignRuntimeState(transaction, scope, 1));

    const branched = await adapters.transaction.command((transaction) => adapters.campaigns.branchCampaign(
      transaction,
      scope,
      {
        targetTurnNumber: 1,
        title: "Authority Branch",
        expectedCurrentTurnNumber: 2
      }
    ));
    expect(branched).toMatchObject({
      ok: true,
      value: {
        id: expect.any(String),
        title: "Authority Branch",
        activeTurnNumber: 1,
        worldVersionId: imported.worldVersionId
      }
    });
    if (!branched.ok) throw new Error("Expected campaign branch creation to succeed.");
    branchCampaignIds.push(branched.value.id);

    const target = await pool.query<{
      ownerUserId: string;
      activeTurnNumber: number;
      worldVersionId: string;
      revision: number;
      scratchpadPrivate: string;
      importProvenance: Record<string, unknown>;
      turnNumber: number;
      sourceTurnId: string | null;
      sourceAcceptedTurnId: string;
      turnImportMetadata: Record<string, unknown>;
      eventDetails: Record<string, unknown>;
    }>(
      `SELECT c.owner_user_id AS "ownerUserId", c.active_turn_number AS "activeTurnNumber",
              c.world_version_id AS "worldVersionId", cs.revision,
              cs.scratchpad_private AS "scratchpadPrivate",
              cs.import_provenance AS "importProvenance", t.turn_number AS "turnNumber",
              t.source_turn_id AS "sourceTurnId",
              source_turn.id AS "sourceAcceptedTurnId", t.import_metadata AS "turnImportMetadata",
              event.details AS "eventDetails"
         FROM campaigns c
         JOIN campaign_state cs ON cs.campaign_id = c.id AND cs.owner_user_id = c.owner_user_id
         JOIN turns t ON t.campaign_id = c.id AND t.owner_user_id = c.owner_user_id
         JOIN turns source_turn
           ON source_turn.campaign_id = $3 AND source_turn.owner_user_id = c.owner_user_id
          AND source_turn.turn_number = t.turn_number
         JOIN activity_events event
           ON event.campaign_id = c.id AND event.owner_user_id = c.owner_user_id
          AND event.event_type = 'campaign_branched'
        WHERE c.id = $1 AND c.owner_user_id = $2`,
      [branched.value.id, ownerUserId, imported.campaignId]
    );
    expect(target.rows).toHaveLength(1);
    expect(target.rows[0]).toMatchObject({
      ownerUserId,
      activeTurnNumber: 1,
      worldVersionId: imported.worldVersionId,
      revision: 0,
      scratchpadPrivate: targetState.scratchpad,
      importProvenance: {
        world: { source: "branch-matrix-world" },
        story: { source: "branch-matrix-story" },
        branch: {
          sourceType: "nexus_campaign_branch",
          branchId: expect.any(String),
          parentCampaignId: imported.campaignId,
          branchTurnNumber: 1
        }
      },
      turnNumber: 1,
      turnImportMetadata: {
        branch: {
          sourceType: "nexus_campaign_branch",
          branchId: expect.any(String),
          parentCampaignId: imported.campaignId,
          sourceTurnId: target.rows[0]!.sourceAcceptedTurnId,
          sourceTurnNumber: 1,
          operationKind: null,
          replacementTurnId: null
        }
      },
      eventDetails: {
        parentCampaignId: imported.campaignId,
        branchTurnNumber: 1,
        branchId: expect.any(String)
      }
    });
    expect((target.rows[0]!.importProvenance.branch as { branchId: string }).branchId)
      .toBe((target.rows[0]!.turnImportMetadata.branch as { branchId: string }).branchId);
    expect((target.rows[0]!.eventDetails as { branchId: string }).branchId)
      .toBe((target.rows[0]!.importProvenance.branch as { branchId: string }).branchId);
    expect(await branchSourceSnapshot(imported.campaignId)).toEqual(sourceBefore);
  });

  it("rejects stale fences and future or missing branch targets without creating a branch", async () => {
    const imported = await createCampaignFixture();
    const adapters = createAdapters();
    const scope = { ownerUserId, campaignId: imported.campaignId };
    const sourceBefore = await branchSourceSnapshot(imported.campaignId);
    const countBefore = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM campaigns WHERE owner_user_id = $1",
      [ownerUserId]
    );

    await expect(adapters.transaction.command((transaction) => adapters.campaigns.branchCampaign(
      transaction,
      scope,
      { targetTurnNumber: 1, expectedCurrentTurnNumber: 1 }
    ))).resolves.toEqual({
      ok: false,
      failure: {
        reason: "active_turn_changed",
        details: {
          campaignId: imported.campaignId,
          expectedTurnNumber: 1,
          actualTurnNumber: 2
        }
      }
    });
    await expect(adapters.transaction.command((transaction) => adapters.campaigns.branchCampaign(
      transaction,
      scope,
      { targetTurnNumber: 3, expectedCurrentTurnNumber: 2 }
    ))).resolves.toEqual({
      ok: false,
      failure: {
        reason: "invalid_transition",
        details: {
          campaignId: imported.campaignId,
          expectedTurnNumber: 3,
          actualTurnNumber: 2
        }
      }
    });
    expect(await branchSourceSnapshot(imported.campaignId)).toEqual(sourceBefore);
    await expect(pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM campaigns WHERE owner_user_id = $1",
      [ownerUserId]
    )).resolves.toMatchObject({ rows: [{ count: countBefore.rows[0]!.count }] });

    const missing = await createCampaignFixture();
    await pool.query(
      "DELETE FROM turns WHERE owner_user_id = $1 AND campaign_id = $2 AND turn_number = 1",
      [ownerUserId, missing.campaignId]
    );
    const missingBaseline = await branchSourceSnapshot(missing.campaignId);
    const countBeforeMissing = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM campaigns WHERE owner_user_id = $1",
      [ownerUserId]
    );
    await expect(adapters.transaction.command((transaction) => adapters.campaigns.branchCampaign(
      transaction,
      { ownerUserId, campaignId: missing.campaignId },
      { targetTurnNumber: 1, expectedCurrentTurnNumber: 2 }
    ))).resolves.toEqual({
      ok: false,
      failure: {
        reason: "invalid_transition",
        details: { campaignId: missing.campaignId, expectedTurnNumber: 1 }
      }
    });
    expect(await branchSourceSnapshot(missing.campaignId)).toEqual(missingBaseline);
    await expect(pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM campaigns WHERE owner_user_id = $1",
      [ownerUserId]
    )).resolves.toMatchObject({ rows: [{ count: countBeforeMissing.rows[0]!.count }] });
  });

  it("preserves accepted append and replacement provenance without cloning operational jobs", async () => {
    const imported = await createCampaignFixture();
    const providerId = await createProviderFixture();
    const adapters = createAdapters();
    const scope = { ownerUserId, campaignId: imported.campaignId };
    const turns = await pool.query<{ id: string; turnNumber: number }>(
      `SELECT id, turn_number AS "turnNumber" FROM turns
        WHERE owner_user_id = $1 AND campaign_id = $2 ORDER BY turn_number`,
      [ownerUserId, imported.campaignId]
    );
    const firstTurn = turns.rows.find((turn) => turn.turnNumber === 1)!;
    const secondTurn = turns.rows.find((turn) => turn.turnNumber === 2)!;
    const replacementTurnId = crypto.randomUUID();
    await pool.query(
      `UPDATE turns
          SET source_turn_id = CASE turn_number WHEN 1 THEN 'legacy-source-one' ELSE 'legacy-source-two' END,
              import_metadata = jsonb_build_object('fixtureMarker', 'preserved-' || turn_number::text)
        WHERE owner_user_id = $1 AND campaign_id = $2`,
      [ownerUserId, imported.campaignId]
    );
    const jobs = await pool.query<{ id: string }>(
      `INSERT INTO generation_jobs (
         owner_user_id, campaign_id, provider_profile_id, idempotency_key,
         expected_turn_number, action, status, requested_model, completed_at,
         operation_kind, replacement_turn_id, result_turn_id, base_turn_number
       ) VALUES
         ($1,$2,$3,$4,1,'Accepted append','completed','fixture-model',now(),'append',NULL,$6,0),
         ($1,$2,$3,$5,2,'Accepted replacement','completed','fixture-model',now(),'replace_latest',$7,$8,1)
       RETURNING id`,
      [
        ownerUserId,
        imported.campaignId,
        providerId,
        crypto.randomUUID(),
        crypto.randomUUID(),
        firstTurn.id,
        replacementTurnId,
        secondTurn.id
      ]
    );
    generationJobIds.push(...jobs.rows.map((row) => row.id));
    const sourceBefore = await branchSourceSnapshot(imported.campaignId);

    const branched = await adapters.transaction.command((transaction) => adapters.campaigns.branchCampaign(
      transaction,
      scope,
      { targetTurnNumber: 2, expectedCurrentTurnNumber: 2 }
    ));
    if (!branched.ok) throw new Error("Expected provenance branch creation to succeed.");
    branchCampaignIds.push(branched.value.id);

    const branchTurns = await pool.query<{
      turnNumber: number;
      sourceTurnId: string | null;
      importMetadata: Record<string, unknown>;
    }>(
      `SELECT turn_number AS "turnNumber", source_turn_id AS "sourceTurnId",
              import_metadata AS "importMetadata"
         FROM turns WHERE owner_user_id = $1 AND campaign_id = $2 ORDER BY turn_number`,
      [ownerUserId, branched.value.id]
    );
    expect(branchTurns.rows).toEqual([
      {
        turnNumber: 1,
        sourceTurnId: "legacy-source-one",
        importMetadata: {
          fixtureMarker: "preserved-1",
          branch: {
            sourceType: "nexus_campaign_branch",
            branchId: expect.any(String),
            parentCampaignId: imported.campaignId,
            sourceTurnId: firstTurn.id,
            sourceTurnNumber: 1,
            operationKind: "append",
            replacementTurnId: null
          }
        }
      },
      {
        turnNumber: 2,
        sourceTurnId: "legacy-source-two",
        importMetadata: {
          fixtureMarker: "preserved-2",
          branch: {
            sourceType: "nexus_campaign_branch",
            branchId: expect.any(String),
            parentCampaignId: imported.campaignId,
            sourceTurnId: secondTurn.id,
            sourceTurnNumber: 2,
            operationKind: "replace_latest",
            replacementTurnId
          }
        }
      }
    ]);
    await expect(pool.query(
      "SELECT id FROM generation_jobs WHERE owner_user_id = $1 AND campaign_id = $2",
      [ownerUserId, branched.value.id]
    )).resolves.toMatchObject({ rows: [] });
    expect(await branchSourceSnapshot(imported.campaignId)).toEqual(sourceBefore);
  });

  it("rolls back every branch write after a deterministic mid-command collaborator failure", async () => {
    const imported = await createCampaignFixture();
    const baseMemory = memoryGeneration(pool);
    const adapters = createAdapters({
      ...baseMemory,
      async rebuildCampaignMemories() {
        throw new Error("injected branch rebuild failure");
      }
    });
    const sourceBefore = await branchSourceSnapshot(imported.campaignId);
    const countBefore = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM campaigns WHERE owner_user_id = $1",
      [ownerUserId]
    );

    await expect(adapters.transaction.command((transaction) => adapters.campaigns.branchCampaign(
      transaction,
      { ownerUserId, campaignId: imported.campaignId },
      { targetTurnNumber: 1, expectedCurrentTurnNumber: 2 }
    ))).rejects.toThrow("injected branch rebuild failure");

    expect(await branchSourceSnapshot(imported.campaignId)).toEqual(sourceBefore);
    await expect(pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM campaigns WHERE owner_user_id = $1",
      [ownerUserId]
    )).resolves.toMatchObject({ rows: [{ count: countBefore.rows[0]!.count }] });
    await expect(pool.query(
      `SELECT c.id FROM campaigns c
        JOIN campaign_state cs ON cs.campaign_id = c.id AND cs.owner_user_id = c.owner_user_id
       WHERE c.owner_user_id = $1
         AND cs.import_provenance->'branch'->>'parentCampaignId' = $2`,
      [ownerUserId, imported.campaignId]
    )).resolves.toMatchObject({ rows: [] });
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

  it("rejects invalid and missing rewind targets without mutating authority", async () => {
    const imported = await createCampaignFixture();
    const adapters = createAdapters();
    const scope = { ownerUserId, campaignId: imported.campaignId };
    const before = await adapters.transaction.read((transaction) =>
      adapters.state.getCampaignRuntimeState(transaction, scope));
    const initial = await authoritySnapshot(imported.campaignId);

    await expect(adapters.transaction.command((transaction) => adapters.campaigns.rewindCampaign(
      transaction,
      scope,
      {
        targetTurnNumber: before.activeTurnNumber + 1,
        expectedCurrentTurnNumber: before.activeTurnNumber,
        expectedStateRevision: before.revision
      }
    ))).resolves.toEqual({
      ok: false,
      failure: {
        reason: "invalid_transition",
        details: {
          campaignId: imported.campaignId,
          expectedTurnNumber: before.activeTurnNumber + 1,
          actualTurnNumber: before.activeTurnNumber
        }
      }
    });
    expect(await authoritySnapshot(imported.campaignId)).toEqual(initial);

    await pool.query(
      "DELETE FROM turns WHERE campaign_id = $1 AND owner_user_id = $2 AND turn_number = 1",
      [imported.campaignId, ownerUserId]
    );
    const missingTargetBaseline = await authoritySnapshot(imported.campaignId);
    await expect(adapters.transaction.command((transaction) => adapters.campaigns.rewindCampaign(
      transaction,
      scope,
      {
        targetTurnNumber: 1,
        expectedCurrentTurnNumber: before.activeTurnNumber,
        expectedStateRevision: before.revision
      }
    ))).resolves.toEqual({
      ok: false,
      failure: {
        reason: "invalid_transition",
        details: { campaignId: imported.campaignId, expectedTurnNumber: 1 }
      }
    });
    expect(await authoritySnapshot(imported.campaignId)).toEqual(missingTargetBaseline);
  });

  it("rejects every active campaign-work category without deleting authority", async () => {
    const providerId = await createProviderFixture();
    for (const category of ["generation", "image", "resolution", "chronicle"] as const) {
      const imported = await createCampaignFixture();
      const adapters = createAdapters();
      const scope = { ownerUserId, campaignId: imported.campaignId };
      const turn = await pool.query<{ id: string }>(
        "SELECT id FROM turns WHERE campaign_id = $1 AND owner_user_id = $2 AND turn_number = 2",
        [imported.campaignId, ownerUserId]
      );
      const turnId = turn.rows[0]!.id;
      if (category === "generation") {
        const job = await pool.query<{ id: string }>(
          `INSERT INTO generation_jobs (
             owner_user_id, campaign_id, provider_profile_id, idempotency_key,
             expected_turn_number, action, status, requested_model
           ) VALUES ($1,$2,$3,$4,3,'Blocked rewind generation','queued','fixture-model')
           RETURNING id`,
          [ownerUserId, imported.campaignId, providerId, crypto.randomUUID()]
        );
        generationJobIds.push(job.rows[0]!.id);
      } else if (category === "image") {
        const job = await pool.query<{ id: string }>(
          `INSERT INTO image_jobs (
             owner_user_id, campaign_id, turn_id, provider_profile_id, requested_model,
             prompt, prompt_hash, status, provider_type, target_type
           ) VALUES ($1,$2,$3,$4,'fixture-model','Blocked rewind image',$5,
                     'queued','openai_compatible','turn_illustration')
           RETURNING id`,
          [ownerUserId, imported.campaignId, turnId, providerId, crypto.randomUUID()]
        );
        imageJobIds.push(job.rows[0]!.id);
      } else if (category === "resolution") {
        const job = await pool.query<{ id: string }>(
          `INSERT INTO illustration_resolution_jobs (
             owner_user_id, campaign_id, turn_id, source_policy, matching_scope,
             confidence_profile, status
           ) VALUES ($1,$2,$3,'library_only','campaign','balanced','queued')
           RETURNING id`,
          [ownerUserId, imported.campaignId, turnId]
        );
        resolutionJobIds.push(job.rows[0]!.id);
      } else {
        const updated = await pool.query<{ id: string }>(
          `UPDATE chronicle_jobs
              SET status = 'running', lease_owner = 'rewind-fixture',
                  lease_expires_at = now() + interval '5 minutes'
            WHERE id = (
              SELECT id FROM chronicle_jobs
               WHERE campaign_id = $1 AND owner_user_id = $2
               ORDER BY created_at LIMIT 1
            )
          RETURNING id`,
          [imported.campaignId, ownerUserId]
        );
        const job = updated.rows[0]
          ? updated
          : await pool.query<{ id: string }>(
            `INSERT INTO chronicle_jobs (
               owner_user_id, campaign_id, job_type, status, lease_owner, lease_expires_at
             ) VALUES ($1,$2,'reindex_campaign','running','rewind-fixture',now() + interval '5 minutes')
             RETURNING id`,
            [ownerUserId, imported.campaignId]
          );
        chronicleJobIds.push(job.rows[0]!.id);
      }

      const baseline = await authoritySnapshot(imported.campaignId);
      await expect(adapters.transaction.command((transaction) => adapters.campaigns.rewindCampaign(
        transaction,
        scope,
        { targetTurnNumber: 1, expectedCurrentTurnNumber: 2, expectedStateRevision: 0 }
      ))).resolves.toEqual({
        ok: false,
        failure: { reason: "invalid_transition", details: { campaignId: imported.campaignId } }
      });
      expect(await authoritySnapshot(imported.campaignId)).toEqual(baseline);
    }
  });

  it("rolls back every rewind write when the caller-owned memory rebuild fails after deletion", async () => {
    const imported = await createCampaignFixture();
    const providerId = await createProviderFixture();
    const scope = { ownerUserId, campaignId: imported.campaignId };
    const baseAdapters = createAdapters();
    const current = await baseAdapters.transaction.read((transaction) =>
      baseAdapters.state.getCampaignRuntimeState(transaction, scope));
    const stateEdit = await pool.query<{ id: string }>(
      `INSERT INTO campaign_state_edits (
         owner_user_id, campaign_id, effective_turn_number, revision,
         state_snapshot_private, changed_fields
       ) VALUES ($1,$2,2,1,$3,'["scratchpad"]') RETURNING id`,
      [ownerUserId, imported.campaignId, JSON.stringify(current)]
    );
    stateEditIds.push(stateEdit.rows[0]!.id);
    const checkpoint = await pool.query<{ id: string }>(
      `INSERT INTO summary_checkpoints (
         owner_user_id, campaign_id, through_turn, summary_kind, content, token_estimate
       ) VALUES ($1,$2,2,'rewind-test','{"summary":"must roll back"}',4) RETURNING id`,
      [ownerUserId, imported.campaignId]
    );
    checkpointIds.push(checkpoint.rows[0]!.id);
    const generation = await pool.query<{ id: string }>(
      `INSERT INTO generation_jobs (
         owner_user_id, campaign_id, provider_profile_id, idempotency_key,
         expected_turn_number, action, status, requested_model, completed_at
       ) VALUES ($1,$2,$3,$4,2,'Rollback rewind generation','completed','fixture-model',now())
       RETURNING id`,
      [ownerUserId, imported.campaignId, providerId, crypto.randomUUID()]
    );
    generationJobIds.push(generation.rows[0]!.id);
    const baseline = await authoritySnapshot(imported.campaignId);
    const memory = memoryGeneration(pool);
    const adapters = createAdapters({
      ...memory,
      async rebuildCampaignMemories() {
        throw new Error("injected rewind rebuild failure");
      }
    });

    await expect(adapters.transaction.command((transaction) => adapters.campaigns.rewindCampaign(
      transaction,
      scope,
      { targetTurnNumber: 1, expectedCurrentTurnNumber: 2, expectedStateRevision: 0 }
    ))).rejects.toThrow("injected rewind rebuild failure");
    expect(await authoritySnapshot(imported.campaignId)).toEqual(baseline);
  });

  it("deletes only post-target derived rows while retaining accepted append and replacement provenance", async () => {
    const imported = await createCampaignFixture();
    const providerId = await createProviderFixture();
    const adapters = createAdapters();
    const scope = { ownerUserId, campaignId: imported.campaignId };
    const targetState = await adapters.transaction.read((transaction) =>
      adapters.state.getCampaignRuntimeState(transaction, scope, 1));
    const currentState = await adapters.transaction.read((transaction) =>
      adapters.state.getCampaignRuntimeState(transaction, scope));
    const turns = await pool.query<{ id: string; turnNumber: number }>(
      `SELECT id, turn_number AS "turnNumber" FROM turns
        WHERE campaign_id = $1 AND owner_user_id = $2 ORDER BY turn_number`,
      [imported.campaignId, ownerUserId]
    );
    const retainedTurnId = turns.rows.find((turn) => turn.turnNumber === 1)!.id;
    const discardedTurnId = turns.rows.find((turn) => turn.turnNumber === 2)!.id;

    const edits = await pool.query<{ id: string }>(
      `INSERT INTO campaign_state_edits (
         owner_user_id, campaign_id, effective_turn_number, revision,
         state_snapshot_private, changed_fields
       ) VALUES
         ($1,$2,1,1,$3,'["scratchpad"]'),
         ($1,$2,2,2,$4,'["scratchpad"]')
       RETURNING id`,
      [ownerUserId, imported.campaignId, JSON.stringify(targetState), JSON.stringify(currentState)]
    );
    stateEditIds.push(...edits.rows.map((row) => row.id));
    const retainedStateEditId = edits.rows[0]!.id;
    const discardedStateEditId = edits.rows[1]!.id;
    const checkpoints = await pool.query<{ id: string; throughTurn: number }>(
      `INSERT INTO summary_checkpoints (
         owner_user_id, campaign_id, through_turn, summary_kind, content, token_estimate
       ) VALUES
         ($1,$2,1,'rewind-test','{"summary":"retain"}',2),
         ($1,$2,2,'rewind-test','{"summary":"discard"}',2)
       RETURNING id, through_turn AS "throughTurn"`,
      [ownerUserId, imported.campaignId]
    );
    checkpointIds.push(...checkpoints.rows.map((row) => row.id));
    const retainedCheckpointId = checkpoints.rows.find((row) => row.throughTurn === 1)!.id;
    const discardedCheckpointId = checkpoints.rows.find((row) => row.throughTurn === 2)!.id;
    const durableReplacementTurnId = crypto.randomUUID();
    const jobs = await pool.query<{
      id: string;
      operationKind: "append" | "replace_latest";
      expectedTurnNumber: number;
    }>(
      `INSERT INTO generation_jobs (
         owner_user_id, campaign_id, provider_profile_id, idempotency_key,
         expected_turn_number, action, status, requested_model, completed_at,
         operation_kind, replacement_turn_id, result_turn_id, base_turn_number
       ) VALUES
         ($1,$2,$3,$4,1,'Retained append','completed','fixture-model',now(),'append',NULL,$7,0),
         ($1,$2,$3,$5,1,'Retained replacement','completed','fixture-model',now(),'replace_latest',$6,$7,0),
         ($1,$2,$3,$8,2,'Discarded append','completed','fixture-model',now(),'append',NULL,$9,1)
       RETURNING id, operation_kind AS "operationKind", expected_turn_number AS "expectedTurnNumber"`,
      [
        ownerUserId,
        imported.campaignId,
        providerId,
        crypto.randomUUID(),
        crypto.randomUUID(),
        durableReplacementTurnId,
        retainedTurnId,
        crypto.randomUUID(),
        discardedTurnId
      ]
    );
    generationJobIds.push(...jobs.rows.map((row) => row.id));
    const retainedJobIds = jobs.rows
      .filter((job) => job.expectedTurnNumber === 1)
      .map((job) => job.id)
      .sort();
    const discardedJobId = jobs.rows.find((job) => job.expectedTurnNumber === 2)!.id;
    const chronicle = await pool.query<{ id: string }>(
      `INSERT INTO chronicle_jobs (owner_user_id, campaign_id, job_type, status, completed_at)
       VALUES ($1,$2,'embed_campaign','completed',now()) RETURNING id`,
      [ownerUserId, imported.campaignId]
    );
    chronicleJobIds.push(chronicle.rows[0]!.id);
    const memories = await pool.query<{ id: string }>(
      `INSERT INTO chronicle_memories (
         owner_user_id, campaign_id, world_version_id, turn_id, memory_kind,
         ordinal, content, token_estimate, metadata
       ) VALUES
         ($1,$2,$3,$4,'campaign_summary',1,'Retained rewind memory',4,'{}'),
         ($1,$2,$3,$5,'campaign_summary',2,'Discarded rewind memory',4,'{}')
       RETURNING id`,
      [ownerUserId, imported.campaignId, imported.worldVersionId, retainedTurnId, discardedTurnId]
    );
    memoryIds.push(...memories.rows.map((row) => row.id));

    await expect(adapters.transaction.command((transaction) => adapters.campaigns.rewindCampaign(
      transaction,
      scope,
      { targetTurnNumber: 1, expectedCurrentTurnNumber: 2, expectedStateRevision: 0 }
    ))).resolves.toMatchObject({ ok: true, value: { activeTurnNumber: 1, discardedTurnCount: 1 } });

    await expect(pool.query(
      `SELECT id FROM turns WHERE campaign_id = $1 AND owner_user_id = $2 ORDER BY turn_number`,
      [imported.campaignId, ownerUserId]
    )).resolves.toMatchObject({ rows: [{ id: retainedTurnId }] });
    await expect(pool.query(
      "SELECT id FROM campaign_state_edits WHERE campaign_id = $1 AND owner_user_id = $2 ORDER BY revision",
      [imported.campaignId, ownerUserId]
    )).resolves.toMatchObject({ rows: [{ id: retainedStateEditId }] });
    await expect(pool.query(
      "SELECT id FROM summary_checkpoints WHERE campaign_id = $1 AND owner_user_id = $2 ORDER BY through_turn",
      [imported.campaignId, ownerUserId]
    )).resolves.toMatchObject({ rows: [{ id: retainedCheckpointId }] });
    const survivingJobs = await pool.query<{
      id: string;
      operationKind: string;
      replacementTurnId: string | null;
    }>(
      `SELECT id, operation_kind AS "operationKind", replacement_turn_id AS "replacementTurnId"
         FROM generation_jobs WHERE campaign_id = $1 AND owner_user_id = $2 ORDER BY id`,
      [imported.campaignId, ownerUserId]
    );
    expect(survivingJobs.rows.map((job) => job.id).sort()).toEqual(retainedJobIds);
    expect(survivingJobs.rows).toContainEqual(expect.objectContaining({
      operationKind: "replace_latest",
      replacementTurnId: durableReplacementTurnId
    }));
    expect(survivingJobs.rows).not.toContainEqual(expect.objectContaining({ id: discardedJobId }));
    await expect(pool.query("SELECT id FROM campaign_state_edits WHERE id = $1", [discardedStateEditId]))
      .resolves.toMatchObject({ rows: [] });
    await expect(pool.query("SELECT id FROM summary_checkpoints WHERE id = $1", [discardedCheckpointId]))
      .resolves.toMatchObject({ rows: [] });
    await expect(pool.query("SELECT id FROM chronicle_jobs WHERE id = $1", [chronicle.rows[0]!.id]))
      .resolves.toMatchObject({ rows: [] });
    await expect(pool.query(
      `SELECT id FROM chronicle_memories
        WHERE campaign_id = $1 AND owner_user_id = $2 AND turn_id = $3`,
      [imported.campaignId, ownerUserId, discardedTurnId]
    )).resolves.toMatchObject({ rows: [] });
    const retainedMemories = await pool.query(
      `SELECT id FROM chronicle_memories
        WHERE campaign_id = $1 AND owner_user_id = $2 AND turn_id = $3`,
      [imported.campaignId, ownerUserId, retainedTurnId]
    );
    expect(retainedMemories.rowCount).toBeGreaterThan(0);
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
