import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTransaction, createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { captureCastGenerationSnapshotWithClient, createPostgresCampaignCastRepository } from "../../packages/database/src/campaign-cast-repository.js";
import { createCampaignCastApplication } from "../../packages/application/src/campaign-cast/use-cases.js";
import { registerCampaignCastRoutes } from "../../services/api/src/campaign-cast-routes.js";
import { buildServer } from "../../services/api/src/server.js";
import { loadRuntimeConfig } from "../../packages/database/src/config.js";
import { inertStorageServerOptions } from "../helpers/build-server-options.js";
import { sha256 } from "../../packages/domain/src/text.js";
import { createApiCampaignCastApplication } from "../../services/runtime/src/campaign-cast-composition.js";

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration("campaign cast editing API", () => {
  let pool: DatabasePool, ownerUserId: string;
  beforeAll(async () => {
    pool = createDatabasePool(process.env.TEST_DATABASE_URL!, 8);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  }, 60_000);
  afterAll(async () => { await pool?.end(); });
  it("hides removed characters from the roster and narrator until explicitly restored", async () => {
    const { app, campaignId, base, write } = await fixture(true, false, true);
    const created = await app.inject({ method: "POST", url: base, payload: { ...write, name: "Keela", aliases: [], profile: {} } });
    expect(created.statusCode).toBe(201);
    const initial = created.json(), id = initial.character.id, scope = { ownerUserId, campaignId };
    const command = (revision: number, characterRevision: number) => ({ expectedCastRevision: revision, expectedCharacterRevision: characterRevision,
      expectedBoundary: write.expectedBoundary, idempotencyKey: randomUUID() });
    const remove = command(initial.revision, initial.character.revision);
    const request = () => app.inject({ method: "POST", url: base + "/" + id + "/remove", payload: remove });
    const result = await request(); expect(result.statusCode).toBe(200); expect(result.json().character.removed).toBe(true);
    expect((await request()).json()).toEqual(result.json());
    expect((await app.inject({ url: base })).json().characters.map((row: {id:string}) => row.id)).not.toContain(id);
    expect((await app.inject({ url: base + "?filter=removed" })).json().characters.map((row: {id:string}) => row.id)).toEqual([id]);
    const capture = async () => withTransaction(pool, client => captureCastGenerationSnapshotWithClient(client, scope, { discoveryEnabled: false, version: "cast-context-v2" }));
    expect(JSON.stringify((await capture()).snapshot)).not.toContain("Keela");
    const restored = await app.inject({ method: "POST", url: base + "/" + id + "/restore", payload: command(result.json().revision,result.json().character.revision) });
    expect(restored.statusCode).toBe(200); expect(restored.json().character.removed).toBeFalsy(); expect(JSON.stringify((await capture()).snapshot)).toContain("Keela");
    const main = (await app.inject({ url: base })).json().characters.find((row: {origin:{kind:string}}) => row.origin.kind === "protagonist");
    const rejected = await app.inject({ method: "POST", url: base + "/" + main.id + "/remove", payload: command(restored.json().revision,main.revision) });
    expect(rejected.statusCode).toBe(422); expect(rejected.json().code).toBe("cast_protagonist_read_only"); await app.close();
  });
  it("keeps lifecycle writers gated independently of cast editing and presets", async () => {
    const { app, base, write } = await fixture(true, true);
    const response = await app.inject({ method:"POST", url: base + "/" + randomUUID() + "/remove", payload: {...write,expectedCharacterRevision:0} });
    expect(response.statusCode).toBe(503); expect(response.json().code).toBe("cast_lifecycle_disabled"); await app.close();
  });
  it("keeps removed characters readable while lifecycle writers are disabled after rollback", async () => {
    const { app, base, campaignId, write } = await fixture(true, false, true);
    const created = (await app.inject({ method: "POST", url: base, payload: { ...write, name: "Rollback companion", aliases: [], profile: {} } })).json();
    const id = created.character.id;
    const removed = (await app.inject({ method: "POST", url: `${base}/${id}/remove`, payload: { ...write, expectedCastRevision: created.revision,
      expectedCharacterRevision: created.character.revision, idempotencyKey: randomUUID() } })).json();
    await app.close();
    const rollback = Fastify(), repository = createPostgresCampaignCastRepository(pool, { editingEnabled: true, lifecycleEnabled: false });
    await rollback.register(registerCampaignCastRoutes, { application: createCampaignCastApplication(repository), enabled: true, lifecycleEnabled: false, resolveOwner: async () => ({ ownerUserId }) });
    try {
      const roster = await rollback.inject({ url: `${base}?filter=removed` });
      expect(roster.statusCode).toBe(200);
      expect(roster.json()).toMatchObject({ capabilities: { castEditing: true, castLifecycle: false }, characters: [{ id, removed: true }] });
      const detail = await rollback.inject({ url: `${base}/${id}` });
      expect(detail.json()).toMatchObject({ character: { id, removed: true }, capabilities: { castEditing: true, castLifecycle: false } });
      for (const operation of ["restore", "remove", "merge", "unmerge", "promote"]) {
        const response = await rollback.inject({ method: "POST", url: `${base}/${id}/${operation}`, payload: {} });
        expect(response.statusCode).toBe(503); expect(response.json().code).toBe("cast_lifecycle_disabled");
      }
      for (const operation of ["merge-preview", "unmerge-preview", "promotion-preview"]) {
        const response = await rollback.inject({ url: `${base}/${id}/${operation}` });
        expect(response.statusCode).toBe(503); expect(response.json().code).toBe("cast_lifecycle_disabled");
      }
      expect((await rollback.inject({ url: `${base}/${id}` })).json().revision).toBe(removed.revision);
      expect((await repository.current({ ownerUserId, campaignId })).characters.find(item => item.id === id)?.removed).toBe(true);
    } finally { await rollback.close(); }
  });
  async function fixture(enabled = true, presets = false, lifecycle = false) {
    const world = randomUUID(), version = randomUUID(), campaignId = randomUUID();
    await pool.query("INSERT INTO worlds(id,owner_user_id,title) VALUES($1,$2,'Cast API')", [world, ownerUserId]);
    await pool.query("INSERT INTO world_versions(id,world_id,owner_user_id,version_number,content) VALUES($1,$2,$3,1,'{}')", [version, world, ownerUserId]);
    await pool.query("INSERT INTO campaigns(id,owner_user_id,world_version_id,title) VALUES($1,$2,$3,'Cast API')", [campaignId, ownerUserId, version]);
    const app = Fastify();
    const application = createCampaignCastApplication(createPostgresCampaignCastRepository(pool, { editingEnabled: enabled, castPresetsEnabled: presets, lifecycleEnabled: lifecycle }));
    await app.register(registerCampaignCastRoutes, { application, enabled, presetsEnabled: presets, lifecycleEnabled: lifecycle, resolveOwner: async () => ({ ownerUserId }) });
    const base = `/api/v1/campaigns/${campaignId}/cast`;
    const write = { expectedCastRevision: 0, expectedBoundary: { turnNumber: 0, timelineRevision: 0 }, idempotencyKey: randomUUID() };
    return { app, base, campaignId, version, write };
  }
  it("maps corrected draft evidence to 409 without applying edits", async () => {
    const { app, base, campaignId, write } = await fixture();
    try {
      const created = (await app.inject({ method: "POST", url: base, payload: { ...write, name: "Mara", aliases: [], profile: {} } })).json();
      const turnId = randomUUID(), narration = "Mara is kind.", sourceHash = sha256(narration);
      await pool.query("UPDATE campaigns SET active_turn_number=1 WHERE id=$1", [campaignId]);
      await pool.query("INSERT INTO turns(id,owner_user_id,campaign_id,turn_number,narration) VALUES($1,$2,$3,1,$4)", [turnId, ownerUserId, campaignId, narration]);
      const repo = createPostgresCampaignCastRepository(pool, { editingEnabled: true });
      await repo.applyBatch({ ownerUserId, campaignId }, { boundary: { turnNumber: 1, timelineRevision: 0 }, idempotencyKey: randomUUID(), commands: [{ kind: "observe", characterId: created.character.id, field: "story.role", value: "kind", mode: "fact", speakerCharacterId: null, supersedesObservationId: null, evidence: { kind: "turn", turnId, turnNumber: 1, narrationRevision: 0, sourceHash, paragraphId: "p1", quote: narration } }] });
      const detail = (await app.inject({ method: "GET", url: `${base}/${created.character.id}` })).json();
      const request = { expectedCastRevision: detail.revision, expectedCharacterRevision: detail.character.revision, expectedBoundary: detail.boundary };
      const context = await repo.draftPreviewContext!({ ownerUserId, campaignId }, created.character.id, request);
      await pool.query(`INSERT INTO turn_narration_corrections(owner_user_id,campaign_id,turn_id,revision,narration,previous_effective_narration_hash,source,created_by_user_id) VALUES($1,$2,$3,1,'Mara leaves.',$4,'user_edit',$1)`, [ownerUserId, campaignId, turnId, sourceHash]);
      const response = await app.inject({ method: "PATCH", url: `${base}/${created.character.id}`, payload: { ...request, idempotencyKey: randomUUID(), setOverrides: { "story.personality": "kind" }, draftEvidenceFences: [{ path: "story.personality", value: "kind", evidence: context.evidence }] } });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("cast_draft_evidence_changed");
      expect((await repo.detail({ ownerUserId, campaignId }, created.character.id)).character.profile["story.personality"]).toBeUndefined();
    } finally { await app.close(); }
  });
  it("composes the draft route with the selected campaign provider without writing observations", async () => {
    const { app: original, base, campaignId, write } = await fixture();
    const created = (await original.inject({ method: "POST", url: base, payload: { ...write, name: "Mara", aliases: [], profile: {} } })).json();
    await original.close();
    const narration = "Mara is kind.", turnId = randomUUID(), sourceHash = sha256(narration), scope = { ownerUserId, campaignId };
    await pool.query("UPDATE campaigns SET active_turn_number=1 WHERE id=$1", [campaignId]);
    await pool.query("INSERT INTO turns(id,owner_user_id,campaign_id,turn_number,narration) VALUES($1,$2,$3,1,$4)", [turnId, ownerUserId, campaignId, narration]);
    const repo = createPostgresCampaignCastRepository(pool, { editingEnabled: true });
    const receipt = await repo.applyBatch(scope, { boundary: { turnNumber: 1, timelineRevision: 0 }, idempotencyKey: randomUUID(), commands: [{ kind: "observe", characterId: created.character.id, field: "story.role", value: "kind", mode: "fact", speakerCharacterId: null, supersedesObservationId: null, evidence: { kind: "turn", turnId, turnNumber: 1, narrationRevision: 0, sourceHash, paragraphId: "p1", quote: narration } }] });
    const execute = vi.fn().mockResolvedValue({ content: JSON.stringify({ proposals: [{ path: "story.personality", value: "kind", evidenceIds: receipt.observationIds }] }), responseId: "r", finishReason: "stop", outputLimited: false, modelInstanceId: "m", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, reportedCost: null, rawMetadata: {} });
    const providers = { resolution: { resolveDirect: vi.fn().mockResolvedValue({ status: "resolved", providerProfileId: randomUUID(), model: "m" }) }, execution: { text: vi.fn().mockResolvedValue({ execute, model: "m" }) } };
    const app = Fastify();
    await app.register(registerCampaignCastRoutes, { application: createApiCampaignCastApplication(pool, { castEditingEnabled: true }, providers as never), enabled: true, resolveOwner: async () => ({ ownerUserId }) });
    try {
      const detail = (await app.inject({ method: "GET", url: `${base}/${created.character.id}` })).json();
      expect(detail.draftFromStoryEligible).toBe(true);
      const before = await pool.query("SELECT count(*)::int AS count FROM campaign_cast_events WHERE campaign_id=$1", [campaignId]);
      const response = await app.inject({ method: "POST", url: `${base}/${created.character.id}/draft-preview`, payload: { expectedCastRevision: detail.revision, expectedCharacterRevision: detail.character.revision, expectedBoundary: detail.boundary } });
      expect(response.statusCode).toBe(200);
      expect(response.json().proposals).toMatchObject([{ path: "story.personality", value: "kind", draftEvidenceFence: { path: "story.personality", value: "kind" } }]);
      expect(execute).toHaveBeenCalledOnce();
      expect((await pool.query("SELECT count(*)::int AS count FROM campaign_cast_events WHERE campaign_id=$1", [campaignId])).rows).toEqual(before.rows);
    } finally { await app.close(); }
  });
  it("chooses one narrator state from installation capability, enrollment and discovery", async () => {
    const { app, campaignId } = await fixture();
    try {
      const scope = { ownerUserId, campaignId };
      const read = async (context: boolean, capability: "r1" | "r2" | null, discovery = false) => {
        const repo = createPostgresCampaignCastRepository(pool, { editingEnabled: true, castContextEnabled: context, storyMemoryCapability: capability, discoveryEnabled: discovery });
        return (await repo.workspaceRead!(scope)).status.narratorState;
      };
      await pool.query("DELETE FROM campaign_story_memory_enrollments WHERE owner_user_id=$1 AND campaign_id=$2", [ownerUserId, campaignId]);
      expect(await read(false, "r2")).toBe("installation_disabled");
      expect(await read(true, null)).toBe("installation_disabled");
      expect(await read(true, "r1")).toBe("enrollment_missing");
      await pool.query("INSERT INTO campaign_story_memory_enrollments(owner_user_id,campaign_id,capability,review_mode) VALUES($1,$2,'r2','off')", [ownerUserId, campaignId]);
      expect(await read(true, "r1")).toBe("capability_insufficient");
      expect(await read(true, "r2")).toBe("discovery_off");
      expect(await read(true, "r2", true)).toBe("ready");
    } finally { await app.close(); }
  });
  it("rejects world aliases that fail the same fiction predicate as campaign seeding", async () => {
    const { app, base, version } = await fixture(true, true);
    try {
      await pool.query("UPDATE world_versions SET content=$2 WHERE id=$1", [version, JSON.stringify({ world: { title: "Fixture" },
        playableCharacters: [{ id: "keeper", name: "Keeper", campaignUse: "supporting", characterText: "Guide", profile: { identity: { aliases: ["Score: 12"] } } }] })]);
      const response = await app.inject({ method: "GET", url: base + "/from-world-preview?characterId=keeper" });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: "cast_invalid_request", details: { fields: [{ path: "identity.aliases", code: "invalid_fiction" }] } });
    } finally { await app.close(); }
  });
  it("offers the existing plain world identity after a campaign rename", async () => {
    const { app, base, version, campaignId, write } = await fixture(true, true);
    try {
      await pool.query("UPDATE world_versions SET content=$2 WHERE id=$1", [version, JSON.stringify({ world: { title: "Fixture" },
        playableCharacters: [{ id: "keeper", name: "Keeper", campaignUse: "supporting", characterText: "Guide" }] })]);
      const repo = createPostgresCampaignCastRepository(pool, { editingEnabled: true, castPresetsEnabled: true });
      const scope = { ownerUserId, campaignId };
      const receipt = await repo.applyBatch(scope, { boundary: write.expectedBoundary, idempotencyKey: "plain-world-person",
        commands: [{ kind: "create", origin: { kind: "world", worldVersionId: version, entityId: "keeper" }, evidence: { kind: "world", worldVersionId: version, sourcePath: "/playableCharacters/0" }, name: "Keeper", aliases: [] }] });
      const id = receipt.characterIds[0]!;
      const loaded = await repo.detail(scope, id);
      await repo.edit(scope, id, { ...write, expectedCastRevision: loaded.revision, expectedCharacterRevision: loaded.character.revision, name: "Town Guide", aliases: [] });
      const preview = await app.inject({ method: "GET", url: base + "/from-world-preview?characterId=keeper" });
      expect(preview.json().eligibleTargets).toEqual([{ id, name: "Town Guide", revision: expect.any(Number) }]);
    } finally { await app.close(); }
  });
  it("applies only a freshly previewed profile and returns the original HTTP receipt on retry", async () => {
    const { app, base, version, write } = await fixture(true, true);
    try {
      await pool.query("UPDATE world_versions SET content=$2 WHERE id=$1", [version, JSON.stringify({ world: { title: "Fixture" },
        playableCharacters: [{ id: "keeper", name: "Keeper", campaignUse: "supporting", characterText: "Legacy note",
          profile: { story: { background: "b".repeat(3000) } } }] })]);
      const choices = () => app.inject({ method: "GET", url: base + "/from-world" });
      expect((await choices()).json().characters).toEqual([{ characterId: "keeper", name: "Keeper", alwaysInContext: false }]);
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
      expect((await choices()).json().characters).toEqual([]);
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
