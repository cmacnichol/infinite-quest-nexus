import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { campaignCreateSchema, worldContentSchema, worldCreateSchema, worldPublishSchema } from "../../packages/contracts/src/world-library.js";
import { campaignTransferCommitRequestSchema, campaignTransferPreviewRequestSchema } from "../../packages/contracts/src/campaign-transfer.js";
import { createCampaign, createWorld, publishWorld } from "../../services/api/src/world-service.js";
import { previewCampaignWorldTransfer, transferCampaignWorld } from "../../services/api/src/campaign-transfer-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

function content(title: string, characterId: string) {
  return worldContentSchema.parse({
    schemaVersion: 4,
    world: {
      title,
      genre: "synthetic",
      tone: "neutral",
      premise: `Premise for ${title}`,
      backgroundStory: `Background for ${title}`,
      firstAction: "Begin.",
      rules: "Synthetic rules."
    },
    playableCharacters: [{ id: characterId, name: `Character ${characterId}`, characterText: "Synthetic guidance." }]
  });
}

integration("cross-world campaign transfer", () => {
  let pool: DatabasePool;

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  async function publishedWorld(label: string, characterId: string) {
    const title = `${label} ${crypto.randomUUID()}`;
    const created = await createWorld(pool, worldCreateSchema.parse({ title, content: content(title, characterId) }));
    const version = await publishWorld(pool, created.id, worldPublishSchema.parse({ expectedRevision: created.draftRevision }));
    return { ...created, ...version, title };
  }

  it("copies authoritative history and state, remaps assets, and retries idempotently", async () => {
    const sourceWorld = await publishedWorld("Transfer Source", "source-hero");
    const targetWorld = await publishedWorld("Transfer Target", "target-hero");
    const source = await createCampaign(pool, campaignCreateSchema.parse({
      worldVersionId: sourceWorld.worldVersionId,
      title: `Source Campaign ${crypto.randomUUID()}`,
      selectedCharacterId: "source-hero"
    }));
    const ownerUserId = await initialOwnerId(pool);
    const currentProfile = {
      name: "Transferred Hero",
      profile: {
        identity: { aliases: ["The Voyager"], pronouns: "they/them" },
        story: { role: "World walker" },
        appearance: { hair: "silver braid" },
        unclassifiedNotes: ""
      }
    };
    await pool.query(
      `UPDATE campaigns
          SET character_profile = $3, character_profile_revision = 4, updated_at = now()
        WHERE id = $1 AND owner_user_id = $2`,
      [source.id, ownerUserId, JSON.stringify(currentProfile)]
    );
    const turn = await pool.query<{ id: string }>(
      `INSERT INTO turns (
         owner_user_id, campaign_id, turn_number, action, narration, choices,
         state_snapshot_private, model_metadata
       ) VALUES ($1,$2,1,'Enter the gate.','The traveler enters the gate.','[]',$3,$4) RETURNING id`,
      [ownerUserId, source.id, JSON.stringify({ scratchpad: "private", trackers: [], eventTriggers: [], pendingEventTriggers: [], rpgStats: [] }),
        JSON.stringify({ model: "synthetic-model", promptProtocolVersion: "test" })]
    );
    await pool.query("UPDATE campaigns SET active_turn_number = 1 WHERE id = $1 AND owner_user_id = $2", [source.id, ownerUserId]);
    await pool.query(
      `UPDATE campaign_state SET scratchpad_private = 'private', scratchpad_safe_for_prompt = true,
              revision = 1, updated_at = now() WHERE campaign_id = $1 AND owner_user_id = $2`,
      [source.id, ownerUserId]
    );
    await pool.query(
      `INSERT INTO campaign_state_edits (
         owner_user_id, campaign_id, effective_turn_number, revision, state_snapshot_private, changed_fields
       ) VALUES ($1,$2,1,1,$3,'["scratchpad"]')`,
      [ownerUserId, source.id, JSON.stringify({ scratchpad: "private", trackers: [], eventTriggers: [], pendingEventTriggers: [], rpgStats: [] })]
    );
    const asset = await pool.query<{ id: string }>(
      `INSERT INTO assets (owner_user_id, campaign_id, turn_id, content_hash, storage_driver, storage_path, mime_type, byte_length)
       VALUES ($1,$2,$3,$4,'filesystem',$5,'image/png',4) RETURNING id`,
      [ownerUserId, source.id, turn.rows[0]!.id, `transfer-${crypto.randomUUID()}`, `transfer/${crypto.randomUUID()}.png`]
    );
    await pool.query(
      `INSERT INTO asset_references (owner_user_id, asset_id, campaign_id, turn_id, asset_role)
       VALUES ($1,$2,$3,$4,'turn_illustration')`,
      [ownerUserId, asset.rows[0]!.id, source.id, turn.rows[0]!.id]
    );

    const previewRequest = campaignTransferPreviewRequestSchema.parse({ targetWorldVersionId: targetWorld.worldVersionId });
    const preview = await previewCampaignWorldTransfer(pool, source.id, previewRequest);
    expect(preview.allowed).toBe(true);
    expect(preview.counts).toMatchObject({ turns: 1, stateEdits: 1, assets: 1 });
    const commitRequest = campaignTransferCommitRequestSchema.parse({
      ...previewRequest,
      idempotencyKey: crypto.randomUUID(),
      expectedActiveTurnNumber: preview.expectedActiveTurnNumber,
      expectedStateRevision: preview.expectedStateRevision,
      sourceFingerprint: preview.sourceFingerprint
    });
    const transferred = await transferCampaignWorld(pool, source.id, commitRequest);
    const retried = await transferCampaignWorld(pool, source.id, commitRequest);
    expect(retried).toMatchObject({ targetCampaignId: transferred.targetCampaignId, reused: true });

    const copied = await pool.query<{
      world_version_id: string;
      active_turn_number: number;
      selected_character_id: string;
      character_snapshot: Record<string, unknown>;
      character_profile: Record<string, unknown>;
      character_profile_revision: number;
      revision: number;
      turn_count: number;
      edit_count: number;
      reference_count: number;
      job_count: number;
      chain_count: number;
      cost_count: number;
    }>(
      `SELECT c.world_version_id, c.active_turn_number, c.selected_character_id, c.character_snapshot,
              c.character_profile, c.character_profile_revision, cs.revision,
              (SELECT count(*)::int FROM turns WHERE campaign_id = c.id) AS turn_count,
              (SELECT count(*)::int FROM campaign_state_edits WHERE campaign_id = c.id) AS edit_count,
              (SELECT count(*)::int FROM asset_references ar JOIN turns t ON t.id = ar.turn_id
                WHERE ar.campaign_id = c.id AND t.campaign_id = c.id) AS reference_count,
              (SELECT count(*)::int FROM generation_jobs WHERE campaign_id = c.id) AS job_count,
              (SELECT count(*)::int FROM model_chains WHERE campaign_id = c.id) AS chain_count,
              (SELECT count(*)::int FROM provider_cost_events WHERE campaign_id = c.id) AS cost_count
         FROM campaigns c JOIN campaign_state cs ON cs.campaign_id = c.id
        WHERE c.id = $1`,
      [transferred.targetCampaignId]
    );
    expect(copied.rows[0]).toMatchObject({
      world_version_id: targetWorld.worldVersionId,
      active_turn_number: 1,
      selected_character_id: "source-hero",
      character_profile: currentProfile,
      character_profile_revision: 1,
      revision: 1,
      turn_count: 1,
      edit_count: 1,
      reference_count: 1,
      job_count: 0,
      chain_count: 0,
      cost_count: 0
    });
    expect(copied.rows[0]?.character_snapshot).toMatchObject({ id: "source-hero" });
    expect(await pool.query(
      `SELECT revision, edit_source, next_profile
         FROM campaign_character_profile_edits WHERE campaign_id = $1`,
      [transferred.targetCampaignId]
    )).toMatchObject({
      rows: [{ revision: 1, edit_source: "transfer", next_profile: currentProfile }]
    });
    const sourceStillExists = await pool.query<{ active_turn_number: number }>("SELECT active_turn_number FROM campaigns WHERE id = $1", [source.id]);
    expect(sourceStillExists.rows[0]?.active_turn_number).toBe(1);
    expect(transferred.chronicleMemoryCount).toBeGreaterThan(0);
  });

  it("rejects same-world targets and stale commit preconditions", async () => {
    const sourceWorld = await publishedWorld("Transfer Guard", "guard-hero");
    const otherWorld = await publishedWorld("Transfer Guard Target", "other-hero");
    const source = await createCampaign(pool, campaignCreateSchema.parse({
      worldVersionId: sourceWorld.worldVersionId,
      title: `Guard Campaign ${crypto.randomUUID()}`,
      selectedCharacterId: "guard-hero"
    }));
    const sameWorld = await previewCampaignWorldTransfer(pool, source.id, campaignTransferPreviewRequestSchema.parse({
      targetWorldVersionId: sourceWorld.worldVersionId
    }));
    expect(sameWorld.allowed).toBe(false);
    expect(sameWorld.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "same_world_use_version_migration" })]));

    const previewRequest = campaignTransferPreviewRequestSchema.parse({ targetWorldVersionId: otherWorld.worldVersionId });
    const preview = await previewCampaignWorldTransfer(pool, source.id, previewRequest);
    const ownerUserId = await initialOwnerId(pool);
    await pool.query("UPDATE campaign_state SET revision = revision + 1, updated_at = now() WHERE campaign_id = $1 AND owner_user_id = $2", [source.id, ownerUserId]);
    await expect(transferCampaignWorld(pool, source.id, campaignTransferCommitRequestSchema.parse({
      ...previewRequest,
      idempotencyKey: crypto.randomUUID(),
      expectedActiveTurnNumber: preview.expectedActiveTurnNumber,
      expectedStateRevision: preview.expectedStateRevision,
      sourceFingerprint: preview.sourceFingerprint
    }))).rejects.toMatchObject({ statusCode: 409 });
  });
});
