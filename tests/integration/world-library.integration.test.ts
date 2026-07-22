import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import {
  campaignCreateSchema,
  campaignUpdateSchema,
  campaignWorldMigrationSchema,
  resourceDeleteSchema,
  WORLD_CONTENT_SCHEMA_VERSION,
  worldContentSchema,
  worldCreateSchema,
  worldDraftUpdateSchema,
  worldForkSchema,
  worldImportRequestSchema,
  worldPublishSchema,
  worldVersionDeleteSchema
} from "../../packages/contracts/src/world-library.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import {
  createCampaign,
  createWorld,
  deleteCampaign,
  deleteWorld,
  deleteWorldVersion,
  exportCampaign,
  exportWorld,
  forkWorld,
  getWorldVersionPlayableCharacterSummary,
  getWorld,
  importWorld,
  listWorldVersionPlayableCharacters,
  listCampaigns,
  listWorlds,
  migrateCampaignWorld,
  previewWorldImport,
  publishWorld,
  updateCampaign,
  updateWorldDraft
} from "../../services/api/src/world-service.js";
import { buildContextPreview } from "../../services/api/src/memory-service.js";
import { importLegacyStory } from "../../services/api/src/import-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

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
    },
    playableCharacters: [{
      id: `character-${marker.toLocaleLowerCase()}`,
      name: `Character ${marker}`,
      characterText: `Character ${marker}`
    }]
  });
}

