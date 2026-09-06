import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { createCanonicalFactId } from "../../packages/domain/src/canonical-facts.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { branchCampaign, importLegacyStory, rebuildCampaignMemories } from "../helpers/memory-aware-services.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("campaign-state correction replay", () => {
  let pool: DatabasePool;

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it("does not resurrect a correction fact after a later accepted turn supersedes it", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Chronological correction replay ${crypto.randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({
      sourceName: "chronological-correction.story",
      story: fixture
    }));
    const ownerUserId = await initialOwnerId(pool);
    const turns = await pool.query<{ id: string; turn_number: number }>(
      "SELECT id,turn_number FROM turns WHERE owner_user_id=$1 AND campaign_id=$2 ORDER BY turn_number",
      [ownerUserId, imported.campaignId]
    );
    const firstTurn = turns.rows[0]!;
    const secondTurn = turns.rows[1]!;
    const correctionFactId = crypto.randomUUID();
    const correctionContent = "The moon gate answers only to the silver key.";
    const laterContent = "The moon gate is permanently sealed beneath the harbor.";
    const laterFactId = createCanonicalFactId({
      campaignId: imported.campaignId,
      sourceTurnId: secondTurn.id,
      factIndex: 0,
      content: laterContent
    });

    await pool.query(
      `INSERT INTO campaign_state_edits (
         owner_user_id,campaign_id,effective_turn_number,revision,state_snapshot_private,changed_fields
       ) VALUES ($1,$2,1,1,$3::jsonb,'["canonicalFacts"]'::jsonb)`,
      [ownerUserId, imported.campaignId, JSON.stringify({
        continuitySummary: "",
        openThreads: [],
        canonicalFacts: [{ id: correctionFactId, content: correctionContent }]
      })]
    );
    await pool.query(
      `UPDATE turns
          SET state_snapshot_private=state_snapshot_private || $3::jsonb
        WHERE owner_user_id=$1 AND campaign_id=$2 AND id=$4`,
      [ownerUserId, imported.campaignId, JSON.stringify({
        canonicalFacts: [laterContent],
        supersededFacts: [],
        canonicalFactUpdates: [{ content: laterContent, supersedesFactIds: [correctionFactId] }]
      }), secondTurn.id]
    );

    await rebuildCampaignMemories(pool, imported.campaignId);

    const facts = await pool.query<{
      id: string;
      content: string;
      valid_until_turn: number | null;
      superseded_by_fact_id: string | null;
    }>(
      `SELECT id,content,valid_until_turn,superseded_by_fact_id
         FROM campaign_canonical_facts
        WHERE owner_user_id=$1 AND campaign_id=$2
        ORDER BY source_turn_number,source_fact_index`,
      [ownerUserId, imported.campaignId]
    );
    expect(facts.rows).toEqual([
      {
        id: correctionFactId,
        content: correctionContent,
        valid_until_turn: 2,
        superseded_by_fact_id: laterFactId
      },
      {
        id: laterFactId,
        content: laterContent,
        valid_until_turn: null,
        superseded_by_fact_id: null
      }
    ]);
  });

  it.each(["generated", "manual"])("branches a %s correction fact so a later accepted turn supersedes its destination identity", async (origin) => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Branch correction portability ${crypto.randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({
      sourceName: "branch-correction-portability.story",
      story: fixture
    }));
    const ownerUserId = await initialOwnerId(pool);
    const turns = await pool.query<{ id: string; turn_number: number }>(
      "SELECT id,turn_number FROM turns WHERE owner_user_id=$1 AND campaign_id=$2 ORDER BY turn_number",
      [ownerUserId, imported.campaignId]
    );
    const firstTurn = turns.rows[0]!;
    const secondTurn = turns.rows[1]!;
    const correctionContent = "The lighthouse lens belongs to the tidekeeper.";
    const replacementContent = "The lighthouse lens shattered beneath the tide.";
    const sourceCorrectionFactId = origin === "generated" ? createCanonicalFactId({
      campaignId: imported.campaignId,
      sourceTurnId: firstTurn.id,
      factIndex: 0,
      content: correctionContent
    }) : crypto.randomUUID();

    await pool.query(
      `UPDATE turns
          SET state_snapshot_private=state_snapshot_private || $3::jsonb
        WHERE owner_user_id=$1 AND campaign_id=$2 AND id=$4`,
      [ownerUserId, imported.campaignId, JSON.stringify({
        canonicalFacts: origin === "generated" ? [correctionContent] : [],
        canonicalFactUpdates: []
      }), firstTurn.id]
    );

    await pool.query(
      `INSERT INTO campaign_state_edits (
         owner_user_id,campaign_id,effective_turn_number,revision,state_snapshot_private,changed_fields
       ) VALUES ($1,$2,1,1,$3::jsonb,'["canonicalFacts"]'::jsonb)`,
      [ownerUserId, imported.campaignId, JSON.stringify({
        continuitySummary: "",
        openThreads: [],
        canonicalFacts: [{ id: sourceCorrectionFactId, content: correctionContent }]
      })]
    );
    await pool.query(
      `UPDATE turns
          SET state_snapshot_private=state_snapshot_private || $3::jsonb
        WHERE owner_user_id=$1 AND campaign_id=$2 AND id=$4`,
      [ownerUserId, imported.campaignId, JSON.stringify({
        canonicalFacts: [replacementContent],
        supersededFacts: [],
        canonicalFactUpdates: [{ content: replacementContent, supersedesFactIds: [sourceCorrectionFactId] }]
      }), secondTurn.id]
    );
    const sourceLedger = await pool.query<{
      turn_snapshot: Record<string, unknown>;
      edit_snapshot: Record<string, unknown>;
    }>(
      `SELECT turn_row.state_snapshot_private AS turn_snapshot,
              edit.state_snapshot_private AS edit_snapshot
         FROM turns turn_row
         CROSS JOIN campaign_state_edits edit
        WHERE turn_row.owner_user_id=$1 AND turn_row.campaign_id=$2 AND turn_row.turn_number=2
          AND edit.owner_user_id=$1 AND edit.campaign_id=$2 AND edit.revision=1`,
      [ownerUserId, imported.campaignId]
    );
    await rebuildCampaignMemories(pool, imported.campaignId);

    const branch = await branchCampaign(pool, imported.campaignId, {
      targetTurnNumber: 2,
      expectedCurrentTurnNumber: 2
    });

    const copied = await pool.query<{
      turn_snapshot: { canonicalFactUpdates?: Array<{ supersedesFactIds?: string[] }> };
      edit_snapshot: { canonicalFacts?: Array<{ id: string | null; content: string }> };
    }>(
      `SELECT turn_row.state_snapshot_private AS turn_snapshot,
              edit.state_snapshot_private AS edit_snapshot
         FROM turns turn_row
         CROSS JOIN campaign_state_edits edit
        WHERE turn_row.owner_user_id=$1 AND turn_row.campaign_id=$2 AND turn_row.turn_number=2
          AND edit.owner_user_id=$1 AND edit.campaign_id=$2 AND edit.revision=1`,
      [ownerUserId, branch.id]
    );
    const destinationFirstTurn = await pool.query<{ id: string }>(
      "SELECT id FROM turns WHERE owner_user_id=$1 AND campaign_id=$2 AND turn_number=1",
      [ownerUserId, branch.id]
    );
    const destinationCorrectionFactId = copied.rows[0]!.edit_snapshot.canonicalFacts?.[0]?.id;
    const expectedDestinationFactId = origin === "generated" ? createCanonicalFactId({
      campaignId: branch.id,
      sourceTurnId: destinationFirstTurn.rows[0]!.id,
      factIndex: 0,
      content: correctionContent
    }) : destinationCorrectionFactId;
    expect(destinationCorrectionFactId).toEqual(expect.any(String));
    expect(destinationCorrectionFactId).not.toBe(sourceCorrectionFactId);
    expect(destinationCorrectionFactId).toBe(expectedDestinationFactId);
    expect(copied.rows[0]!.turn_snapshot.canonicalFactUpdates?.[0]?.supersedesFactIds)
      .toEqual([destinationCorrectionFactId]);
    await rebuildCampaignMemories(pool, branch.id);
    expect(await pool.query<{
      id: string;
      content: string;
      valid_until_turn: number | null;
      superseded_by_fact_id: string | null;
    }>(
      `SELECT id,content,valid_until_turn,superseded_by_fact_id
         FROM campaign_canonical_facts
        WHERE owner_user_id=$1 AND campaign_id=$2
        ORDER BY source_turn_number,source_fact_index`,
      [ownerUserId, branch.id]
    )).toMatchObject({
      rows: [
        {
          id: expectedDestinationFactId,
          content: correctionContent,
          valid_until_turn: 2,
          superseded_by_fact_id: expect.any(String)
        },
        {
          content: replacementContent,
          valid_until_turn: null,
          superseded_by_fact_id: null
        }
      ]
    });
    expect(await pool.query(
      `SELECT turn_row.state_snapshot_private AS turn_snapshot,
              edit.state_snapshot_private AS edit_snapshot
         FROM turns turn_row
         CROSS JOIN campaign_state_edits edit
        WHERE turn_row.owner_user_id=$1 AND turn_row.campaign_id=$2 AND turn_row.turn_number=2
          AND edit.owner_user_id=$1 AND edit.campaign_id=$2 AND edit.revision=1`,
      [ownerUserId, imported.campaignId]
    )).toMatchObject({ rows: sourceLedger.rows });
  });
});
