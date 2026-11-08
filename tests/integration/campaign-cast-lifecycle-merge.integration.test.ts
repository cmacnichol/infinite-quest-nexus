import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { castAuthoredPathSchema } from "../../packages/contracts/src/campaign-cast.js";
import { createPostgresCampaignCastRepository } from "../../packages/database/src/campaign-cast-repository.js";

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration("cast lifecycle merge", () => {
  let pool: DatabasePool, ownerUserId: string;
  beforeAll(async () => { pool = createDatabasePool(process.env.TEST_DATABASE_URL!, 8); await migrateDatabase(pool, resolve("database/migrations")); ownerUserId = await initialOwnerId(pool); }, 60_000);
  afterAll(async () => { await pool?.end(); });
  it("reserves removed names and aliases for restore even when lifecycle writes are disabled", async () => {
    const world = randomUUID(), version = randomUUID(), campaignId = randomUUID(), scope = { ownerUserId, campaignId };
    await pool.query("INSERT INTO worlds(id,owner_user_id,title) VALUES($1,$2,'Names')", [world, ownerUserId]);
    await pool.query("INSERT INTO world_versions(id,world_id,owner_user_id,version_number,content) VALUES($1,$2,$3,1,$4)", [version, world, ownerUserId, { world: { title: "Names" } }]);
    await pool.query("INSERT INTO campaigns(id,owner_user_id,world_version_id,title) VALUES($1,$2,$3,'Names')", [campaignId, ownerUserId, version]);
    const repo = createPostgresCampaignCastRepository(pool, { editingEnabled: true, lifecycleEnabled: true });
    const boundary = { turnNumber: 0, timelineRevision: 0 };
    const original = await repo.create(scope, { expectedCastRevision: 0, expectedBoundary: boundary, idempotencyKey: randomUUID(), name: "Mara", aliases: ["Moon  Keeper"], profile: {} });
    const removed = await repo.changeRemoval!(scope, original.character.id, "remove", { expectedCastRevision: original.revision, expectedBoundary: boundary, expectedCharacterRevision: original.character.revision, idempotencyKey: randomUUID() });
    const disabled = createPostgresCampaignCastRepository(pool, { editingEnabled: true, lifecycleEnabled: false });
    for (const [name, aliases] of [["ＭＡＲＡ", []], ["Other", ["moon keeper"]]] as const) {
      await expect(disabled.create(scope, { expectedCastRevision: removed.revision, expectedBoundary: boundary, idempotencyKey: randomUUID(), name, aliases: [...aliases], profile: {} })).rejects.toMatchObject({ code: "cast_character_removed" });
    }
    await expect(disabled.applyBatch(scope, { boundary, idempotencyKey: randomUUID(), commands: [{ kind: "create", name: "MARA", aliases: [], origin: { kind: "manual" } }] })).rejects.toMatchObject({ code: "cast_character_removed" });
    const restored = await repo.changeRemoval!(scope, original.character.id, "restore", { expectedCastRevision: removed.revision, expectedBoundary: boundary, expectedCharacterRevision: removed.character.revision, idempotencyKey: randomUUID() });
    const duplicate = await disabled.create(scope, { expectedCastRevision: restored.revision, expectedBoundary: boundary, idempotencyKey: randomUUID(), name: "Mara", aliases: [], profile: {} });
    expect(duplicate.character.id).not.toBe(original.character.id);
  });
  it("merges seeded authored paths and restores their original values on undo", async () => {
    const world = randomUUID(), version = randomUUID(), campaignId = randomUUID(), scope = { ownerUserId, campaignId };
    const entries = [
      { id: "a", name: "Mara", campaignUse: "supporting", characterText: "", profile: { story: { fearsAndConflicts: "Fear A" }, appearance: { distinguishingFeatures: ["Scar A"] } } },
      { id: "b", name: "Mary", campaignUse: "supporting", characterText: "", profile: { story: { fearsAndConflicts: "Fear B" }, appearance: { distinguishingFeatures: ["Scar B"] } } }
    ];
    await pool.query("INSERT INTO worlds(id,owner_user_id,title) VALUES($1,$2,'Seeds')", [world, ownerUserId]);
    await pool.query("INSERT INTO world_versions(id,world_id,owner_user_id,version_number,content) VALUES($1,$2,$3,1,$4)", [version, world, ownerUserId, JSON.stringify({ world: { title: "Seeds" }, playableCharacters: entries })]);
    await pool.query("INSERT INTO campaigns(id,owner_user_id,world_version_id,title) VALUES($1,$2,$3,'Seeds')", [campaignId, ownerUserId, version]);
    const repo = createPostgresCampaignCastRepository(pool, { editingEnabled: true, lifecycleEnabled: true, castPresetsEnabled: true });
    const boundary = { turnNumber: 0, timelineRevision: 0 };
    const add = async (characterId: string) => { const preview = await repo.fromWorldPreview!(scope, { characterId }); return repo.fromWorld!(scope, { characterId, expectedWorldVersionId: version, expectedCastRevision: preview.castRevision, expectedBoundary: boundary, previewFingerprint: preview.previewFingerprint, idempotencyKey: randomUUID() }); };
    const target = await add("a"), source = await add("b");
    const manual = await repo.create(scope, { expectedCastRevision: source.revision, expectedBoundary: boundary, idempotencyKey: randomUUID(), name: "Other", aliases: [], profile: {} });
    const swapped = await repo.mergePreview!(scope, manual.character.id, target.character.id);
    expect(swapped.target.character.id).toBe(target.character.id);
    expect(swapped.source.character.id).toBe(manual.character.id);
    const detail = await repo.detail(scope, target.character.id), other = await repo.detail(scope, source.character.id);
    const preview = await repo.mergePreview!(scope, detail.character.id, other.character.id);
    expect(preview.fields.map(field => field.path)).toEqual(expect.arrayContaining([...castAuthoredPathSchema.options]));
    expect(preview.fields.find(field => field.path === "appearance.distinguishingFeatures")).toMatchObject({ source: ["Scar B"], allowedChoices: ["target", "source"] });
    const merged = await repo.merge!(scope, detail.character.id, { expectedCastRevision: detail.revision, expectedBoundary: boundary, idempotencyKey: randomUUID(), sourceCharacterId: other.character.id, expectedCharacterRevision: detail.character.revision, expectedSourceCharacterRevision: other.character.revision, reviewedAliases: ["Mary"], choices: { "story.fearsAndConflicts": "source", "appearance.distinguishingFeatures": "source" } });
    expect(merged.character.campaignProfile?.story.fearsAndConflicts).toBe("Fear B");
    expect(merged.character.campaignProfile?.appearance.distinguishingFeatures).toEqual(["Scar B"]);
    const hidden = (await repo.current(scope)).characters.find(person => person.id === other.character.id)!;
    const undone = await repo.unmerge!(scope, detail.character.id, { expectedCastRevision: merged.revision, expectedBoundary: boundary, idempotencyKey: randomUUID(), expectedCharacterRevision: merged.character.revision, expectedSourceCharacterRevision: hidden.revision, mergeEventId: merged.character.activeMerges![0]!.mergeEventId });
    expect(undone.character.campaignProfile?.story.fearsAndConflicts).toBe("Fear A");
    expect(undone.character.campaignProfile?.appearance.distinguishingFeatures).toEqual(["Scar A"]);
    const restoredSource = await repo.detail(scope, source.character.id);
    const again = await repo.merge!(scope, target.character.id, { expectedCastRevision: undone.revision, expectedBoundary: boundary, expectedCharacterRevision: undone.character.revision, expectedSourceCharacterRevision: restoredSource.character.revision, sourceCharacterId: source.character.id, reviewedAliases: ["Mary"], choices: { "story.fearsAndConflicts": "target", "appearance.distinguishingFeatures": "target" }, idempotencyKey: randomUUID() });
    const dependent = await repo.merge!(scope, target.character.id, { expectedCastRevision: again.revision, expectedBoundary: boundary, expectedCharacterRevision: again.character.revision, expectedSourceCharacterRevision: (await repo.detail(scope, manual.character.id)).character.revision, sourceCharacterId: manual.character.id, reviewedAliases: ["Mary", "Other"], choices: {}, idempotencyKey: randomUUID() });
    const firstEvent = again.character.activeMerges![0]!.mergeEventId;
    expect(dependent.character.activeMerges!.find(item => item.mergeEventId === firstEvent)?.canUndo).toBe(false);
    await expect(repo.unmergePreview!(scope, target.character.id, firstEvent)).rejects.toMatchObject({ code: "cast_invalid_request" });
  });
  it("merges, previews undo without writes, and restores independent later edits", async () => {
    const world = randomUUID(), version = randomUUID(), campaignId = randomUUID(), scope = { ownerUserId, campaignId };
    await pool.query("INSERT INTO worlds(id,owner_user_id,title) VALUES($1,$2,'Merge')", [world, ownerUserId]);
    await pool.query("INSERT INTO world_versions(id,world_id,owner_user_id,version_number,content) VALUES($1,$2,$3,1,'{}')", [version, world, ownerUserId]);
    await pool.query("INSERT INTO campaigns(id,owner_user_id,world_version_id,title) VALUES($1,$2,$3,'Merge')", [campaignId, ownerUserId, version]);
    const repo = createPostgresCampaignCastRepository(pool, { editingEnabled: true, lifecycleEnabled: true });
    const boundary = { turnNumber: 0, timelineRevision: 0 };
    const first = await repo.create(scope, { expectedCastRevision: 0, expectedBoundary: boundary, idempotencyKey: randomUUID(), name: "Mara", aliases: [], profile: {} });
    const second = await repo.create(scope, { expectedCastRevision: first.revision, expectedBoundary: boundary, idempotencyKey: randomUUID(), name: "Mary", aliases: [], profile: {} });
    const target = await repo.detail(scope, first.character.id), source = await repo.detail(scope, second.character.id);
    const request = { expectedCastRevision: second.revision, expectedBoundary: boundary, idempotencyKey: randomUUID(), sourceCharacterId: source.character.id, expectedCharacterRevision: target.character.revision, expectedSourceCharacterRevision: source.character.revision, reviewedAliases: ["Mary"], choices: {} };
    await expect(repo.mergePreview!(scope, target.character.id, target.character.id)).rejects.toMatchObject({ code: "cast_merge_invalid" });
    await expect(repo.merge!(scope, target.character.id, { ...request, reviewedAliases: ["Forged"] })).rejects.toMatchObject({ code: "cast_merge_invalid" });
    await expect(repo.merge!(scope, target.character.id, { ...request, choices: { "story.role": "source" } })).rejects.toMatchObject({ code: "cast_merge_invalid" });
    await expect(repo.merge!(scope, target.character.id, { ...request, expectedCastRevision: 999 })).rejects.toMatchObject({ code: "cast_revision_conflict" });
    const merged = await repo.merge!(scope, target.character.id, request);
    expect(merged.character.aliases).toEqual(["Mary"]);
    const edited = await repo.edit(scope, target.character.id, { expectedCastRevision: merged.revision, expectedCharacterRevision: merged.character.revision, expectedBoundary: boundary, idempotencyKey: randomUUID(), aliases: ["Mary", "M"] });
    const removedAlias = await repo.edit(scope, target.character.id, { expectedCastRevision: edited.revision, expectedCharacterRevision: edited.character.revision, expectedBoundary: boundary, idempotencyKey: randomUUID(), aliases: ["M"] });
    const reentered = await repo.edit(scope, target.character.id, { expectedCastRevision: removedAlias.revision, expectedCharacterRevision: removedAlias.character.revision, expectedBoundary: boundary, idempotencyKey: randomUUID(), aliases: ["M", "Mary"] });
    const state = await repo.current(scope), hidden = state.characters.find(person => person.id === source.character.id)!;
    expect(hidden.mergedIntoCharacterId).toBe(target.character.id);
    const eventId = edited.character.activeMerges![0]!.mergeEventId;
    const before = (await pool.query("SELECT count(*)::int AS n FROM campaign_cast_events WHERE campaign_id=$1", [campaignId])).rows[0].n;
    const preview = await repo.unmergePreview!(scope, target.character.id, eventId);
    expect(preview.target.aliases).toEqual(["M", "Mary"]);
    expect(preview.source.mergedIntoCharacterId).toBeNull();
    expect((await pool.query("SELECT count(*)::int AS n FROM campaign_cast_events WHERE campaign_id=$1", [campaignId])).rows[0].n).toBe(before);
    expect((await repo.current(scope)).revision).toBe(state.revision);
    expect(preview.revision).toBe(state.revision);
    const undone = await repo.unmerge!(scope, target.character.id, { expectedCastRevision: state.revision, expectedBoundary: boundary, idempotencyKey: randomUUID(), expectedCharacterRevision: reentered.character.revision, expectedSourceCharacterRevision: hidden.revision, mergeEventId: eventId });
    expect(undone.character.aliases).toEqual(["M", "Mary"]);
    expect((await repo.current(scope)).characters.find(person => person.id === source.character.id)?.mergedIntoCharacterId).toBeNull();
  });
});
