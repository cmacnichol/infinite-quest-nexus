import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createPostgresCampaignCastRepository } from "../../packages/database/src/campaign-cast-repository.js";
import { createCampaignCastApplication } from "../../packages/application/src/campaign-cast/use-cases.js";
import { registerCampaignCastRoutes } from "../../services/api/src/campaign-cast-routes.js";
import { buildServer } from "../../services/api/src/server.js";
import { loadRuntimeConfig } from "../../packages/database/src/config.js";
import { inertStorageServerOptions } from "../helpers/build-server-options.js";

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration("campaign cast editing API", () => {
  let pool: DatabasePool, ownerUserId: string;
  beforeAll(async () => {
    pool = createDatabasePool(process.env.TEST_DATABASE_URL!, 8);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  }, 60_000);
  afterAll(async () => { await pool?.end(); });
  async function fixture(enabled = true, presets = false) {
    const world = randomUUID(), version = randomUUID(), campaignId = randomUUID();
    await pool.query("INSERT INTO worlds(id,owner_user_id,title) VALUES($1,$2,'Cast API')", [world, ownerUserId]);
    await pool.query("INSERT INTO world_versions(id,world_id,owner_user_id,version_number,content) VALUES($1,$2,$3,1,'{}')", [version, world, ownerUserId]);
    await pool.query("INSERT INTO campaigns(id,owner_user_id,world_version_id,title) VALUES($1,$2,$3,'Cast API')", [campaignId, ownerUserId, version]);
    const app = Fastify();
    const application = createCampaignCastApplication(createPostgresCampaignCastRepository(pool, { editingEnabled: enabled, castPresetsEnabled: presets }));
    await app.register(registerCampaignCastRoutes, { application, enabled, resolveOwner: async () => ({ ownerUserId }) });
    const base = `/api/v1/campaigns/${campaignId}/cast`;
    const write = { expectedCastRevision: 0, expectedBoundary: { turnNumber: 0, timelineRevision: 0 }, idempotencyKey: randomUUID() };
    return { app, base, campaignId, version, write };
  }
  it("applies only a freshly previewed profile and returns the original HTTP receipt on retry", async () => {
    const { app, base, version, write } = await fixture(true, true);
    try {
      await pool.query("UPDATE world_versions SET content=$2 WHERE id=$1", [version, JSON.stringify({ world: { title: "Fixture" },
        playableCharacters: [{ id: "keeper", name: "Keeper", campaignUse: "supporting", characterText: "Legacy note",
          profile: { story: { background: "b".repeat(3000) } } }] })]);
      const read = () => app.inject({ method: "GET", url: base + "/from-world-preview?characterId=keeper" });
      const first = await read();
      expect(first.statusCode).toBe(200);
      const save = { ...write, expectedWorldVersionId: version, characterId: "keeper", previewFingerprint: first.json().previewFingerprint };
      const added = await app.inject({ method: "POST", url: base + "/from-world", payload: { ...save, previewFingerprint: "0".repeat(64) } });
      expect(added.json().code).toBe("cast_world_preview_changed");
      expect((await read()).json()).toEqual(first.json());
      const created = await app.inject({ method: "POST", url: base + "/from-world", payload: save });
      expect(created.statusCode).toBe(201);
      const result = created.json();
      const complexText = '界"\\\u0001'.repeat(5000);
      const short = complexText.slice(0, 2000);
      const story = Object.fromEntries(["role", "background", "personality", "motivations", "fearsAndConflicts", "keyRelationships",
        "narrativeHooks", "voiceAndMannerisms", "otherGuidance"].map(key => ["story." + key, complexText]));
      const appearance = Object.fromEntries(["ancestryOrSpecies", "apparentAge", "genderPresentation", "build", "skinOrComplexion", "eyes",
        "face", "hair", "clothing", "equipmentAndAccessories", "otherVisualDetails"].map((key, i) => ["appearance." + key, i < 6 ? short : complexText]));
      const set = { ...story, ...appearance, "identity.pronouns": short, "appearance.distinguishingFeatures": Array(50).fill(short),
        unclassifiedNotes: complexText.repeat(10) };
      const edit = { ...write, idempotencyKey: randomUUID(), expectedCastRevision: result.revision,
        expectedCharacterRevision: result.character.revision, set, aliases: Array.from({ length: 20 }, (_, i) => String(i).padEnd(200, "a")),
        setOverrides: { "story.goals": complexText, "state.location": short, "state.condition": short, "state.clothing": short, "appearance.description": "" } };
      const url = base + "/" + result.character.id + "/authored-profile";
      expect(Buffer.byteLength(JSON.stringify(edit))).toBeGreaterThan(1024 * 1024);
      const saved = await app.inject({ method: "POST", url, payload: edit });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().character.campaignProfile.story.background).toBe(complexText);
      expect((await app.inject({ method: "POST", url, payload: edit })).json()).toEqual(saved.json());
      expect((await app.inject({ method: "POST", url: base + "/from-world", payload: save })).json()).toEqual(result);
      const roster = (await app.inject({ method: "GET", url: base })).json().characters.find((person: { id: string }) => person.id === result.character.id);
      expect(roster.profile["story.background"]).toHaveLength(200);
      expect(roster).not.toHaveProperty("originProfile");
    } finally { await app.close(); }
  });
  it("reads discovery status while editing is disabled and rejects unknown campaigns", async () => {
    const { app, base } = await fixture(false);
    try {
      const response = await app.inject({ method: "GET", url: `${base}/discovery` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ enabled: false, state: "disabled", activeTurnNumber: 0,
        automaticJobs: { queued: 0, runningTurn: null, retryWait: 0, failed: 0, complete: 0 },
        coverageStartTurn: null, trackedThroughTurn: null, unresolvedCount: 0, firstGap: null });
      expect((await app.inject({ method: "GET", url: `/api/v1/campaigns/${randomUUID()}/cast/discovery` })).statusCode).toBe(404);
    } finally { await app.close(); }
  });
  it("creates sparse characters and preserves a blank override and the original replay receipt", async () => {
    const { app, base, write } = await fixture();
    try {
      const created = await app.inject({ method: "POST", url: base, payload: { ...write, name: "Mara", aliases: [], profile: { "appearance.description": "blue eyes" } } });
      expect(created.statusCode).toBe(201);
      const first = created.json();
      expect(first.character).toMatchObject({ name: "Mara", profile: { "appearance.description": "blue eyes" } });
      const edit = { ...write, expectedCastRevision: first.revision, expectedCharacterRevision: first.character.revision,
        idempotencyKey: randomUUID(), setOverrides: { "appearance.description": "" } };
      const saved = await app.inject({ method: "PATCH", url: `${base}/${first.character.id}`, payload: edit });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().character.profile).toEqual({ "appearance.description": "" });
      const renamed = await app.inject({ method: "PATCH", url: `${base}/${first.character.id}`, payload: { ...edit,
        expectedCastRevision: saved.json().revision, expectedCharacterRevision: saved.json().character.revision,
        idempotencyKey: randomUUID(), name: "Mara Reed" } });
      expect(renamed.statusCode).toBe(200);
      expect((await app.inject({ method: "PATCH", url: `${base}/${first.character.id}`, payload: edit })).json()).toEqual(saved.json());
      const detail = await app.inject({ method: "GET", url: `${base}/${first.character.id}` });
      expect(detail.json()).toMatchObject({ character: { name: "Mara Reed", profile: { "appearance.description": "" } }, observations: [], overrides: [{ field: "appearance.description", value: "" }] });
      expect(detail.json().identityEvents.map((event: { name: string }) => event.name)).toEqual(["Mara", "Mara Reed"]);
      expect(detail.json().unresolvedCandidateIds).toEqual([]);
    } finally { await app.close(); }
  });
  it.each([null, "r1"] as const)("publishes effective cast capabilities with Story Memory %s through the production server", async (storyMemoryCapability) => {
    const local = await fixture(); await local.app.close();
    const previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL!;
    const config = { ...loadRuntimeConfig(), systemArchiveEnabled: false, castEditingEnabled: true, castContextEnabled: true, castPresetsEnabled: true, storyMemoryCapability };
    if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
    const application = createCampaignCastApplication(createPostgresCampaignCastRepository(pool, { editingEnabled: true }));
    const app = await buildServer({ ...inertStorageServerOptions({ pool, config }), cast: application });
    try {
      expect((await app.inject({ method: "GET", url: "/api/v1/meta" })).json().capabilities).toMatchObject({ castEditing: true, castContext: Boolean(storyMemoryCapability), castPresets: true });
      const response = await app.inject({ method: "POST", url: local.base, payload: { ...local.write, name: "Mara", aliases: [], profile: {} } });
      expect(response.statusCode).toBe(201);
      expect(response.json().character.name).toBe("Mara");
    } finally { await app.close(); }
  });
  it("clears a blank user override to restore the supported discovered value", async () => {
    const { app, base, campaignId, write } = await fixture();
    try {
      const created = (await app.inject({ method: "POST", url: base, payload: { ...write, name: "Mara", aliases: [], profile: {} } })).json();
      const version = (await pool.query("SELECT world_version_id FROM campaigns WHERE id=$1", [campaignId])).rows[0].world_version_id;
      await pool.query(`UPDATE world_versions SET content='{"appearance":"blue eyes"}' WHERE id=$1`, [version]);
      const repo = createPostgresCampaignCastRepository(pool);
      await repo.applyBatch({ ownerUserId, campaignId }, { boundary: write.expectedBoundary, idempotencyKey: randomUUID(), commands: [{
        kind: "observe", characterId: created.character.id, field: "appearance.description", value: "blue eyes", mode: "fact",
        speakerCharacterId: null, supersedesObservationId: null, evidence: { kind: "world", worldVersionId: version, sourcePath: "/appearance" }
      }] });
      const detail = (await app.inject({ method: "GET", url: `${base}/${created.character.id}` })).json();
      const blank = (await app.inject({ method: "PATCH", url: `${base}/${created.character.id}`, payload: { ...write,
        expectedCastRevision: detail.revision, expectedCharacterRevision: detail.character.revision,
        idempotencyKey: randomUUID(), setOverrides: { "appearance.description": "" } } })).json();
      expect(blank.character.profile).toEqual({ "appearance.description": "" });
      const reset = await app.inject({ method: "PATCH", url: `${base}/${created.character.id}`, payload: { ...write,
        expectedCastRevision: blank.revision, expectedCharacterRevision: blank.character.revision,
        idempotencyKey: randomUUID(), clearOverrides: ["appearance.description"] } });
      expect(reset.statusCode).toBe(200);
      expect(reset.json().character.profile).toEqual({ "appearance.description": "blue eyes" });
      expect((await app.inject({ method: "GET", url: `${base}/${created.character.id}` })).json().overrides).toEqual([]);
    } finally { await app.close(); }
  });
  it("serializes concurrent writes, rejects stale authority and idempotency collisions", async () => {
    const { app, base, write } = await fixture();
    try {
      const responses = await Promise.all(["one", "two"].map((key) => app.inject({ method: "POST", url: base,
        payload: { ...write, idempotencyKey: key, name: "Mara", aliases: [], profile: {} } })));
      expect(responses.map((r) => r.statusCode).sort()).toEqual([201, 409]);
      expect(responses.find((r) => r.statusCode === 409)!.json().code).toBe("cast_revision_conflict");
      const winner = responses.findIndex((r) => r.statusCode === 201);
      const collision = await app.inject({ method: "POST", url: base, payload: { ...write, idempotencyKey: ["one", "two"][winner], name: "Different", aliases: [], profile: {} } });
      expect(collision.statusCode).toBe(409);
      expect(collision.json().code).toBe("cast_idempotency_conflict");
    } finally { await app.close(); }
  });
  it("blocks queued and recoverable generation without changing cast state", async () => {
    const { app, base, campaignId, write } = await fixture();
    try {
      const provider = randomUUID();
      await pool.query(`INSERT INTO provider_profiles(id,owner_user_id,provider_role,name,base_url,default_model,provider_type)
        VALUES($1,$2,'text','Cast test','http://localhost:1234','test','lmstudio')`, [provider, ownerUserId]);
      const job = (await pool.query(`INSERT INTO generation_jobs(owner_user_id,campaign_id,provider_profile_id,idempotency_key,expected_turn_number,action,status)
        VALUES($1,$2,$3,$4,1,'Continue','queued') RETURNING id`, [ownerUserId, campaignId, provider, randomUUID()])).rows[0];
      for (const status of ["queued", "recoverable"]) {
        await pool.query("UPDATE generation_jobs SET status=$2 WHERE id=$1", [job.id, status]);
        const response = await app.inject({ method: "POST", url: base, payload: { ...write, name: "Mara", aliases: [], profile: {} } });
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe("cast_generation_active");
      }
      expect((await app.inject({ method: "GET", url: base })).json().revision).toBe(0);
    } finally { await app.close(); }
  });
  it("keeps same names distinct, paginates aliases and handles markup as data", async () => {
    const { app, base, write } = await fixture();
    try {
      const first = (await app.inject({ method: "POST", url: base, payload: { ...write, name: "Mara", aliases: ["River"], profile: {} } })).json();
      const second = await app.inject({ method: "POST", url: base, payload: { ...write, expectedCastRevision: first.revision,
        idempotencyKey: randomUUID(), name: "Mara", aliases: ["River"], profile: { "story.background": "<img src=x onerror=alert(1)>" } } });
      expect(second.statusCode).toBe(201);
      expect(second.json().character.id).not.toBe(first.character.id);
      expect(second.json().character.profile["story.background"]).toBe("<img src=x onerror=alert(1)>");
      const page = (await app.inject({ method: "GET", url: `${base}?query=River&limit=1` })).json();
      const next = (await app.inject({ method: "GET", url: `${base}?query=River&limit=1&cursor=${page.nextCursor}` })).json();
      expect(page.characters).toHaveLength(1);
      expect(next.characters).toHaveLength(1);
      expect(next.characters[0].id).not.toBe(page.characters[0].id);
      expect(next.nextCursor).toBeNull();
      const main = (await app.inject({ method: "GET", url: `${base}?filter=main` })).json();
      expect(main.characters.every((person: any) => person.origin.kind === "protagonist")).toBe(true);
      const pinned = (await app.inject({ method: "GET", url: `${base}?filter=pinned` })).json();
      expect(pinned.characters).toEqual([]);
      const stale = await app.inject({ method: "GET", url: `${base}?cursor=${page.nextCursor}&expectedRevision=0` });
      expect(stale.statusCode).toBe(409);
      const staleBoundary = await app.inject({ method: "GET", url: `${base}?cursor=${page.nextCursor}&expectedRevision=${page.revision}&expectedTurnNumber=1&expectedTimelineRevision=0` });
      expect(staleBoundary.statusCode).toBe(409);
      const status = await app.inject({ method: "GET", url: `${base}/workspace-status` });
      expect(status.statusCode).toBe(200);
      const repeatedStatus = await app.inject({ method: "GET", url: `${base}/workspace-status` });
      expect(repeatedStatus.json()).toEqual(status.json());
      expect(status.json()).toMatchObject({ revision: second.json().revision, counts: { identities: 0, details: 0, conflicts: 0 }, capabilities: { autoMatch: false } });
    } finally { await app.close(); }
  });
  it("enforces ownership, shape, body limits, protagonist protection and disabled writes", async () => {
    const { app, base, write } = await fixture(false);
    try {
      const list = await app.inject({ method: "GET", url: base });
      expect(list.json().capabilities.castEditing).toBe(false);
      const post = await app.inject({ method: "POST", url: base, payload: { ...write, name: "Mara", aliases: [], profile: {} } });
      expect(post.statusCode).toBe(503);
      expect((await app.inject({ method: "GET", url: `/api/v1/campaigns/${randomUUID()}/cast` })).statusCode).toBe(404);
    } finally { await app.close(); }
    const live = await fixture();
    try {
      const list = (await live.app.inject({ method: "GET", url: live.base })).json();
      const hero = list.characters.find((c: any) => c.origin.kind === "protagonist");
      const patch = await live.app.inject({ method: "PATCH", url: `${live.base}/${hero.id}`, payload: { ...live.write, expectedCharacterRevision: 0, ignored: true } });
      expect(patch.statusCode).toBe(422);
      expect(patch.json()).toMatchObject({ code: "cast_protagonist_read_only", editorDestination: expect.stringContaining("character-profile") });
      expect((await live.app.inject({ method: "POST", url: live.base, payload: { ...live.write, ownerUserId: randomUUID(), name: "Mara", aliases: [], profile: {} } })).statusCode).toBe(422);
      expect((await live.app.inject({ method: "POST", url: live.base, payload: { ...live.write, name: "x".repeat(350_000), aliases: [], profile: {} } })).statusCode).toBe(413);
    } finally { await live.app.close(); }
  });
});
