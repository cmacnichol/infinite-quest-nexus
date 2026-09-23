import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresCampaignCastRepository } from "../../packages/database/src/campaign-cast-repository.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { sha256 } from "../../packages/domain/src/text.js";

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration("campaign cast PostgreSQL foundation", () => {
  let pool: DatabasePool;
  let ownerUserId: string;
  beforeAll(async () => {
    pool = createDatabasePool(process.env.TEST_DATABASE_URL!, 8);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  }, 60_000);
  afterAll(async () => { await pool?.end(); });

  async function fixture() {
    const worldId = randomUUID(), worldVersionId = randomUUID(), campaignId = randomUUID();
    await pool.query("INSERT INTO worlds(id,owner_user_id,title) VALUES($1,$2,'Cast fixture')", [worldId, ownerUserId]);
    await pool.query("INSERT INTO world_versions(id,world_id,owner_user_id,version_number,content) VALUES($1,$2,$3,1,$4)",
      [worldVersionId, worldId, ownerUserId, JSON.stringify({ entities: [{ id: "mara", name: "Mara" }] })]);
    await pool.query("INSERT INTO campaigns(id,owner_user_id,world_version_id,title,active_turn_number,character_profile) VALUES($1,$2,$3,'Cast fixture',2,$4)",
      [campaignId, ownerUserId, worldVersionId, JSON.stringify({ name: "Iven", profile: { story: { role: "courier" } } })]);
    const turns = [];
    for (const n of [1, 2]) {
      const turnId = randomUUID();
      const narration = n === 1 ? "Mara has blue eyes. She waits in the forest." : "Mara waits at the harbor.";
      await pool.query("INSERT INTO turns(id,owner_user_id,campaign_id,turn_number,narration) VALUES($1,$2,$3,$4,$5)", [turnId, ownerUserId, campaignId, n, narration]);
      turns.push({ kind: "turn" as const, turnId, turnNumber: n, narrationRevision: 0, sourceHash: sha256(narration), paragraphId: "p1", quote: narration });
    }
    return { scope: { ownerUserId, campaignId }, worldVersionId, evidence: turns[0]!, later: turns[1]!, boundary: { turnNumber: 2, timelineRevision: 0 } };
  }

  it("initializes one linked protagonist concurrently without copying its profile", async () => {
    const { scope, boundary } = await fixture();
    const repo = createPostgresCampaignCastRepository(pool);
    const snapshots = await Promise.all([repo.initialize(scope), repo.initialize(scope)]);
    expect(snapshots[0]!.characters[0]!.id).toBe(snapshots[1]!.characters[0]!.id);
    expect(snapshots[0]!.characters[0]).toMatchObject({ name: "Iven", origin: { kind: "protagonist", selectedCharacterId: null }, profile: { "story.role": "courier" } });
    expect((await pool.query("SELECT count(*)::int n FROM campaign_cast_profiles WHERE campaign_id=$1", [scope.campaignId])).rows[0].n).toBe(0);
    await pool.query("UPDATE campaigns SET character_profile=$2 WHERE id=$1", [scope.campaignId, JSON.stringify({ name: "Iven", profile: { story: { role: "sailor" } } })]);
    expect((await repo.loadSnapshot(scope, boundary)).characters[0]!.profile["story.role"]).toBe("sailor");
  });

  it("keeps identical names distinct and replays a batch without creating duplicates", async () => {
    const { scope, boundary } = await fixture();
    const repo = createPostgresCampaignCastRepository(pool);
    const request = { boundary, idempotencyKey: "create-two", commands: [
      { kind: "create" as const, name: "Mara", aliases: [], origin: { kind: "manual" as const } },
      { kind: "create" as const, name: "Mara", aliases: [], origin: { kind: "manual" as const } }
    ] };
    const receipt = await repo.applyBatch(scope, request);
    expect(receipt.characterIds).toHaveLength(2);
    expect(new Set(receipt.characterIds).size).toBe(2);
    expect(await repo.applyBatch(scope, request)).toEqual(receipt);
    expect((await repo.loadSnapshot(scope, boundary)).characters.filter((c) => c.name === "Mara")).toHaveLength(2);
    await expect(repo.applyBatch(scope, { ...request, commands: [request.commands[0]!] })).rejects.toThrow(/idempotency/i);
  });

  it("rebuilds observations and blank overrides and respects the requested historical boundary", async () => {
    const { scope, boundary, evidence, later } = await fixture();
    const repo = createPostgresCampaignCastRepository(pool);
    const receipt = await repo.applyBatch(scope, { boundary, idempotencyKey: "discover", commands: [
      { kind: "create", name: "Mara", aliases: [], origin: { kind: "discovered" }, evidence }
    ] });
    const characterId = receipt.characterIds[0]!;
    await repo.applyBatch(scope, { boundary, idempotencyKey: "observe", commands: [
      { kind: "observe", characterId, field: "appearance.description", value: "blue eyes", mode: "fact", speakerCharacterId: null, evidence, supersedesObservationId: null },
      { kind: "observe", characterId, field: "state.location", value: "forest", mode: "fact", speakerCharacterId: null, evidence, supersedesObservationId: null },
      { kind: "observe", characterId, field: "state.location", value: "harbor", mode: "fact", speakerCharacterId: null, evidence: later, supersedesObservationId: null }
    ] });
    await repo.applyBatch(scope, { boundary, idempotencyKey: "blank", commands: [
      { kind: "override", characterId, field: "appearance.description", value: "" }
    ] });
    const before = await repo.loadSnapshot(scope, boundary);
    const person = before.characters.find((c) => c.id === characterId)!;
    expect(person.profile).toEqual({ "appearance.description": "", "state.location": "harbor" });
    await pool.query("DELETE FROM campaign_cast_profiles WHERE campaign_id=$1", [scope.campaignId]);
    expect(await repo.rebuild(scope)).toEqual(before);
    expect((await repo.loadSnapshot(scope, { turnNumber: 1, timelineRevision: 0 })).characters.find((c) => c.id === characterId)!.profile)
      .toEqual({ "appearance.description": "blue eyes", "state.location": "forest" });
  });

  it("invalidates corrected narration and rejects stale evidence on writes", async () => {
    const { scope, boundary, evidence } = await fixture();
    const repo = createPostgresCampaignCastRepository(pool);
    const created = await repo.applyBatch(scope, { boundary, idempotencyKey: "manual", commands: [{ kind: "create", name: "Mara", aliases: [], origin: { kind: "manual" } }] });
    const command = { kind: "observe" as const, characterId: created.characterIds[0]!, field: "appearance.description" as const, value: "blue eyes", mode: "fact" as const, speakerCharacterId: null, evidence, supersedesObservationId: null };
    await repo.applyBatch(scope, { boundary, idempotencyKey: "observe", commands: [command] });
    await pool.query(`INSERT INTO turn_narration_corrections(owner_user_id,campaign_id,turn_id,revision,narration,previous_effective_narration_hash,source,created_by_user_id)
      VALUES($1,$2,$3,1,'Mara has brown eyes.',$4,'user_edit',$1)`, [ownerUserId, scope.campaignId, evidence.turnId, evidence.sourceHash]);
    expect((await repo.rebuild(scope)).characters.find((c) => c.id === command.characterId)!.profile).toEqual({});
    await expect(repo.applyBatch(scope, { boundary, idempotencyKey: "stale-source", commands: [command] })).rejects.toThrow(/evidence/i);
  });

  it("rejects foreign ownership, foreign characters, foreign evidence, and stale boundaries atomically", async () => {
    const a = await fixture(), b = await fixture();
    const repo = createPostgresCampaignCastRepository(pool);
    const created = await repo.applyBatch(a.scope, { boundary: a.boundary, idempotencyKey: "manual", commands: [{ kind: "create", name: "Mara", aliases: [], origin: { kind: "manual" } }] });
    await expect(repo.loadSnapshot({ ...a.scope, ownerUserId: randomUUID() }, a.boundary)).rejects.toThrow(/not found/i);
    await expect(repo.applyBatch(b.scope, { boundary: b.boundary, idempotencyKey: "foreign-character", commands: [{ kind: "override", characterId: created.characterIds[0]!, field: "story.role", value: "queen" }] })).rejects.toThrow();
    await expect(repo.applyBatch(a.scope, { boundary: a.boundary, idempotencyKey: "foreign-source", commands: [{ kind: "create", name: "Mara", aliases: [], origin: { kind: "discovered" }, evidence: b.evidence }] })).rejects.toThrow(/evidence/i);
    await expect(repo.applyBatch(a.scope, { boundary: { ...a.boundary, timelineRevision: 1 }, idempotencyKey: "stale", commands: [{ kind: "create", name: "New", aliases: [], origin: { kind: "manual" } }] })).rejects.toThrow(/boundary/i);
    expect((await repo.loadSnapshot(a.scope, a.boundary)).characters).toHaveLength(2);
  });

  it("enforces source and supersession campaign relationships in PostgreSQL", async () => {
    const a = await fixture(), b = await fixture();
    const repo = createPostgresCampaignCastRepository(pool);
    const created = await repo.applyBatch(a.scope, { boundary: a.boundary, idempotencyKey: "manual", commands: [{ kind: "create", name: "Mara", aliases: [], origin: { kind: "manual" } }] });
    const eventId = (await pool.query("SELECT id FROM campaign_cast_events WHERE campaign_id=$1 AND idempotency_key='manual'", [a.scope.campaignId])).rows[0].id;
    await expect(pool.query(`INSERT INTO campaign_cast_observations(id,owner_user_id,campaign_id,character_id,event_id,field,value,mode,evidence)
      VALUES($1,$2,$3,$4,$5,'story.role','courier','fact',$6)`, [randomUUID(), ownerUserId, a.scope.campaignId, created.characterIds[0], eventId, JSON.stringify(b.evidence)])).rejects.toMatchObject({ code: "23503" });
    await expect(pool.query(`INSERT INTO campaign_cast_characters(id,owner_user_id,campaign_id,origin,first_observed_turn)
      VALUES($1,$2,$3,$4,0)`, [randomUUID(), randomUUID(), a.scope.campaignId, JSON.stringify({ kind: "manual" })])).rejects.toMatchObject({ code: "23503" });
  });

  it("admits a world occurrence once, and never mutates the world or protagonist through cast events", async () => {
    const { scope, boundary, worldVersionId } = await fixture();
    const repo = createPostgresCampaignCastRepository(pool);
    const command = { kind: "create" as const, name: "Mara", aliases: [], origin: { kind: "world" as const, worldVersionId, entityId: "mara" }, evidence: { kind: "world" as const, worldVersionId, sourcePath: "/entities/0" } };
    await repo.applyBatch(scope, { boundary, idempotencyKey: "world", commands: [command] });
    expect((await repo.loadSnapshot(scope, { turnNumber: 1, timelineRevision: 0 })).characters.map((c) => c.name)).toEqual(["Iven"]);
    await expect(repo.applyBatch(scope, { boundary, idempotencyKey: "duplicate-world", commands: [command] })).rejects.toThrow();
    const protagonist = (await repo.loadSnapshot(scope, boundary)).characters.find((c) => c.origin.kind === "protagonist")!;
    await expect(repo.applyBatch(scope, { boundary, idempotencyKey: "hero", commands: [{ kind: "override", characterId: protagonist.id, field: "story.role", value: "queen" }] })).rejects.toThrow(/protagonist/i);
    expect((await pool.query("SELECT content FROM world_versions WHERE id=$1", [worldVersionId])).rows[0].content.entities).toEqual([{ id: "mara", name: "Mara" }]);
  });

  it("requires discovered identities to originate in accepted narration, not an arbitrary world object", async () => {
    const { scope, boundary, worldVersionId } = await fixture();
    const repo = createPostgresCampaignCastRepository(pool);
    await expect(repo.applyBatch(scope, { boundary, idempotencyKey: "false-discovery", commands: [{ kind: "create", name: "Invented", aliases: [], origin: { kind: "discovered" }, evidence: { kind: "world", worldVersionId, sourcePath: "/entities/0" } }] })).rejects.toThrow(/evidence/i);
  });

  it("validates event payload shape and restores identity, pin, ignore, and cleared override events", async () => {
    const { scope, boundary, evidence } = await fixture();
    const repo = createPostgresCampaignCastRepository(pool);
    const created = await repo.applyBatch(scope, { boundary, idempotencyKey: "manual", commands: [{ kind: "create", name: "Mara", aliases: [], origin: { kind: "manual" } }] });
    const characterId = created.characterIds[0]!;
    await repo.applyBatch(scope, { boundary, idempotencyKey: "edit", commands: [
      { kind: "observe", characterId, field: "appearance.description", value: "blue eyes", mode: "fact", evidence, speakerCharacterId: null, supersedesObservationId: null },
      { kind: "override", characterId, field: "appearance.description", value: "" },
      { kind: "identity", characterId, name: "Captain Mara", aliases: ["Mara"] },
      { kind: "pin", characterId, value: true }, { kind: "ignore", characterId, value: true },
      { kind: "clear_override", characterId, field: "appearance.description" }
    ] });
    const snapshot = await repo.rebuild(scope);
    expect(snapshot.characters.find((person) => person.id === characterId)).toMatchObject({ name: "Captain Mara", aliases: ["Mara"], pinned: true, ignored: true, profile: { "appearance.description": "blue eyes" } });
    await expect(repo.applyBatch(scope, { boundary, idempotencyKey: "invalid", commands: [{ kind: "override", characterId, field: "story.role", value: "Roll 1d20+4" }] })).rejects.toThrow(/mechanics/i);
    expect(await repo.loadSnapshot(scope, boundary)).toEqual(snapshot);
  });

  it("enforces same-character supersession and rolls back a partially invalid batch", async () => {
    const a = await fixture(), b = await fixture();
    const repo = createPostgresCampaignCastRepository(pool);
    const created = await repo.applyBatch(a.scope, { boundary: a.boundary, idempotencyKey: "manual", commands: [{ kind: "create", name: "Mara", aliases: [], origin: { kind: "manual" } }] });
    const other = await repo.applyBatch(b.scope, { boundary: b.boundary, idempotencyKey: "manual", commands: [{ kind: "create", name: "Mara", aliases: [], origin: { kind: "manual" } }] });
    const source = await repo.applyBatch(b.scope, { boundary: b.boundary, idempotencyKey: "observe", commands: [{ kind: "observe", characterId: other.characterIds[0]!, field: "story.role", value: "courier", mode: "fact", evidence: b.evidence, speakerCharacterId: null, supersedesObservationId: null }] });
    await expect(pool.query(`INSERT INTO campaign_cast_observations(id,owner_user_id,campaign_id,character_id,event_id,field,value,mode,evidence,supersedes_observation_id)
      VALUES($1,$2,$3,$4,$5,'story.role','sailor','fact',$6,$7)`, [randomUUID(), ownerUserId, a.scope.campaignId, created.characterIds[0], created.eventId, JSON.stringify(a.later), source.observationIds[0]])).rejects.toMatchObject({ code: "23503" });
    const before = await repo.loadSnapshot(a.scope, a.boundary);
    await expect(repo.applyBatch(a.scope, { boundary: a.boundary, idempotencyKey: "partial", commands: [
      { kind: "create", name: "New person", aliases: [], origin: { kind: "manual" } },
      { kind: "override", characterId: other.characterIds[0]!, field: "story.role", value: "queen" }
    ] })).rejects.toThrow();
    expect(await repo.loadSnapshot(a.scope, a.boundary)).toEqual(before);
  });

  it("retains user authority and admits fresh evidence when introduction narration is corrected", async () => {
    const { scope, boundary, evidence, later } = await fixture();
    const repo = createPostgresCampaignCastRepository(pool);
    const created = await repo.applyBatch(scope, { boundary, idempotencyKey: "discover", commands: [
      { kind: "create", name: "Mara", aliases: [], origin: { kind: "discovered" }, evidence },
      { kind: "create", name: "Other Mara", aliases: [], origin: { kind: "discovered" }, evidence }
    ] });
    const [editedId, observedId] = created.characterIds as [string, string];
    await repo.applyBatch(scope, { boundary, idempotencyKey: "edit", commands: [{ kind: "override", characterId: editedId, field: "story.role", value: "captain" }] });
    await pool.query(`INSERT INTO turn_narration_corrections(owner_user_id,campaign_id,turn_id,revision,narration,previous_effective_narration_hash,source,created_by_user_id)
      VALUES($1,$2,$3,1,'Mara arrived quietly.',$4,'user_edit',$1)`, [ownerUserId, scope.campaignId, evidence.turnId, evidence.sourceHash]);
    expect((await repo.rebuild(scope)).characters.find((c) => c.id === editedId)?.profile).toEqual({ "story.role": "captain" });
    expect((await repo.loadSnapshot(scope, boundary)).characters.find((c) => c.id === observedId)).toBeUndefined();
    await repo.applyBatch(scope, { boundary, idempotencyKey: "refresh", commands: [{ kind: "observe", characterId: observedId, field: "state.location", value: "harbor", mode: "fact", speakerCharacterId: null, evidence: later, supersedesObservationId: null }] });
    expect((await repo.rebuild(scope)).characters.find((c) => c.id === observedId)?.profile).toEqual({ "state.location": "harbor" });
    expect((await repo.loadSnapshot(scope, { turnNumber: 1, timelineRevision: 0 })).characters.map((c) => c.id)).not.toContain(editedId);
  });
});
