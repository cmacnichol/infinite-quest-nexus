import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createPostgresPortableFamilyMutationRepository } from "../../packages/database/src/portable-import-family-repository.js";
import { createDatabasePool, initialOwnerId, type DatabasePool, withTransaction } from "../../packages/database/src/pool.js";
import { createPostgresWorldRepositoryAdapters } from "../../packages/database/src/world-repository.js";
import { createCanonicalFactId } from "../../packages/domain/src/canonical-facts.js";
import { branchCampaign, getCampaignRuntimeState, importLegacyStory, rebuildCampaignMemories } from "../helpers/memory-aware-services.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("canonical fact remapping compatibility", () => {
  let pool: DatabasePool;

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  async function campaignEvidence(campaignId: string) {
    const [turns, edits, facts] = await Promise.all([
      pool.query<{ state_snapshot_private: unknown }>(
        "SELECT state_snapshot_private FROM turns WHERE campaign_id=$1 ORDER BY turn_number",
        [campaignId]
      ),
      pool.query<{ state_snapshot_private: unknown }>(
        "SELECT state_snapshot_private FROM campaign_state_edits WHERE campaign_id=$1 ORDER BY revision",
        [campaignId]
      ),
      pool.query<{
        id: string;
        content: string;
        valid_until_turn: number | null;
        superseded_by_fact_id: string | null;
      }>(
        `SELECT id,content,valid_until_turn,superseded_by_fact_id
           FROM campaign_canonical_facts WHERE campaign_id=$1
           ORDER BY source_turn_number,source_fact_index`,
        [campaignId]
      )
    ]);
    return {
      turnSnapshots: turns.rows.map((row) => row.state_snapshot_private),
      correctionSnapshots: edits.rows.map((row) => row.state_snapshot_private),
      facts: facts.rows
    };
  }

  it("replays and branches repeated object fact identities while preserving correction and supersession provenance", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Repeated fact remapping ${crypto.randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({
      sourceName: "repeated-object-fact-remapping.story",
      story: fixture
    }));
    const ownerUserId = await initialOwnerId(pool);
    const turns = await pool.query<{ id: string; turn_number: number }>(
      "SELECT id,turn_number FROM turns WHERE owner_user_id=$1 AND campaign_id=$2 ORDER BY turn_number",
      [ownerUserId, imported.campaignId]
    );
    const firstTurn = turns.rows[0]!;
    const secondTurn = turns.rows[1]!;
    const repeatedContent = "The harbor lantern remains lit through the storm.";
    const replacementContent = "The harbor lantern is extinguished after the storm.";
    const sourceFactId = createCanonicalFactId({
      campaignId: imported.campaignId,
      sourceTurnId: firstTurn.id,
      factIndex: 0,
      content: repeatedContent
    });

    await pool.query(
      `UPDATE turns
          SET state_snapshot_private=state_snapshot_private || $3::jsonb
        WHERE owner_user_id=$1 AND campaign_id=$2 AND id=$4`,
      [ownerUserId, imported.campaignId, JSON.stringify({
        canonicalFacts: [{ id: sourceFactId, content: repeatedContent }],
        canonicalFactUpdates: []
      }), firstTurn.id]
    );
    await pool.query(
      `UPDATE turns
          SET state_snapshot_private=state_snapshot_private || $3::jsonb
        WHERE owner_user_id=$1 AND campaign_id=$2 AND id=$4`,
      [ownerUserId, imported.campaignId, JSON.stringify({
        canonicalFacts: [{ id: sourceFactId, content: repeatedContent }],
        canonicalFactUpdates: [{ content: replacementContent, supersedesFactIds: [sourceFactId] }]
      }), secondTurn.id]
    );
    await pool.query(
      `INSERT INTO campaign_state_edits (
         owner_user_id,campaign_id,effective_turn_number,revision,state_snapshot_private,changed_fields
       ) VALUES ($1,$2,1,1,$3::jsonb,'["canonicalFacts"]'::jsonb)`,
      [ownerUserId, imported.campaignId, JSON.stringify({
        continuitySummary: "",
        openThreads: [],
        canonicalFacts: [{ id: sourceFactId, content: repeatedContent }]
      })]
    );

    await rebuildCampaignMemories(pool, imported.campaignId);
    const sourceEvidence = await campaignEvidence(imported.campaignId);
    expect(sourceEvidence.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: sourceFactId, content: repeatedContent, valid_until_turn: 2, superseded_by_fact_id: expect.any(String) }),
      expect.objectContaining({ content: replacementContent, valid_until_turn: null, superseded_by_fact_id: null })
    ]));
    expect((await getCampaignRuntimeState(pool, imported.campaignId)).canonicalFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: replacementContent })
    ]));
    const branch = await branchCampaign(pool, imported.campaignId, {
      targetTurnNumber: 2,
      expectedCurrentTurnNumber: 2
    });
    await rebuildCampaignMemories(pool, branch.id);

    const copied = await pool.query<{
      first_snapshot: { canonicalFacts?: Array<{ id: string | null; content: string }> };
      second_snapshot: { canonicalFacts?: Array<{ id: string | null; content: string }>; canonicalFactUpdates?: Array<{ supersedesFactIds?: string[] }> };
      correction_snapshot: { canonicalFacts?: Array<{ id: string | null; content: string }> };
    }>(
      `SELECT first_turn.state_snapshot_private AS first_snapshot,
              second_turn.state_snapshot_private AS second_snapshot,
              edit.state_snapshot_private AS correction_snapshot
         FROM turns first_turn
         JOIN turns second_turn ON second_turn.campaign_id=first_turn.campaign_id AND second_turn.turn_number=2
         JOIN campaign_state_edits edit ON edit.campaign_id=first_turn.campaign_id AND edit.revision=1
        WHERE first_turn.owner_user_id=$1 AND first_turn.campaign_id=$2 AND first_turn.turn_number=1`,
      [ownerUserId, branch.id]
    );
    const destinationFactId = copied.rows[0]!.first_snapshot.canonicalFacts?.[0]?.id;
    expect(destinationFactId).toEqual(expect.any(String));
    expect(destinationFactId).not.toBe(sourceFactId);
    expect(copied.rows[0]!.second_snapshot.canonicalFacts).toEqual([
      { id: destinationFactId, content: repeatedContent }
    ]);
    expect(copied.rows[0]!.correction_snapshot.canonicalFacts).toEqual([
      { id: destinationFactId, content: repeatedContent }
    ]);
    expect(copied.rows[0]!.second_snapshot.canonicalFactUpdates?.[0]?.supersedesFactIds).toEqual([destinationFactId]);
    expect(await campaignEvidence(imported.campaignId)).toEqual(sourceEvidence);
  });

  it("imports repeated object fact identities without replacing their original destination provenance", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Portable repeated fact remapping ${crypto.randomUUID()}`;
    const source = await importLegacyStory(pool, storyImportRequestSchema.parse({
      sourceName: "portable-repeated-object-fact-remapping.story",
      story: fixture
    }));
    const ownerUserId = await initialOwnerId(pool);
    const destination = await pool.query<{ world_id: string; world_version_id: string; content: unknown }>(
      `SELECT w.id AS world_id,wv.id AS world_version_id,wv.content
         FROM campaigns c
         JOIN world_versions wv ON wv.id=c.world_version_id
         JOIN worlds w ON w.id=wv.world_id
        WHERE c.owner_user_id=$1 AND c.id=$2`,
      [ownerUserId, source.campaignId]
    );
    const sourceCampaignId = crypto.randomUUID();
    const sourceTurnOneId = crypto.randomUUID();
    const sourceTurnTwoId = crypto.randomUUID();
    const repeatedContent = "The observatory lens remains aligned with the north star.";
    const replacementContent = "The observatory lens turns toward the crimson comet.";
    const sourceFactId = createCanonicalFactId({
      campaignId: sourceCampaignId,
      sourceTurnId: sourceTurnOneId,
      factIndex: 0,
      content: repeatedContent
    });
    const mutations = createPostgresPortableFamilyMutationRepository(
      createPostgresWorldRepositoryAdapters(pool, {
        memory: { async autoEnableCampaignEmbedding() { return { enabled: false }; } }
      }).worlds
    );
    const imported = await withTransaction(pool, (database) => mutations.commitCampaignZip(database, {
      owner: { ownerUserId },
      destination: {
        kind: "existing_world_version",
        worldId: destination.rows[0]!.world_id,
        worldVersionId: destination.rows[0]!.world_version_id
      },
      authorityFingerprint: crypto.randomUUID().replaceAll("-", ""),
      payload: {
        archiveFormat: "manifest_v1",
        sourceName: "repeated-object-fact-remapping.zip",
        campaign: {
          campaign: { sourceCampaignId, title: "Portable repeated fact remapping", stateRevision: 1 },
          settings: {},
          turns: [{
            id: sourceTurnOneId, turnNumber: 1, action: "Observe", narration: "The observatory lens holds steady.",
            worldStateSnapshot: { canonicalFacts: [{ id: sourceFactId, content: repeatedContent }] }
          }, {
            id: sourceTurnTwoId, turnNumber: 2, action: "Record", narration: "The observatory lens turns toward the comet.",
            worldStateSnapshot: {
              canonicalFacts: [{ id: sourceFactId, content: repeatedContent }],
              canonicalFactUpdates: [{ content: replacementContent, supersedesFactIds: [sourceFactId] }]
            }
          }],
          archiveRecords: {
            formatVersion: 1,
            characterProfileEdits: [],
            stateEdits: [{
              id: crypto.randomUUID(), effective_turn_number: 1, revision: 1,
              state_snapshot_private: { canonicalFacts: [{ id: sourceFactId, content: repeatedContent }] },
              changed_fields: ["canonicalFacts"], created_at: "2030-01-01T00:00:00.000Z"
            }],
            narrationCorrections: [], worldMigrations: [], illustrationConfig: null,
            illustrationSets: [], illustrationSegments: [], costs: []
          }
        },
        world: { canonicalHash: crypto.randomUUID().replaceAll("-", ""), content: JSON.parse(JSON.stringify(destination.rows[0]!.content)) },
        chronicle: { formatVersion: 1, memories: [], summaries: [] }
      },
      publishedAssets: []
    }));
    if (!imported.campaignId) throw new Error("expected imported campaign");
    await rebuildCampaignMemories(pool, imported.campaignId);

    const copied = await pool.query<{
      first_snapshot: { canonicalFacts?: Array<{ id: string | null; content: string }> };
      second_snapshot: { canonicalFacts?: Array<{ id: string | null; content: string }>; canonicalFactUpdates?: Array<{ supersedesFactIds?: string[] }> };
      correction_snapshot: { canonicalFacts?: Array<{ id: string | null; content: string }> };
    }>(
      `SELECT first_turn.state_snapshot_private AS first_snapshot,
              second_turn.state_snapshot_private AS second_snapshot,
              edit.state_snapshot_private AS correction_snapshot
         FROM turns first_turn
         JOIN turns second_turn ON second_turn.campaign_id=first_turn.campaign_id AND second_turn.turn_number=2
         JOIN campaign_state_edits edit ON edit.campaign_id=first_turn.campaign_id AND edit.revision=1
        WHERE first_turn.owner_user_id=$1 AND first_turn.campaign_id=$2 AND first_turn.turn_number=1`,
      [ownerUserId, imported.campaignId]
    );
    const destinationFactId = copied.rows[0]!.first_snapshot.canonicalFacts?.[0]?.id;
    expect(destinationFactId).toEqual(expect.any(String));
    expect(destinationFactId).not.toBe(sourceFactId);
    expect(copied.rows[0]!.second_snapshot.canonicalFacts).toEqual([
      { id: destinationFactId, content: repeatedContent }
    ]);
    expect(copied.rows[0]!.correction_snapshot.canonicalFacts).toEqual([
      { id: destinationFactId, content: repeatedContent }
    ]);
    expect(copied.rows[0]!.second_snapshot.canonicalFactUpdates?.[0]?.supersedesFactIds).toEqual([destinationFactId]);
  });
});
