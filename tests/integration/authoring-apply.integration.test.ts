import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { authoringSubmitSchema } from "../../packages/contracts/src/authoring.js";
import { playableCharacterSchema, worldContentSchema } from "../../packages/contracts/src/world-library.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { createRuntimeAuthoringApplication } from "../../services/runtime/src/authoring-composition.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

const content = worldContentSchema.parse({
  world: {
    title: "Receipt Lantern",
    genre: "fantasy",
    tone: "hopeful",
    premise: "A lantern remembers every promise.",
    backgroundStory: "The city follows its light.",
    firstAction: "Follow the lantern.",
    rules: "Promises have weight."
  },
  playableCharacters: [],
  entities: [], relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [], defaults: {}
});

const originalHero = playableCharacterSchema.parse({
  id: "hero", name: "Mara", characterText: "Mara guards the lantern bridge.",
  profile: { story: { role: "Guide", background: "Mara knows every bridge.", personality: "Patient.", motivations: "Keep travelers safe.", goals: "Find the lost gate.", fearsAndConflicts: "The lantern might fade.", keyRelationships: "Trusts the keeper.", narrativeHooks: "A map glows at dusk.", voiceAndMannerisms: "Speaks softly.", otherGuidance: "" } }
});
const revisedHero = playableCharacterSchema.parse({
  ...originalHero, name: "Mara of the North Bridge", characterText: "Mara now maps every promise that crosses the river."
});
const validatedOutline = {
  kind: "outline",
  outline: {
    title: content.world.title, genre: content.world.genre, tone: content.world.tone,
    premise: content.world.premise, backgroundStory: content.world.backgroundStory,
    firstAction: content.world.firstAction, rules: content.world.rules,
    seeds: [], rpgStats: [], defaultTriggers: [], eventTriggers: []
  }
};
const unrelatedHero = playableCharacterSchema.parse({
  ...originalHero, id: "unselected", name: "Iven", characterText: "Iven maintains the bridge mechanisms."
});

