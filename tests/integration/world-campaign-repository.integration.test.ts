import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { worldContentSchema, WORLD_CONTENT_SCHEMA_VERSION } from "../../packages/contracts/src/world-library.js";
import {
  createPostgresWorldRepositoryAdapters
} from "../../packages/database/src/world-repository.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
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
    await pool.query("DELETE FROM campaigns");
    await pool.query("DELETE FROM campaign_world_transfers");
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
    const adapters = createPostgresWorldRepositoryAdapters(pool);
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
    const adapters = createPostgresWorldRepositoryAdapters(pool);
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
    const adapters = createPostgresWorldRepositoryAdapters(pool);
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
    const adapters = createPostgresWorldRepositoryAdapters(pool);
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
    const adapters = createPostgresWorldRepositoryAdapters(pool);
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
    const adapters = createPostgresWorldRepositoryAdapters(pool);
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
      { ownerUserId, worldId: ownWorld.created.id, worldVersionId: ownVersion.worldVersionId }
    ));
    const summary = await adapters.transaction.read((transaction) => adapters.campaigns.getWorldVersionPlayableCharacterSummary(
      transaction,
      { ownerUserId, worldId: ownWorld.created.id, worldVersionId: ownVersion.worldVersionId }
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
        turnControlStyle: "flexible_auto"
      }
    ));
    expect(foreignCreate).toMatchObject({ ok: false, failure: { reason: "world_version_not_found" } });
    await expect(adapters.transaction.read((transaction) => adapters.campaigns.getWorldVersionPlayableCharacterSummary(
      transaction,
      { ownerUserId: foreignOwnerUserId, worldId: ownWorld.created.id, worldVersionId: ownVersion.worldVersionId }
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

  it("blocks campaign deletion while durable work remains active", async () => {
    const adapters = createPostgresWorldRepositoryAdapters(pool);
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
    const adapters = createPostgresWorldRepositoryAdapters(pool);
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
});
