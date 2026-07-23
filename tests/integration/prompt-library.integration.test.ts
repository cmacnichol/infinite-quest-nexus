import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { worldContentSchema } from "../../packages/contracts/src/world-library.js";
import { createCampaign, createWorld, publishWorld } from "../../services/api/src/world-service.js";
import {
  resetPromptOverride,
  resolvePromptSnapshot,
  savePromptOverride
} from "../../services/api/src/prompt-library-service.js";

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
      turnControlStyle: "flexible_auto"
    })).id;
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it("resolves campaign override, application override, and shipped default in order", async () => {
    await savePromptOverride(pool, { key: "story_system", scope: "application", content: "Application story prompt." });
    expect((await resolvePromptSnapshot(pool, ownerUserId, campaignId)).story_system)
      .toMatchObject({ content: "Application story prompt.", source: "application" });

    await savePromptOverride(pool, {
      key: "story_system",
      scope: "campaign",
      campaignId,
      content: "Campaign story prompt."
    });
    expect((await resolvePromptSnapshot(pool, ownerUserId, campaignId)).story_system)
      .toMatchObject({ content: "Campaign story prompt.", source: "campaign" });

    await resetPromptOverride(pool, { key: "story_system", scope: "campaign", campaignId });
    expect((await resolvePromptSnapshot(pool, ownerUserId, campaignId)).story_system.source).toBe("application");
    await resetPromptOverride(pool, { key: "story_system", scope: "application" });
    expect((await resolvePromptSnapshot(pool, ownerUserId, campaignId)).story_system.source).toBe("shipped");
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
