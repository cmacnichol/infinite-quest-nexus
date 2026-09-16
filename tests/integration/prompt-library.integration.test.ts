import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, withTransaction, type DatabasePool } from "../../packages/database/src/pool.js";
import { promptCompatibilityRequirement, assertContinuityReviewPromptSnapshot, CONTINUITY_REVIEW_PROMPT_CATALOG } from "../../packages/contracts/src/prompt-library.js";
import { createPromptRepository, resolveStoryMemoryPromptSnapshot } from "../../packages/database/src/prompt-repository.js";
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

  it("captures campaign-over-application review and repair overrides as a strict v2 pair", async () => {
    await pool.query(`INSERT INTO prompt_template_overrides(owner_user_id,campaign_id,prompt_key,content) VALUES
      ($1,NULL,'story_continuity_review','Application review.'),
      ($1,$2,'story_continuity_review','Campaign review.'),
      ($1,NULL,'story_continuity_repair','Application repair.')`, [ownerUserId, campaignId]);
    const snapshot = await withTransaction(pool, (client) => resolveStoryMemoryPromptSnapshot(client, { ownerUserId, scope: "campaign", campaignId }, "enforce"));
    expect(snapshot.continuityReview).toMatchObject({ review: { content: "Campaign review.", source: "campaign" }, repair: { content: "Application repair.", source: "application" } });
    expect(assertContinuityReviewPromptSnapshot(snapshot, "enforce").continuityReview).toEqual(snapshot.continuityReview);
  });

  it.each(["story_continuity_review", "story_continuity_repair"] as const)("displays the exact effective %s bytes through save, inheritance and reset", async (key) => withTransaction(pool, async (client) => {
    const repository = createPromptRepository(client);
    const applicationScope = { ownerUserId, scope: "application" as const };
    const campaignScope = { ownerUserId, scope: "campaign" as const, campaignId };
    const member = key === "story_continuity_review" ? "review" : "repair";
    const applicationContent = `Application ${key} fixture.`;
    const campaignContent = `Campaign ${key} fixture.`;
    const assertEffective = async (scope: typeof applicationScope | typeof campaignScope, content: string, source: string) => {
      const library = await repository.listPromptLibrary(scope);
      const listed = library.templates.find((template) => template.key === key)!;
      const frozen = await resolveStoryMemoryPromptSnapshot(client, scope, "enforce");
      expect(listed).toMatchObject({ effectiveContent: content, effectiveSource: source,
        contentHash: createHash("sha256").update(content).digest("hex") });
      expect(frozen.continuityReview![member]).toMatchObject({ content: listed.effectiveContent, source: listed.effectiveSource, hash: listed.contentHash });
      return frozen;
    };

    await repository.resetPromptOverride({ ...campaignScope, key });
    const saved = await repository.savePromptOverride({ ...applicationScope, key, content: applicationContent });
    expect(saved.templates.find((template) => template.key === key)).toMatchObject({ effectiveContent: applicationContent, effectiveSource: "application" });
    await assertEffective(applicationScope, applicationContent, "application");
    await assertEffective(campaignScope, applicationContent, "application");
    await repository.savePromptOverride({ ...campaignScope, key, content: campaignContent });
    const frozen = await assertEffective(campaignScope, campaignContent, "campaign");
    await assertEffective(applicationScope, applicationContent, "application");

    const otherOwner = await client.query<{ id: string }>("INSERT INTO users(display_name) VALUES ('Other prompt reader') RETURNING id");
    await assertEffective({ ...applicationScope, ownerUserId: otherOwner.rows[0]!.id }, CONTINUITY_REVIEW_PROMPT_CATALOG[member].defaultContent, "shipped");
    await expect(repository.listPromptLibrary({ ...campaignScope, ownerUserId: otherOwner.rows[0]!.id })).rejects.toMatchObject({ statusCode: 404 });

    await repository.resetPromptOverride({ ...campaignScope, key });
    await assertEffective(campaignScope, applicationContent, "application");
    await repository.resetPromptOverride({ ...applicationScope, key });
    await assertEffective(campaignScope, CONTINUITY_REVIEW_PROMPT_CATALOG[member].defaultContent, "shipped");
    expect(frozen.continuityReview![member]).toMatchObject({ content: campaignContent, source: "campaign" });
  }));
});
