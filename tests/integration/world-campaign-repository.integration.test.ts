import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { worldContentSchema, WORLD_CONTENT_SCHEMA_VERSION } from "../../packages/contracts/src/world-library.js";
import { worldImportRequestSchema } from "../../packages/contracts/src/world-library.js";
import {
  createPostgresChronicleGenerationTransactionPort
} from "../../packages/database/src/chronicle-repository.js";
import {
  createPostgresWorldRepositoryAdapters
} from "../../packages/database/src/world-repository.js";
import {
  createDatabasePool,
  initialOwnerId,
  type DatabaseClient,
  type DatabasePool
} from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe.sequential : describe.skip;

function content(title: string, marker: string) {
  const characterId = `character-${marker.toLocaleLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
  return worldContentSchema.parse({
    schemaVersion: WORLD_CONTENT_SCHEMA_VERSION,
    world: {
      title,
      genre: "test",
      tone: "neutral",
      premise: `Premise ${marker}`,
      backgroundStory: `Background ${marker}`,
      firstAction: `Action ${marker}`,
      rules: `Rules ${marker}`
    },
    rpgStats: [{ id: "shared-stat", name: "Shared stat", value: 50, note: "" }],
    defaultTriggers: [{ id: "shared-trigger", name: "Shared trigger", rules: "Track it.", value: "Initial" }],
    playableCharacters: [{
      id: characterId,
      name: `Character ${marker}`,
      characterText: `Character guidance ${marker}`,
      rpgStats: [{ id: "character-stat", name: "Character stat", value: 60, note: "" }],
      defaultTriggers: [{ id: "character-trigger", name: "Character trigger", rules: "Track it.", value: "Ready" }]
    }]
  });
}

integration("PostgreSQL world campaign repository adapters", () => {
  let pool: DatabasePool;
  let ownerUserId = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });

  afterEach(async () => {
    await pool.query("DROP TRIGGER IF EXISTS campaign_migration_target_race_trigger ON campaign_world_migrations");
    await pool.query("DROP FUNCTION IF EXISTS block_campaign_migration_target_race()");
    await pool.query("DELETE FROM campaigns");
    await pool.query("DELETE FROM campaign_world_transfers");
    await pool.query("DELETE FROM imports");
    await pool.query("DELETE FROM provider_profiles");
    await pool.query("DELETE FROM world_versions");
    await pool.query("DELETE FROM world_drafts");
    await pool.query("DELETE FROM worlds");
    await pool.query("DELETE FROM activity_events");
    await pool.query("DELETE FROM users WHERE system_key IS NULL");
  });

  afterAll(async () => {
    await pool?.end();
  });

  function unwrap<T>(result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>): T {
    if (!result.ok) throw new Error("repository fixture transition failed");
    return result.value;
  }

  function createAdapters() {
    const memory = createPostgresChronicleGenerationTransactionPort({
      embeddings: {
        async resolve(database, scope) {
          const selected = await (database as DatabaseClient).query<{ id: string }>(
            `SELECT id FROM provider_profiles
              WHERE owner_user_id = $1 AND provider_role = 'embedding' AND enabled = true
              ORDER BY is_default DESC, name, id LIMIT 1`,
            [scope.ownerUserId]
          );
          return selected.rows[0]?.id
            ? { status: "resolved" as const, resolutionSource: "dedicated_embedding" as const, resolvedRole: "embedding" as const, providerProfileId: selected.rows[0].id, providerType: "openai_compatible", model: "embed-v1" }
            : { status: "unconfigured" as const, resolutionSource: "none" as const, resolvedRole: null };
        },
        async load() { throw new Error("provider loading is outside this repository test"); },
        async embed() { throw new Error("provider transport is outside this repository test"); },
        async fingerprint() { throw new Error("provider fingerprinting is outside this repository test"); },
        async recordHealth() {},
        async recordCost() { return null; },
        logDiagnostic() {}
      }
    });
    return createPostgresWorldRepositoryAdapters(pool, { memory });
  }

  async function createFixtureWorld(
    adapters: ReturnType<typeof createPostgresWorldRepositoryAdapters>,
    label: string,
    fixtureOwnerUserId = ownerUserId,
  ) {
    const title = `${label} ${crypto.randomUUID()}`;
    const created = unwrap(await adapters.transaction.command((transaction) => adapters.worlds.createWorld(
      transaction,
      { ownerUserId: fixtureOwnerUserId },
      { title, content: content(title, "One") }
    )));
    return { title, created };
  }

  async function publishFixtureWorld(
    adapters: ReturnType<typeof createPostgresWorldRepositoryAdapters>,
    worldId: string,
    expectedRevision: number,
    releaseNotes: string,
    fixtureOwnerUserId = ownerUserId,
  ) {
    return unwrap(await adapters.transaction.command((transaction) => adapters.worlds.publishWorld(
      transaction,
      { ownerUserId: fixtureOwnerUserId, worldId },
      { expectedRevision, releaseNotes }
    )));
  }

  async function createFixtureCampaign(
    adapters: ReturnType<typeof createPostgresWorldRepositoryAdapters>,
    worldVersionId: string,
    label: string,
    fixtureOwnerUserId = ownerUserId,
  ) {
    const title = `${label} ${crypto.randomUUID()}`;
    const created = unwrap(await adapters.transaction.command((transaction) => adapters.campaigns.createCampaign(
      transaction,
      { ownerUserId: fixtureOwnerUserId },
      {
        worldVersionId,
        title,
        storyLengthProfile: "standard",
        storyContextBudgetTokens: 32_000,
        turnControlStyle: "flexible_auto"
      }
    )));
    return { title, created };
  }

  it("creates and lists raw-Date worlds only inside the explicit owner scope", async () => {
    const foreignOwner = await pool.query<{ id: string }>(
      "INSERT INTO users (display_name, status) VALUES ($1, 'active') RETURNING id",
      [`Foreign world owner ${crypto.randomUUID()}`]
    );
    const foreignOwnerUserId = foreignOwner.rows[0]!.id;
    const adapters = createAdapters();
    const ownTitle = `Adapter world ${crypto.randomUUID()}`;
    const foreignTitle = `Foreign adapter world ${crypto.randomUUID()}`;

    const own = await adapters.transaction.command((transaction) => adapters.worlds.createWorld(
      transaction,
      { ownerUserId },
      { title: ownTitle, content: content(ownTitle, "Owned") }
    ));
    const foreign = await adapters.transaction.command((transaction) => adapters.worlds.createWorld(
      transaction,
      { ownerUserId: foreignOwnerUserId },
      { title: foreignTitle, content: content(foreignTitle, "Foreign") }
    ));

    expect(own.ok).toBe(true);
    expect(foreign.ok).toBe(true);
    if (!own.ok || !foreign.ok) throw new Error("world fixture creation failed");
    expect(own.value.createdAt).toBeInstanceOf(Date);
    expect(own.value.updatedAt).toBeInstanceOf(Date);

    const listed = await adapters.transaction.read((transaction) => adapters.worlds.listWorlds(
      transaction,
      { ownerUserId }
    ));

    expect(listed.worlds.map((world) => world.id)).toContain(own.value.id);
    expect(listed.worlds.map((world) => world.id)).not.toContain(foreign.value.id);
    expect(listed.worlds.find((world) => world.id === own.value.id)?.createdAt).toBeInstanceOf(Date);

    await expect(adapters.transaction.read((transaction) => adapters.worlds.getWorld(
      transaction,
      { ownerUserId: foreignOwnerUserId, worldId: own.value.id }
    ))).rejects.toMatchObject({ reason: "world_not_found" });
    const foreignMutation = await adapters.transaction.command((transaction) => adapters.worlds.updateWorldStatus(
      transaction,
      { ownerUserId: foreignOwnerUserId, worldId: own.value.id },
      { status: "archived" }
    ));
    expect(foreignMutation).toMatchObject({ ok: false, failure: { reason: "world_not_found" } });
    const foreignDeletion = await adapters.transaction.command((transaction) => adapters.worlds.deleteWorld(
      transaction,
      { ownerUserId: foreignOwnerUserId, worldId: own.value.id },
      { confirmation: "DELETE", expectedTitle: ownTitle }
    ));
    expect(foreignDeletion).toMatchObject({ ok: false, failure: { reason: "world_not_found" } });
  });

  it("rolls back repository writes when the caller-owned command transaction fails", async () => {
    const adapters = createAdapters();
    const title = `Rolled back adapter world ${crypto.randomUUID()}`;

    await expect(adapters.transaction.command(async (transaction) => {
      const created = await adapters.worlds.createWorld(
        transaction,
        { ownerUserId },
        { title, content: content(title, "Rollback") }
      );
      expect(created.ok).toBe(true);
      throw new Error("synthetic caller failure");
    })).rejects.toThrow("synthetic caller failure");

    const persisted = await pool.query(
      "SELECT id FROM worlds WHERE owner_user_id = $1 AND title = $2",
      [ownerUserId, title]
    );
    expect(persisted.rowCount).toBe(0);
  });

  it("locks draft revisions and keeps published content immutable across status changes and forks", async () => {
    const adapters = createAdapters();
    const fixture = await createFixtureWorld(adapters, "Locked immutable world");
    const stale = await adapters.transaction.command((transaction) => adapters.worlds.updateWorldDraft(
      transaction,
      { ownerUserId, worldId: fixture.created.id },
      {
        expectedRevision: fixture.created.draftRevision + 1,
        content: content(fixture.title, "Stale")
      }
    ));
    expect(stale).toMatchObject({
      ok: false,
      failure: {
        reason: "draft_revision_changed",
        details: {
          expectedDraftRevision: fixture.created.draftRevision + 1,
          actualDraftRevision: fixture.created.draftRevision
        }
      }
    });

    const saved = unwrap(await adapters.transaction.command((transaction) => adapters.worlds.updateWorldDraft(
      transaction,
      { ownerUserId, worldId: fixture.created.id },
      {
        expectedRevision: fixture.created.draftRevision,
        content: content(fixture.title, "Published")
      }
    )));
    expect(saved.updatedAt).toBeInstanceOf(Date);
    const published = await publishFixtureWorld(adapters, fixture.created.id, saved.revision, "Immutable one");
    expect(published.publishedAt).toBeInstanceOf(Date);

    const nextDraft = unwrap(await adapters.transaction.command((transaction) => adapters.worlds.updateWorldDraft(
      transaction,
      { ownerUserId, worldId: fixture.created.id },
      {
        expectedRevision: saved.revision,
        content: content(fixture.title, "Unpublished")
      }
    )));
    const publishedRow = await pool.query<{ content: Record<string, any> }>(
      "SELECT content FROM world_versions WHERE id = $1 AND owner_user_id = $2",
      [published.worldVersionId, ownerUserId]
    );
    expect(publishedRow.rows[0]?.content.world.backgroundStory).toBe("Background Published");

    const archived = unwrap(await adapters.transaction.command((transaction) => adapters.worlds.updateWorldStatus(
      transaction,
      { ownerUserId, worldId: fixture.created.id },
      { status: "archived" }
    )));
    expect(archived.status).toBe("archived");
    expect(archived.updatedAt).toBeInstanceOf(Date);
    const archivedEdit = await adapters.transaction.command((transaction) => adapters.worlds.updateWorldDraft(
      transaction,
      { ownerUserId, worldId: fixture.created.id },
      {
        expectedRevision: nextDraft.revision,
        content: content(fixture.title, "Forbidden")
      }
    ));
    expect(archivedEdit).toMatchObject({ ok: false, failure: { reason: "invalid_transition" } });

    const forked = unwrap(await adapters.transaction.command((transaction) => adapters.worlds.forkWorld(
      transaction,
      { ownerUserId, worldId: fixture.created.id },
      { title: `Fork ${crypto.randomUUID()}`, sourceWorldVersionId: published.worldVersionId }
    )));
    expect(forked).toMatchObject({
      sourceWorldId: fixture.created.id,
      sourceWorldVersionId: published.worldVersionId,
      revision: 1
    });

    const detail = await adapters.transaction.read((transaction) => adapters.worlds.getWorld(
      transaction,
      { ownerUserId, worldId: fixture.created.id }
    ));
    expect(detail.versions.map((version) => version.id)).toContain(published.worldVersionId);
    expect(detail.createdAt).toBeInstanceOf(Date);
    expect(detail.versions[0]?.publishedAt).toBeInstanceOf(Date);
  });

  it("blocks referenced deletions before deleting unreferenced versions and worlds", async () => {
    const adapters = createAdapters();
    const fixture = await createFixtureWorld(adapters, "Deletion blocker world");
    const first = await publishFixtureWorld(
      adapters,
      fixture.created.id,
      fixture.created.draftRevision,
      "Deletion blocker version"
    );
    const campaign = await pool.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id, world_version_id, title) VALUES ($1,$2,$3) RETURNING id",
      [ownerUserId, first.worldVersionId, `Deletion blocker campaign ${crypto.randomUUID()}`]
    );

    const blockedVersion = await adapters.transaction.command((transaction) => adapters.worlds.deleteWorldVersion(
      transaction,
      { ownerUserId, worldId: fixture.created.id, worldVersionId: first.worldVersionId },
      { confirmation: "DELETE", expectedVersionNumber: first.versionNumber }
    ));
    expect(blockedVersion).toMatchObject({
      ok: false,
      failure: { reason: "deletion_blocked", details: { blockers: ["current_campaigns:1"] } }
    });
    const blockedWorld = await adapters.transaction.command((transaction) => adapters.worlds.deleteWorld(
      transaction,
      { ownerUserId, worldId: fixture.created.id },
      { confirmation: "DELETE", expectedTitle: fixture.title }
    ));
    expect(blockedWorld).toMatchObject({
      ok: false,
      failure: { reason: "deletion_blocked", details: { blockers: ["campaigns:1"] } }
    });

    await pool.query("DELETE FROM campaigns WHERE id = $1 AND owner_user_id = $2", [campaign.rows[0]!.id, ownerUserId]);
    const deletedVersion = await adapters.transaction.command((transaction) => adapters.worlds.deleteWorldVersion(
      transaction,
      { ownerUserId, worldId: fixture.created.id, worldVersionId: first.worldVersionId },
      { confirmation: "DELETE", expectedVersionNumber: first.versionNumber }
    ));
    expect(deletedVersion).toEqual({ ok: true, value: undefined });
    const deletedWorld = await adapters.transaction.command((transaction) => adapters.worlds.deleteWorld(
      transaction,
      { ownerUserId, worldId: fixture.created.id },
      { confirmation: "DELETE", expectedTitle: fixture.title }
    ));
    expect(deletedWorld).toEqual({ ok: true, value: undefined });
    const remaining = await pool.query("SELECT id FROM worlds WHERE id = $1", [fixture.created.id]);
    expect(remaining.rowCount).toBe(0);
  });

  it("migrates a campaign only to a newer version of its current owner-scoped world", async () => {
    const adapters = createAdapters();
    const fixture = await createFixtureWorld(adapters, "Migration world");
    const first = await publishFixtureWorld(adapters, fixture.created.id, fixture.created.draftRevision, "Version one");
    const saved = unwrap(await adapters.transaction.command((transaction) => adapters.worlds.updateWorldDraft(
      transaction,
      { ownerUserId, worldId: fixture.created.id },
      { expectedRevision: first.draftRevision, content: content(fixture.title, "Two") }
    )));
    const second = await publishFixtureWorld(adapters, fixture.created.id, saved.revision, "Version two");
    const other = await createFixtureWorld(adapters, "Other migration world");
    const otherVersion = await publishFixtureWorld(adapters, other.created.id, other.created.draftRevision, "Other version");
    const campaign = await pool.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id, world_version_id, title) VALUES ($1,$2,$3) RETURNING id",
      [ownerUserId, first.worldVersionId, `Migration campaign ${crypto.randomUUID()}`]
    );
    const campaignId = campaign.rows[0]!.id;
    const foreign = await pool.query<{ id: string }>(
      "INSERT INTO users (display_name, status) VALUES ($1, 'active') RETURNING id",
      [`Foreign migration owner ${crypto.randomUUID()}`]
    );
    const foreignMigration = await adapters.transaction.command((transaction) => adapters.campaigns.migrateCampaignWorldVersion(
      transaction,
      { ownerUserId: foreign.rows[0]!.id, campaignId },
      { worldVersionId: second.worldVersionId, note: "foreign scope" }
    ));
    expect(foreignMigration).toMatchObject({ ok: false, failure: { reason: "campaign_not_found" } });

    const crossWorld = await adapters.transaction.command((transaction) => adapters.campaigns.migrateCampaignWorldVersion(
      transaction,
      { ownerUserId, campaignId },
      { worldVersionId: otherVersion.worldVersionId, note: "must transfer" }
    ));
    expect(crossWorld).toMatchObject({ ok: false, failure: { reason: "world_transfer_required" } });

    const migrated = unwrap(await adapters.transaction.command((transaction) => adapters.campaigns.migrateCampaignWorldVersion(
      transaction,
      { ownerUserId, campaignId },
      { worldVersionId: second.worldVersionId, note: "explicit upgrade" }
    )));
    expect(migrated).toMatchObject({
      campaignId,
      fromWorldVersionId: first.worldVersionId,
      toWorldVersionId: second.worldVersionId,
      worldVersionNumber: 2
    });
    expect(migrated.migratedAt).toBeInstanceOf(Date);
    const persisted = await pool.query<{ world_version_id: string; migrations: number }>(
      `SELECT c.world_version_id,
              (SELECT count(*)::int FROM campaign_world_migrations WHERE campaign_id = c.id) AS migrations
         FROM campaigns c WHERE c.id = $1 AND c.owner_user_id = $2`,
      [campaignId, ownerUserId]
    );
    expect(persisted.rows[0]).toEqual({ world_version_id: second.worldVersionId, migrations: 1 });
    expect((await pool.query(
      "SELECT id FROM activity_events WHERE owner_user_id = $1 AND campaign_id = $2 AND event_type = 'campaign_world_migrated'",
      [ownerUserId, campaignId]
    )).rowCount).toBe(1);

    await pool.query(
      `INSERT INTO campaign_world_transfers (
         owner_user_id, idempotency_key, from_world_version_id, to_world_version_id,
         character_strategy, state_strategy, target_defaults_policy, source_fingerprint
       ) VALUES ($1,$2,$3,$4,'preserve_source','preserve','retain_source',$5)`,
      [ownerUserId, crypto.randomUUID(), first.worldVersionId, otherVersion.worldVersionId, "a".repeat(64)]
    );
    const auditedVersion = await adapters.transaction.command((transaction) => adapters.worlds.deleteWorldVersion(
      transaction,
      { ownerUserId, worldId: fixture.created.id, worldVersionId: first.worldVersionId },
      { confirmation: "DELETE", expectedVersionNumber: first.versionNumber }
    ));
    expect(auditedVersion).toMatchObject({
      ok: false,
      failure: {
        reason: "deletion_blocked",
        details: { blockers: ["campaign_migrations:1", "campaign_transfers:1"] }
      }
    });
  });

  it("owns the complete campaign lifecycle and playable-character reads", async () => {
    const adapters = createAdapters();
    const foreign = await pool.query<{ id: string }>(
      "INSERT INTO users (display_name, status) VALUES ($1, 'active') RETURNING id",
      [`Foreign campaign owner ${crypto.randomUUID()}`]
    );
    const foreignOwnerUserId = foreign.rows[0]!.id;
    const ownWorld = await createFixtureWorld(adapters, "Owned campaign world");
    const ownVersion = await publishFixtureWorld(
      adapters,
      ownWorld.created.id,
      ownWorld.created.draftRevision,
      "Owned campaign version"
    );
    const foreignWorld = await createFixtureWorld(adapters, "Foreign campaign world", foreignOwnerUserId);
    const foreignVersion = await publishFixtureWorld(
      adapters,
      foreignWorld.created.id,
      foreignWorld.created.draftRevision,
      "Foreign campaign version",
      foreignOwnerUserId
    );

    const ownCampaign = await createFixtureCampaign(adapters, ownVersion.worldVersionId, "Owned campaign");
    const foreignCampaign = await createFixtureCampaign(
      adapters,
      foreignVersion.worldVersionId,
      "Foreign campaign",
      foreignOwnerUserId
    );
    expect(ownCampaign.created).toMatchObject({
      status: "active",
      activeTurnNumber: 0,
      turnControlStyle: "flexible_auto",
      worldId: ownWorld.created.id,
      worldVersionId: ownVersion.worldVersionId,
      selectedCharacterId: "character-one",
      selectedCharacterName: "Character One"
    });
    const state = await pool.query<{ trackers: unknown[]; rpg_stats: unknown[]; initial_state_snapshot: Record<string, unknown> }>(
      "SELECT trackers, rpg_stats, initial_state_snapshot FROM campaign_state WHERE campaign_id = $1 AND owner_user_id = $2",
      [ownCampaign.created.id, ownerUserId]
    );
    expect(state.rows[0]?.trackers).toHaveLength(2);
    expect(state.rows[0]?.rpg_stats).toHaveLength(2);
    expect(state.rows[0]?.initial_state_snapshot).toMatchObject({ scratchpad: "" });

    const listed = await adapters.transaction.read((transaction) => adapters.campaigns.listCampaigns(
      transaction,
      { ownerUserId }
    ));
    expect(listed.campaigns.map((campaign) => campaign.id)).toContain(ownCampaign.created.id);
    expect(listed.campaigns.map((campaign) => campaign.id)).not.toContain(foreignCampaign.created.id);
    expect(listed.campaigns.find((campaign) => campaign.id === ownCampaign.created.id)?.createdAt).toBeInstanceOf(Date);
    expect(listed.campaigns.find((campaign) => campaign.id === ownCampaign.created.id)?.updatedAt).toBeInstanceOf(Date);

    const characters = await adapters.transaction.read((transaction) => adapters.campaigns.listWorldVersionPlayableCharacters(
      transaction,
      { ownerUserId, worldVersionId: ownVersion.worldVersionId }
    ));
    const summary = await adapters.transaction.read((transaction) => adapters.campaigns.getWorldVersionPlayableCharacterSummary(
      transaction,
      { ownerUserId, worldVersionId: ownVersion.worldVersionId }
    ));
    expect(characters).toEqual([{ id: "character-one", name: "Character One", rpgStatCount: 1, defaultTriggerCount: 1 }]);
    expect(summary).toMatchObject({ characters, readiness: { ready: true, issues: [] } });

    const foreignCreate = await adapters.transaction.command((transaction) => adapters.campaigns.createCampaign(
      transaction,
      { ownerUserId: foreignOwnerUserId },
      {
        worldVersionId: ownVersion.worldVersionId,
        title: `Spoofed campaign ${crypto.randomUUID()}`,
        storyLengthProfile: "standard",
        storyContextBudgetTokens: 32_000,
        turnControlStyle: "flexible_auto"
      }
    ));
    expect(foreignCreate).toMatchObject({ ok: false, failure: { reason: "world_version_not_found" } });
    await expect(adapters.transaction.read((transaction) => adapters.campaigns.getWorldVersionPlayableCharacterSummary(
      transaction,
      { ownerUserId: foreignOwnerUserId, worldVersionId: ownVersion.worldVersionId }
    ))).rejects.toMatchObject({ reason: "world_version_not_found" });

    const foreignUpdate = await adapters.transaction.command((transaction) => adapters.campaigns.updateCampaign(
      transaction,
      { ownerUserId: foreignOwnerUserId, campaignId: ownCampaign.created.id },
      { title: "Spoofed title" }
    ));
    expect(foreignUpdate).toMatchObject({ ok: false, failure: { reason: "campaign_not_found" } });
    const updated = unwrap(await adapters.transaction.command((transaction) => adapters.campaigns.updateCampaign(
      transaction,
      { ownerUserId, campaignId: ownCampaign.created.id },
      { title: `${ownCampaign.title} updated`, status: "archived", storyLengthProfile: "long", turnControlStyle: "action_only" }
    )));
    expect(updated).toMatchObject({
      title: `${ownCampaign.title} updated`,
      status: "archived",
      storyLengthProfile: "long",
      turnControlStyle: "action_only"
    });
    expect(updated.updatedAt).toBeInstanceOf(Date);

    const wrongTitle = await adapters.transaction.command((transaction) => adapters.campaigns.deleteCampaign(
      transaction,
      { ownerUserId, campaignId: ownCampaign.created.id },
      { confirmation: "DELETE", expectedTitle: ownCampaign.title }
    ));
    expect(wrongTitle).toMatchObject({ ok: false, failure: { reason: "invalid_transition" } });
    const foreignDelete = await adapters.transaction.command((transaction) => adapters.campaigns.deleteCampaign(
      transaction,
      { ownerUserId: foreignOwnerUserId, campaignId: ownCampaign.created.id },
      { confirmation: "DELETE", expectedTitle: `${ownCampaign.title} updated` }
    ));
    expect(foreignDelete).toMatchObject({ ok: false, failure: { reason: "campaign_not_found" } });
    const deleted = await adapters.transaction.command((transaction) => adapters.campaigns.deleteCampaign(
      transaction,
      { ownerUserId, campaignId: ownCampaign.created.id },
      { confirmation: "DELETE", expectedTitle: `${ownCampaign.title} updated` }
    ));
    expect(deleted).toEqual({ ok: true, value: undefined });
    expect((await pool.query("SELECT id FROM campaigns WHERE id = $1", [ownCampaign.created.id])).rowCount).toBe(0);
  });

  it("defaults new world campaigns to chunked retrieval and shadow comparison without an embedding provider", async () => {
    const adapters = createAdapters();
    const world = await createFixtureWorld(adapters, "Retrieval defaults world");
    const version = await publishFixtureWorld(adapters, world.created.id, world.created.draftRevision, "Retrieval defaults");
    const existing = await createFixtureCampaign(adapters, version.worldVersionId, "Existing campaign");
    await pool.query(
      `INSERT INTO campaign_memory_configs (campaign_id, owner_user_id, retrieval_implementation, retrieval_shadow_enabled)
       VALUES ($1,$2,'legacy_hybrid',false)
       ON CONFLICT (campaign_id) DO UPDATE SET retrieval_implementation = 'legacy_hybrid', retrieval_shadow_enabled = false`,
      [existing.created.id, ownerUserId]
    );

    const campaign = await createFixtureCampaign(adapters, version.worldVersionId, "New campaign");
    const configs = await pool.query(
      `SELECT campaign_id, embedding_enabled, retrieval_implementation, retrieval_shadow_enabled
         FROM campaign_memory_configs WHERE owner_user_id = $1 ORDER BY campaign_id`,
      [ownerUserId]
    );
    expect(configs.rows).toHaveLength(2);
    expect(configs.rows).toEqual(expect.arrayContaining([
      { campaign_id: existing.created.id, embedding_enabled: false, retrieval_implementation: "legacy_hybrid", retrieval_shadow_enabled: false },
      { campaign_id: campaign.created.id, embedding_enabled: false, retrieval_implementation: "chunked_hybrid", retrieval_shadow_enabled: true }
    ]));
    expect((await pool.query("SELECT id FROM chronicle_jobs WHERE campaign_id = $1", [campaign.created.id])).rows).toEqual([]);
    expect((await pool.query("SELECT id FROM chronicle_chunk_jobs WHERE campaign_id = $1", [campaign.created.id])).rows).toEqual([]);
  });

  it("auto-enables eligible campaign embedding and queues chunk indexing inside the caller-owned creation transaction", async () => {
    const adapters = createAdapters();
    const provider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles (
         owner_user_id, name, provider_type, provider_role, base_url, default_model, is_default
       ) VALUES ($1,$2,'openai_compatible','embedding','http://provider.invalid/v1',$3,true)
       RETURNING id`,
      [ownerUserId, `Campaign embedding ${crypto.randomUUID()}`, "campaign-embedding-model"]
    );
    const providerProfileId = provider.rows[0]!.id;
    const world = await createFixtureWorld(adapters, "Campaign embedding world");
    const version = await publishFixtureWorld(
      adapters,
      world.created.id,
      world.created.draftRevision,
      "Campaign embedding version"
    );
    const campaign = await createFixtureCampaign(adapters, version.worldVersionId, "Embedded campaign");

    const enabled = await pool.query<{
      embedding_enabled: boolean;
      embedding_provider_profile_id: string;
      embedding_model: string;
      retrieval_implementation: string;
      retrieval_shadow_enabled: boolean;
      job_type: string;
      status: string;
    }>(
      `SELECT config.embedding_enabled, config.embedding_provider_profile_id, config.embedding_model,
              config.retrieval_implementation, config.retrieval_shadow_enabled,
              job.job_type, job.status
         FROM campaign_memory_configs config
         JOIN chronicle_jobs job
           ON job.campaign_id = config.campaign_id AND job.owner_user_id = config.owner_user_id
        WHERE config.campaign_id = $1 AND config.owner_user_id = $2`,
      [campaign.created.id, ownerUserId]
    );
    expect(enabled.rows[0]).toEqual({
      embedding_enabled: true,
      embedding_provider_profile_id: providerProfileId,
      embedding_model: "campaign-embedding-model",
      retrieval_implementation: "chunked_hybrid",
      retrieval_shadow_enabled: true,
      job_type: "embed_campaign",
      status: "queued"
    });
    const chunkJobs = await pool.query(
      `SELECT owner_user_id, campaign_id, job_type, status FROM chronicle_chunk_jobs WHERE campaign_id = $1`,
      [campaign.created.id]
    );
    expect(chunkJobs.rows).toEqual([{
      owner_user_id: ownerUserId,
      campaign_id: campaign.created.id,
      job_type: "index_memory_chunks_v2",
      status: "queued"
    }]);

    let rolledBackCampaignId = "";
    await expect(adapters.transaction.command(async (transaction) => {
      const created = unwrap(await adapters.campaigns.createCampaign(
        transaction,
        { ownerUserId },
        {
          worldVersionId: version.worldVersionId,
          title: `Rolled back embedded campaign ${crypto.randomUUID()}`,
          storyLengthProfile: "standard",
          storyContextBudgetTokens: 32_000,
          turnControlStyle: "flexible_auto"
        }
      ));
      rolledBackCampaignId = created.id;
      throw new Error("synthetic campaign creation rollback");
    })).rejects.toThrow("synthetic campaign creation rollback");
    expect(rolledBackCampaignId).not.toBe("");
    const rolledBack = await pool.query<{ campaigns: string; configs: string; jobs: string; chunk_jobs: string }>(
      `SELECT
         (SELECT count(*)::text FROM campaigns WHERE id = $1) AS campaigns,
         (SELECT count(*)::text FROM campaign_memory_configs WHERE campaign_id = $1) AS configs,
         (SELECT count(*)::text FROM chronicle_jobs WHERE campaign_id = $1) AS jobs,
         (SELECT count(*)::text FROM chronicle_chunk_jobs WHERE campaign_id = $1) AS chunk_jobs`,
      [rolledBackCampaignId]
    );
    expect(rolledBack.rows[0]).toEqual({ campaigns: "0", configs: "0", jobs: "0", chunk_jobs: "0" });
  });

  it("blocks campaign deletion while durable work remains active", async () => {
    const adapters = createAdapters();
    const world = await createFixtureWorld(adapters, "Campaign deletion work world");
    const version = await publishFixtureWorld(adapters, world.created.id, world.created.draftRevision, "Work blocker version");
    const campaign = await createFixtureCampaign(adapters, version.worldVersionId, "Work blocker campaign");
    await pool.query(
      "INSERT INTO chronicle_jobs (owner_user_id, campaign_id, job_type) VALUES ($1,$2,'reindex_campaign')",
      [ownerUserId, campaign.created.id]
    );

    const blocked = await adapters.transaction.command((transaction) => adapters.campaigns.deleteCampaign(
      transaction,
      { ownerUserId, campaignId: campaign.created.id },
      { confirmation: "DELETE", expectedTitle: campaign.title }
    ));
    expect(blocked).toMatchObject({
      ok: false,
      failure: { reason: "deletion_blocked", details: { blockers: ["memory:1"] } }
    });
  });

  it("serializes world deletion with concurrent campaign creation and returns a typed blocker", async () => {
    const adapters = createAdapters();
    const world = await createFixtureWorld(adapters, "Concurrent deletion world");
    const version = await publishFixtureWorld(
      adapters,
      world.created.id,
      world.created.draftRevision,
      "Concurrent deletion version"
    );
    const campaignWriter = await pool.connect();
    let writerOpen = false;
    try {
      await campaignWriter.query("BEGIN");
      writerOpen = true;
      const writerBackend = await campaignWriter.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const writerPid = writerBackend.rows[0]!.pid;
      await campaignWriter.query(
        "INSERT INTO campaigns (owner_user_id, world_version_id, title) VALUES ($1,$2,$3)",
        [ownerUserId, version.worldVersionId, `Concurrent blocker ${crypto.randomUUID()}`]
      );
      const deletion = adapters.transaction.command((transaction) => adapters.worlds.deleteWorld(
        transaction,
        { ownerUserId, worldId: world.created.id },
        { confirmation: "DELETE", expectedTitle: world.title }
      ));

      let waitingOnWriter = false;
      for (let attempt = 0; attempt < 100 && !waitingOnWriter; attempt += 1) {
        const waiting = await pool.query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
              WHERE $1::int = ANY(pg_blocking_pids(pid))
           ) AS waiting`,
          [writerPid]
        );
        waitingOnWriter = waiting.rows[0]?.waiting === true;
        if (!waitingOnWriter) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      expect(waitingOnWriter).toBe(true);
      await campaignWriter.query("COMMIT");
      writerOpen = false;

      await expect(deletion).resolves.toMatchObject({
        ok: false,
        failure: { reason: "deletion_blocked", details: { blockers: ["campaigns:1"] } }
      });
    } finally {
      if (writerOpen) await campaignWriter.query("ROLLBACK");
      campaignWriter.release();
    }
  });

  it("serializes target-version deletion with campaign migration and returns a typed blocker", async () => {
    const adapters = createAdapters();
    const world = await createFixtureWorld(adapters, "Concurrent migration world");
    const first = await publishFixtureWorld(
      adapters,
      world.created.id,
      world.created.draftRevision,
      "Concurrent migration version one"
    );
    const saved = unwrap(await adapters.transaction.command((transaction) => adapters.worlds.updateWorldDraft(
      transaction,
      { ownerUserId, worldId: world.created.id },
      { expectedRevision: first.draftRevision, content: content(world.title, "Concurrent Two") }
    )));
    const second = await publishFixtureWorld(
      adapters,
      world.created.id,
      saved.revision,
      "Concurrent migration version two"
    );
    const campaign = await pool.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id, world_version_id, title) VALUES ($1,$2,$3) RETURNING id",
      [ownerUserId, first.worldVersionId, `Concurrent migration campaign ${crypto.randomUUID()}`]
    );
    const campaignId = campaign.rows[0]!.id;
    await pool.query(
      `CREATE FUNCTION block_campaign_migration_target_race() RETURNS trigger
       LANGUAGE plpgsql AS $$
       BEGIN
         PERFORM pg_advisory_xact_lock(hashtext(NEW.to_world_version_id::text));
         RETURN NEW;
       END
       $$`
    );
    await pool.query(
      `CREATE TRIGGER campaign_migration_target_race_trigger
       BEFORE INSERT ON campaign_world_migrations
       FOR EACH ROW EXECUTE FUNCTION block_campaign_migration_target_race()`
    );

    const blocker = await pool.connect();
    let blockerOpen = false;
    try {
      await blocker.query("BEGIN");
      blockerOpen = true;
      const blockerBackend = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const blockerPid = blockerBackend.rows[0]!.pid;
      await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [second.worldVersionId]);

      const migration = adapters.transaction.command((transaction) => adapters.campaigns.migrateCampaignWorldVersion(
        transaction,
        { ownerUserId, campaignId },
        { worldVersionId: second.worldVersionId, note: "coordinated target race" }
      ));
      let migrationPid: number | null = null;
      for (let attempt = 0; attempt < 100 && migrationPid === null; attempt += 1) {
        const waiting = await pool.query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity
            WHERE $1::int = ANY(pg_blocking_pids(pid))
              AND query LIKE '%INSERT INTO campaign_world_migrations%'
            LIMIT 1`,
          [blockerPid]
        );
        migrationPid = waiting.rows[0]?.pid ?? null;
        if (migrationPid === null) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      expect(migrationPid).not.toBeNull();

      const deletion = adapters.transaction.command((transaction) => adapters.worlds.deleteWorldVersion(
        transaction,
        { ownerUserId, worldId: world.created.id, worldVersionId: second.worldVersionId },
        { confirmation: "DELETE", expectedVersionNumber: second.versionNumber }
      ));
      let deletionWaitingOnMigration = false;
      for (let attempt = 0; attempt < 100 && !deletionWaitingOnMigration; attempt += 1) {
        const waiting = await pool.query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
              WHERE $1::int = ANY(pg_blocking_pids(pid))
           ) AS waiting`,
          [migrationPid]
        );
        deletionWaitingOnMigration = waiting.rows[0]?.waiting === true;
        if (!deletionWaitingOnMigration) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }

      await blocker.query("COMMIT");
      blockerOpen = false;
      const [migrationOutcome, deletionOutcome] = await Promise.allSettled([migration, deletion]);
      expect(deletionWaitingOnMigration).toBe(true);
      expect(migrationOutcome).toMatchObject({
        status: "fulfilled",
        value: { ok: true, value: { toWorldVersionId: second.worldVersionId } }
      });
      expect(deletionOutcome).toMatchObject({
        status: "fulfilled",
        value: {
          ok: false,
          failure: {
            reason: "deletion_blocked",
            details: { blockers: ["current_campaigns:1", "campaign_migrations:1"] }
          }
        }
      });
    } finally {
      if (blockerOpen) await blocker.query("ROLLBACK");
      blocker.release();
    }
  });

  it("exports and idempotently imports portable worlds inside the explicit owner scope", async () => {
    const adapters = createAdapters();
    const source = await createFixtureWorld(adapters, "Portable source");
    const published = await publishFixtureWorld(
      adapters,
      source.created.id,
      source.created.draftRevision,
      "Portable source release"
    );

    const exported = await adapters.transaction.read((transaction) => adapters.worlds.exportWorld(
      transaction,
      { ownerUserId, worldId: source.created.id, worldVersionId: published.worldVersionId }
    ));
    expect(exported).toMatchObject({
      format: "infinite-quest-world",
      formatVersion: 1,
      title: source.title,
      content: { world: { title: source.title } }
    });

    const request = worldImportRequestSchema.parse({
      sourceName: "portable-world.json",
      worldExport: exported
    });
    const firstPreview = await adapters.transaction.read((transaction) => adapters.worlds.previewWorldImport(
      transaction,
      { ownerUserId },
      request
    ));
    expect(firstPreview).toMatchObject({ duplicate: false, existingWorldId: null, title: source.title });

    const firstImport = await adapters.transaction.command((transaction) => adapters.worlds.importWorld(
      transaction,
      { ownerUserId },
      request
    ));
    expect(firstImport).toMatchObject({ ok: true, value: { duplicate: false } });
    if (!firstImport.ok) throw new Error("portable world import failed");

    const duplicatePreview = await adapters.transaction.read((transaction) => adapters.worlds.previewWorldImport(
      transaction,
      { ownerUserId },
      request
    ));
    expect(duplicatePreview).toMatchObject({
      duplicate: true,
      existingWorldId: firstImport.value.worldId
    });

    const duplicateImport = await adapters.transaction.command((transaction) => adapters.worlds.importWorld(
      transaction,
      { ownerUserId },
      request
    ));
    expect(duplicateImport).toEqual({
      ok: true,
      value: { ...firstImport.value, duplicate: true }
    });

    const foreignOwner = await pool.query<{ id: string }>(
      "INSERT INTO users (display_name, status) VALUES ($1, 'active') RETURNING id",
      [`Portable foreign owner ${crypto.randomUUID()}`]
    );
    const foreignExport = adapters.transaction.read((transaction) => adapters.worlds.exportWorld(
      transaction,
      {
        ownerUserId: foreignOwner.rows[0]!.id,
        worldId: source.created.id,
        worldVersionId: published.worldVersionId
      }
    ));
    await expect(foreignExport).rejects.toMatchObject({
      kind: "not_found",
      reason: "world_version_not_found"
    });
  });

  it("promotes selected active campaign discoveries into an owner-scoped reviewable draft", async () => {
    const adapters = createAdapters();
    const source = await createFixtureWorld(adapters, "Promotion source");
    const published = await publishFixtureWorld(
      adapters,
      source.created.id,
      source.created.draftRevision,
      "Promotion source release"
    );
    const campaign = await createFixtureCampaign(adapters, published.worldVersionId, "Promotion campaign");
    const target = await createFixtureWorld(adapters, "Promotion target");
    const turn = await pool.query<{ id: string }>(
      `INSERT INTO turns (owner_user_id, campaign_id, turn_number, narration)
       VALUES ($1,$2,1,$3) RETURNING id`,
      [ownerUserId, campaign.created.id, "The observatory reveals a hidden moon."]
    );
    const factId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO campaign_canonical_facts (
         id, owner_user_id, campaign_id, world_version_id, source_turn_id,
         source_turn_number, source_fact_index, content, normalized_content,
         valid_from_turn
       ) VALUES ($1,$2,$3,$4,$5,1,0,$6,$7,1)`,
      [
        factId,
        ownerUserId,
        campaign.created.id,
        published.worldVersionId,
        turn.rows[0]!.id,
        "A hidden moon orbits beyond the observatory.",
        "a hidden moon orbits beyond the observatory"
      ]
    );

    const promoted = await adapters.transaction.command((transaction) => adapters.worlds.promoteCampaignDiscoveries(
      transaction,
      { ownerUserId, campaignId: campaign.created.id },
      {
        draftWorldId: target.created.id,
        expectedWorldVersionId: published.worldVersionId,
        discoveryFactIds: [factId]
      }
    ));
    expect(promoted).toEqual({
      ok: true,
      value: {
        worldId: target.created.id,
        draftRevision: target.created.draftRevision + 1,
        promotedFactCount: 1
      }
    });
    const draft = await pool.query<{ revision: number; content: Record<string, unknown> }>(
      "SELECT revision, content FROM world_drafts WHERE owner_user_id = $1 AND world_id = $2",
      [ownerUserId, target.created.id]
    );
    expect(draft.rows[0]).toMatchObject({
      revision: target.created.draftRevision + 1,
      content: {
        defaults: {
          promotedCampaignDiscoveries: [{
            campaignId: campaign.created.id,
            factId,
            sourceTurnId: turn.rows[0]!.id,
            content: "A hidden moon orbits beyond the observatory."
          }]
        }
      }
    });
  });
});
