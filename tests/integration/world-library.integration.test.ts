import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createPostgresCampaignCastRepository } from "../../packages/database/src/campaign-cast-repository.js";
import { buildEditorPayload, createEditorDraft, discardEditorOrganize, reapplyEditorDraft, setEditorDraftField, stageEditorOrganize } from "../../packages/client-core/src/characters/editor-model.js";
import { buildServer } from "../../services/api/src/server.js";
import { runtimeConfigFixture } from "../fixtures/instance-settings.js";
import { inertStorageServerOptions } from "../helpers/build-server-options.js";
import { createApiWorldCampaignApplication } from "../helpers/runtime-application-fixtures.js";
import { exportCampaign } from "../legacy-api/src/campaign-archive-service.js";
import {
  campaignCreateSchema,
  campaignCharacterProfileUpdateSchema,
  campaignUpdateSchema,
  campaignWorldMigrationSchema,
  resourceDeleteSchema,
  WORLD_CONTENT_SCHEMA_VERSION,
  characterProfileSchema,
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
  organizeCampaignCharacterProfileForOwner,
  organizeWorldCharacterProfileForOwner
} from "../../services/runtime/src/provider-character-organization-adapter.js";
import { campaignTransferCommitRequestSchema, campaignTransferPreviewRequestSchema } from "../../packages/contracts/src/campaign-transfer.js";
import {
  createWorld,
  deleteCampaign,
  deleteWorld,
  deleteWorldVersion,
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
} from "../helpers/memory-aware-services.js";
import {
  branchCampaign,
  buildContextPreview,
  createCampaign,
  getCampaignCharacterProfile,
  importLegacyStory,
  previewCampaignWorldTransfer,
  rewindCampaign,
  transferCampaignWorld,
  updateCampaignCharacterProfile
} from "../helpers/memory-aware-services.js";

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
      expectedRevision: detail.draftRevision!,
      content: content(title, marker)
    }));
    return publishWorld(pool, worldId, worldPublishSchema.parse({
      expectedRevision: saved.revision,
      releaseNotes: `Synthetic version ${marker}`
    }));
  }

  it("creates starting cast atomically and rejects invalid selections", async () => {
    const title = `Starting cast ${crypto.randomUUID()}`;
    const draft = content(title, "One");
    draft.playableCharacters.push(
      { ...draft.playableCharacters[0]!, id: "support-a", name: "Ally", campaignUse: "supporting", profile: characterProfileSchema.parse({ identity: { aliases: ["Score 9"] }, story: { role: "Original role" } }) },
      { ...draft.playableCharacters[0]!, id: "support-b", name: "Friend", campaignUse: "both" }
    );
    const world = await createWorld(pool, worldCreateSchema.parse({ title, content: draft }));
    const version = await publishWorld(pool, world.id, worldPublishSchema.parse({ expectedRevision: world.draftRevision }));
    const enabled = createApiWorldCampaignApplication(pool, { credentialSecret: "integration-test-credential-secret", castPresetsEnabled: true });
    const disabled = createApiWorldCampaignApplication(pool, { credentialSecret: "integration-test-credential-secret" });
    const request = campaignCreateSchema.parse({ worldVersionId: version.worldVersionId, title: "Cast", selectedCharacterId: draft.playableCharacters[0]!.id,
      startingCast: [{ characterId: "support-a" }, { characterId: "support-b", alwaysInContext: true }] });
    const scope = { ownerUserId: await initialOwnerId(pool) };
    await expect(disabled.createCampaign(scope, request)).rejects.toMatchObject({ reason: "cast_presets_disabled" });
    for (const startingCast of [[{ characterId: "missing", alwaysInContext: false }], [{ characterId: "support-a", alwaysInContext: false }, { characterId: "support-a", alwaysInContext: false }], [{ characterId: draft.playableCharacters[0]!.id, alwaysInContext: false }]]) {
      await expect(enabled.createCampaign(scope, { ...request, startingCast })).rejects.toMatchObject({ kind: "invalid_request" });
    }
    // A failure on the second seed must roll back the campaign and first seed too.
    const functionName = `test_fail_cast_${crypto.randomUUID().replaceAll("-", "")}`;
    await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.idempotency_key LIKE '%:support-b' THEN RAISE EXCEPTION 'injected seed failure'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER ${functionName} BEFORE INSERT ON campaign_cast_events FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
    try {
      await expect(enabled.createCampaign(scope, request)).rejects.toThrow();
      expect((await pool.query("SELECT id FROM campaigns WHERE world_version_id=$1 AND title=$2", [version.worldVersionId, request.title])).rows).toHaveLength(0);
    } finally {
      await pool.query(`DROP TRIGGER ${functionName} ON campaign_cast_events`);
      await pool.query(`DROP FUNCTION ${functionName}()`);
    }
    const campaign = await enabled.createCampaign(scope, request);
    expect(campaign.skippedStartingCast).toEqual([{ characterId: "support-a", name: "Ally", aliases: ["Score 9"], reason: "invalid_alias" }]);
    const events = await pool.query("SELECT idempotency_key, payload FROM campaign_cast_events WHERE campaign_id=$1 ORDER BY sequence", [campaign.id]);
    expect(events.rows).toHaveLength(2);
    expect(events.rows.map((row) => row.idempotency_key)).toEqual([`campaign-seed:${campaign.id}:support-a`, `campaign-seed:${campaign.id}:support-b`]);
    expect(events.rows[1].payload.some((item: { command: { kind: string } }) => item.command.kind === "pin")).toBe(true);
    const second = await enabled.createCampaign(scope, { ...request, title: "Second cast" });
    const storedSeed = async (id: string) => (await pool.query("SELECT payload FROM campaign_cast_events WHERE campaign_id=$1 AND idempotency_key=$2", [id, `campaign-seed:${id}:support-a`])).rows[0].payload;
    const firstSeed = await storedSeed(campaign.id), secondSeed = await storedSeed(second.id);
    expect(firstSeed.find((item: { command: { kind: string } }) => item.command.kind === "seed_profile").command.profile.story.role).toBe("Original role");
    expect(firstSeed.find((item: { command: { kind: string } }) => item.command.kind === "seed_profile").command.rosterAliases).toEqual([]);
    expect(secondSeed.find((item: { command: { kind: string } }) => item.command.kind === "seed_profile").command.profile.story.role).toBe("Original role");
    const updated = structuredClone(draft);
    updated.playableCharacters[1]!.profile!.story.role = "New draft role";
    await updateWorldDraft(pool, world.id, worldDraftUpdateSchema.parse({ expectedRevision: (await getWorld(pool, world.id)).draftRevision, content: updated }));
    expect(await storedSeed(campaign.id)).toEqual(firstSeed);
    expect(await storedSeed(second.id)).toEqual(secondSeed);
    const pinned = (await pool.query("SELECT content FROM world_versions WHERE id=$1", [version.worldVersionId])).rows[0].content;
    expect(pinned.playableCharacters[1].profile.story.role).toBe("Original role");
    const editor = createPostgresCampaignCastRepository(pool, { editingEnabled: true, castPresetsEnabled: true });
    const firstScope = { ...scope, campaignId: campaign.id }, secondScope = { ...scope, campaignId: second.id };
    const first = await editor.current(firstScope), ally = first.characters.find(person => person.name === "Ally")!;
    await editor.editAuthoredProfile!(firstScope, ally.id, { expectedCastRevision: first.revision, expectedBoundary: first.boundary,
      expectedCharacterRevision: ally.revision, idempotencyKey: "edit-first-only", set: { "story.background": "First campaign edit" }, reset: [] });
    const otherAlly = (await editor.current(secondScope)).characters.find(person => person.name === "Ally")!;
    expect(otherAlly.campaignProfile?.story.background).not.toBe("First campaign edit");
    expect(otherAlly.originProfile?.legacyCharacterText).toBe(draft.playableCharacters[0]!.characterText);
    expect((await getWorldVersionPlayableCharacterSummary(pool, version.worldVersionId)).startingCastCandidates.find(person => person.id === "support-a")?.name).toBe("Ally");
    const publishedContent = (await pool.query("SELECT content FROM world_versions WHERE id=$1", [version.worldVersionId])).rows[0].content;
    expect(publishedContent.playableCharacters.find((person: { id: string }) => person.id === "support-a").characterText).toBe(draft.playableCharacters[0]!.characterText);
  });

  it("uses the roster entry rather than a same-ID generic entity when reporting starting-cast aliases", async () => {
    const title = `Roster identity ${crypto.randomUUID()}`, draft = content(title, "One");
    draft.playableCharacters.push({ ...draft.playableCharacters[0]!, id: "ally", name: "Ally", campaignUse: "supporting",
      profile: characterProfileSchema.parse({ identity: { aliases: ["Guide", "Score: 12"] } }) });
    draft.entities.push({ id: "ally", name: "Ally", kind: "character", aliases: ["Other"] });
    const world = await createWorld(pool, worldCreateSchema.parse({ title, content: draft }));
    const version = await publishWorld(pool, world.id, worldPublishSchema.parse({ expectedRevision: world.draftRevision }));
    const app = createApiWorldCampaignApplication(pool, { credentialSecret: "integration-test-credential-secret", castPresetsEnabled: true });
    const created = await app.createCampaign({ ownerUserId: await initialOwnerId(pool) }, campaignCreateSchema.parse({ worldVersionId: version.worldVersionId,
      title: "Roster identity", selectedCharacterId: draft.playableCharacters[0]!.id, startingCast: [{ characterId: "ally" }] }));
    expect(created.skippedStartingCast).toEqual([{ characterId: "ally", name: "Ally", aliases: ["Score: 12"], reason: "invalid_alias" }]);
    const events = await pool.query("SELECT payload FROM campaign_cast_events WHERE campaign_id=$1", [created.id]);
    expect(events.rows[0].payload[0].command.aliases).toEqual(["Guide"]);
  });

  it.runIf(process.env.NEXUS_CAST_BROWSER_PROOF === "1")("edits a real seeded cast from the campaign page", async ({ onTestFinished }) => {
    const { chromium, expect: browserExpect } = await import("@playwright/test");
    const { createCampaignCastApplication } = await import("../../packages/application/src/campaign-cast/use-cases.js");
    const { createPostgresCampaignCastRepository } = await import("../../packages/database/src/campaign-cast-repository.js");
    const title = `Browser cast ${crypto.randomUUID()}`;
    const authored = content(title, "One");
    authored.playableCharacters.push({ ...authored.playableCharacters[0]!, id: "browser-ally", name: "Browser Ally", campaignUse: "supporting",
      profile: characterProfileSchema.parse({ story: { role: "World guide", goals: "World goal" } }) },
      { ...authored.playableCharacters[0]!, id: "browser-invalid", name: "Score 9", campaignUse: "supporting" },
      { ...authored.playableCharacters[0]!, id: "browser-keeper", name: "Browser Keeper", campaignUse: "supporting", startingCastDefault: false,
        profile: characterProfileSchema.parse({ story: { role: "World keeper" } }) });
    const world = await createWorld(pool, worldCreateSchema.parse({ title, content: authored }));
    const published = await publishWorld(pool, world.id, worldPublishSchema.parse({ expectedRevision: world.draftRevision }));
    const config = { ...runtimeConfigFixture(), databaseUrl: databaseUrl!, role: "api" as const,
      castEditingEnabled: true, castPresetsEnabled: true, castContextEnabled: true, storyMemoryCapability: "r3" as const,
      legacyWebRoot: resolve("apps/web/dist"), nextWebRoot: resolve("apps/web-next/dist") };
    const cast = createCampaignCastApplication(createPostgresCampaignCastRepository(pool, { editingEnabled: true, castPresetsEnabled: true, castContextEnabled: true, storyMemoryCapability: "r3" }));
    const server = await buildServer({ ...inertStorageServerOptions({ pool, config,
      worldCampaign: createApiWorldCampaignApplication(pool, { credentialSecret: config.credentialEncryptionKey, castPresetsEnabled: true }) }), cast });
    const origin = await server.listen({ host: "127.0.0.1", port: 0 });
    onTestFinished(() => server.close());
    const browser = await chromium.launch();
    onTestFinished(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const webOrigin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
    const screenshotRoot = resolve(process.env.CAST_SCREENSHOT_ROOT ?? "docs/review/assets/unified-character-editor-phase-4");
    await page.route("**/api/v1/**", async route => {
      const requestUrl = new URL(route.request().url());
      const response = await route.fetch({ url: `${origin}${requestUrl.pathname}${requestUrl.search}`, headers: { ...route.request().headers(), origin } });
      await route.fulfill({ response });
    });
    await page.route("**/story/**", async route => {
      const html = await (await import("node:fs/promises")).readFile(resolve("apps/web/public/story.html"), "utf8");
      await route.fulfill({ contentType: "text/html", body: html.replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts") });
    });
    await page.goto(`${webOrigin}/nexus/index.html#world-library`);
    await page.locator("#worldManagementCarousel").getByRole("button", { name: `Select ${title}` }).click();
    await page.locator("#createCampaignModalBtn").click();
    await page.locator("#newCampaignTitle").fill("Browser cast campaign");
    await browserExpect(page.locator("#startingCastNotice")).toContainText("of 30");
    await browserExpect(page.locator("#startingCastList label").filter({ hasText: "Browser Ally" }).locator("input[type=checkbox]").first()).toBeChecked();
    const createdResponse = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/campaigns");
    await page.locator("#confirmCreateCampaign").click();
    expect((await createdResponse).status()).toBe(201);
    await browserExpect(page.locator("#createCampaignStatus")).toContainText("Score 9: character was skipped");
    await browserExpect(page.locator("#openCommittedCampaign")).toBeVisible();
    await (await import("node:fs/promises")).mkdir(screenshotRoot, { recursive: true });
    await page.locator("#createCampaignStatus").scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(screenshotRoot, "skipped-result-1440.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#createCampaignStatus").scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(screenshotRoot, "skipped-result-390.png") });
    await page.setViewportSize({ width: 1440, height: 900 });
    const row = await pool.query<{ id: string }>("SELECT id FROM campaigns WHERE world_version_id=$1 AND title=$2", [published.worldVersionId, "Browser cast campaign"]);
    const campaignId = row.rows[0]!.id;
    await page.goto(`${webOrigin}/nexus/index.html?proof=cast#campaigns?campaignId=${campaignId}`);
    await browserExpect(page.locator(`#campaignList [data-campaign-id="${campaignId}"]`)).toBeVisible();
    await page.locator("#editCampaignCharacter").click();
    await page.locator("#campaignCastDialog").getByRole("button", { name: "Browser Ally", exact: true }).first().click();
    await page.locator("#campaignCastDialog").getByRole("button", { name: "Edit character", exact: true }).click();
    await page.locator("#cast-story-role").fill("Campaign guide");
    await page.locator("#cast-save").click();
    await browserExpect(page.locator("#campaignCastDialog")).toContainText("Campaign guide");
    const storyLink = page.locator("#campaignCastDialog").getByRole("link", { name: "Open in Story" });
    const href = await storyLink.getAttribute("href");
    expect(href).toMatch(new RegExp(`^/story/${campaignId}\\?character=[0-9a-f-]+$`));
    const ownerUserId = await initialOwnerId(pool);
    await pool.query("INSERT INTO turns (owner_user_id,campaign_id,turn_number,action,narration) VALUES ($1,$2,1,'Continue','A quiet moment passes.')", [ownerUserId, campaignId]);
    await pool.query("UPDATE campaigns SET active_turn_number=1 WHERE id=$1", [campaignId]);
    await storyLink.click();
    await browserExpect(page.locator("#campaignCastDialog")).toContainText("Browser Ally");
    await (await import("node:fs/promises")).mkdir(screenshotRoot, { recursive: true });
    await page.screenshot({ path: resolve(screenshotRoot, "story-deep-link-1440.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: resolve(screenshotRoot, "story-deep-link-390.png") });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${webOrigin}/nexus/index.html?proof=return#campaigns?campaignId=${campaignId}`);
    await page.locator("#editCampaignCharacter").click();
    await page.locator("#campaignCastDialog").getByRole("button", { name: "Browser Ally", exact: true }).first().click();
    await page.locator("#campaignCastDialog").getByRole("button", { name: "Edit character", exact: true }).click();
    await page.screenshot({ path: resolve(screenshotRoot, "reset-restore-controls-1440.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: resolve(screenshotRoot, "reset-restore-controls-390.png") });
    await page.locator("#cast-story-goals").locator("..").getByRole("button", { name: "Restore authored goals" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(screenshotRoot, "restore-goals-390.png") });
    await page.setViewportSize({ width: 1440, height: 900 });
    const roleRow = page.locator("#cast-story-role").locator("..");
    await roleRow.getByRole("button", { name: "Reset to world value" }).click();
    await browserExpect(page.locator("#cast-story-role")).toHaveValue("World guide");
    await page.locator("#cast-story-goals").fill("Campaign goal");
    await page.locator("#cast-save").click();
    await browserExpect(page.locator("#campaignCastDialog").getByRole("button", { name: "Edit character", exact: true })).toBeVisible();
    await browserExpect(page.locator("#campaignCastDialog")).toContainText("World guide");
    await page.locator("#campaignCastDialog").getByRole("button", { name: "Edit character", exact: true }).click();
    await page.locator("#cast-story-goals").locator("..").getByRole("button", { name: "Restore authored goals" }).click();
    await browserExpect(page.locator("#cast-story-goals")).toHaveValue("World goal");
    await page.locator("#cast-save").click();
    await browserExpect(page.locator("#campaignCastDialog").getByRole("button", { name: "Edit character", exact: true })).toBeVisible();
    await browserExpect(page.locator("#campaignCastDialog")).toContainText("World goal");
    const draft = await getWorld(pool, world.id);
    const nextDraft = await updateWorldDraft(pool, world.id, worldDraftUpdateSchema.parse({ expectedRevision: draft.draftRevision, content: { ...authored, world: { ...authored.world, premise: "Updated world premise" } } }));
    const nextVersion = await publishWorld(pool, world.id, worldPublishSchema.parse({ expectedRevision: nextDraft.revision }));
    await migrateCampaignWorld(pool, campaignId, campaignWorldMigrationSchema.parse({ worldVersionId: nextVersion.worldVersionId }));
    await rewindCampaign(pool, campaignId, { targetTurnNumber: 0 });
    await page.goto(`${webOrigin}/nexus/index.html?proof=migrated#campaigns?campaignId=${campaignId}`);
    await page.locator("#editCampaignCharacter").click();
    await page.locator("#campaignCastDialog").getByRole("button", { name: "Browser Ally", exact: true }).first().click();
    await browserExpect(page.locator("#campaignCastDialog")).toContainText("World goal");
    await (await import("node:fs/promises")).mkdir(screenshotRoot, { recursive: true });
    await page.screenshot({ path: resolve(screenshotRoot, "campaign-cast-1440.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: resolve(screenshotRoot, "campaign-cast-390.png") });
    // Apply an unselected world profile to an existing same-name campaign record.
    const editor = createPostgresCampaignCastRepository(pool, { editingEnabled: true, castPresetsEnabled: true });
    const scope = { ownerUserId, campaignId };
    const beforeManual = await editor.current(scope);
    const manual = await editor.create(scope, { name: "Browser Keeper", aliases: [], profile: {},
      expectedCastRevision: beforeManual.revision, expectedBoundary: beforeManual.boundary, idempotencyKey: crypto.randomUUID() });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator("#campaignCastDialog").getByRole("button", { name: "Back to characters", exact: true }).click();
    await page.locator("#campaignCastDialog").getByRole("button", { name: "Add from world", exact: true }).click();
    await page.getByLabel("World character").selectOption("browser-keeper");
    await page.locator("#campaignCastDialog").getByRole("button", { name: `Browser Keeper · ${manual.character.id}` }).click();
    await browserExpect(page.locator("#campaignCastDialog")).toContainText("World keeper");
    await page.screenshot({ path: resolve(screenshotRoot, "apply-preview-1440.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: resolve(screenshotRoot, "apply-preview-390.png") });
    const applyResponse = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/v1/campaigns/${campaignId}/cast/from-world`);
    await page.locator("#campaignCastDialog").getByRole("button", { name: "Apply world profile to Browser Keeper" }).click();
    expect((await applyResponse).status()).toBe(200);
    await browserExpect(page.locator("#campaignCastDialog").getByRole("button", { name: "Edit character", exact: true })).toBeVisible();
    await browserExpect(page.locator("#campaignCastDialog")).toContainText("World keeper");
    const after = await editor.detail(scope, manual.character.id);
    expect(after.character.id).toBe(manual.character.id);
    expect(after.character.campaignProfile?.story.role).toBe("World keeper");
    expect((await editor.current(scope)).characters.filter(person => person.name === "Browser Keeper")).toHaveLength(1);
    await page.unrouteAll({ behavior: "wait" });
  }, 60_000);

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

  it("ignores browser-supplied world id and owner identity on creation", async () => {
    const spoofedWorldId = crypto.randomUUID();
    const spoofedOwner = await pool.query<{ id: string }>(
      "INSERT INTO users (display_name, status) VALUES ($1, 'active') RETURNING id",
      [`Spoof target ${crypto.randomUUID()}`]
    );
    const spoofedOwnerUserId = spoofedOwner.rows[0]!.id;
    const created = await createWorld(pool, worldCreateSchema.parse({
      id: spoofedWorldId,
      ownerUserId: spoofedOwnerUserId,
      title: `Server-owned world ${crypto.randomUUID()}`
    }));
    const persisted = await pool.query<{ id: string; owner_user_id: string }>(
      "SELECT id, owner_user_id FROM worlds WHERE id = $1",
      [created.id]
    );

    expect(created.id).not.toBe(spoofedWorldId);
    expect(persisted.rows[0]).toEqual({
      id: created.id,
      owner_user_id: await initialOwnerId(pool)
    });
    expect(persisted.rows[0]?.owner_user_id).not.toBe(spoofedOwnerUserId);
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
    expect(world?.draftPreview).toMatchObject({
      genre: "test",
      premise: "Premise Unpublished",
      backgroundStory: "Background Unpublished",
      firstAction: "Action Unpublished"
    });
    expect(Object.keys(world?.draftPreview || {}).sort()).toEqual([
      "backgroundStory",
      "firstAction",
      "genre",
      "premise",
      "title",
      "tone"
    ]);
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
      expectedRevision: beforeAdd.draftRevision!,
      content: {
        ...beforeAdd.draftContent!,
        playableCharacters: [
          ...beforeAdd.draftContent!.playableCharacters,
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
    expect(added.revision).toBe(beforeAdd.draftRevision! + 1);

    const beforeEdit = await getWorld(pool, created.id);
    const editedCharacters = beforeEdit.draftContent!.playableCharacters.map((character: any) => character.id === "imported-character"
      ? { ...character, name: "Renamed Character", characterText: "Edited character guidance." }
      : character);
    const edited = await updateWorldDraft(pool, created.id, worldDraftUpdateSchema.parse({
      expectedRevision: beforeEdit.draftRevision!,
      content: { ...beforeEdit.draftContent!, playableCharacters: editedCharacters }
    }));
    expect(edited.revision).toBe(beforeEdit.draftRevision! + 1);

    const beforeDelete = await getWorld(pool, created.id);
    const deleted = await updateWorldDraft(pool, created.id, worldDraftUpdateSchema.parse({
      expectedRevision: beforeDelete.draftRevision!,
      content: {
        ...beforeDelete.draftContent!,
        playableCharacters: beforeDelete.draftContent!.playableCharacters.filter((character: any) => character.id !== "new-character")
      }
    }));
    expect(deleted.revision).toBe(beforeDelete.draftRevision! + 1);

    const draft = (await getWorld(pool, created.id)).draftContent;
    expect(draft!.playableCharacters).toHaveLength(1);
    expect(draft!.playableCharacters[0]).toMatchObject({
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

  it("assigns stable unique tracker IDs when creating a campaign from world defaults", async () => {
    const title = `Tracker defaults ${crypto.randomUUID()}`;
    const created = await createWorld(pool, worldCreateSchema.parse({
      title,
      content: {
        ...content(title, "Tracker"),
        defaults: {
          trackers: [
            { name: "Keeper trust", value: "wary", rules: "Update after honest exchanges." },
            { name: "Keeper trust", value: "unknown", rules: "A duplicate name must remain independently editable." }
          ]
        },
        playableCharacters: [{
          id: "tracker-keeper",
          name: "Tracker Keeper",
          characterText: "Keeps watch over campaign trackers."
        }]
      }
    }));
    const published = await publishWorld(pool, created.id, worldPublishSchema.parse({
      expectedRevision: created.draftRevision
    }));
    const campaign = await createCampaign(pool, campaignCreateSchema.parse({
      title: `Tracker campaign ${crypto.randomUUID()}`,
      worldVersionId: published.worldVersionId,
      selectedCharacterId: "tracker-keeper"
    }));

    const state = await pool.query<{ trackers: unknown }>(
      "SELECT trackers FROM campaign_state WHERE campaign_id = $1",
      [campaign.id]
    );
    expect(state.rows[0]?.trackers).toEqual([
      expect.objectContaining({ id: "Keeper trust", name: "Keeper trust" }),
      expect.objectContaining({ id: "Keeper trust-2", name: "Keeper trust" })
    ]);
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

  it("rejects deletion of a version retained by campaign transfer history", async () => {
    const source = await publishedWorld("Delete Transfer History Source");
    const target = await publishedWorld("Delete Transfer History Target");
    const campaignTitle = `Synthetic Transfer Blocker ${crypto.randomUUID()}`;
    const campaign = await createCampaign(pool, campaignCreateSchema.parse({
      title: campaignTitle,
      worldVersionId: source.version.worldVersionId,
      storyContextBudgetTokens: 1_000_000
    }));
    const previewRequest = campaignTransferPreviewRequestSchema.parse({
      targetWorldVersionId: target.version.worldVersionId
    });
    const preview = await previewCampaignWorldTransfer(pool, campaign.id, previewRequest);
    const transferred = await transferCampaignWorld(pool, campaign.id, campaignTransferCommitRequestSchema.parse({
      ...previewRequest,
      idempotencyKey: crypto.randomUUID(),
      expectedActiveTurnNumber: preview.expectedActiveTurnNumber,
      expectedStateRevision: preview.expectedStateRevision,
      sourceFingerprint: preview.sourceFingerprint
    }));
    const targetCampaign = await pool.query<{ title: string; story_context_budget_tokens: number }>(
      "SELECT title, story_context_budget_tokens FROM campaigns WHERE id = $1",
      [transferred.targetCampaignId]
    );
    expect(targetCampaign.rows[0]?.story_context_budget_tokens).toBe(1_000_000);

    await deleteCampaign(pool, campaign.id, resourceDeleteSchema.parse({ confirmation: "DELETE", expectedTitle: campaignTitle }));
    await deleteCampaign(pool, transferred.targetCampaignId, resourceDeleteSchema.parse({
      confirmation: "DELETE",
      expectedTitle: targetCampaign.rows[0]!.title
    }));

    await expect(deleteWorldVersion(
      pool,
      source.created.id,
      source.version.worldVersionId,
      worldVersionDeleteSchema.parse({ confirmation: "DELETE", expectedVersionNumber: 1 })
    )).rejects.toMatchObject({
      statusCode: 409,
      details: { code: "deletion_blocked", blockers: ["campaign_transfers:1"] }
    });
  });

  it("rejects deletion of a version retained by Chronicle memory", async () => {
    const source = await publishedWorld("Delete Chronicle Memory");
    const target = await publishedWorld("Delete Chronicle Memory Target");
    const campaign = await createCampaign(pool, campaignCreateSchema.parse({
      title: `Synthetic Chronicle Blocker ${crypto.randomUUID()}`,
      worldVersionId: source.version.worldVersionId
    }));
    const ownerUserId = await initialOwnerId(pool);
    const turn = await pool.query<{ id: string }>(
      `INSERT INTO turns (owner_user_id, campaign_id, turn_number, action, narration)
       VALUES ($1,$2,1,'Synthetic action','Synthetic accepted narration') RETURNING id`,
      [ownerUserId, campaign.id]
    );
    await pool.query(
      `INSERT INTO chronicle_memories (
         owner_user_id, campaign_id, world_version_id, turn_id, memory_kind, ordinal, content,
         token_estimate, importance, entities, metadata
       ) VALUES ($1,$2,$3,$4,'turn_fiction',1,'Synthetic accepted narration',4,0.5,ARRAY[]::text[],'{}'::jsonb)`,
      [ownerUserId, campaign.id, source.version.worldVersionId, turn.rows[0]!.id]
    );
    await pool.query("UPDATE campaigns SET world_version_id = $2 WHERE id = $1", [campaign.id, target.version.worldVersionId]);

    await expect(deleteWorldVersion(
      pool,
      source.created.id,
      source.version.worldVersionId,
      worldVersionDeleteSchema.parse({ confirmation: "DELETE", expectedVersionNumber: 1 })
    )).rejects.toMatchObject({
      statusCode: 409,
      details: { code: "deletion_blocked", blockers: ["chronicle_memories:1"] }
    });
  });

  it("rejects deletion of a version retained by a model chain", async () => {
    const source = await publishedWorld("Delete Model Chain");
    const target = await publishedWorld("Delete Model Chain Target");
    const campaign = await createCampaign(pool, campaignCreateSchema.parse({
      title: `Synthetic Model Chain Blocker ${crypto.randomUUID()}`,
      worldVersionId: source.version.worldVersionId
    }));
    const ownerUserId = await initialOwnerId(pool);
    const provider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles (
         owner_user_id, name, provider_type, provider_role, base_url, default_model
       ) VALUES ($1,$2,'lmstudio','text','http://provider.invalid','synthetic-model') RETURNING id`,
      [ownerUserId, `Synthetic deletion provider ${crypto.randomUUID()}`]
    );
    await pool.query(
      `INSERT INTO model_chains (
         owner_user_id, campaign_id, world_version_id, provider_profile_id, model,
         endpoint_identity, prompt_protocol_version, context_fingerprint, previous_response_id
       ) VALUES ($1,$2,$3,$4,'synthetic-model','synthetic-endpoint','synthetic-protocol','synthetic-context','synthetic-response')`,
      [ownerUserId, campaign.id, source.version.worldVersionId, provider.rows[0]!.id]
    );
    await pool.query("UPDATE campaigns SET world_version_id = $2 WHERE id = $1", [campaign.id, target.version.worldVersionId]);

    await expect(deleteWorldVersion(
      pool,
      source.created.id,
      source.version.worldVersionId,
      worldVersionDeleteSchema.parse({ confirmation: "DELETE", expectedVersionNumber: 1 })
    )).rejects.toMatchObject({
      statusCode: 409,
      details: { code: "deletion_blocked", blockers: ["model_chains:1"] }
    });
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
      .rejects.toMatchObject({ statusCode: 400, details: { code: "invalid_transition" } });

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
    const exported = await exportCampaign(pool, campaign.id, null);
    expect(exported.settings.storyLength).toBe("extended");
  });

  it.each([false, true])("carries native first-appearance eligibility %s through an empty-cast branch and migration", async (enabled) => {
    const world = await publishedWorld("First appearance");
    const ownerUserId = await initialOwnerId(pool);
    const app = createApiWorldCampaignApplication(pool, { credentialSecret: "synthetic", castPresetsEnabled: enabled });
    const campaign = await app.createCampaign({ ownerUserId }, campaignCreateSchema.parse({
      title: "Synthetic root eligibility", worldVersionId: world.version.worldVersionId
    }));
    const branch = await branchCampaign(pool, campaign.id, { targetTurnNumber: 0, title: "Synthetic branch" });
    const second = await publishNextVersion(world.created.id, world.title, "Two");
    await migrateCampaignWorld(pool, campaign.id, campaignWorldMigrationSchema.parse({ worldVersionId: second.worldVersionId }));
    const rows = await pool.query("SELECT first_appearance_eligible FROM campaigns WHERE owner_user_id=$1 AND id=ANY($2::uuid[])",
      [ownerUserId, [campaign.id, branch.id]]);
    expect(rows.rows.map(row => row.first_appearance_eligible)).toEqual([enabled, enabled]);
  });

  it("persists the selected campaign Story context budget", async () => {
    const world = await publishedWorld("Story Context Budget");
    const campaign = await createCampaign(pool, campaignCreateSchema.parse({
      title: `Synthetic Context Campaign ${crypto.randomUUID()}`,
      worldVersionId: world.version.worldVersionId,
      storyContextBudgetTokens: 128_000
    }));

    expect(campaign.storyContextBudgetTokens).toBe(128_000);
    expect((await listCampaigns(pool)).find((item: any) => item.id === campaign.id)?.storyContextBudgetTokens).toBe(128_000);

    const updated = await updateCampaign(pool, campaign.id, campaignUpdateSchema.parse({
      storyContextBudgetTokens: 256_000
    }));

    expect(updated.storyContextBudgetTokens).toBe(256_000);
    expect((await listCampaigns(pool)).find((item: any) => item.id === campaign.id)?.storyContextBudgetTokens).toBe(256_000);
    expect((await exportCampaign(pool, campaign.id, null)).settings.storyContextBudgetTokens).toBe(256_000);
  });

  it("seeds, revisions, audits, exports, and prompts from an editable structured campaign profile", async () => {
    const title = `Synthetic Structured Character ${crypto.randomUUID()}`;
    const originalProfile = characterProfileSchema.parse({
      identity: { aliases: ["The Fox"], pronouns: "she/her" },
      story: {
        role: "Scout",
        personality: "Patient and watchful",
        goals: "Find the vanished road"
      },
      appearance: {
        eyes: "green",
        hair: "black braid",
        clothing: "weathered blue cloak"
      }
    });
    const created = await createWorld(pool, worldCreateSchema.parse({
      title,
      content: worldContentSchema.parse({
        schemaVersion: WORLD_CONTENT_SCHEMA_VERSION,
        world: { title, genre: "fantasy", premise: "The roads move after dusk." },
        playableCharacters: [{
          id: "mira",
          name: "Mira",
          characterText: "Original legacy source remains unchanged.",
          profile: originalProfile,
          importedExtension: { preserve: true }
        }]
      })
    }));
    const version = await publishWorld(pool, created.id, worldPublishSchema.parse({
      expectedRevision: created.draftRevision
    }));
    const campaign = await createCampaign(pool, campaignCreateSchema.parse({
      title: `Structured Campaign ${crypto.randomUUID()}`,
      worldVersionId: version.worldVersionId,
      selectedCharacterId: "mira"
    }));

    expect(await getCampaignCharacterProfile(pool, campaign.id)).toMatchObject({
      characterId: "mira",
      revision: 1,
      name: "Mira",
      profile: originalProfile,
      inheritedFromSnapshot: false,
      legacyCharacterText: "Original legacy source remains unchanged."
    });
    const origin = await pool.query<any>(
      "SELECT character_snapshot, character_profile, character_profile_revision FROM campaigns WHERE id = $1",
      [campaign.id]
    );
    expect(origin.rows[0]).toMatchObject({
      character_snapshot: {
        name: "Mira",
        profile: originalProfile,
        importedExtension: { preserve: true }
      },
      character_profile: { name: "Mira", profile: originalProfile },
      character_profile_revision: 1
    });

    const ownerUserId = await initialOwnerId(pool);
    const provider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles (
         owner_user_id, name, provider_type, provider_role, base_url, default_model
       ) VALUES ($1,$2,'lmstudio','text','http://provider.invalid','synthetic-model') RETURNING id`,
      [ownerUserId, `Structured profile provider ${crypto.randomUUID()}`]
    );
    await pool.query(
      `INSERT INTO model_chains (
         owner_user_id, campaign_id, world_version_id, provider_profile_id, model,
         endpoint_identity, prompt_protocol_version, context_fingerprint, previous_response_id
       ) VALUES ($1,$2,$3,$4,'synthetic-model','synthetic-endpoint','old-protocol','old-context','old-response')`,
      [ownerUserId, campaign.id, version.worldVersionId, provider.rows[0]!.id]
    );
    const editedProfile = characterProfileSchema.parse({
      ...originalProfile,
      story: { ...originalProfile.story, role: "Expedition leader" },
      appearance: { ...originalProfile.appearance, clothing: "dark green travel coat" }
    });
    const saved = await updateCampaignCharacterProfile(pool, campaign.id, campaignCharacterProfileUpdateSchema.parse({
      expectedRevision: 1,
      name: "Mira Vale",
      profile: editedProfile,
      editSource: "manual"
    }));
    expect(saved).toMatchObject({ revision: 2, name: "Mira Vale", profile: editedProfile });
    await expect(updateCampaignCharacterProfile(pool, campaign.id, campaignCharacterProfileUpdateSchema.parse({
      expectedRevision: 1,
      name: "Stale edit",
      profile: editedProfile,
      editSource: "manual"
    }))).rejects.toMatchObject({ statusCode: 409 });
    const activeJob = await pool.query<{ id: string }>(
      `INSERT INTO generation_jobs (
         owner_user_id, campaign_id, provider_profile_id, idempotency_key,
         expected_turn_number, action, status
       ) VALUES ($1,$2,$3,$4,1,'Synthetic action','queued') RETURNING id`,
      [ownerUserId, campaign.id, provider.rows[0]!.id, crypto.randomUUID()]
    );
    await expect(updateCampaignCharacterProfile(pool, campaign.id, campaignCharacterProfileUpdateSchema.parse({
      expectedRevision: 2,
      name: "Blocked edit",
      profile: editedProfile,
      editSource: "manual"
    }))).rejects.toMatchObject({ statusCode: 400, details: { code: "invalid_transition" } });
    await pool.query("UPDATE generation_jobs SET status = 'failed' WHERE id = $1", [activeJob.rows[0]!.id]);

    const audit = await pool.query<any>(
      `SELECT revision, edit_source, previous_profile, next_profile
         FROM campaign_character_profile_edits WHERE campaign_id = $1 ORDER BY revision`,
      [campaign.id]
    );
    expect(audit.rows).toMatchObject([
      { revision: 1, edit_source: "world_version_seed", previous_profile: null },
      {
        revision: 2,
        edit_source: "manual",
        previous_profile: { name: "Mira", profile: originalProfile },
        next_profile: { name: "Mira Vale", profile: editedProfile }
      }
    ]);
    expect(await pool.query("SELECT active FROM model_chains WHERE campaign_id = $1", [campaign.id]))
      .toMatchObject({ rows: [{ active: false }] });
    const current = await pool.query<any>(
      "SELECT character_snapshot, character_profile FROM campaigns WHERE id = $1",
      [campaign.id]
    );
    expect(current.rows[0].character_snapshot).toEqual(origin.rows[0].character_snapshot);
    expect(current.rows[0].character_profile).toEqual({ name: "Mira Vale", profile: editedProfile });

    const context = await buildContextPreview(pool, campaign.id, {
      budgetTokens: 8000,
      compression: "auto",
      recentTurns: 4,
      query: "begin"
    });
    expect(context.scopes.worldCanon.playerCharacter).toMatchObject({
      name: "Mira Vale",
      story: { role: "Expedition leader" },
      appearance: { clothing: "dark green travel coat" }
    });
    expect(JSON.stringify(context.scopes.worldCanon.playerCharacter)).not.toContain("Original legacy source");

    const exported = await exportCampaign(pool, campaign.id, null);
    expect(exported.campaign).toMatchObject({
      selectedCharacterId: "mira",
      characterProfile: { name: "Mira Vale", profile: editedProfile },
      characterProfileRevision: 2
    });
    expect(exported.world.character).toContain("Mira Vale");
    expect(exported.world.character).toContain("dark green travel coat");

    const nextVersion = await publishNextVersion(created.id, title, "Two");
    await migrateCampaignWorld(pool, campaign.id, campaignWorldMigrationSchema.parse({
      worldVersionId: nextVersion.worldVersionId,
      note: "Retain edited campaign profile"
    }));
    expect(await pool.query(
      "SELECT character_profile, character_profile_revision FROM campaigns WHERE id = $1",
      [campaign.id]
    )).toMatchObject({
      rows: [{ character_profile: { name: "Mira Vale", profile: editedProfile }, character_profile_revision: 2 }]
    });
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
      selectedCharacterId: "second-character",
      storyContextBudgetTokens: 1_000_000
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
    expect(firstContext.scopes.worldCanon.playerCharacter).toMatchObject({
      name: "First Character",
      guidance: "First character canon."
    });
    expect(secondContext.scopes.worldCanon.playerCharacter).toMatchObject({
      name: "Second Character",
      guidance: "Second character canon."
    });
    expect((await exportCampaign(pool, first.id, null)).world.character).toBe("First Character\n\nFirst character canon.");
    expect((await exportCampaign(pool, second.id, null)).world.character).toBe("Second Character\n\nSecond character canon.");

    const portableCampaign = await exportCampaign(pool, second.id, null);
    expect(portableCampaign.settings.storyContextBudgetTokens).toBe(1_000_000);
    portableCampaign.world.title = `Roundtrip Character ${crypto.randomUUID()}`;
    const roundtrip = await importLegacyStory(pool, storyImportRequestSchema.parse({
      sourceName: "synthetic-character-roundtrip.story",
      story: portableCampaign
    }));
    const roundtripCampaign = await pool.query<{ selected_character_id: string; character_snapshot: any; story_context_budget_tokens: number }>(
      "SELECT selected_character_id, character_snapshot, story_context_budget_tokens FROM campaigns WHERE id = $1",
      [roundtrip.campaignId]
    );
    expect(roundtripCampaign.rows[0]).toMatchObject({
      selected_character_id: "second-character",
      character_snapshot: { characterText: "Second character canon." },
      story_context_budget_tokens: 1_000_000
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
      details: { code: "invalid_transition" }
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
    expect(detail.draftContent!.world.title).toBe(forkTitle);
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
        providerPromptProtocolVersion: "synthetic-protocol"
      })]
    );
    await pool.query(
      "UPDATE campaigns SET active_turn_number = 1 WHERE id = $1 AND owner_user_id = $2",
      [campaign.id, ownerUserId]
    );
    const exported = await exportCampaign(pool, campaign.id, null);
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
      .rejects.toMatchObject({ statusCode: 400, details: { code: "world_transfer_required" } });
  });

  it("deletes campaigns before safely deleting their world", async () => {
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
    }))).rejects.toMatchObject({ statusCode: 400, details: { code: "invalid_transition" } });

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

  it("keeps owner-scoped world and campaign organizer failures read-only", async () => {
    const world = await publishedWorld("Organizer ownership");
    const campaign = await createCampaign(pool, campaignCreateSchema.parse({
      title: `Organizer campaign ${crypto.randomUUID()}`,
      worldVersionId: world.version.worldVersionId,
      selectedCharacterId: "character-one"
    }));
    const ownerUserId = await initialOwnerId(pool);
    const foreign = await pool.query<{ id: string }>(
      "INSERT INTO users (display_name, status) VALUES ($1, 'active') RETURNING id",
      [`Organizer foreign owner ${crypto.randomUUID()}`]
    );
    const request = {
      expectedRevision: 1,
      character: {
        id: "character-one", name: "Character One", characterText: "Character One wears a blue coat.",
        campaignUse: "playable" as const, startingCastDefault: true, alwaysInContext: false,
        rpgStats: [], defaultTriggers: [], source: {}
      }
    };
    const providers = {
      resolution: { resolveDirect: async () => ({ status: "resolved", providerProfileId: "provider", model: "model" }) },
      execution: { text: async () => ({ execute: async () => ({
        content: "malformed organizer output", responseId: "response", finishReason: "stop", outputLimited: false,
        modelInstanceId: "model", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, reportedCost: null, rawMetadata: {}
      }) }) },
      prompts: { loadCharacterOrganizationPromptSnapshot: async () => ({ snapshot: {} }) },
      promptTools: { content: () => "Organize supplied character facts." }
    } as never;
    const worldBefore = await pool.query<{ content: unknown; revision: number }>(
      "SELECT content, revision FROM world_drafts WHERE world_id = $1 AND owner_user_id = $2", [world.created.id, ownerUserId]
    );
    const campaignBefore = await pool.query<{ character_profile: unknown; character_profile_revision: number }>(
      "SELECT character_profile, character_profile_revision FROM campaigns WHERE id = $1 AND owner_user_id = $2", [campaign.id, ownerUserId]
    );
    const campaignRequest = { ...request, expectedRevision: campaignBefore.rows[0]!.character_profile_revision };

    await expect(organizeWorldCharacterProfileForOwner(pool, foreign.rows[0]!.id, world.created.id, request, providers))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(organizeCampaignCharacterProfileForOwner(pool, foreign.rows[0]!.id, campaign.id, campaignRequest, providers))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(organizeWorldCharacterProfileForOwner(pool, ownerUserId, world.created.id, request, providers))
      .rejects.toMatchObject({ name: "AuthoringResponseError", authoringFailure: { stage: "organizer" } });
    await expect(organizeCampaignCharacterProfileForOwner(pool, ownerUserId, campaign.id, campaignRequest, providers))
      .rejects.toMatchObject({ name: "AuthoringResponseError", authoringFailure: { stage: "organizer" } });

    expect(await pool.query("SELECT content, revision FROM world_drafts WHERE world_id = $1 AND owner_user_id = $2", [world.created.id, ownerUserId]))
      .toMatchObject({ rows: worldBefore.rows });
    expect(await pool.query("SELECT character_profile, character_profile_revision FROM campaigns WHERE id = $1 AND owner_user_id = $2", [campaign.id, ownerUserId]))
      .toMatchObject({ rows: campaignBefore.rows });
  });

  it("keeps organizer previews local and records the reviewed protocol after a conflicting campaign edit is reapplied", async ({ onTestFinished }) => {
    const title = `Synthetic Organizer Save ${crypto.randomUUID()}`;
    const authored = worldContentSchema.parse({
      world: { title },
      playableCharacters: [{
        id: "synthetic-guide", name: "Synthetic Guide", characterText: "The guide wears a weathered blue cloak."
      }]
    });
    const character = authored.playableCharacters[0]!;
    const created = await createWorld(pool, worldCreateSchema.parse({ title, content: authored }));
    const published = await publishWorld(pool, created.id, worldPublishSchema.parse({ expectedRevision: created.draftRevision }));
    const campaign = await createCampaign(pool, campaignCreateSchema.parse({
      title: "Synthetic organizer explicit save", worldVersionId: published.worldVersionId, selectedCharacterId: character.id
    }));
    const ownerUserId = await initialOwnerId(pool);
    const candidate = characterProfileSchema.parse({ appearance: { clothing: "weathered blue cloak" } });
    const evidence = [{ path: "appearance.clothing", source: "legacyGuidance", quote: "weathered blue cloak" }];
    let providerCalls = 0;
    const providers = {
      resolution: { resolveDirect: async () => ({ status: "resolved", providerProfileId: "synthetic-provider", model: "synthetic-model" }) },
      execution: { text: async () => ({ execute: async () => {
        providerCalls += 1;
        return {
          content: JSON.stringify({ candidate, evidence, unassignedText: [], conflicts: [], warnings: [] }),
          responseId: "synthetic-response", finishReason: "stop", outputLimited: false,
          modelInstanceId: "synthetic-model", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, reportedCost: null, rawMetadata: {}
        };
      } }) },
      prompts: { loadCharacterOrganizationPromptSnapshot: async () => ({ snapshot: {} }) },
      promptTools: { content: () => "Organize supplied character facts." }
    } as never;
    const snapshot = async () => ({
      draft: (await pool.query("SELECT content, revision FROM world_drafts WHERE world_id = $1 AND owner_user_id = $2", [created.id, ownerUserId])).rows,
      campaign: (await pool.query("SELECT character_profile, character_profile_revision, character_snapshot FROM campaigns WHERE id = $1 AND owner_user_id = $2", [campaign.id, ownerUserId])).rows,
      version: (await pool.query("SELECT content FROM world_versions WHERE id = $1 AND owner_user_id = $2", [published.worldVersionId, ownerUserId])).rows,
      edits: (await pool.query("SELECT revision, edit_source, next_profile FROM campaign_character_profile_edits WHERE campaign_id = $1 AND owner_user_id = $2 ORDER BY revision", [campaign.id, ownerUserId])).rows
    });
    const before = await snapshot();
    expect(before.draft).toHaveLength(1);
    expect(before.campaign).toHaveLength(1);
    expect(before.version).toHaveLength(1);
    const draftRevision = before.draft[0]!.revision;
    const profileRevision = before.campaign[0]!.character_profile_revision;
    const worldProposal = await organizeWorldCharacterProfileForOwner(pool, ownerUserId, created.id, {
      expectedRevision: draftRevision, character
    }, providers);
    const campaignProposal = await organizeCampaignCharacterProfileForOwner(pool, ownerUserId, campaign.id, {
      expectedRevision: profileRevision, character
    }, providers);
    expect(providerCalls).toBe(2);
    expect(worldProposal).toMatchObject({ candidate, evidence });
    expect(campaignProposal).toMatchObject({ candidate, evidence });
    expect(await snapshot()).toEqual(before);

    const savedContent = worldContentSchema.parse({ ...authored, playableCharacters: [{ ...character, profile: worldProposal.candidate }] });
    const savedDraft = await updateWorldDraft(pool, created.id, worldDraftUpdateSchema.parse({
      expectedRevision: draftRevision, content: savedContent
    }));
    expect(savedDraft.revision).toBe(draftRevision + 1);
    const afterWorldSave = await snapshot();
    expect(afterWorldSave.draft[0]).toMatchObject({ revision: draftRevision + 1, content: savedContent });
    expect(afterWorldSave.campaign).toEqual(before.campaign);
    expect(afterWorldSave.version).toEqual(before.version);
    expect(afterWorldSave.edits).toEqual(before.edits);

    const config = { ...runtimeConfigFixture(), databaseUrl: databaseUrl!, role: "api" as const,
      legacyWebRoot: resolve("apps/web/dist"), nextWebRoot: resolve("apps/web-next/dist") };
    const server = await buildServer(inertStorageServerOptions({
      pool, config, worldCampaign: createApiWorldCampaignApplication(pool, { credentialSecret: config.credentialEncryptionKey })
    }));
    onTestFinished(() => server.close());
    const url = `/api/v1/campaigns/${campaign.id}/character-profile`;
    const save = (payload: Record<string, unknown>) => server.inject({ method: "PUT", url, payload });
    const loaded = (await server.inject(url)).json();
    const staged = stageEditorOrganize(createEditorDraft("campaign-main", loaded), {
      "appearance.clothing": campaignProposal.candidate.appearance.clothing
    }, campaignProposal.protocolVersion);
    const profileSave = campaignCharacterProfileUpdateSchema.parse(buildEditorPayload(staged, { expectedRevision: profileRevision }));
    // With a built Nexus client, send the stale PUT from the rendered editor to this same database.
    let submitStale = async () => (await save(profileSave)).statusCode;
    let submitReapplied = async (payload: Record<string, unknown>) => {
      const response = await save(payload);
      expect(response.statusCode).toBe(200);
      return response.json();
    };
    if (process.env.NEXUS_EDITOR_BROWSER_PROOF === "1") {
      const { chromium } = await import("@playwright/test");
      const { installLegacyUiFixture, legacyUiFixture } = await import("../e2e/helpers/legacy-ui-fixtures.js");
      const origin = await server.listen({ host: "127.0.0.1", port: 0 });
      const browser = await chromium.launch();
      onTestFinished(() => browser.close());
      const page = await browser.newPage();
      const base = legacyUiFixture({ campaignCount: 1, worldCount: 1, turnCount: 1 });
      const fixture = { ...base, campaignId: campaign.id, campaigns: [{ ...base.campaigns[0], id: campaign.id }] };
      await installLegacyUiFixture(page, fixture);
      await page.route(`**${url}`, route => route.continue());
      await page.route(`**${url}/organize`, route => route.fulfill({ json: campaignProposal }));
      await page.goto(`${origin}/nexus/index.html#campaigns`);
      await page.locator(`#campaignList [data-campaign-id="${campaign.id}"]`).click();
      await page.locator("#editCampaignCharacter").click();
      await page.locator("#organizeCharacterProfile").click();
      await page.locator("#applyCharacterProfileReview").click();
      submitStale = async () => {
        const pending = page.waitForResponse(res => res.request().method() === "PUT" && new URL(res.url()).pathname === url);
        await page.locator("#saveCharacter").click();
        const result = await pending;
        expect(result.request().postDataJSON()).toEqual(profileSave);
        return result.status();
      };
      submitReapplied = async (expected) => {
        const dialog = page.locator("#characterDialog");
        await dialog.getByRole("button", { name: "Compare latest", exact: true }).click();
        await dialog.getByRole("button", { name: "Reapply my changes", exact: true }).click();
        const pending = page.waitForResponse(res => res.request().method() === "PUT" && new URL(res.url()).pathname === url);
        await page.locator("#saveCharacter").click();
        const response = await pending;
        expect(response.request().postDataJSON()).toEqual(expected);
        expect(response.status()).toBe(200);
        return response.json();
      };
    }
    // A concurrent manual save follows a discarded review.
    const manual = setEditorDraftField(discardEditorOrganize(staged), "name", "Renamed guide");
    expect((await save(buildEditorPayload(manual, { expectedRevision: profileRevision }))).statusCode).toBe(200);
    expect(await submitStale()).toBe(409);
    const latest = (await server.inject(url)).json();
    expect(latest).toMatchObject({ revision: profileRevision + 1, name: "Renamed guide", profile: { appearance: { clothing: "" } } });
    const reapplied = reapplyEditorDraft(staged, latest);
    const savedProfile = await submitReapplied(buildEditorPayload(reapplied, { expectedRevision: latest.revision }));
    expect(savedProfile).toMatchObject({ revision: profileRevision + 2, name: latest.name, profile: candidate });
    expect((await server.inject(url)).json()).toMatchObject(savedProfile);
    const afterSaves = await snapshot();
    expect(afterSaves.campaign[0]).toMatchObject({
      character_profile_revision: profileRevision + 2, character_profile: { name: latest.name, profile: candidate },
      character_snapshot: before.campaign[0]!.character_snapshot
    });
    expect(afterSaves.version).toEqual(before.version);
    expect(afterSaves.draft).toEqual(afterWorldSave.draft);
    expect(afterSaves.edits).toHaveLength(before.edits.length + 2);
    expect(afterSaves.edits.at(-1)).toMatchObject({ revision: profileRevision + 2, edit_source: "ai_organized", next_profile: { name: latest.name, profile: candidate } });
    const audit = await pool.query(
      "SELECT details FROM activity_events WHERE owner_user_id = $1 AND campaign_id = $2 AND event_type = 'campaign_character_profile_updated' ORDER BY (details->>'characterProfileRevision')::int",
      [ownerUserId, campaign.id]
    );
    expect(audit.rows.map(row => row.details)).toEqual([
      { characterProfileRevision: profileRevision + 1, editSource: "manual", organizerProtocolVersion: null },
      { characterProfileRevision: profileRevision + 2, editSource: "ai_organized", organizerProtocolVersion: campaignProposal.protocolVersion }
    ]);

    await expect(updateWorldDraft(pool, created.id, worldDraftUpdateSchema.parse({
      expectedRevision: draftRevision, content: authored
    }))).rejects.toMatchObject({ statusCode: 409 });
    await expect(updateCampaignCharacterProfile(pool, campaign.id, profileSave)).rejects.toMatchObject({ statusCode: 409 });
    expect(await snapshot()).toEqual(afterSaves);
    expect(providerCalls).toBe(2);
  });

});
