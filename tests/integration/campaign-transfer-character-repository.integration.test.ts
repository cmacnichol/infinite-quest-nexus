import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  CampaignTransferRepositoryPort,
  WorldCampaignRepositoryResult
} from "../../packages/application/src/world-campaign/index.js";
import {
  campaignTransferCommitRequestSchema,
  campaignTransferPreviewRequestSchema
} from "../../packages/contracts/src/campaign-transfer.js";
import {
  campaignCharacterProfileUpdateSchema,
  campaignCreateSchema,
  characterProfileSchema,
  worldContentSchema,
  worldCreateSchema,
  worldPublishSchema
} from "../../packages/contracts/src/world-library.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import {
  createDatabasePool,
  initialOwnerId,
  type DatabasePool
} from "../../packages/database/src/pool.js";
import * as repositoryModule from "../../packages/database/src/campaign-transfer-character-repository.js";
import { createPostgresWorldRepositoryAdapters } from "../../packages/database/src/world-repository.js";
import { createPostgresWorldCampaignTransactionPort } from "../../packages/database/src/world-campaign-transaction.js";
import { memoryGeneration } from "../helpers/memory-applications.js";
import { DEDICATED_CHUNKED_AUDIT } from "../fixtures/chronicle-retrieval-audits.js";

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
    playableCharacters: [{
      id: characterId,
      name: `Character ${characterId}`,
      characterText: "Synthetic guidance.",
      profile: characterProfileSchema.parse({
        story: { role: "PostgreSQL adapter witness" }
      })
    }]
  });
}