integration("World Library and campaign version integration", () => {
  let pool: DatabasePool;

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  async function publishedWorld(label: string) {
    const title = `Synthetic World ${label} ${crypto.randomUUID()}`;
    const created = await createWorld(pool, worldCreateSchema.parse({ title, content: content(title, "One") }));
    const version = await publishWorld(pool, created.id, worldPublishSchema.parse({ expectedRevision: created.draftRevision, releaseNotes: "Synthetic version one" }));
    return { title, created, version };
  }

  async function publishNextVersion(worldId: string, title: string, marker: string) {
    const detail = await getWorld(pool, worldId);
    const saved = await updateWorldDraft(pool, worldId, worldDraftUpdateSchema.parse({
      expectedRevision: detail.draftRevision,
      content: content(title, marker)
    }));
    return publishWorld(pool, worldId, worldPublishSchema.parse({
      expectedRevision: saved.revision,
      releaseNotes: `Synthetic version ${marker}`
    }));
  }

  it("keeps published versions immutable while drafts advance by revision", async () => {
    const first = await publishedWorld("Immutable");
    const detail = await getWorld(pool, first.created.id);
    const updatedContent = content(first.title, "Two");
    const saved = await updateWorldDraft(pool, first.created.id, worldDraftUpdateSchema.parse({
      expectedRevision: detail.draftRevision,
      content: updatedContent
    }));
    const second = await publishWorld(pool, first.created.id, worldPublishSchema.parse({
      expectedRevision: saved.revision,
      releaseNotes: "Synthetic version two"
    }));
    expect(second.versionNumber).toBe(2);
    const rows = await pool.query<{ version_number: number; content: any }>(
      "SELECT version_number, content FROM world_versions WHERE world_id = $1 ORDER BY version_number",
      [first.created.id]
    );
    expect(rows.rows[0]?.content.world.backgroundStory).toBe("Background One");
    expect(rows.rows[1]?.content.world.backgroundStory).toBe("Background Two");
    expect(rows.rows[0]?.content.world).not.toHaveProperty("character");
    expect(rows.rows[1]?.content.world).not.toHaveProperty("character");
  });

  it("lists immutable published world previews without leaking newer draft edits", async () => {
    const published = await publishedWorld("Dashboard Preview");
    const detail = await getWorld(pool, published.created.id);
    await updateWorldDraft(pool, published.created.id, worldDraftUpdateSchema.parse({
      expectedRevision: detail.draftRevision,
      content: content(published.title, "Unpublished")
    }));

    const listed = await listWorlds(pool);
    const world = listed.find((candidate) => candidate.id === published.created.id);

    expect(world?.latestPreview).toMatchObject({
      genre: "test",
      premise: "Premise One",
      backgroundStory: "Background One",
      firstAction: "Action One"
    });
  });

  it("adds, edits, and deletes draft characters without changing published versions or campaign snapshots", async () => {
    const title = `Synthetic Character Authoring ${crypto.randomUUID()}`;
    const originalContent = worldContentSchema.parse({
      ...content(title, "Original"),
      playableCharacters: [{
        id: "imported-character",
        name: "Imported Character",
        characterText: "Original imported guidance.",
        rpgStats: [{ id: "imported-stat", name: "Resolve", value: 61, note: "Imported note", importMarker: "keep-stat" }],
        defaultTriggers: [{ id: "imported-tracker", name: "Oath", value: "Unbroken", rules: "Track the oath.", importMarker: "keep-tracker" }],
        source: { type: "world-import", externalId: "legacy-42" },
        importMarker: "keep-character"
      }]
    });
    const created = await createWorld(pool, worldCreateSchema.parse({ title, content: originalContent }));
    const published = await publishWorld(pool, created.id, worldPublishSchema.parse({ expectedRevision: created.draftRevision }));
    const campaign = await createCampaign(pool, campaignCreateSchema.parse({
      title: `Synthetic Character Snapshot ${crypto.randomUUID()}`,
      worldVersionId: published.worldVersionId
    }));

    const beforeAdd = await getWorld(pool, created.id);
    const added = await updateWorldDraft(pool, created.id, worldDraftUpdateSchema.parse({
      expectedRevision: beforeAdd.draftRevision,
      content: {
        ...beforeAdd.draftContent,
        playableCharacters: [
          ...beforeAdd.draftContent.playableCharacters,
          {
            id: "new-character",
            name: "New Character",
            characterText: "Newly authored guidance.",
            rpgStats: [{ id: "new-stat", name: "Insight", value: 72, note: "Notices hidden paths." }],
            defaultTriggers: [{ id: "new-tracker", name: "Clues", value: "None", rules: "Record discovered clues." }]
          }
        ]
      }
    }));
    expect(added.revision).toBe(beforeAdd.draftRevision + 1);

    const beforeEdit = await getWorld(pool, created.id);
    const editedCharacters = beforeEdit.draftContent.playableCharacters.map((character: any) => character.id === "imported-character"
      ? { ...character, name: "Renamed Character", characterText: "Edited character guidance." }
      : character);
    const edited = await updateWorldDraft(pool, created.id, worldDraftUpdateSchema.parse({
      expectedRevision: beforeEdit.draftRevision,
      content: { ...beforeEdit.draftContent, playableCharacters: editedCharacters }
    }));
    expect(edited.revision).toBe(beforeEdit.draftRevision + 1);

    const beforeDelete = await getWorld(pool, created.id);
    const deleted = await updateWorldDraft(pool, created.id, worldDraftUpdateSchema.parse({
      expectedRevision: beforeDelete.draftRevision,
      content: {
        ...beforeDelete.draftContent,
        playableCharacters: beforeDelete.draftContent.playableCharacters.filter((character: any) => character.id !== "new-character")
      }
    }));
    expect(deleted.revision).toBe(beforeDelete.draftRevision + 1);

    const draft = (await getWorld(pool, created.id)).draftContent;
    expect(draft.playableCharacters).toHaveLength(1);
    expect(draft.playableCharacters[0]).toMatchObject({
      id: "imported-character",
      name: "Renamed Character",
      characterText: "Edited character guidance.",
      source: { type: "world-import", externalId: "legacy-42" },
      importMarker: "keep-character",
      rpgStats: [{ id: "imported-stat", importMarker: "keep-stat" }],
      defaultTriggers: [{ id: "imported-tracker", importMarker: "keep-tracker" }]
    });

    const publishedContent = await pool.query<{ content: any }>("SELECT content FROM world_versions WHERE id = $1", [published.worldVersionId]);
    expect(publishedContent.rows[0]?.content.playableCharacters).toMatchObject([{
      id: "imported-character",
      name: "Imported Character",
      characterText: "Original imported guidance."
    }]);
    const campaignSnapshot = await pool.query<{ character_snapshot: any }>(
      "SELECT character_snapshot FROM campaigns WHERE id = $1",
      [campaign.id]
    );
    expect(campaignSnapshot.rows[0]?.character_snapshot).toMatchObject({
      id: "imported-character",
      name: "Imported Character",
      characterText: "Original imported guidance."
    });
  });

  it("deletes an unused intermediate version without renumbering survivors", async () => {
    const world = await publishedWorld("Delete Intermediate");
    const second = await publishNextVersion(world.created.id, world.title, "Two");
    const third = await publishNextVersion(world.created.id, world.title, "Three");

    await deleteWorldVersion(pool, world.created.id, second.worldVersionId, worldVersionDeleteSchema.parse({
      confirmation: "DELETE",
      expectedVersionNumber: 2
    }));

    const detail = await getWorld(pool, world.created.id);
    expect(detail.versions.map((version: any) => version.versionNumber).sort()).toEqual([1, 3]);
    expect(detail.draftBasedOnWorldVersionId).toBe(third.worldVersionId);
  });

  it("does not reuse the number of a deleted latest version", async () => {
    const world = await publishedWorld("Delete Latest");
    const second = await publishNextVersion(world.created.id, world.title, "Two");
    await deleteWorldVersion(pool, world.created.id, second.worldVersionId, worldVersionDeleteSchema.parse({
      confirmation: "DELETE",
      expectedVersionNumber: 2
    }));

    const third = await publishNextVersion(world.created.id, world.title, "Three");
    expect(third.versionNumber).toBe(3);
    expect((await getWorld(pool, world.created.id)).versions.map((version: any) => version.versionNumber).sort()).toEqual([1, 3]);
  });

  it("preserves draft content and returns a World to draft status after deleting its only version", async () => {
    const world = await publishedWorld("Delete Only");
    const before = await getWorld(pool, world.created.id);

    await deleteWorldVersion(pool, world.created.id, world.version.worldVersionId, worldVersionDeleteSchema.parse({
      confirmation: "DELETE",
      expectedVersionNumber: 1
    }));

    const after = await getWorld(pool, world.created.id);
    expect(after).toMatchObject({ status: "draft", draftBasedOnWorldVersionId: null });
    expect(after.versions).toEqual([]);
    expect(after.draftContent).toEqual(before.draftContent);
  });

  it("rejects deletion of a version used by a current campaign", async () => {
    const world = await publishedWorld("Delete Current Campaign");
    await createCampaign(pool, campaignCreateSchema.parse({
      title: `Synthetic Version Blocker ${crypto.randomUUID()}`,
      worldVersionId: world.version.worldVersionId
    }));

    await expect(deleteWorldVersion(
      pool,
      world.created.id,
      world.version.worldVersionId,
      worldVersionDeleteSchema.parse({ confirmation: "DELETE", expectedVersionNumber: 1 })
    )).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects deletion of a version retained by campaign migration history", async () => {
    const world = await publishedWorld("Delete Migration History");
    const campaign = await createCampaign(pool, campaignCreateSchema.parse({
      title: `Synthetic Historical Blocker ${crypto.randomUUID()}`,
      worldVersionId: world.version.worldVersionId
    }));
    const second = await publishNextVersion(world.created.id, world.title, "Two");
    await migrateCampaignWorld(pool, campaign.id, campaignWorldMigrationSchema.parse({ worldVersionId: second.worldVersionId }));

    await expect(deleteWorldVersion(
      pool,
      world.created.id,
      world.version.worldVersionId,
      worldVersionDeleteSchema.parse({ confirmation: "DELETE", expectedVersionNumber: 1 })
    )).rejects.toMatchObject({ statusCode: 409 });
  });

  it("detaches draft, fork, and import provenance when deleting an otherwise unused version", async () => {
    const source = await publishedWorld("Delete Provenance");
    const fork = await forkWorld(pool, source.created.id, worldForkSchema.parse({
      title: `Synthetic Detached Fork ${crypto.randomUUID()}`,
      sourceWorldVersionId: source.version.worldVersionId
    }));
    const ownerUserId = await initialOwnerId(pool);
    const imported = await pool.query<{ id: string }>(
      `INSERT INTO imports (
         owner_user_id, source_type, source_name, source_hash, status, world_id, world_version_id, stats, completed_at
       ) VALUES ($1,'world','synthetic-delete-provenance.json',$2,'completed',$3,$4,'{}'::jsonb,now())
       RETURNING id`,
      [ownerUserId, crypto.randomUUID(), source.created.id, source.version.worldVersionId]
    );
    const draftBefore = (await getWorld(pool, source.created.id)).draftContent;

    await deleteWorldVersion(pool, source.created.id, source.version.worldVersionId, worldVersionDeleteSchema.parse({
      confirmation: "DELETE",
      expectedVersionNumber: 1
    }));

    expect(await getWorld(pool, source.created.id)).toMatchObject({
      draftBasedOnWorldVersionId: null,
      draftContent: draftBefore
    });
    expect(await getWorld(pool, fork.worldId)).toMatchObject({
      forkedFromWorldId: source.created.id,
      forkedFromWorldVersionId: null
    });
    const importRow = await pool.query<{ world_id: string; world_version_id: string | null }>(
      "SELECT world_id, world_version_id FROM imports WHERE id = $1",
      [imported.rows[0]!.id]
    );
    expect(importRow.rows[0]).toEqual({ world_id: source.created.id, world_version_id: null });
  });

  it("rejects stale version selection, wrong-World access, and versions owned by another user", async () => {
    const first = await publishedWorld("Delete Boundary A");
    const second = await publishedWorld("Delete Boundary B");
    const request = worldVersionDeleteSchema.parse({ confirmation: "DELETE", expectedVersionNumber: 1 });

    await expect(deleteWorldVersion(pool, first.created.id, first.version.worldVersionId, worldVersionDeleteSchema.parse({
      confirmation: "DELETE",
      expectedVersionNumber: 2
    }))).rejects.toMatchObject({ statusCode: 409 });
    await expect(deleteWorldVersion(pool, second.created.id, first.version.worldVersionId, request))
      .rejects.toMatchObject({ statusCode: 409 });

    const otherUser = await pool.query<{ id: string }>(
      "INSERT INTO users (display_name, status) VALUES ($1, 'active') RETURNING id",
      [`Synthetic Other Owner ${crypto.randomUUID()}`]
    );
    const otherWorld = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id, title, status) VALUES ($1,$2,'active') RETURNING id",
      [otherUser.rows[0]!.id, `Synthetic Other World ${crypto.randomUUID()}`]
    );
    const otherVersion = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id, owner_user_id, version_number, content)
       VALUES ($1,$2,1,$3) RETURNING id`,
      [otherWorld.rows[0]!.id, otherUser.rows[0]!.id, JSON.stringify(content("Other Owner", "One"))]
    );

    await expect(deleteWorldVersion(pool, otherWorld.rows[0]!.id, otherVersion.rows[0]!.id, request))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects stale draft writes", async () => {
    const title = `Synthetic World Stale ${crypto.randomUUID()}`;
    const created = await createWorld(pool, worldCreateSchema.parse({ title }));
    await updateWorldDraft(pool, created.id, worldDraftUpdateSchema.parse({ expectedRevision: 1, content: content(title, "One") }));
    await expect(updateWorldDraft(pool, created.id, worldDraftUpdateSchema.parse({ expectedRevision: 1, content: content(title, "Two") })))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it("keeps campaigns pinned until an explicit audited migration", async () => {
    const world = await publishedWorld("Migration");
    const campaign = await createCampaign(pool, campaignCreateSchema.parse({
      title: `Synthetic Campaign ${crypto.randomUUID()}`,
      worldVersionId: world.version.worldVersionId
    }));
    const detail = await getWorld(pool, world.created.id);
    const saved = await updateWorldDraft(pool, world.created.id, worldDraftUpdateSchema.parse({
      expectedRevision: detail.draftRevision,
      content: content(world.title, "Two")
    }));
    const second = await publishWorld(pool, world.created.id, worldPublishSchema.parse({ expectedRevision: saved.revision }));
    const ownerUserId = await initialOwnerId(pool);
    const provider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles (
         owner_user_id, name, provider_type, provider_role, base_url, default_model
       ) VALUES ($1,$2,'lmstudio','text','http://provider.invalid','synthetic-model') RETURNING id`,
      [ownerUserId, `Synthetic migration provider ${crypto.randomUUID()}`]
    );
    await pool.query(
      `INSERT INTO model_chains (
         owner_user_id, campaign_id, world_version_id, provider_profile_id, model,
         endpoint_identity, prompt_protocol_version, context_fingerprint, previous_response_id
       ) VALUES ($1,$2,$3,$4,'synthetic-model','synthetic-endpoint','synthetic-protocol','synthetic-context','synthetic-response')`,
      [ownerUserId, campaign.id, world.version.worldVersionId, provider.rows[0]!.id]
    );
    const before = (await listCampaigns(pool)).find((item: any) => item.id === campaign.id);
    expect(before).toMatchObject({ worldVersionNumber: 1, latestWorldVersionNumber: 2, worldUpdateAvailable: true });
    const characterBefore = await pool.query<{ character_snapshot: unknown }>("SELECT character_snapshot FROM campaigns WHERE id = $1", [campaign.id]);
    const migrated = await migrateCampaignWorld(pool, campaign.id, campaignWorldMigrationSchema.parse({
      worldVersionId: second.worldVersionId,
      note: "Synthetic migration"
    }));
    expect(migrated.worldVersionNumber).toBe(2);
    const characterAfter = await pool.query<{ character_snapshot: unknown }>("SELECT character_snapshot FROM campaigns WHERE id = $1", [campaign.id]);
    expect(characterAfter.rows[0]?.character_snapshot).toEqual(characterBefore.rows[0]?.character_snapshot);
    const audit = await pool.query("SELECT * FROM campaign_world_migrations WHERE campaign_id = $1", [campaign.id]);
    expect(audit.rows).toHaveLength(1);
    const turns = await pool.query("SELECT id FROM turns WHERE campaign_id = $1", [campaign.id]);
    expect(turns.rows).toHaveLength(0);
    const chains = await pool.query<{ active: boolean }>("SELECT active FROM model_chains WHERE campaign_id = $1", [campaign.id]);
    expect(chains.rows).toEqual([{ active: false }]);
  });

  it("persists and exports the authoritative campaign story-length profile", async () => {
    const world = await publishedWorld("Story Length");
    const campaign = await createCampaign(pool, campaignCreateSchema.parse({
      title: `Synthetic Length Campaign ${crypto.randomUUID()}`,
      worldVersionId: world.version.worldVersionId,
      storyLengthProfile: "long"
    }));
    expect(campaign.storyLengthProfile).toBe("long");
    expect((await listCampaigns(pool)).find((item: any) => item.id === campaign.id)?.storyLengthProfile).toBe("long");

    const updated = await updateCampaign(pool, campaign.id, campaignUpdateSchema.parse({ storyLengthProfile: "extended" }));
    expect(updated.storyLengthProfile).toBe("extended");
    const exported = await exportCampaign(pool, campaign.id);
    expect(exported.settings.storyLength).toBe("extended");
  });

  it("creates isolated campaign character snapshots from one multi-character world version", async () => {
    const title = `Synthetic Roster World ${crypto.randomUUID()}`;
    const rosterContent = worldContentSchema.parse({
      schemaVersion: WORLD_CONTENT_SCHEMA_VERSION,
      world: { title },
      rpgStats: [{ id: "shared-stat", name: "Shared stat", value: 50, note: "" }],
      defaultTriggers: [{ id: "shared-tracker", name: "Shared tracker", rules: "Track it.", value: "Initial" }],
      playableCharacters: [
        {
          id: "first-character",
          name: "First Character",
          characterText: "First character canon.",
          rpgStats: [{ id: "first-stat", name: "First stat", value: 60, note: "" }],
          defaultTriggers: [{ id: "first-tracker", name: "First tracker", rules: "Track it.", value: "First" }]
        },
        {
          id: "second-character",
          name: "Second Character",
          characterText: "Second character canon.",
          rpgStats: [{ id: "second-stat", name: "Second stat", value: 70, note: "" }],
          defaultTriggers: [{ id: "second-tracker", name: "Second tracker", rules: "Track it.", value: "Second" }]
        }
      ]
    });
    const created = await createWorld(pool, worldCreateSchema.parse({ title, content: rosterContent }));
    const published = await publishWorld(pool, created.id, worldPublishSchema.parse({ expectedRevision: created.draftRevision }));
    expect(await listWorldVersionPlayableCharacters(pool, published.worldVersionId)).toMatchObject([
      { id: "first-character", name: "First Character" },
      { id: "second-character", name: "Second Character" }
    ]);
    await expect(createCampaign(pool, campaignCreateSchema.parse({
      title: `Missing Selection ${crypto.randomUUID()}`,
      worldVersionId: published.worldVersionId
    }))).rejects.toMatchObject({ statusCode: 400 });

    const first = await createCampaign(pool, campaignCreateSchema.parse({
      title: `First Campaign ${crypto.randomUUID()}`,
      worldVersionId: published.worldVersionId,
      selectedCharacterId: "first-character"
    }));
    const second = await createCampaign(pool, campaignCreateSchema.parse({
      title: `Second Campaign ${crypto.randomUUID()}`,
      worldVersionId: published.worldVersionId,
      selectedCharacterId: "second-character"
    }));
    const rows = await pool.query<any>(
      `SELECT c.id, c.selected_character_id, c.character_snapshot, cs.rpg_stats, cs.default_triggers
         FROM campaigns c JOIN campaign_state cs ON cs.campaign_id = c.id AND cs.owner_user_id = c.owner_user_id
        WHERE c.id = ANY($1::uuid[]) ORDER BY c.selected_character_id`,
      [[first.id, second.id]]
    );
    expect(rows.rows[0]).toMatchObject({ selected_character_id: "first-character", character_snapshot: { characterText: "First character canon." } });
    expect(JSON.stringify(rows.rows[0].rpg_stats)).toContain("first-stat");
    expect(JSON.stringify(rows.rows[0].rpg_stats)).not.toContain("second-stat");
    expect(rows.rows[1]).toMatchObject({ selected_character_id: "second-character", character_snapshot: { characterText: "Second character canon." } });

    // Simulate a historical version that still carries the retired overview key.
    await pool.query(
      "UPDATE world_versions SET content = jsonb_set(content, '{world,character}', to_jsonb($2::text), true) WHERE id = $1",
      [published.worldVersionId, "Historical default that must not override the campaign snapshot."]
    );

    const firstContext = await buildContextPreview(pool, first.id, { budgetTokens: 8000, compression: "auto", recentTurns: 4, query: "begin" });
    const secondContext = await buildContextPreview(pool, second.id, { budgetTokens: 8000, compression: "auto", recentTurns: 4, query: "begin" });
    expect(firstContext.scopes.worldCanon.character).toBe("First character canon.");
    expect(secondContext.scopes.worldCanon.character).toBe("Second character canon.");
    expect((await exportCampaign(pool, first.id)).world.character).toBe("First character canon.");
    expect((await exportCampaign(pool, second.id)).world.character).toBe("Second character canon.");

    const portableCampaign = await exportCampaign(pool, second.id);
    portableCampaign.world.title = `Roundtrip Character ${crypto.randomUUID()}`;
    const roundtrip = await importLegacyStory(pool, storyImportRequestSchema.parse({
      sourceName: "synthetic-character-roundtrip.story",
      story: portableCampaign
    }));
    const roundtripCampaign = await pool.query<{ selected_character_id: string; character_snapshot: any }>(
      "SELECT selected_character_id, character_snapshot FROM campaigns WHERE id = $1",
      [roundtrip.campaignId]
    );
    expect(roundtripCampaign.rows[0]).toMatchObject({
      selected_character_id: "second-character",
      character_snapshot: { characterText: "Second character canon." }
    });
  });

  it("publishes incomplete drafts but rejects campaign creation until a playable character exists", async () => {
    const title = `Synthetic Incomplete World ${crypto.randomUUID()}`;
    const created = await createWorld(pool, worldCreateSchema.parse({ title }));
    const published = await publishWorld(pool, created.id, worldPublishSchema.parse({ expectedRevision: created.draftRevision }));

    expect(await listWorldVersionPlayableCharacters(pool, published.worldVersionId)).toEqual([]);
    expect(await getWorldVersionPlayableCharacterSummary(pool, published.worldVersionId)).toMatchObject({
      characters: [],
      readiness: {
        ready: false,
        issues: [{ code: "no-playable-characters" }]
      }
    });
    await expect(createCampaign(pool, campaignCreateSchema.parse({
      title: `Unavailable Campaign ${crypto.randomUUID()}`,
      worldVersionId: published.worldVersionId
    }))).rejects.toMatchObject({
      statusCode: 400,
      message: "This world version has no playable characters."
    });
  });

  it("forks a selected immutable version into an independent draft", async () => {
    const source = await publishedWorld("Fork");
    const forkTitle = `Synthetic Fork ${crypto.randomUUID()}`;
    const fork = await forkWorld(pool, source.created.id, worldForkSchema.parse({
      title: forkTitle,
      sourceWorldVersionId: source.version.worldVersionId
    }));
    const detail = await getWorld(pool, fork.worldId);
    expect(detail).toMatchObject({
      title: forkTitle,
      status: "draft",
      forkedFromWorldId: source.created.id,
      forkedFromWorldVersionId: source.version.worldVersionId,
      draftRevision: 1
    });
    expect(detail.draftContent.world.title).toBe(forkTitle);
    expect(detail.versions).toHaveLength(0);
  });

  it("previews and imports portable worlds idempotently", async () => {
    const source = await publishedWorld("Portable");
    const portable = await exportWorld(pool, source.created.id, source.version.worldVersionId);
    const request = worldImportRequestSchema.parse({
      sourceName: "synthetic-world.json",
      worldExport: {
        ...portable,
        content: { ...portable.content, providerMetadata: { apiKey: "test-credential-placeholder" } }
      }
    });
    const preview = await previewWorldImport(pool, request);
    expect(preview).toMatchObject({ kind: "world", duplicate: false, warnings: ["Credential-shaped fields will be removed before import."] });
    const imported = await importWorld(pool, request);
    const duplicate = await importWorld(pool, request);
    expect(duplicate).toMatchObject({ duplicate: true, worldId: imported.worldId, worldVersionId: imported.worldVersionId });
    const exported = await exportWorld(pool, imported.worldId, imported.worldVersionId);
    expect(JSON.stringify(exported)).not.toContain("test-credential-placeholder");
    expect(JSON.stringify(exported)).not.toContain("apiKey");
    expect(exported.content.world).not.toHaveProperty("character");
    expect(exported.content.schemaVersion).toBe(WORLD_CONTENT_SCHEMA_VERSION);
  });

  it("rejects portable worlds that depend only on retired character guidance", async () => {
    const title = `Synthetic Legacy Portable ${crypto.randomUUID()}`;
    const request = worldImportRequestSchema.parse({
      sourceName: "legacy-only-world.json",
      worldExport: {
        format: "infinite-quest-world",
        formatVersion: 1,
        title,
        content: {
          schemaVersion: 2,
          world: { title, character: "Legacy-only guidance that must not be silently discarded." }
        }
      }
    });

    await expect(previewWorldImport(pool, request)).rejects.toMatchObject({ statusCode: 400 });
    await expect(importWorld(pool, request)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("exports campaign state without provider settings or credentials", async () => {
    const world = await publishedWorld("Export");
    const campaign = await createCampaign(pool, campaignCreateSchema.parse({
      title: `Synthetic Export Campaign ${crypto.randomUUID()}`,
      worldVersionId: world.version.worldVersionId
    }));
    const ownerUserId = await initialOwnerId(pool);
    await pool.query(
      "UPDATE campaigns SET legacy_settings = $3 WHERE id = $1 AND owner_user_id = $2",
      [campaign.id, ownerUserId, JSON.stringify({ apiKey: "test-credential-placeholder", baseUrl: "https://provider.invalid" })]
    );
    await pool.query(
      `INSERT INTO turns (
         owner_user_id, campaign_id, turn_number, action, narration, model_metadata
       ) VALUES ($1,$2,1,'Synthetic Action','Synthetic Narration',$3)`,
      [ownerUserId, campaign.id, JSON.stringify({
        providerProfileId: crypto.randomUUID(),
        providerType: "lmstudio",
        model: "synthetic-model",
        responseId: "private-response-id",
        promptProtocolVersion: "synthetic-protocol"
      })]
    );
    const exported = await exportCampaign(pool, campaign.id);
    const serialized = JSON.stringify(exported);
    expect(exported).toMatchObject({
      format: "infinite-quest-campaign",
      formatVersion: 3,
      campaign: {
        sourceCampaignId: campaign.id,
        sourceWorldVersionId: world.version.worldVersionId,
        selectedCharacterId: expect.any(String),
        characterSnapshot: expect.any(Object),
        stateRevision: expect.any(Number)
      }
    });
    expect(serialized).not.toContain("test-credential-placeholder");
    expect(serialized).not.toContain("provider.invalid");
    expect(serialized).not.toContain("private-response-id");
    expect(serialized).not.toContain("providerProfileId");
    expect(serialized).toContain("synthetic-model");
  });

  it("rejects migration to a different world", async () => {
    const first = await publishedWorld("Boundary A");
    const second = await publishedWorld("Boundary B");
    const campaign = await createCampaign(pool, campaignCreateSchema.parse({
      title: `Synthetic Boundary Campaign ${crypto.randomUUID()}`,
      worldVersionId: first.version.worldVersionId
    }));
    await expect(migrateCampaignWorld(pool, campaign.id, campaignWorldMigrationSchema.parse({ worldVersionId: second.version.worldVersionId })))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it.skip("deletes campaigns before safely deleting their world", async () => {
    const world = await publishedWorld("Delete");
    const campaignTitle = `Synthetic Delete Campaign ${crypto.randomUUID()}`;
    const campaign = await createCampaign(pool, campaignCreateSchema.parse({
      title: campaignTitle,
      worldVersionId: world.version.worldVersionId
    }));

    await expect(deleteWorld(pool, world.created.id, resourceDeleteSchema.parse({
      confirmation: "DELETE",
      expectedTitle: world.title
    }))).rejects.toMatchObject({ statusCode: 409 });

    await expect(deleteCampaign(pool, campaign.id, resourceDeleteSchema.parse({
      confirmation: "DELETE",
      expectedTitle: "Wrong title"
    }))).rejects.toMatchObject({ statusCode: 409 });

    await deleteCampaign(pool, campaign.id, resourceDeleteSchema.parse({
      confirmation: "DELETE",
      expectedTitle: campaignTitle
    }));
    await deleteWorld(pool, world.created.id, resourceDeleteSchema.parse({
      confirmation: "DELETE",
      expectedTitle: world.title
    }));

    expect((await pool.query("SELECT id FROM campaigns WHERE id = $1", [campaign.id])).rows).toHaveLength(0);
    expect((await pool.query("SELECT id FROM worlds WHERE id = $1", [world.created.id])).rows).toHaveLength(0);
    expect((await pool.query("SELECT id FROM world_versions WHERE world_id = $1", [world.created.id])).rows).toHaveLength(0);
  });
});
