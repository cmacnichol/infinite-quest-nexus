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
    }
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
    await pool.query("DELETE FROM world_versions");
    await pool.query("DELETE FROM world_drafts");
    await pool.query("DELETE FROM worlds");
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
  ) {
    return unwrap(await adapters.transaction.command((transaction) => adapters.worlds.publishWorld(
      transaction,
      { ownerUserId, worldId },
      { expectedRevision, releaseNotes }
    )));
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
  });
});
