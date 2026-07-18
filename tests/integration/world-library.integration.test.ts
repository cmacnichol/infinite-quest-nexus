import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import {
  campaignCreateSchema,
  campaignWorldMigrationSchema,
  worldContentSchema,
  worldCreateSchema,
  worldDraftUpdateSchema,
  worldForkSchema,
  worldImportRequestSchema,
  worldPublishSchema
} from "../../packages/contracts/src/world-library.js";
import {
  createCampaign,
  createWorld,
  exportCampaign,
  exportWorld,
  forkWorld,
  getWorld,
  importWorld,
  listCampaigns,
  migrateCampaignWorld,
  previewWorldImport,
  publishWorld,
  updateWorldDraft
} from "../../services/api/src/world-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

function content(title: string, marker: string) {
  return worldContentSchema.parse({
    schemaVersion: 2,
    world: {
      title,
      genre: "test",
      tone: "neutral",
      premise: `Premise ${marker}`,
      backgroundStory: `Background ${marker}`,
      character: `Character ${marker}`,
      firstAction: `Action ${marker}`,
      rules: `Rules ${marker}`
    }
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
    const migrated = await migrateCampaignWorld(pool, campaign.id, campaignWorldMigrationSchema.parse({
      worldVersionId: second.worldVersionId,
      note: "Synthetic migration"
    }));
    expect(migrated.worldVersionNumber).toBe(2);
    const audit = await pool.query("SELECT * FROM campaign_world_migrations WHERE campaign_id = $1", [campaign.id]);
    expect(audit.rows).toHaveLength(1);
    const turns = await pool.query("SELECT id FROM turns WHERE campaign_id = $1", [campaign.id]);
    expect(turns.rows).toHaveLength(0);
    const chains = await pool.query<{ active: boolean }>("SELECT active FROM model_chains WHERE campaign_id = $1", [campaign.id]);
    expect(chains.rows).toEqual([{ active: false }]);
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
    expect(exported).toMatchObject({ format: "infinite-quest-campaign", formatVersion: 1 });
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
});