integration("authoring apply PostgreSQL integration", () => {
  let pool: DatabasePool;
  let ownerUserId: string;
  const jobIds: string[] = [];
  const worldIds: string[] = [];
  const foreignUserIds: string[] = [];
  const foreignWorldIds: string[] = [];
  const protectedVersionIds: string[] = [];
  const protectedCampaignIds: string[] = [];

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 8);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });

  afterEach(async () => {
    if (protectedCampaignIds.length) await pool.query("DELETE FROM campaigns WHERE id = ANY($1::uuid[])", [protectedCampaignIds]);
    if (protectedVersionIds.length) await pool.query("DELETE FROM world_versions WHERE id = ANY($1::uuid[])", [protectedVersionIds]);
    if (foreignWorldIds.length) await pool.query("DELETE FROM worlds WHERE id = ANY($1::uuid[])", [foreignWorldIds]);
    if (worldIds.length) await pool.query("DELETE FROM worlds WHERE id = ANY($1::uuid[])", [worldIds]);
    if (jobIds.length) await pool.query("DELETE FROM authoring_jobs WHERE id = ANY($1::uuid[])", [jobIds]);
    if (foreignUserIds.length) await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [foreignUserIds]);
    worldIds.length = 0;
    jobIds.length = 0;
    foreignWorldIds.length = 0;
    foreignUserIds.length = 0;
    protectedVersionIds.length = 0;
    protectedCampaignIds.length = 0;
  });

  afterAll(async () => { await pool?.end(); });

  async function reviewedWorldJob() {
    const application = createRuntimeAuthoringApplication(pool, (value) => createHash("sha256").update(value).digest("hex"));
    const job = await application.submit({ ownerUserId }, authoringSubmitSchema.parse({
      kind: "world_concept",
      idempotencyKey: `apply-world-${crypto.randomUUID()}`,
      target: { kind: "new_world" },
      prompt: "Draft a lantern city."
    }));
    jobIds.push(job.id);
    const stageId = job.stages[0]!.id;
    await pool.query("UPDATE authoring_jobs SET status = 'awaiting_review' WHERE id = $1", [job.id]);
    await pool.query("UPDATE authoring_job_stages SET status = 'validated', output = $2::jsonb WHERE id = $1", [stageId, JSON.stringify(validatedOutline)]);
    const reviewed = await application.review({ ownerUserId }, job.id, {
      expectedRevision: job.revision,
      content,
      selectedStageIds: [stageId]
    });
    return { application, jobId: job.id, stageId, revision: reviewed.revision };
  }

  async function reviewedCharacterJob(worldId: string, expectedRevision: number) {
    const application = createRuntimeAuthoringApplication(pool, (value) => createHash("sha256").update(value).digest("hex"));
    const source = worldContentSchema.parse({ ...content, playableCharacters: [originalHero, unrelatedHero] });
    const job = await application.submit({ ownerUserId }, authoringSubmitSchema.parse({
      kind: "character",
      idempotencyKey: `apply-character-${crypto.randomUUID()}`,
      target: { kind: "world_draft", worldId, expectedRevision, characterId: originalHero.id },
      characterId: originalHero.id,
      prompt: "Strengthen Mara's guidance.",
      content: source
    }));
    jobIds.push(job.id);
    const stageId = job.stages[0]!.id;
    await pool.query("UPDATE authoring_jobs SET status = 'awaiting_review' WHERE id = $1", [job.id]);
    await pool.query("UPDATE authoring_job_stages SET status = 'validated', output = $2::jsonb WHERE id = $1", [stageId, JSON.stringify({ kind: "character", character: revisedHero })]);
    const reviewed = await application.review({ ownerUserId }, job.id, {
      expectedRevision: job.revision,
      content: revisedHero,
      selectedStageIds: [stageId]
    });
    return { application, jobId: job.id, stageId, revision: reviewed.revision, source };
  }

  async function createDraft(revision: number, draftContent = worldContentSchema.parse({ ...content, playableCharacters: [originalHero, unrelatedHero] })) {
    const created = await pool.query<{ id: string }>("INSERT INTO worlds (owner_user_id, title, status) VALUES ($1, $2, 'draft') RETURNING id", [ownerUserId, draftContent.world.title]);
    const worldId = created.rows[0]!.id;
    worldIds.push(worldId);
    await pool.query("INSERT INTO world_drafts (world_id, owner_user_id, revision, content) VALUES ($1, $2, $3, $4::jsonb)", [worldId, ownerUserId, revision, JSON.stringify(draftContent)]);
    return { worldId, content: draftContent };
  }

  async function seedProtectedCampaign(seedOwnerUserId: string, suffix: string) {
    const protectedContent = worldContentSchema.parse({ ...content, world: { ...content.world, title: `Protected ${suffix}` } });
    const world = await pool.query<{ id: string }>("INSERT INTO worlds (owner_user_id, title, status) VALUES ($1, $2, 'active') RETURNING id", [seedOwnerUserId, protectedContent.world.title]);
    const worldId = world.rows[0]!.id;
    const version = await pool.query<{ id: string }>("INSERT INTO world_versions (world_id, owner_user_id, version_number, content, source_hash) VALUES ($1, $2, 1, $3::jsonb, $4) RETURNING id", [worldId, seedOwnerUserId, JSON.stringify(protectedContent), `protected-${suffix}`]);
    const versionId = version.rows[0]!.id;
    const campaign = await pool.query<{ id: string }>("INSERT INTO campaigns (owner_user_id, world_version_id, title) VALUES ($1, $2, $3) RETURNING id", [seedOwnerUserId, versionId, `Protected campaign ${suffix}`]);
    const campaignId = campaign.rows[0]!.id;
    await pool.query("INSERT INTO campaign_state (campaign_id, owner_user_id, scratchpad_private, trackers) VALUES ($1, $2, $3, $4::jsonb)", [campaignId, seedOwnerUserId, `Protected scratchpad ${suffix}`, JSON.stringify([{ id: "promise", value: suffix }])]);
    const turn = await pool.query<{ id: string }>("INSERT INTO turns (owner_user_id, campaign_id, turn_number, narration) VALUES ($1, $2, 1, $3) RETURNING id", [seedOwnerUserId, campaignId, `Protected turn ${suffix}`]);
    await pool.query("INSERT INTO chronicle_memories (owner_user_id, campaign_id, world_version_id, turn_id, memory_kind, ordinal, content, token_estimate) VALUES ($1, $2, $3, $4, 'turn_fiction', 1, $5, 3)", [seedOwnerUserId, campaignId, versionId, turn.rows[0]!.id, `Protected memory ${suffix}`]);
    protectedCampaignIds.push(campaignId);
    protectedVersionIds.push(versionId);
    (seedOwnerUserId === ownerUserId ? worldIds : foreignWorldIds).push(worldId);
    return { worldId, versionId, campaignId, title: protectedContent.world.title, suffix };
  }

  it("P28-F3 persists and applies the exact current review subset despite retained history and an unselected validated sibling", async () => {
    const { application, jobId, stageId, revision } = await reviewedWorldJob();
    const replacement = await pool.query<{ id: string }>(
      "INSERT INTO authoring_job_stages (job_id, owner_user_id, stage_key, generation, parent_generations, status, output) SELECT job_id, owner_user_id, stage_key, generation + 1, parent_generations, 'validated', output FROM authoring_job_stages WHERE id = $1 RETURNING id",
      [stageId]
    );
    const currentId = replacement.rows[0]!.id;
    const sibling = await pool.query<{ id: string }>(
      "INSERT INTO authoring_job_stages (job_id, owner_user_id, stage_key, generation, parent_generations, status, output) VALUES ($1, $2, 'character:unselected', 1, '{}'::jsonb, 'validated', $3::jsonb) RETURNING id",
      [jobId, ownerUserId, JSON.stringify({ kind: "character", character: unrelatedHero })]
    );
    const reviewed = await application.review({ ownerUserId }, jobId, { expectedRevision: revision, selectedStageIds: [currentId], content });
    const detail = await application.get({ ownerUserId }, jobId);
    expect(reviewed.reviewedStageIds).toEqual([currentId]);
    expect(detail?.reviewedStageIds).toEqual([currentId]); expect(detail?.canApply).toBe(true);
    expect(detail?.stages.filter(stage => stage.status === "validated")).toHaveLength(3);
    expect((await application.list({ ownerUserId })).jobs.find(job => job.id === jobId)).not.toHaveProperty("reviewedStageIds");
    const input = { expectedRevision: reviewed.revision, idempotencyKey: "exact-subset", selectedStageIds: [currentId], content };
    await expect(application.apply({ ownerUserId }, jobId, { ...input, selectedStageIds: [stageId, currentId, sibling.rows[0]!.id] })).rejects.toThrow();
    expect(await application.get({ ownerUserId }, jobId)).toEqual(detail);
    const receipt = await application.apply({ ownerUserId }, jobId, input);
    worldIds.push(receipt.worldId);
    expect((await pool.query("SELECT content FROM world_drafts WHERE world_id = $1", [receipt.worldId])).rows[0]!.content.playableCharacters).toEqual([]);
    await expect(application.apply({ ownerUserId }, jobId, input)).resolves.toEqual(receipt);
  });

  it("atomically creates one draft and replays a lost same-key apply response", async () => {
    const { application, jobId, stageId, revision } = await reviewedWorldJob();
    const input = { expectedRevision: revision, idempotencyKey: "apply-replay", selectedStageIds: [stageId], content };
    const ownedProtected = await seedProtectedCampaign(ownerUserId, "owned");
    const foreign = await pool.query<{ id: string }>("INSERT INTO users (display_name) VALUES ($1) RETURNING id", [`authoring foreign ${crypto.randomUUID()}`]);
    foreignUserIds.push(foreign.rows[0]!.id);
    const foreignProtected = await seedProtectedCampaign(foreign.rows[0]!.id, "foreign");
    const protectedAuthorityBefore = await pool.query(
      "SELECT to_jsonb(worlds) AS world, to_jsonb(world_versions) AS version, to_jsonb(campaigns) AS campaign, to_jsonb(campaign_state) AS state, to_jsonb(turns) AS turn, to_jsonb(chronicle_memories) AS memory FROM worlds JOIN world_versions ON world_versions.world_id = worlds.id JOIN campaigns ON campaigns.world_version_id = world_versions.id JOIN campaign_state ON campaign_state.campaign_id = campaigns.id JOIN turns ON turns.campaign_id = campaigns.id JOIN chronicle_memories ON chronicle_memories.turn_id = turns.id WHERE worlds.id = ANY($1::uuid[]) ORDER BY worlds.id",
      [[ownedProtected.worldId, foreignProtected.worldId]]
    );
    expect(protectedAuthorityBefore.rows).toHaveLength(2);
    const beforeUnrelated = await pool.query<{ versions: number; campaigns: number; turns: number; memories: number }>(
      "SELECT (SELECT count(*)::int FROM world_versions) AS versions, (SELECT count(*)::int FROM campaigns) AS campaigns, (SELECT count(*)::int FROM turns) AS turns, (SELECT count(*)::int FROM chronicle_memories) AS memories"
    );
    const eligibleDetail = await application.get({ ownerUserId }, jobId);
    const eligibleList = await application.list({ ownerUserId });
    expect(eligibleDetail?.canApply).toBe(true);
    expect(eligibleList.jobs.find((item) => item.id === jobId)?.canApply).toBe(true);
    expect(JSON.stringify(eligibleList)).not.toContain(content.world.backgroundStory);

    const [first, replay] = await Promise.all([
      application.apply({ ownerUserId }, jobId, input),
      application.apply({ ownerUserId }, jobId, input)
    ]);
    worldIds.push(first.worldId);

    expect(replay).toEqual(first);
    expect(first).toMatchObject({ jobId, draftRevision: 1 });
    await expect(pool.query("SELECT id FROM worlds WHERE id = $1", [first.worldId]))
      .resolves.toMatchObject({ rowCount: 1 });
    await expect(pool.query("SELECT count(*)::int AS count FROM worlds WHERE owner_user_id = $1 AND title = $2", [ownerUserId, content.world.title]))
      .resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(pool.query("SELECT input, reviewed_content AS \"reviewedContent\", execution_snapshot AS \"executionSnapshot\", apply_receipt AS \"applyReceipt\" FROM authoring_jobs WHERE id = $1", [jobId]))
      .resolves.toMatchObject({ rows: [{ input: { applied: true }, reviewedContent: null, executionSnapshot: null, applyReceipt: first }] });
    await expect(pool.query("SELECT count(*)::int AS count FROM authoring_job_stages WHERE job_id = $1 AND (output IS NOT NULL OR failure IS NOT NULL)", [jobId]))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(pool.query("SELECT (SELECT count(*)::int FROM world_versions) AS versions, (SELECT count(*)::int FROM campaigns) AS campaigns, (SELECT count(*)::int FROM turns) AS turns, (SELECT count(*)::int FROM chronicle_memories) AS memories"))
      .resolves.toMatchObject({ rows: beforeUnrelated.rows });
    await expect(pool.query<{ title: string; narration: string; memory: string }>(
      "SELECT worlds.title, turns.narration, chronicle_memories.content AS memory FROM worlds JOIN world_versions ON world_versions.world_id = worlds.id JOIN campaigns ON campaigns.world_version_id = world_versions.id JOIN turns ON turns.campaign_id = campaigns.id JOIN chronicle_memories ON chronicle_memories.turn_id = turns.id WHERE worlds.id = ANY($1::uuid[]) ORDER BY worlds.title",
      [[ownedProtected.worldId, foreignProtected.worldId]]
    )).resolves.toMatchObject({ rows: [
      { title: foreignProtected.title, narration: "Protected turn foreign", memory: "Protected memory foreign" },
      { title: ownedProtected.title, narration: "Protected turn owned", memory: "Protected memory owned" }
    ] });
    await expect(pool.query(
      "SELECT to_jsonb(worlds) AS world, to_jsonb(world_versions) AS version, to_jsonb(campaigns) AS campaign, to_jsonb(campaign_state) AS state, to_jsonb(turns) AS turn, to_jsonb(chronicle_memories) AS memory FROM worlds JOIN world_versions ON world_versions.world_id = worlds.id JOIN campaigns ON campaigns.world_version_id = world_versions.id JOIN campaign_state ON campaign_state.campaign_id = campaigns.id JOIN turns ON turns.campaign_id = campaigns.id JOIN chronicle_memories ON chronicle_memories.turn_id = turns.id WHERE worlds.id = ANY($1::uuid[]) ORDER BY worlds.id",
      [[ownedProtected.worldId, foreignProtected.worldId]]
    )).resolves.toEqual(protectedAuthorityBefore);

    // Receipts remain replayable after the inactive-proposal window but before
    // their own thirty-day deadline. Changing identity/body is a conflict.
    await pool.query("UPDATE authoring_jobs SET last_activity_at = clock_timestamp() - interval '8 days' WHERE id = $1", [jobId]);
    await expect(application.apply({ ownerUserId }, jobId, input)).resolves.toEqual(first);
    await expect(application.apply({ ownerUserId }, jobId, { ...input, idempotencyKey: "different-key" }))
      .rejects.toMatchObject({ code: "authoring_idempotency_conflict" });
    await expect(application.apply({ ownerUserId }, jobId, { ...input, content: { ...content, world: { ...content.world, title: "Changed after receipt" } } }))
      .rejects.toMatchObject({ code: "authoring_idempotency_conflict" });
    await pool.query("UPDATE authoring_jobs SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [jobId]);
    await expect(application.apply({ ownerUserId }, jobId, input)).rejects.toMatchObject({ code: "authoring_invalid_state" });
  });

  it("merges a reviewed existing-world character at its pinned draft revision without touching the unselected roster", async () => {
    const { worldId } = await createDraft(3);
    const { application, jobId, stageId, revision } = await reviewedCharacterJob(worldId, 3);
    expect(revision).not.toBe(3);

    const receipt = await application.apply({ ownerUserId }, jobId, {
      expectedRevision: revision,
      idempotencyKey: "apply-existing-character",
      selectedStageIds: [stageId],
      content: revisedHero
    });

    expect(receipt).toMatchObject({ worldId, draftRevision: 4, characterId: originalHero.id });
    await expect(pool.query<{ revision: number; content: typeof content }>("SELECT revision, content FROM world_drafts WHERE world_id = $1", [worldId]))
      .resolves.toMatchObject({ rows: [{ revision: 4, content: expect.objectContaining({ playableCharacters: [revisedHero, unrelatedHero] }) }] });
  });

  it("applies a valid incomplete reviewed world draft without publishing or creating a campaign", async () => {
    const { application, jobId, stageId, revision } = await reviewedWorldJob();
    await pool.query("INSERT INTO authoring_job_stages (job_id, owner_user_id, stage_key, parent_generations, status) VALUES ($1, $2, 'character:optional', '{\"world\":1}'::jsonb, 'recoverable')", [jobId, ownerUserId]);
    await pool.query("UPDATE authoring_jobs SET status = 'recoverable' WHERE id = $1", [jobId]);
    const ready = await application.get({ ownerUserId }, jobId);
    expect(ready).toMatchObject({ incomplete: true, canApply: true });
    const receipt = await application.apply({ ownerUserId }, jobId, {
      expectedRevision: revision, idempotencyKey: "apply-incomplete-draft", selectedStageIds: [stageId], content
    });
    worldIds.push(receipt.worldId);
    await expect(pool.query("SELECT status FROM worlds WHERE id = $1", [receipt.worldId])).resolves.toMatchObject({ rows: [{ status: "draft" }] });
    await expect(pool.query("SELECT count(*)::int AS count FROM world_versions WHERE world_id = $1", [receipt.worldId])).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(pool.query("SELECT count(*)::int AS count FROM campaigns WHERE world_version_id IN (SELECT id FROM world_versions WHERE world_id = $1)", [receipt.worldId])).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("does not advertise or accept a recoverable review whose selected current stage has no validated output", async () => {
    const { application, jobId, stageId, revision } = await reviewedWorldJob();
    await pool.query("UPDATE authoring_jobs SET status = 'recoverable' WHERE id = $1", [jobId]);
    await pool.query("UPDATE authoring_job_stages SET output = NULL WHERE id = $1", [stageId]);
    expect((await application.get({ ownerUserId }, jobId))?.canApply).toBe(false);
    expect((await application.list({ ownerUserId })).jobs.find((job) => job.id === jobId)?.canApply).toBe(false);
    await expect(application.apply({ ownerUserId }, jobId, {
      expectedRevision: revision, idempotencyKey: "apply-zero-output", selectedStageIds: [stageId], content
    })).rejects.toMatchObject({ code: "authoring_invalid_state" });
  });

  it("keeps an independently saved empty review but rejects its empty apply without mutation", async () => {
    const { application, jobId, revision } = await reviewedWorldJob();
    const saved = await application.review({ ownerUserId }, jobId, {
      expectedRevision: revision, selectedStageIds: [], content
    });
    expect(saved).toMatchObject({ reviewedStageIds: [], canApply: false });
    const before = await pool.query("SELECT status, revision, apply_receipt AS \"applyReceipt\" FROM authoring_jobs WHERE id = $1", [jobId]);
    await expect(application.apply({ ownerUserId }, jobId, {
      expectedRevision: saved.revision, idempotencyKey: "empty-selection", selectedStageIds: [], content
    })).rejects.toMatchObject({ code: "authoring_invalid_state" });
    await expect(pool.query("SELECT status, revision, apply_receipt AS \"applyReceipt\" FROM authoring_jobs WHERE id = $1", [jobId])).resolves.toEqual(before);
    await expect(pool.query("SELECT count(*)::int AS count FROM worlds WHERE owner_user_id = $1", [ownerUserId]))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("rejects a stale target revision and stale selected generation before any authoritative mutation", async () => {
    const { worldId, content: original } = await createDraft(4);
    const { application, jobId, stageId, revision } = await reviewedCharacterJob(worldId, 4);
    await pool.query("UPDATE world_drafts SET revision = 5 WHERE world_id = $1", [worldId]);
    await expect(application.apply({ ownerUserId }, jobId, {
      expectedRevision: revision, idempotencyKey: "apply-stale-target", selectedStageIds: [stageId], content: revisedHero
    })).rejects.toMatchObject({ code: "authoring_revision_conflict" });
    await expect(pool.query("SELECT revision, content FROM world_drafts WHERE world_id = $1", [worldId]))
      .resolves.toMatchObject({ rows: [{ revision: 5, content: original }] });
    await expect(pool.query("SELECT status, apply_receipt AS \"applyReceipt\" FROM authoring_jobs WHERE id = $1", [jobId]))
      .resolves.toMatchObject({ rows: [{ status: "awaiting_review", applyReceipt: null }] });

    const valid = await reviewedWorldJob();
    await pool.query("INSERT INTO authoring_job_stages (job_id, owner_user_id, stage_key, generation, status) VALUES ($1, $2, 'world', 2, 'validated')", [valid.jobId, ownerUserId]);
    await expect(valid.application.apply({ ownerUserId }, valid.jobId, {
      expectedRevision: valid.revision, idempotencyKey: "apply-stale-generation", selectedStageIds: [valid.stageId], content
    })).rejects.toMatchObject({ code: "authoring_invalid_state" });
    await expect(pool.query("SELECT count(*)::int AS count FROM worlds WHERE title = $1", [content.world.title]))
      .resolves.toMatchObject({ rows: [{ count: 1 }] });

    const parentStale = await reviewedWorldJob();
    const child = await pool.query<{ id: string }>(
      "INSERT INTO authoring_job_stages (job_id, owner_user_id, stage_key, parent_generations, status, output) VALUES ($1, $2, 'character:parent-stale', '{\"world\":1}'::jsonb, 'validated', $3::jsonb) RETURNING id",
      [parentStale.jobId, ownerUserId, JSON.stringify({ kind: "character", character: { ...revisedHero, id: "parent-stale" } })]
    );
    await pool.query("UPDATE authoring_jobs SET reviewed_stage_ids = $2::jsonb WHERE id = $1", [parentStale.jobId, JSON.stringify([child.rows[0]!.id])]);
    await pool.query("INSERT INTO authoring_job_stages (job_id, owner_user_id, stage_key, generation, status) VALUES ($1, $2, 'world', 2, 'validated')", [parentStale.jobId, ownerUserId]);
    expect((await parentStale.application.get({ ownerUserId }, parentStale.jobId))?.canApply).toBe(false);
    expect((await parentStale.application.list({ ownerUserId })).jobs.find((job) => job.id === parentStale.jobId)?.canApply).toBe(false);
    await expect(parentStale.application.apply({ ownerUserId }, parentStale.jobId, {
      expectedRevision: parentStale.revision, idempotencyKey: "apply-stale-parent", selectedStageIds: [child.rows[0]!.id], content
    })).rejects.toMatchObject({ code: "authoring_invalid_state" });
  });

  it("rejects apply after its target world is deleted and preserves the unapplied review", async () => {
    const { worldId } = await createDraft(3);
    const { application, jobId, stageId, revision } = await reviewedCharacterJob(worldId, 3);
    await pool.query("DELETE FROM worlds WHERE id = $1", [worldId]);
    await expect(application.apply({ ownerUserId }, jobId, {
      expectedRevision: revision, idempotencyKey: "deleted-world-apply",
      selectedStageIds: [stageId], content: revisedHero
    })).rejects.toMatchObject({ code: "authoring_not_found" });
    expect((await pool.query("SELECT id FROM worlds WHERE id = $1", [worldId])).rows).toEqual([]);
    expect((await pool.query("SELECT apply_receipt, reviewed_content FROM authoring_jobs WHERE id = $1", [jobId])).rows[0])
      .toMatchObject({ apply_receipt: null, reviewed_content: revisedHero });
  });

  it("rolls back the world write when receipt persistence fails after the mutation", async () => {
    const { application, jobId, stageId, revision } = await reviewedWorldJob();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const trigger = `authoring_apply_receipt_failure_${suffix}`;
    const routine = `authoring_apply_receipt_failure_fn_${suffix}`;
    await pool.query(`CREATE FUNCTION ${routine}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'receipt persistence failure'; END; $$`);
    await pool.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON authoring_jobs FOR EACH ROW WHEN (NEW.apply_receipt IS NOT NULL AND OLD.apply_receipt IS NULL) EXECUTE FUNCTION ${routine}()`);
    try {
      await expect(application.apply({ ownerUserId }, jobId, {
        expectedRevision: revision, idempotencyKey: "apply-trigger-rollback", selectedStageIds: [stageId], content
      })).rejects.toThrow("receipt persistence failure");
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON authoring_jobs`);
      await pool.query(`DROP FUNCTION IF EXISTS ${routine}()`);
    }
    await expect(pool.query("SELECT count(*)::int AS count FROM worlds WHERE owner_user_id = $1 AND title = $2", [ownerUserId, content.world.title]))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(pool.query("SELECT status, input, apply_receipt AS \"applyReceipt\" FROM authoring_jobs WHERE id = $1", [jobId]))
      .resolves.toMatchObject({ rows: [{ status: "awaiting_review", input: expect.objectContaining({ kind: "world_concept" }), applyReceipt: null }] });
  });

  it("keeps a new-world character proposal local to its parent review instead of publishing it", async () => {
    const application = createRuntimeAuthoringApplication(pool, (value) => createHash("sha256").update(value).digest("hex"));
    const localParent = worldContentSchema.parse({ ...content, playableCharacters: [originalHero] });
    const job = await application.submit({ ownerUserId }, authoringSubmitSchema.parse({
      kind: "character", idempotencyKey: `local-character-${crypto.randomUUID()}`, target: { kind: "new_world" },
      prompt: "Refine this local character.", content: localParent, characterId: originalHero.id
    }));
    jobIds.push(job.id);
    const stageId = job.stages[0]!.id;
    await pool.query("UPDATE authoring_jobs SET status = 'awaiting_review' WHERE id = $1", [job.id]);
    await pool.query("UPDATE authoring_job_stages SET status = 'validated', output = $2::jsonb WHERE id = $1", [stageId, JSON.stringify({ kind: "character", character: revisedHero })]);
    const reviewed = await application.review({ ownerUserId }, job.id, { expectedRevision: job.revision, content: revisedHero, selectedStageIds: [stageId] });
    expect(reviewed.canApply).toBe(false);
    await expect(application.apply({ ownerUserId }, job.id, {
      expectedRevision: reviewed.revision, idempotencyKey: "local-character-must-not-publish", selectedStageIds: [stageId], content: revisedHero
    })).rejects.toMatchObject({ code: "authoring_invalid_state" });
    await expect(pool.query("SELECT count(*)::int AS count FROM worlds WHERE owner_user_id = $1 AND title = $2", [ownerUserId, localParent.world.title]))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });
  });
});
