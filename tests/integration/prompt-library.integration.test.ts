import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { promptCompatibilityRequirement } from "../../packages/contracts/src/prompt-library.js";
import { worldContentSchema } from "../../packages/contracts/src/world-library.js";
import { createCampaign, createWorld, publishWorld } from "../helpers/memory-aware-services.js";
import {
  resetPromptOverride,
  loadPromptSnapshotForTest,
  savePromptOverride
} from "../helpers/provider-application-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("Prompt Library persistence", () => {
  let pool: DatabasePool;
  let campaignId: string;
  let ownerUserId: string;

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 3);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    const title = `Prompt Test ${crypto.randomUUID()}`;
    const world = await createWorld(pool, {
      title,
      content: worldContentSchema.parse({
        schemaVersion: 4,
        world: { title, premise: "Synthetic premise.", firstAction: "Begin." },
        playableCharacters: [{ id: "hero", name: "Hero", characterText: "Synthetic hero." }]
      })
    });
    const version = await publishWorld(pool, world.id, { expectedRevision: world.draftRevision, releaseNotes: "Prompt Library integration fixture." });
    campaignId = (await createCampaign(pool, {
      worldVersionId: version.worldVersionId,
      title: `${title} Campaign`,
      selectedCharacterId: "hero",
      storyLengthProfile: "standard",
      storyContextBudgetTokens: 32_000,
      turnControlStyle: "flexible_action"
    })).id;
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it("resolves campaign override, application override, and shipped default in order", async () => {
    const requiredCompatibility = promptCompatibilityRequirement("story_system")!;
    const compatibilityAcknowledgement = (content: string) => ({
      requiredShapeVersion: requiredCompatibility.requiredShapeVersion,
      protocolIdentity: requiredCompatibility.protocolIdentity,
      contentHash: createHash("sha256").update(content).digest("hex")
    });
    const applicationContent = "Application story prompt.";
    await savePromptOverride(pool, {
      key: "story_system",
      scope: "application",
      content: applicationContent,
      compatibilityAcknowledgement: compatibilityAcknowledgement(applicationContent)
    });
    expect((await loadPromptSnapshotForTest(pool, ownerUserId, campaignId)).story_system)
      .toMatchObject({ content: "Application story prompt.", source: "application" });

    const campaignContent = "Campaign story prompt.";
    await savePromptOverride(pool, {
      key: "story_system",
      scope: "campaign",
      campaignId,
      content: campaignContent,
      compatibilityAcknowledgement: compatibilityAcknowledgement(campaignContent)
    });
    expect((await loadPromptSnapshotForTest(pool, ownerUserId, campaignId)).story_system)
      .toMatchObject({ content: "Campaign story prompt.", source: "campaign" });

    await resetPromptOverride(pool, { key: "story_system", scope: "campaign", campaignId });
    expect((await loadPromptSnapshotForTest(pool, ownerUserId, campaignId)).story_system.source).toBe("application");
    await resetPromptOverride(pool, { key: "story_system", scope: "application" });
    expect((await loadPromptSnapshotForTest(pool, ownerUserId, campaignId)).story_system.source).toBe("shipped");
  });

  it("rejects a campaign override whose owner does not own the campaign", async () => {
    const otherOwner = await pool.query<{ id: string }>(
      "INSERT INTO users (display_name) VALUES ('Prompt Test Other Owner') RETURNING id"
    );
    await expect(pool.query(
      `INSERT INTO prompt_template_overrides (owner_user_id, campaign_id, prompt_key, content)
       VALUES ($1,$2,'story_system','Cross-owner prompt.')`,
      [otherOwner.rows[0]!.id, campaignId]
    )).rejects.toThrow();
  });
});