integration("campaign transfer and character PostgreSQL adapters", () => {
  let pool: DatabasePool;
  let ownerUserId: string;
  const campaignIds: string[] = [];
  const worldVersionIds: string[] = [];
  const worldIds: string[] = [];
  const foreignUserIds: string[] = [];
  const providerIds: string[] = [];
  const assetIds: string[] = [];

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });

  afterEach(async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (campaignIds.length || worldIds.length || foreignUserIds.length) {
        await client.query(
          `DELETE FROM activity_events
            WHERE campaign_id = ANY($1::uuid[])
               OR correlation_id = ANY($2::text[])
               OR owner_user_id = ANY($3::uuid[])`,
          [campaignIds, worldIds, foreignUserIds],
        );
      }
      if (campaignIds.length) {
        await client.query(
          "DELETE FROM campaign_world_transfers WHERE source_campaign_id = ANY($1::uuid[]) OR target_campaign_id = ANY($1::uuid[])",
          [campaignIds],
        );
        await client.query("DELETE FROM campaigns WHERE id = ANY($1::uuid[])", [campaignIds]);
      }
      if (assetIds.length) await client.query("DELETE FROM assets WHERE id = ANY($1::uuid[])", [assetIds]);
      if (providerIds.length) await client.query("DELETE FROM provider_profiles WHERE id = ANY($1::uuid[])", [providerIds]);
      if (worldVersionIds.length) await client.query("DELETE FROM world_versions WHERE id = ANY($1::uuid[])", [worldVersionIds]);
      if (worldIds.length) {
        await client.query("DELETE FROM world_drafts WHERE world_id = ANY($1::uuid[])", [worldIds]);
        await client.query("DELETE FROM worlds WHERE id = ANY($1::uuid[])", [worldIds]);
      }
      if (foreignUserIds.length) await client.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [foreignUserIds]);
      await client.query("COMMIT");
      campaignIds.length = 0;
      worldVersionIds.length = 0;
      worldIds.length = 0;
      foreignUserIds.length = 0;
      providerIds.length = 0;
      assetIds.length = 0;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  function unwrap<T>(result: WorldCampaignRepositoryResult<T>): T {
    if (!result.ok) throw new Error(`fixture transition failed: ${result.failure.reason}`);
    return result.value;
  }

  function worldAdapters() {
    return createPostgresWorldRepositoryAdapters(pool, { memory: memoryGeneration(pool) });
  }

  async function publishedWorld(label: string, characterId: string, fixtureOwnerUserId = ownerUserId) {
    const adapters = worldAdapters();
    const title = `${label} ${crypto.randomUUID()}`;
    const created = unwrap(await adapters.transaction.command((transaction) => adapters.worlds.createWorld(
      transaction,
      { ownerUserId: fixtureOwnerUserId },
      { title, content: content(title, characterId) },
    )));
    const published = unwrap(await adapters.transaction.command((transaction) => adapters.worlds.publishWorld(
      transaction,
      { ownerUserId: fixtureOwnerUserId, worldId: created.id },
      worldPublishSchema.parse({ expectedRevision: created.draftRevision }),
    )));
    worldIds.push(created.id);
    worldVersionIds.push(published.worldVersionId);
    return { ...created, ...published, title };
  }

  async function campaignFixture(label: string, fixtureOwnerUserId = ownerUserId) {
    const world = await publishedWorld(`${label} world`, `${label.toLocaleLowerCase()}-hero`, fixtureOwnerUserId);
    const adapters = worldAdapters();
    const campaign = unwrap(await adapters.transaction.command((transaction) => adapters.campaigns.createCampaign(
      transaction,
      { ownerUserId: fixtureOwnerUserId },
      campaignCreateSchema.parse({
        worldVersionId: world.worldVersionId,
        title: `${label} campaign ${crypto.randomUUID()}`,
        selectedCharacterId: `${label.toLocaleLowerCase()}-hero`
      }),
    )));
    campaignIds.push(campaign.id);
    return { world, campaign };
  }

  function transferRepository(memory = memoryGeneration(pool)): CampaignTransferRepositoryPort {
    const createRepository = Reflect.get(repositoryModule, "createPostgresCampaignTransferRepository");
    expect(createRepository).toBeTypeOf("function");
    return createRepository({ memory });
  }

  it("reads an owner-scoped campaign character profile from authoritative PostgreSQL state", async () => {
    const { campaign } = await campaignFixture("Profile");
    const repository = repositoryModule.createPostgresCharacterProfileRepository();
    const transactions = createPostgresWorldCampaignTransactionPort(pool);
    const profile = await transactions.read((transaction) => repository.getCampaignCharacterProfile(
      transaction,
      { ownerUserId, campaignId: campaign.id },
    ));
    expect(profile).toMatchObject({
      campaignId: campaign.id,
      characterId: "profile-hero",
      revision: 1,
      name: "Character profile-hero",
      inheritedFromSnapshot: false,
      legacyCharacterText: "Synthetic guidance."
    });
  });

  it("updates a character profile atomically with revision, audit, and model-chain fences", async () => {
    const { campaign, world } = await campaignFixture("Profile update");
    const provider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles (
         owner_user_id, name, provider_type, provider_role, base_url, default_model
       ) VALUES ($1, $2, 'lmstudio', 'text', 'http://provider.invalid', 'synthetic-model')
       RETURNING id`,
      [ownerUserId, `Character adapter provider ${crypto.randomUUID()}`],
    );
    const providerId = provider.rows[0]!.id;
    providerIds.push(providerId);
    await pool.query(
      `INSERT INTO model_chains (
         owner_user_id, campaign_id, world_version_id, provider_profile_id, model,
         endpoint_identity, prompt_protocol_version, context_fingerprint, previous_response_id
       ) VALUES ($1, $2, $3, $4, 'synthetic-model', 'synthetic-endpoint',
                 'old-protocol', 'old-context', 'old-response')`,
      [ownerUserId, campaign.id, world.worldVersionId, providerId],
    );
    const transactions = createPostgresWorldCampaignTransactionPort(pool);
    const repository = repositoryModule.createPostgresCharacterProfileRepository();
    const profile = characterProfileSchema.parse({ story: { role: "Updated authority witness" } });
    const request = campaignCharacterProfileUpdateSchema.parse({
      expectedRevision: 1,
      name: "Updated Hero",
      profile,
      editSource: "manual"
    });

    const saved = unwrap(await transactions.command((transaction) => repository.updateCampaignCharacterProfile(
      transaction,
      { ownerUserId, campaignId: campaign.id },
      request,
    )));
    expect(saved).toMatchObject({ campaignId: campaign.id, revision: 2, name: "Updated Hero", profile });

    const persisted = await pool.query<{
      characterProfile: unknown;
      characterProfileRevision: number;
      activeChain: boolean;
      edits: unknown;
      activities: number;
      activityDetails: unknown;
    }>(
      `SELECT c.character_profile AS "characterProfile",
              c.character_profile_revision AS "characterProfileRevision",
              coalesce((SELECT bool_or(active) FROM model_chains WHERE campaign_id = c.id), false) AS "activeChain",
              (SELECT jsonb_agg(jsonb_build_array(revision, edit_source) ORDER BY revision)
                 FROM campaign_character_profile_edits WHERE campaign_id = c.id) AS edits,
              (SELECT count(*)::int FROM activity_events
                WHERE campaign_id = c.id AND event_type = 'campaign_character_profile_updated') AS activities,
              (SELECT details FROM activity_events
                WHERE campaign_id = c.id AND event_type = 'campaign_character_profile_updated'
                ORDER BY created_at DESC LIMIT 1) AS "activityDetails"
         FROM campaigns c WHERE c.id = $1`,
      [campaign.id],
    );
    expect(persisted.rows[0]).toMatchObject({
      characterProfile: { name: "Updated Hero", profile },
      characterProfileRevision: 2,
      activeChain: false,
      edits: [[1, "world_version_seed"], [2, "manual"]],
      activities: 1,
      activityDetails: {
        characterProfileRevision: 2,
        editSource: "manual",
        organizerProtocolVersion: null
      }
    });

    const stale = await transactions.command((transaction) => repository.updateCampaignCharacterProfile(
      transaction,
      { ownerUserId, campaignId: campaign.id },
      request,
    ));
    expect(stale).toMatchObject({
      ok: false,
      failure: {
        reason: "state_revision_changed",
        details: { expectedStateRevision: 1, actualStateRevision: 2 }
      }
    });

    const activeJob = await pool.query<{ id: string }>(
      `INSERT INTO generation_jobs (
         owner_user_id, campaign_id, provider_profile_id, idempotency_key,
         expected_turn_number, action, status
       ) VALUES ($1, $2, $3, $4, 1, 'Synthetic action', 'queued') RETURNING id`,
      [ownerUserId, campaign.id, providerId, crypto.randomUUID()],
    );
    const blocked = await transactions.command((transaction) => repository.updateCampaignCharacterProfile(
      transaction,
      { ownerUserId, campaignId: campaign.id },
      campaignCharacterProfileUpdateSchema.parse({
        expectedRevision: 2,
        name: "Blocked Hero",
        profile,
        editSource: "manual"
      }),
    ));
    expect(blocked).toMatchObject({ ok: false, failure: { reason: "invalid_transition" } });
    await pool.query("UPDATE generation_jobs SET status = 'failed' WHERE id = $1", [activeJob.rows[0]!.id]);
    expect((await pool.query<{ revision: number }>(
      "SELECT character_profile_revision AS revision FROM campaigns WHERE id = $1",
      [campaign.id],
    )).rows[0]?.revision).toBe(2);
  });

  it("keeps character reads and writes owner-invisible and rejects malformed persisted profiles safely", async () => {
    const { campaign } = await campaignFixture("Profile isolation");
    const foreign = await pool.query<{ id: string }>(
      "INSERT INTO users (display_name, status) VALUES ($1, 'active') RETURNING id",
      [`Foreign character owner ${crypto.randomUUID()}`],
    );
    const foreignOwnerUserId = foreign.rows[0]!.id;
    foreignUserIds.push(foreignOwnerUserId);
    const transactions = createPostgresWorldCampaignTransactionPort(pool);
    const repository = repositoryModule.createPostgresCharacterProfileRepository();

    await expect(transactions.read((transaction) => repository.getCampaignCharacterProfile(
      transaction,
      { ownerUserId: foreignOwnerUserId, campaignId: campaign.id },
    ))).rejects.toMatchObject({ kind: "not_found", reason: "campaign_not_found" });
    const foreignUpdate = await transactions.command((transaction) => repository.updateCampaignCharacterProfile(
      transaction,
      { ownerUserId: foreignOwnerUserId, campaignId: campaign.id },
      campaignCharacterProfileUpdateSchema.parse({
        expectedRevision: 1,
        name: "Foreign write",
        profile: characterProfileSchema.parse({}),
        editSource: "manual"
      }),
    ));
    expect(foreignUpdate).toMatchObject({ ok: false, failure: { reason: "campaign_not_found" } });

    await pool.query("UPDATE campaigns SET character_profile = '{\"name\":\"Incomplete\"}'::jsonb WHERE id = $1", [campaign.id]);
    await expect(transactions.read((transaction) => repository.getCampaignCharacterProfile(
      transaction,
      { ownerUserId, campaignId: campaign.id },
    ))).rejects.toMatchObject({ kind: "unavailable", reason: "invalid_transition" });
  });

  it("persists AI organizer protocol provenance and refuses an unversioned organized edit", async () => {
    const { campaign } = await campaignFixture("Profile organizer audit");
    const transactions = createPostgresWorldCampaignTransactionPort(pool);
    const repository = repositoryModule.createPostgresCharacterProfileRepository();
    const profile = characterProfileSchema.parse({ story: { role: "Organized authority witness" } });

    const saved = unwrap(await transactions.command((transaction) => repository.updateCampaignCharacterProfile(
      transaction,
      { ownerUserId, campaignId: campaign.id },
      campaignCharacterProfileUpdateSchema.parse({
        expectedRevision: 1,
        name: "Organized Hero",
        profile,
        editSource: "ai_organized",
        organizerProtocolVersion: "character-profile-organizer-v2"
      }),
    )));
    expect(saved).toMatchObject({ revision: 2, name: "Organized Hero" });
    expect((await pool.query<{ details: unknown }>(
      `SELECT details FROM activity_events
        WHERE campaign_id = $1 AND event_type = 'campaign_character_profile_updated'
        ORDER BY created_at DESC LIMIT 1`,
      [campaign.id],
    )).rows[0]?.details).toMatchObject({
      characterProfileRevision: 2,
      editSource: "ai_organized",
      organizerProtocolVersion: "character-profile-organizer-v2"
    });

    await expect(transactions.command((transaction) => repository.updateCampaignCharacterProfile(
      transaction,
      { ownerUserId, campaignId: campaign.id },
      campaignCharacterProfileUpdateSchema.parse({
        expectedRevision: 2,
        name: "Unversioned organized hero",
        profile,
        editSource: "ai_organized"
      }),
    ))).rejects.toMatchObject({ kind: "invalid_request", reason: "invalid_transition" });
  });

  it("previews transfer compatibility and counts without mutating either aggregate", async () => {
    const source = await campaignFixture("Transfer preview");
    const target = await publishedWorld("Transfer target", "target-hero");
    const turn = await pool.query<{ id: string }>(
      `INSERT INTO turns (
         owner_user_id, campaign_id, turn_number, action, narration, choices,
         state_snapshot_private, model_metadata
       ) VALUES ($1, $2, 1, 'Enter.', 'Entered.', '[]', '{}', '{}') RETURNING id`,
      [ownerUserId, source.campaign.id],
    );
    await pool.query("UPDATE campaigns SET active_turn_number = 1 WHERE id = $1", [source.campaign.id]);
    await pool.query(
      `INSERT INTO campaign_state_edits (
         owner_user_id, campaign_id, effective_turn_number, revision,
         state_snapshot_private, changed_fields
       ) VALUES ($1, $2, 1, 1, '{}', '["scratchpad"]')`,
      [ownerUserId, source.campaign.id],
    );
    await pool.query(
      `INSERT INTO summary_checkpoints (
         owner_user_id, campaign_id, through_turn, summary_kind, content, token_estimate
       ) VALUES ($1, $2, 1, 'chronicle', $3, 1)`,
      [ownerUserId, source.campaign.id, JSON.stringify({ summary: "Summary." })],
    );
    const asset = await pool.query<{ id: string }>(
      `INSERT INTO assets (
         owner_user_id, campaign_id, turn_id, content_hash, storage_driver,
         storage_path, mime_type, byte_length
       ) VALUES ($1, $2, $3, $4, 'filesystem', $5, 'image/png', 4) RETURNING id`,
      [ownerUserId, source.campaign.id, turn.rows[0]!.id, `transfer-${crypto.randomUUID()}`, `transfer/${crypto.randomUUID()}.png`],
    );
    assetIds.push(asset.rows[0]!.id);
    await pool.query(
      `INSERT INTO asset_references (owner_user_id, asset_id, campaign_id, turn_id, asset_role)
       VALUES ($1, $2, $3, $4, 'turn_illustration')`,
      [ownerUserId, asset.rows[0]!.id, source.campaign.id, turn.rows[0]!.id],
    );
    const transactions = createPostgresWorldCampaignTransactionPort(pool);
    const repository = transferRepository();
    const request = campaignTransferPreviewRequestSchema.parse({ targetWorldVersionId: target.worldVersionId });
    const before = await pool.query("SELECT count(*)::int AS count FROM campaigns WHERE owner_user_id = $1", [ownerUserId]);

    const preview = await transactions.read((transaction) => repository.previewCampaignWorldTransfer(
      transaction,
      { ownerUserId, campaignId: source.campaign.id },
      request,
    ));
    expect(preview).toMatchObject({
      allowed: true,
      source: { campaignId: source.campaign.id, worldVersionId: source.world.worldVersionId },
      target: { worldVersionId: target.worldVersionId },
      counts: { turns: 1, stateEdits: 1, summaries: 1, assets: 1 },
      expectedActiveTurnNumber: 1,
      expectedStateRevision: 0
    });
    expect(preview.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const sameWorld = await transactions.read((transaction) => repository.previewCampaignWorldTransfer(
      transaction,
      { ownerUserId, campaignId: source.campaign.id },
      campaignTransferPreviewRequestSchema.parse({ targetWorldVersionId: source.world.worldVersionId }),
    ));
    expect(sameWorld).toMatchObject({ allowed: false });
    expect(sameWorld.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "same_world_use_version_migration", severity: "blocking" })
    ]));
    expect((await pool.query("SELECT count(*)::int AS count FROM campaigns WHERE owner_user_id = $1", [ownerUserId])).rows)
      .toEqual(before.rows);
  });

  it("keeps transfer source and target owner-invisible and rejects malformed persisted targets safely", async () => {
    const source = await campaignFixture("Transfer isolation");
    const target = await publishedWorld("Transfer owned target", "owned-target");
    const foreign = await pool.query<{ id: string }>(
      "INSERT INTO users (display_name, status) VALUES ($1, 'active') RETURNING id",
      [`Foreign transfer owner ${crypto.randomUUID()}`],
    );
    const foreignOwnerUserId = foreign.rows[0]!.id;
    foreignUserIds.push(foreignOwnerUserId);
    const foreignTarget = await publishedWorld("Foreign transfer target", "foreign-target", foreignOwnerUserId);
    const transactions = createPostgresWorldCampaignTransactionPort(pool);
    const repository = transferRepository();

    await expect(transactions.read((transaction) => repository.previewCampaignWorldTransfer(
      transaction,
      { ownerUserId: foreignOwnerUserId, campaignId: source.campaign.id },
      campaignTransferPreviewRequestSchema.parse({ targetWorldVersionId: target.worldVersionId }),
    ))).rejects.toMatchObject({ kind: "not_found", reason: "campaign_not_found" });
    await expect(transactions.read((transaction) => repository.previewCampaignWorldTransfer(
      transaction,
      { ownerUserId, campaignId: source.campaign.id },
      campaignTransferPreviewRequestSchema.parse({ targetWorldVersionId: foreignTarget.worldVersionId }),
    ))).rejects.toMatchObject({ kind: "not_found", reason: "world_version_not_found" });

    await pool.query("UPDATE world_versions SET content = '[]'::jsonb WHERE id = $1", [target.worldVersionId]);
    await expect(transactions.read((transaction) => repository.previewCampaignWorldTransfer(
      transaction,
      { ownerUserId, campaignId: source.campaign.id },
      campaignTransferPreviewRequestSchema.parse({ targetWorldVersionId: target.worldVersionId }),
    ))).rejects.toMatchObject({ kind: "unavailable", reason: "invalid_transition" });
  });

  it.each(["provider_pending", "downloading"] as const)(
    "blocks transfer preview and commit while an image job is %s",
    async (status) => {
      const source = await campaignFixture(`Transfer image ${status}`);
      const target = await publishedWorld(`Transfer image ${status} target`, `${status}-target`);
      const provider = await pool.query<{ id: string }>(
        `INSERT INTO provider_profiles (
           owner_user_id, name, provider_type, provider_role, base_url, default_model
         ) VALUES ($1, $2, 'openai_compatible', 'image', 'http://provider.invalid', 'synthetic-image-model')
         RETURNING id`,
        [ownerUserId, `Transfer image provider ${status} ${crypto.randomUUID()}`],
      );
      const providerId = provider.rows[0]!.id;
      providerIds.push(providerId);
      const turn = await pool.query<{ id: string }>(
        `INSERT INTO turns (
           owner_user_id, campaign_id, turn_number, action, narration, choices,
           state_snapshot_private, model_metadata
         ) VALUES ($1, $2, 1, 'Wait.', 'Waiting.', '[]', '{}', '{}') RETURNING id`,
        [ownerUserId, source.campaign.id],
      );
      await pool.query(
        `INSERT INTO image_jobs (
           owner_user_id, campaign_id, turn_id, provider_profile_id, requested_model,
           prompt, prompt_hash, status, provider_type, target_type
         ) VALUES ($1,$2,$3,$4,'synthetic-image-model','A safe fictional scene.',$5,$6,
                   'openai_compatible','turn_illustration')`,
        [ownerUserId, source.campaign.id, turn.rows[0]!.id, providerId, crypto.randomUUID(), status],
      );
      const transactions = createPostgresWorldCampaignTransactionPort(pool);
      const repository = transferRepository();
      const previewRequest = campaignTransferPreviewRequestSchema.parse({ targetWorldVersionId: target.worldVersionId });
      const preview = await transactions.read((transaction) => repository.previewCampaignWorldTransfer(
        transaction,
        { ownerUserId, campaignId: source.campaign.id },
        previewRequest,
      ));
      expect(preview).toMatchObject({ allowed: false });
      expect(preview.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "active_image_job", severity: "blocking" })
      ]));
      const before = await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM campaigns WHERE owner_user_id = $1",
        [ownerUserId],
      );
      const committed = await transactions.command((transaction) => repository.transferCampaignWorld(
        transaction,
        { ownerUserId, campaignId: source.campaign.id },
        campaignTransferCommitRequestSchema.parse({
          ...previewRequest,
          idempotencyKey: crypto.randomUUID(),
          expectedActiveTurnNumber: preview.expectedActiveTurnNumber,
          expectedStateRevision: preview.expectedStateRevision,
          sourceFingerprint: preview.sourceFingerprint
        }),
      ));
      expect(committed).toMatchObject({ ok: false, failure: { reason: "invalid_transition" } });
      expect((await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM campaigns WHERE owner_user_id = $1",
        [ownerUserId],
      )).rows[0]?.count).toBe(before.rows[0]?.count);
    },
  );

  it("commits a transfer once with migration, state, asset, and replacement provenance", async () => {
    const source = await campaignFixture("Transfer commit");
    const target = await publishedWorld("Transfer commit target", "commit-target");
    const provider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles (
         owner_user_id, name, provider_type, provider_role, base_url, default_model
       ) VALUES ($1, $2, 'lmstudio', 'text', 'http://provider.invalid', 'synthetic-model')
       RETURNING id`,
      [ownerUserId, `Transfer provider ${crypto.randomUUID()}`],
    );
    const providerId = provider.rows[0]!.id;
    providerIds.push(providerId);
    const firstTurn = await pool.query<{ id: string }>(
      `INSERT INTO turns (
         owner_user_id, campaign_id, turn_number, source_turn_id, action, narration,
         choices, state_snapshot_private, model_metadata, import_metadata
       ) VALUES ($1, $2, 1, 'portable-source-one', 'Enter.', 'Entered.', '[]',
                 '{}', $3::jsonb, '{"legacy":{"batch":"one"}}')
       RETURNING id`,
      [ownerUserId, source.campaign.id, JSON.stringify({ protocol: "synthetic", chronicleRetrieval: DEDICATED_CHUNKED_AUDIT })],
    );
    const secondTurn = await pool.query<{ id: string }>(
      `INSERT INTO turns (
         owner_user_id, campaign_id, turn_number, source_turn_id, action, narration,
         choices, state_snapshot_private, model_metadata, import_metadata
       ) VALUES ($1, $2, 2, 'portable-source-two', 'Continue.', 'Continued.', '[]',
                 '{}', '{"protocol":"synthetic"}', '{"legacy":{"batch":"two"}}')
       RETURNING id`,
      [ownerUserId, source.campaign.id],
    );
    await pool.query(
      `INSERT INTO generation_jobs (
         owner_user_id, campaign_id, provider_profile_id, idempotency_key,
         expected_turn_number, action, status, operation_kind, replacement_turn_id,
         result_turn_id, completed_at
       ) VALUES ($1, $2, $3, $4, 1, 'Continue.', 'completed', 'replace_latest',
                 $5, $6, now())`,
      [
        ownerUserId,
        source.campaign.id,
        providerId,
        crypto.randomUUID(),
        firstTurn.rows[0]!.id,
        secondTurn.rows[0]!.id
      ],
    );
    await pool.query("UPDATE campaigns SET active_turn_number = 2 WHERE id = $1", [source.campaign.id]);
    await pool.query(
      `UPDATE campaign_state
          SET revision = 2,
              trackers = '[{"id":"transfer-oath","name":"Transfer oath","value":"open","rules":"Close explicitly."}]',
              import_provenance = '{"legacy":{"archive":"fixture"}}',
              updated_at = now()
        WHERE campaign_id = $1 AND owner_user_id = $2`,
      [source.campaign.id, ownerUserId],
    );
    await pool.query(
      `INSERT INTO campaign_state_edits (
         owner_user_id, campaign_id, effective_turn_number, revision,
         state_snapshot_private, changed_fields
       ) VALUES ($1, $2, 2, 2, '{"scratchpad":"transfer"}', '["scratchpad"]')`,
      [ownerUserId, source.campaign.id],
    );
    await pool.query(
      `INSERT INTO summary_checkpoints (
         owner_user_id, campaign_id, through_turn, summary_kind, content, token_estimate
       ) VALUES ($1, $2, 2, 'chronicle', $3, 2)`,
      [ownerUserId, source.campaign.id, JSON.stringify({ summary: "Transferred summary." })],
    );
    await pool.query(
      `INSERT INTO campaign_memory_configs (
         campaign_id, owner_user_id, embedding_enabled, retrieval_implementation, retrieval_shadow_enabled
       ) VALUES ($1, $2, false, 'chunked_hybrid', true)`,
      [source.campaign.id, ownerUserId],
    );
    const asset = await pool.query<{ id: string }>(
      `INSERT INTO assets (
         owner_user_id, campaign_id, turn_id, content_hash, storage_driver,
         storage_path, mime_type, byte_length
       ) VALUES ($1, $2, $3, $4, 'filesystem', $5, 'image/png', 4) RETURNING id`,
      [ownerUserId, source.campaign.id, secondTurn.rows[0]!.id, `commit-${crypto.randomUUID()}`, `commit/${crypto.randomUUID()}.png`],
    );
    assetIds.push(asset.rows[0]!.id);
    await pool.query(
      `INSERT INTO asset_references (owner_user_id, asset_id, campaign_id, turn_id, asset_role)
       VALUES ($1, $2, $3, $4, 'turn_illustration')`,
      [ownerUserId, asset.rows[0]!.id, source.campaign.id, secondTurn.rows[0]!.id],
    );
    const transactions = createPostgresWorldCampaignTransactionPort(pool);
    const baseMemory = memoryGeneration(pool);
    const enqueueChunkIndex = vi.fn(baseMemory.enqueueChunkIndex.bind(baseMemory));
    const repository = transferRepository({ ...baseMemory, enqueueChunkIndex });
    const previewRequest = campaignTransferPreviewRequestSchema.parse({
      targetWorldVersionId: target.worldVersionId
    });
    const preview = await transactions.read((transaction) => repository.previewCampaignWorldTransfer(
      transaction,
      { ownerUserId, campaignId: source.campaign.id },
      previewRequest,
    ));
    const idempotencyKey = crypto.randomUUID();
    const request = campaignTransferCommitRequestSchema.parse({
      ...previewRequest,
      idempotencyKey,
      expectedActiveTurnNumber: preview.expectedActiveTurnNumber,
      expectedStateRevision: preview.expectedStateRevision,
      sourceFingerprint: preview.sourceFingerprint,
      note: "Synthetic transfer audit"
    });
    const committed = unwrap(await transactions.command((transaction) => repository.transferCampaignWorld(
      transaction,
      { ownerUserId, campaignId: source.campaign.id },
      request,
    )));
    campaignIds.push(committed.targetCampaignId);
    const retried = unwrap(await transactions.command((transaction) => repository.transferCampaignWorld(
      transaction,
      { ownerUserId, campaignId: source.campaign.id },
      request,
    )));
    expect(retried).toMatchObject({
      transferId: committed.transferId,
      targetCampaignId: committed.targetCampaignId,
      reused: true
    });
    expect(enqueueChunkIndex).toHaveBeenCalledOnce();
    expect(enqueueChunkIndex).toHaveBeenCalledWith(expect.anything(), {
      ownerUserId,
      campaignId: committed.targetCampaignId,
      worldVersionId: target.worldVersionId
    });
    await expect(pool.query<{
      retrieval_implementation: string;
      retrieval_shadow_enabled: boolean;
    }>(
      `SELECT retrieval_implementation,retrieval_shadow_enabled
         FROM campaign_memory_configs WHERE campaign_id=$1 AND owner_user_id=$2`,
      [committed.targetCampaignId, ownerUserId]
    )).resolves.toMatchObject({
      rows: [{ retrieval_implementation: "chunked_hybrid", retrieval_shadow_enabled: true }]
    });

    const copied = await pool.query<{
      worldVersionId: string;
      activeTurnNumber: number;
      stateRevision: number;
      importProvenance: unknown;
      turns: unknown;
      stateEdits: number;
      summaries: number;
      assetReferences: number;
      generationJobs: number;
      transferRows: number;
    }>(
      `SELECT c.world_version_id AS "worldVersionId",
              c.active_turn_number AS "activeTurnNumber",
              cs.revision AS "stateRevision",
              cs.import_provenance AS "importProvenance",
              (SELECT jsonb_agg(jsonb_build_object(
                 'sourceTurnId', t.source_turn_id,
                 'importMetadata', t.import_metadata,
                 'chronicleRetrieval', t.model_metadata -> 'chronicleRetrieval'
               ) ORDER BY t.turn_number)
                 FROM turns t WHERE t.campaign_id = c.id) AS turns,
              (SELECT count(*)::int FROM campaign_state_edits WHERE campaign_id = c.id) AS "stateEdits",
              (SELECT count(*)::int FROM summary_checkpoints WHERE campaign_id = c.id) AS summaries,
              (SELECT count(*)::int FROM asset_references WHERE campaign_id = c.id) AS "assetReferences",
              (SELECT count(*)::int FROM generation_jobs WHERE campaign_id = c.id) AS "generationJobs",
              (SELECT count(*)::int FROM campaign_world_transfers WHERE target_campaign_id = c.id) AS "transferRows"
         FROM campaigns c
         JOIN campaign_state cs ON cs.campaign_id = c.id AND cs.owner_user_id = c.owner_user_id
        WHERE c.id = $1 AND c.owner_user_id = $2`,
      [committed.targetCampaignId, ownerUserId],
    );
    expect(copied.rows[0]).toMatchObject({
      worldVersionId: target.worldVersionId,
      activeTurnNumber: 2,
      stateRevision: 2,
      importProvenance: {
        legacy: { archive: "fixture" },
        transfer: {
          type: "nexus_world_transfer",
          transferId: committed.transferId,
          sourceCampaignId: source.campaign.id,
          sourceWorldVersionId: source.world.worldVersionId
        }
      },
      stateEdits: 1,
      summaries: 1,
      assetReferences: 1,
      generationJobs: 0,
      transferRows: 1
    });
    expect(copied.rows[0]?.turns).toEqual([
      {
        sourceTurnId: "portable-source-one",
        chronicleRetrieval: DEDICATED_CHUNKED_AUDIT,
        importMetadata: {
          legacy: { batch: "one" },
          transfer: expect.objectContaining({
            sourceCampaignId: source.campaign.id,
            sourceTurnId: firstTurn.rows[0]!.id,
            operationKind: null,
            replacementTurnId: null
          })
        }
      },
      {
        sourceTurnId: "portable-source-two",
        chronicleRetrieval: null,
        importMetadata: {
          legacy: { batch: "two" },
          transfer: expect.objectContaining({
            sourceCampaignId: source.campaign.id,
            sourceTurnId: secondTurn.rows[0]!.id,
            operationKind: "replace_latest",
            replacementTurnId: firstTurn.rows[0]!.id
          })
        }
      }
    ]);
    expect(committed).toMatchObject({
      sourceCampaignId: source.campaign.id,
      targetWorldVersionId: target.worldVersionId,
      activeTurnNumber: 2,
      reused: false
    });
  });

  it("rejects stale transfer fences and conflicting idempotency without partial clones", async () => {
    const stateSource = await campaignFixture("Transfer state fence");
    const activeSource = await campaignFixture("Transfer turn fence");
    const idempotentSource = await campaignFixture("Transfer idempotency fence");
    const target = await publishedWorld("Transfer fence target", "fence-target");
    const otherTarget = await publishedWorld("Transfer alternate target", "alternate-target");
    const transactions = createPostgresWorldCampaignTransactionPort(pool);
    const repository = transferRepository();

    const previewFor = async (campaignId: string, targetWorldVersionId = target.worldVersionId) => transactions.read(
      (transaction) => repository.previewCampaignWorldTransfer(
        transaction,
        { ownerUserId, campaignId },
        campaignTransferPreviewRequestSchema.parse({ targetWorldVersionId }),
      ),
    );
    const statePreview = await previewFor(stateSource.campaign.id);
    await pool.query(
      "UPDATE campaign_state SET revision = revision + 1, updated_at = now() WHERE campaign_id = $1",
      [stateSource.campaign.id],
    );
    const staleState = await transactions.command((transaction) => repository.transferCampaignWorld(
      transaction,
      { ownerUserId, campaignId: stateSource.campaign.id },
      campaignTransferCommitRequestSchema.parse({
        targetWorldVersionId: target.worldVersionId,
        idempotencyKey: crypto.randomUUID(),
        expectedActiveTurnNumber: statePreview.expectedActiveTurnNumber,
        expectedStateRevision: statePreview.expectedStateRevision,
        sourceFingerprint: statePreview.sourceFingerprint
      }),
    ));
    expect(staleState).toMatchObject({ ok: false, failure: { reason: "state_revision_changed" } });

    const activePreview = await previewFor(activeSource.campaign.id);
    await pool.query("UPDATE campaigns SET active_turn_number = 1 WHERE id = $1", [activeSource.campaign.id]);
    const staleTurn = await transactions.command((transaction) => repository.transferCampaignWorld(
      transaction,
      { ownerUserId, campaignId: activeSource.campaign.id },
      campaignTransferCommitRequestSchema.parse({
        targetWorldVersionId: target.worldVersionId,
        idempotencyKey: crypto.randomUUID(),
        expectedActiveTurnNumber: activePreview.expectedActiveTurnNumber,
        expectedStateRevision: activePreview.expectedStateRevision,
        sourceFingerprint: activePreview.sourceFingerprint
      }),
    ));
    expect(staleTurn).toMatchObject({ ok: false, failure: { reason: "active_turn_changed" } });

    const idempotencyPreview = await previewFor(idempotentSource.campaign.id);
    const idempotencyKey = crypto.randomUUID();
    const committed = unwrap(await transactions.command((transaction) => repository.transferCampaignWorld(
      transaction,
      { ownerUserId, campaignId: idempotentSource.campaign.id },
      campaignTransferCommitRequestSchema.parse({
        targetWorldVersionId: target.worldVersionId,
        idempotencyKey,
        expectedActiveTurnNumber: idempotencyPreview.expectedActiveTurnNumber,
        expectedStateRevision: idempotencyPreview.expectedStateRevision,
        sourceFingerprint: idempotencyPreview.sourceFingerprint
      }),
    )));
    campaignIds.push(committed.targetCampaignId);
    const mismatch = await transactions.command((transaction) => repository.transferCampaignWorld(
      transaction,
      { ownerUserId, campaignId: idempotentSource.campaign.id },
      campaignTransferCommitRequestSchema.parse({
        targetWorldVersionId: otherTarget.worldVersionId,
        idempotencyKey,
        expectedActiveTurnNumber: idempotencyPreview.expectedActiveTurnNumber,
        expectedStateRevision: idempotencyPreview.expectedStateRevision,
        sourceFingerprint: idempotencyPreview.sourceFingerprint
      }),
    ));
    expect(mismatch).toMatchObject({ ok: false, failure: { reason: "idempotency_mismatch" } });
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM campaign_world_transfers WHERE idempotency_key = $1",
      [idempotencyKey],
    )).rows[0]?.count).toBe(1);
  });

  it("rolls back every transfer write when a named memory collaborator fails mid-command", async () => {
    const source = await campaignFixture("Transfer rollback");
    const target = await publishedWorld("Transfer rollback target", "rollback-target");
    const baseMemory = memoryGeneration(pool);
    async function failAfterClone(..._parameters: Parameters<typeof baseMemory.rebuildCampaignMemories>): Promise<number> {
      throw new Error("synthetic transfer memory failure");
    }
    const failingMemory = {
      ...baseMemory,
      rebuildCampaignMemories: failAfterClone
    };
    const repository = transferRepository(failingMemory);
    const transactions = createPostgresWorldCampaignTransactionPort(pool);
    const previewRequest = campaignTransferPreviewRequestSchema.parse({
      targetWorldVersionId: target.worldVersionId,
      title: `Rolled back clone ${crypto.randomUUID()}`
    });
    const preview = await transactions.read((transaction) => repository.previewCampaignWorldTransfer(
      transaction,
      { ownerUserId, campaignId: source.campaign.id },
      previewRequest,
    ));
    const request = campaignTransferCommitRequestSchema.parse({
      ...previewRequest,
      idempotencyKey: crypto.randomUUID(),
      expectedActiveTurnNumber: preview.expectedActiveTurnNumber,
      expectedStateRevision: preview.expectedStateRevision,
      sourceFingerprint: preview.sourceFingerprint
    });

    await expect(transactions.command((transaction) => repository.transferCampaignWorld(
      transaction,
      { ownerUserId, campaignId: source.campaign.id },
      request,
    ))).rejects.toThrow("synthetic transfer memory failure");
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM campaigns WHERE owner_user_id = $1 AND title = $2",
      [ownerUserId, previewRequest.title],
    )).rows[0]?.count).toBe(0);
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM campaign_world_transfers WHERE owner_user_id = $1 AND idempotency_key = $2",
      [ownerUserId, request.idempotencyKey],
    )).rows[0]?.count).toBe(0);
  });
});
