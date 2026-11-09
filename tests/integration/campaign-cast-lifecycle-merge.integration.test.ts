import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, withTransaction, type DatabasePool } from "../../packages/database/src/pool.js";
import { applyCastBoundaryChange } from "../../packages/database/src/campaign-cast-lifecycle.js";
import { exportCampaignCast, importCampaignCast } from "../../packages/database/src/campaign-cast-portability.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { castAuthoredPathSchema, portableCampaignCastSchema } from "../../packages/contracts/src/campaign-cast.js";
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
    await expect(repo.unmerge!(scope, target.character.id, { expectedCastRevision: state.revision, expectedBoundary: boundary, idempotencyKey: randomUUID(), expectedCharacterRevision: reentered.character.revision, expectedSourceCharacterRevision: hidden.revision, mergeEventId: eventId, reviewedAliases: ["M"] })).rejects.toMatchObject({ code: "cast_merge_invalid" });
    const undone = await repo.unmerge!(scope, target.character.id, { expectedCastRevision: state.revision, expectedBoundary: boundary, idempotencyKey: randomUUID(), expectedCharacterRevision: reentered.character.revision, expectedSourceCharacterRevision: hidden.revision, mergeEventId: eventId });
    expect(undone.character.aliases).toEqual(["M", "Mary"]);
    expect((await repo.current(scope)).characters.find(person => person.id === source.character.id)?.mergedIntoCharacterId).toBeNull();
  });

  async function seededCampaign(entries: unknown[]) {
    const world = randomUUID(), version = randomUUID(), campaignId = randomUUID(), scope = { ownerUserId, campaignId };
    const content = { world: { title: "Seeds" }, playableCharacters: entries };
    await pool.query("INSERT INTO worlds(id,owner_user_id,title) VALUES($1,$2,'Seeds')", [world, ownerUserId]);
    await pool.query("INSERT INTO world_versions(id,world_id,owner_user_id,version_number,content) VALUES($1,$2,$3,1,$4)", [version, world, ownerUserId, JSON.stringify(content)]);
    await pool.query("INSERT INTO campaigns(id,owner_user_id,world_version_id,title) VALUES($1,$2,$3,'Seeds')", [campaignId, ownerUserId, version]);
    const repo = createPostgresCampaignCastRepository(pool, { editingEnabled: true, lifecycleEnabled: true, castPresetsEnabled: true });
    const boundary = { turnNumber: 0, timelineRevision: 0 };
    const add = async (characterId: string) => { const preview = await repo.fromWorldPreview!(scope, { characterId }); return repo.fromWorld!(scope, { characterId, expectedWorldVersionId: version, expectedCastRevision: preview.castRevision, expectedBoundary: boundary, previewFingerprint: preview.previewFingerprint, idempotencyKey: randomUUID() }); };
    return { world, version, scope, repo, boundary, add, content };
  }
  it("reviews overflowing undo aliases, preserves later edits, and replays the decision across import and rewind", async () => {
    const { repo, scope, boundary } = await seededCampaign([]);
    const base = { expectedBoundary: boundary, idempotencyKey: randomUUID() };
    const aliases = Array.from({ length: 20 }, (_, index) => "Port alias " + (index + 1));
    const target = await repo.create(scope, { ...base, expectedCastRevision: 0, name: "Mara", aliases, profile: {} });
    const id = target.character.id;
    const source = await repo.create(scope, { ...base, idempotencyKey: randomUUID(), expectedCastRevision: target.revision, name: "Mary", aliases: [], profile: {} });
    const merged = await repo.merge!(scope, id, { ...base, idempotencyKey: randomUUID(), expectedCastRevision: source.revision,
      expectedCharacterRevision: target.character.revision, sourceCharacterId: source.character.id, expectedSourceCharacterRevision: source.character.revision,
      reviewedAliases: aliases.slice(0, 19), choices: {} });
    const laterAliases = [...aliases.slice(0, 19), "Harbor guide"];
    const edited = await repo.edit(scope, id, { ...base, idempotencyKey: randomUUID(), expectedCastRevision: merged.revision,
      expectedCharacterRevision: merged.character.revision, name: "Captain Mara", aliases: laterAliases, setOverrides: { "story.role": "Navigator" } });
    const event = merged.character.activeMerges![0]!.mergeEventId;
    await pool.query("UPDATE campaigns SET active_turn_number=1 WHERE id=$1", [scope.campaignId]);
    const preview = await repo.unmergePreview!(scope, id, event);
    expect(preview.target).toMatchObject({ name: "Captain Mara", profile: { "story.role": "Navigator" }, aliases: [...aliases, "Harbor guide"] });
    const undo = { expectedBoundary: preview.boundary, expectedCastRevision: preview.revision, expectedCharacterRevision: preview.expectedCharacterRevision,
      expectedSourceCharacterRevision: preview.expectedSourceCharacterRevision, mergeEventId: event, idempotencyKey: randomUUID() };
    for (const selection of [undefined, ["Invented"], [aliases[0]!, aliases[0]!]]) {
      await expect(repo.unmerge!(scope, id, { ...undo, reviewedAliases: selection })).rejects.toMatchObject({ code: "cast_merge_invalid" });
    }
    await expect(repo.unmerge!(scope, id, { ...undo, reviewedAliases: preview.target.aliases })).rejects.toThrow();
    expect((await repo.current(scope)).revision).toBe(edited.revision);
    const reviewedAliases = preview.target.aliases.slice(1);
    const request = { ...undo, reviewedAliases };
    const result = await repo.unmerge!(scope, id, request);
    expect(result.character).toMatchObject({ aliases: reviewedAliases, name: "Captain Mara", profile: { "story.role": "Navigator" }, activeMerges: [] });
    expect(await repo.unmerge!(scope, id, request)).toEqual(result);
    await expect(repo.unmerge!(scope, id, { ...request, reviewedAliases: [] })).rejects.toMatchObject({ code: "cast_idempotency_conflict" });
    const archived = await withTransaction(pool, client => exportCampaignCast(client, scope));
    expect(archived?.formatVersion).toBe(4);
    for (const change of [{ aliases: ["Invented"] }, { name: "Unreviewed rename" }, { aliases: [reviewedAliases[0], reviewedAliases[0]] }]) {
      const forged = structuredClone(archived!);
      Object.assign(forged.events.at(-1)!.commands[1]!.command, change);
      expect(portableCampaignCastSchema.safeParse(forged).success).toBe(false);
    }
    const dest = await seededCampaign([]);
    await pool.query("UPDATE campaigns SET active_turn_number=1 WHERE id=$1", [dest.scope.campaignId]);
    await withTransaction(pool, client => importCampaignCast(client, dest.scope, archived, { worlds: new Map(), turns: new Map() }));
    expect((await dest.repo.current(dest.scope)).characters.find(person => person.name === "Captain Mara")).toMatchObject({ aliases: reviewedAliases, activeMerges: [] });
    await withTransaction(pool, async client => {
      await client.query("UPDATE campaigns SET active_turn_number=0 WHERE id=$1", [scope.campaignId]);
      await applyCastBoundaryChange(client, scope, { turnNumber: 0, changeKey: randomUUID() });
    });
    expect((await repo.detail(scope, id)).character).toMatchObject({ aliases: laterAliases, activeMerges: [{ mergeEventId: event }] });
  });
  const npc = (id: string, name: string, story: Record<string, string> = {}) => ({ id, name, campaignUse: "supporting", characterText: "", profile: { story } });
  it("keeps exclusions from a reviewed undo independent of an older merge", async () => {
    const { repo, scope, boundary } = await seededCampaign([]);
    const aliases = Array.from({ length: 20 }, (_, index) => "Port alias " + (index + 1));
    const laterAliases = Array.from({ length: 20 }, (_, index) => "Market alias " + (index + 1));
    const create = (name: string, aliases: string[], expectedCastRevision: number) => repo.create(scope, {
      expectedBoundary: boundary, expectedCastRevision, idempotencyKey: randomUUID(), name, aliases, profile: {}
    });
    const target = await create("Mara", ["Original", ...aliases.slice(1)], 0);
    const source = await create(aliases[0]!, [], target.revision), other = await create("Mary", [], source.revision);
    const id = target.character.id;
    const merge = (sourceCharacterId: string, expectedSourceCharacterRevision: number, expectedCastRevision: number, expectedCharacterRevision: number, reviewedAliases: string[]) =>
      repo.merge!(scope, id, { sourceCharacterId, expectedSourceCharacterRevision, expectedCastRevision, expectedCharacterRevision, reviewedAliases,
        expectedBoundary: boundary, idempotencyKey: randomUUID(), choices: {} });
    const first = await merge(source.character.id, source.character.revision, other.revision, target.character.revision, aliases);
    const second = await merge(other.character.id, other.character.revision, first.revision, first.character.revision, []);
    await repo.edit(scope, id, { expectedBoundary: boundary, expectedCastRevision: second.revision,
      expectedCharacterRevision: second.character.revision, idempotencyKey: randomUUID(), aliases: laterAliases });
    const undo = async (mergeEventId: string, reviewedAliases?: string[]) => {
      const p = await repo.unmergePreview!(scope, id, mergeEventId);
      return repo.unmerge!(scope, id, { mergeEventId, reviewedAliases, expectedBoundary: p.boundary, expectedCastRevision: p.revision,
        expectedSourceCharacterRevision: p.expectedSourceCharacterRevision, expectedCharacterRevision: p.expectedCharacterRevision, idempotencyKey: randomUUID() });
    };
    const event = second.character.activeMerges!.find(item => item.sourceCharacterId === other.character.id)!.mergeEventId;
    expect((await repo.unmergePreview!(scope, id, event)).target.aliases).toEqual([...aliases, ...laterAliases]);
    const kept = laterAliases.slice(0, 2);
    expect((await undo(event, kept)).character.aliases).toEqual(kept);
    expect((await undo(first.character.activeMerges![0]!.mergeEventId)).character.aliases).toEqual(["Original", ...kept]);
    expect((await withTransaction(pool, client => exportCampaignCast(client, scope)))?.formatVersion).toBe(4);
  });
  async function mergedPair() {
    const f = await seededCampaign([npc("a", "Mara"), npc("b", "Mary")]);
    const target = await f.add("a"), source = await f.add("b");
    const detail = await f.repo.detail(f.scope, target.character.id), other = await f.repo.detail(f.scope, source.character.id);
    const merged = await f.repo.merge!(f.scope, detail.character.id, { expectedCastRevision: detail.revision, expectedBoundary: f.boundary, idempotencyKey: randomUUID(), sourceCharacterId: other.character.id, expectedCharacterRevision: detail.character.revision, expectedSourceCharacterRevision: other.character.revision, reviewedAliases: ["Mary"], choices: {} });
    return { ...f, merged, sourceId: other.character.id };
  }
  it("blocks Not this character on a seed while a merge depends on it (D18)", async () => {
    const f = await mergedPair();
    await expect(f.repo.detachAttachment(f.scope, f.merged.character.id, f.merged.character.originProfile!.seedEventId, { expectedBoundary: f.boundary, expectedCastRevision: f.merged.revision, expectedCharacterRevision: f.merged.character.revision, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "cast_merge_invalid" });
  });
  it("blocks Undo on a removed target and Promote of a removed character (D19)", async () => {
    const f = await mergedPair();
    const removed = await f.repo.changeRemoval!(f.scope, f.merged.character.id, "remove", { expectedCastRevision: f.merged.revision, expectedBoundary: f.boundary, expectedCharacterRevision: f.merged.character.revision, idempotencyKey: randomUUID() });
    const hidden = (await f.repo.current(f.scope)).characters.find(person => person.id === f.sourceId)!;
    await expect(f.repo.unmergePreview!(f.scope, removed.character.id, f.merged.character.activeMerges![0]!.mergeEventId)).rejects.toMatchObject({ code: "cast_character_removed" });
    await expect(f.repo.unmerge!(f.scope, removed.character.id, { expectedCastRevision: removed.revision, expectedBoundary: f.boundary, idempotencyKey: randomUUID(), expectedCharacterRevision: removed.character.revision, expectedSourceCharacterRevision: hidden.revision, mergeEventId: f.merged.character.activeMerges![0]!.mergeEventId })).rejects.toMatchObject({ code: "cast_character_removed" });
    await pool.query("INSERT INTO world_drafts(world_id,owner_user_id,revision,content) VALUES($1,$2,1,$3::jsonb)", [f.world, ownerUserId, JSON.stringify(f.content)]);
    await expect(f.repo.promotionPreview!(f.scope, removed.character.id, f.world)).rejects.toMatchObject({ code: "cast_character_removed" });
  });
  it("keeps editing and context when presets are turned off, and closes from-world (A12)", async () => {
    const f = await seededCampaign([npc("a", "Mara", { role: "Warden" }), npc("b", "Mary")]);
    const seeded = await f.add("a");
    const off = createPostgresCampaignCastRepository(pool, { editingEnabled: true, lifecycleEnabled: true, castPresetsEnabled: false });
    const saved = await off.editAuthoredProfile!(f.scope, seeded.character.id, { expectedCastRevision: seeded.revision, expectedCharacterRevision: seeded.character.revision, expectedBoundary: f.boundary, idempotencyKey: randomUUID(), set: { "story.role": "Captain" } });
    expect(saved.character.campaignProfile?.story.role).toBe("Captain");
    expect((await off.current(f.scope)).characters.find(person => person.id === seeded.character.id)?.profile["story.role"]).toBe("Captain");
    await expect(off.fromWorldPreview!(f.scope, { characterId: "b" })).rejects.toMatchObject({ code: "cast_presets_disabled" });
  });
  it("rejects Restore authored goals without an authored goal", async () => {
    const f = await seededCampaign([npc("a", "Mara")]);
    const seeded = await f.add("a");
    await expect(f.repo.editAuthoredProfile!(f.scope, seeded.character.id, { expectedCastRevision: seeded.revision, expectedCharacterRevision: seeded.character.revision, expectedBoundary: f.boundary, idempotencyKey: randomUUID(), restoreAuthoredGoals: true })).rejects.toMatchObject({ code: "cast_invalid_request" });
  });
  it("marks mechanics text unselectable and keeps source on Replace", async () => {
    const f = await seededCampaign([npc("a", "Mara", { role: "Rolls 2d6 for hits", personality: "Stoic" })]);
    const seeded = await f.add("a");
    const draftEntry = { id: "w", name: "Mara", characterText: "", campaignUse: "supporting", source: { type: "manual" } };
    await pool.query("INSERT INTO world_drafts(world_id,owner_user_id,revision,content) VALUES($1,$2,1,$3::jsonb)", [f.world, ownerUserId, JSON.stringify({ ...f.content, playableCharacters: [draftEntry] })]);
    const preview = await f.repo.promotionPreview!(f.scope, seeded.character.id, f.world);
    const role = preview.destinations.find(item => item.path === "story.role")!;
    expect(role.candidates[0]).toMatchObject({ unselectableReason: "mechanics_language" });
    expect(role.tickedByDefault).toBe(false);
    const base = { worldId: f.world, expectedDraftRevision: preview.draftRevision, expectedCastRevision: preview.castRevision, expectedBoundary: preview.boundary, expectedCharacterRevision: preview.characterRevision, mode: "replace" as const, targetCharacterId: "w" };
    await expect(f.repo.promote!(f.scope, seeded.character.id, { ...base, idempotencyKey: randomUUID(), selections: [{ destinationPath: "story.role", sourcePath: role.candidates[0]!.sourcePath }] })).rejects.toMatchObject({ code: "cast_invalid_request" });
    await f.repo.promote!(f.scope, seeded.character.id, { ...base, idempotencyKey: randomUUID(), selections: [{ destinationPath: "story.personality", sourcePath: "authored.story.personality" }] });
    const stored = (await pool.query("SELECT content FROM world_drafts WHERE world_id=$1", [f.world])).rows[0]!.content;
    expect(stored.playableCharacters[0]).toMatchObject({ source: { type: "manual" }, profile: { story: { personality: "Stoic" } } });
  });
});
