import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generationRequestSchema, illustrationConfigSchema, illustrationSegmentRequestSchema, worldCoverRequestSchema } from "../../packages/contracts/src/generation.js";
import { assetListQuerySchema } from "../../packages/contracts/src/assets.js";
import { worldContentSchema, worldCreateSchema } from "../../packages/contracts/src/world-library.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, withTransaction, type DatabasePool } from "../../packages/database/src/pool.js";
import { enqueueGeneration, getGenerationJob, runGenerationJob } from "../../services/api/src/generation-service.js";
import { enqueueAcceptedTurnIllustration, enqueueIllustration, enqueueWorldCover, getIllustrationConfig, getImageJob, getLatestWorldCoverJob, listCampaignImageJobs, runImageJob, setIllustrationConfig } from "../../services/api/src/image-service.js";
import { importLegacyStory } from "../../services/api/src/import-service.js";
import { createProvider } from "../../services/api/src/provider-service.js";
import { listAssets, queryAssets, readAssetDerivative, selectTurnIllustration, selectWorldCover, updateAssetMetadata } from "../../services/api/src/asset-service.js";
import { getTurnIllustrationResolution, runIllustrationResolutionJob } from "../../services/api/src/illustration-resolution-service.js";
import {
  generateTurnIllustrationSegments,
  listCampaignIllustrationSegments,
  previewIllustrationBackfill,
  runIllustrationPromptJob
} from "../../services/api/src/segmented-illustration-service.js";
import { getCampaignCostSummary } from "../../services/api/src/cost-service.js";
import { createWorld, getWorld } from "../../services/api/src/world-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const credentialSecret = "synthetic-image-integration-secret";
const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function storyOutput() {
  return JSON.stringify({
    narration: "Synthetic Location Image opens beneath a quiet violet sky.",
    choices: ["Enter the arch.", "Study the sky.", "Wait nearby.", "Call the guide."],
    custom_action_suggestion: "Inspect the luminous boundary.",
    scratchpad: "Synthetic fiction continuity only.",
    tracker_updates: [],
    image_prompt: "A quiet violet sky above a luminous stone arch in an empty valley.",
    continuity_summary: "A luminous stone arch stands open beneath the violet sky.",
    canonical_facts: ["The luminous stone arch is open."],
    superseded_facts: [],
    open_threads: ["Explore beyond the luminous arch."]
  });
}

integration("independent illustration pipeline", () => {
  let pool: DatabasePool;
  let server: Server;
  let baseUrl = "";
  let textProviderId = "";
  let imageProviderId = "";
  let assetRoot = "";
  let failImages = false;
  const imageRequests: Array<Record<string, unknown>> = [];
  const refinementRequests: Array<Record<string, unknown>> = [];
  const sogniRequests: Array<{ body: Record<string, unknown>; idempotencyKey: string }> = [];

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 5);
    await migrateDatabase(pool, resolve("database/migrations"));
    assetRoot = await mkdtemp(join(tmpdir(), "infinitequest-image-test-"));
    server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        if (request.method === "POST" && request.url === "/v1/creative-agent/workflows") {
          sogniRequests.push({ body: parsed, idempotencyKey: String(request.headers["idempotency-key"] || "") });
          response.writeHead(201, { "content-type": "application/json" });
          response.end(JSON.stringify({ status: "success", data: { workflow: { workflowId: "wf_integration-1", status: "queued" } } }));
          return;
        }
        if (request.method === "GET" && request.url === "/v1/creative-agent/workflows/wf_integration-1") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ status: "success", data: { workflow: {
            workflowId: "wf_integration-1",
            status: "completed",
            steps: [{ status: "completed", artifacts: [{ url: `${baseUrl}/sogni-artifact.png`, mimeType: "image/png" }] }],
            usage: { images: 1 }
          } } }));
          return;
        }
        if (request.method === "GET" && request.url === "/sogni-artifact.png") {
          response.writeHead(200, { "content-type": "image/png", "content-length": Buffer.byteLength(tinyPng, "base64") });
          response.end(Buffer.from(tinyPng, "base64"));
          return;
        }
        if (request.url?.endsWith("/images/generations")) {
          imageRequests.push(parsed);
          if (failImages) {
            response.writeHead(503, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: { message: "Synthetic image endpoint unavailable." } }));
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ id: crypto.randomUUID(), data: [{ b64_json: tinyPng }], usage: { cost: 0.04 } }));
          return;
        }
        if (JSON.stringify(parsed).includes("expert visual translator and prompt engineer")) {
          refinementRequests.push(parsed);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({
            id: crypto.randomUUID(),
            model: "synthetic-text-model",
            choices: [{
              message: { content: "Mira, raising a lantern, fogbound road, eerie moonlight, cinematic fantasy illustration" },
              finish_reason: "stop"
            }],
            usage: { prompt_tokens: 300, completion_tokens: 40, total_tokens: 340 }
          }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: crypto.randomUUID(),
          model: "synthetic-text-model",
          choices: [{ message: { content: storyOutput() }, finish_reason: "stop" }],
          usage: { prompt_tokens: 500, completion_tokens: 150, total_tokens: 650 }
        }));
      });
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Synthetic provider did not expose a TCP address.");
    baseUrl = `http://127.0.0.1:${address.port}`;
    textProviderId = (await createProvider(pool, {
      name: `Synthetic text ${crypto.randomUUID()}`,
      providerType: "openai_compatible",
      providerRole: "text",
      baseUrl,
      defaultModel: "synthetic-text-model",
      contextWindowTokens: 32768,
      maxOutputTokens: 4096,
      temperature: 0,
      enabled: true,
      isDefault: true,
      configuration: {}
    }, credentialSecret)).id;
    imageProviderId = (await createProvider(pool, {
      name: `Synthetic image ${crypto.randomUUID()}`,
      providerType: "openai_compatible",
      providerRole: "image",
      baseUrl,
      defaultModel: "synthetic-image-model",
      contextWindowTokens: 32768,
      maxOutputTokens: 4096,
      temperature: 0,
      enabled: true,
      isDefault: true,
      configuration: {}
    }, credentialSecret)).id;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    await pool.end();
    await rm(assetRoot, { recursive: true, force: true });
  });

  async function campaign(maxAttempts = 3) {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Synthetic illustrated campaign ${crypto.randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "synthetic-image.story", story: fixture }));
    await setIllustrationConfig(pool, imported.campaignId, illustrationConfigSchema.parse({
      enabled: true,
      providerProfileId: imageProviderId,
      model: "synthetic-image-model",
      size: "1024x1024",
      aspectRatio: "1:1",
      quality: "auto",
      outputFormat: "png",
      maxAttempts
    }));
    return imported;
  }

  async function generate(campaignId: string) {
    const job = await enqueueGeneration(pool, campaignId, generationRequestSchema.parse({
      action: "Approach Synthetic Location Image.",
      providerProfileId: textProviderId,
      idempotencyKey: crypto.randomUUID(),
      context: { budgetTokens: 16000, compression: "full", recentTurns: 8 }
    }));
    await runGenerationJob(pool, `synthetic-story-${crypto.randomUUID()}`, 30, credentialSecret);
    expect(await getGenerationJob(pool, job.id)).toMatchObject({ status: "completed" });
    return job;
  }

  async function processThroughTerminal(jobId: string, workerPrefix: string) {
    for (let index = 0; index < 20; index += 1) {
      const current = await getImageJob(pool, jobId);
      if (["completed", "recoverable", "failed"].includes(current.status)) return current;
      await runImageJob(pool, `${workerPrefix}-${index}`, 30, credentialSecret, { root: assetRoot });
    }
    return getImageJob(pool, jobId);
  }

  it("creates historical segment jobs without changing accepted turn or Chronicle state", async () => {
    const imported = await campaign();
    const ownerUserId = await initialOwnerId(pool);
    const profile = {
      name: "Mira",
      profile: {
        identity: { aliases: ["The Lantern Bearer"], pronouns: "she/her" },
        story: { role: "Guide" },
        appearance: { hair: "black braid", clothing: "weathered blue cloak" },
        unclassifiedNotes: ""
      }
    };
    await pool.query(
      `UPDATE campaigns
          SET character_profile = $3, character_profile_revision = 3, updated_at = now()
        WHERE id = $1 AND owner_user_id = $2`,
      [imported.campaignId, ownerUserId, JSON.stringify(profile)]
    );
    await setIllustrationConfig(pool, imported.campaignId, illustrationConfigSchema.parse({
      enabled: true,
      providerProfileId: imageProviderId,
      model: "synthetic-image-model",
      size: "1024x1024",
      aspectRatio: "1:1",
      quality: "auto",
      outputFormat: "png",
      maxAttempts: 3,
      segmentWordCount: 100,
      imagesPerSegment: 2,
      segmentPromptMode: "direct"
    }));
    const turn = await pool.query<{ id: string }>(
      "SELECT id FROM turns WHERE campaign_id = $1 ORDER BY turn_number DESC LIMIT 1",
      [imported.campaignId]
    );
    expect(turn.rows[0]).toBeDefined();
    const turnId = turn.rows[0]!.id;
    const before = await pool.query(
      `SELECT narration, mechanics_private, state_snapshot_private, model_metadata, import_metadata,
              image_prompt, choices, turn_number, image_url
         FROM turns WHERE id = $1`,
      [turnId]
    );
    const memoriesBefore = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM chronicle_memories WHERE campaign_id = $1",
      [imported.campaignId]
    );

    const result = await generateTurnIllustrationSegments(pool, turnId, illustrationSegmentRequestSchema.parse({ mode: "missing" }));
    expect(result).toMatchObject({ duplicate: false, segmentCount: expect.any(Number) });
    expect(result.segmentCount).toBeGreaterThan(0);
    const segments = (await listCampaignIllustrationSegments(pool, imported.campaignId)).segments.filter(
      (segment: any) => segment.turnId === turnId
    );
    expect(segments).toHaveLength(result.segmentCount);
    const jobs = await pool.query<{ image_count: number; prompt: string }>(
      "SELECT image_count, prompt FROM image_jobs WHERE segment_id = ANY($1::uuid[]) ORDER BY created_at",
      [segments.map((segment: any) => segment.id)]
    );
    expect(jobs.rows).toHaveLength(result.segmentCount);
    expect(jobs.rows.every((job) => job.image_count === 2)).toBe(true);
    expect(jobs.rows.every((job) => job.prompt.includes("weathered blue cloak"))).toBe(true);
    expect(jobs.rows.every((job) => (
      job.prompt.match(/CANONICAL CHARACTER REFERENCE:/g)?.length === 1
    ))).toBe(true);
    const originalSet = await pool.query<{ id: string; character_visual_reference: string }>(
      `SELECT id, character_visual_reference FROM turn_illustration_sets
        WHERE turn_id = $1 AND is_active = true`,
      [turnId]
    );
    expect(originalSet.rows[0]?.character_visual_reference).toContain("weathered blue cloak");
    expect(segments.every((segment: any) => !segment.resolvedPrompt.includes("CANONICAL CHARACTER REFERENCE:"))).toBe(true);

    const revisedProfile = {
      ...profile,
      profile: {
        ...profile.profile,
        appearance: { ...profile.profile.appearance, clothing: "dark green travel coat" }
      }
    };
    await pool.query(
      `UPDATE campaigns
          SET character_profile = $3, character_profile_revision = 4, updated_at = now()
        WHERE id = $1 AND owner_user_id = $2`,
      [imported.campaignId, ownerUserId, JSON.stringify(revisedProfile)]
    );
    const rebuilt = await generateTurnIllustrationSegments(
      pool,
      turnId,
      illustrationSegmentRequestSchema.parse({ mode: "rebuild" })
    );
    expect(rebuilt.duplicate).toBe(false);
    const sets = await pool.query<{ id: string; is_active: boolean; character_visual_reference: string }>(
      `SELECT id, is_active, character_visual_reference
         FROM turn_illustration_sets WHERE turn_id = $1 ORDER BY created_at`,
      [turnId]
    );
    expect(sets.rows.find((set) => set.id === originalSet.rows[0]?.id)).toMatchObject({
      is_active: false,
      character_visual_reference: expect.stringContaining("weathered blue cloak")
    });
    expect(sets.rows.find((set) => set.is_active)).toMatchObject({
      character_visual_reference: expect.stringContaining("dark green travel coat")
    });
    const rebuiltJobs = await pool.query<{ prompt: string }>(
      `SELECT jobs.prompt FROM image_jobs jobs
         JOIN turn_illustration_segments segments ON segments.id = jobs.segment_id
         JOIN turn_illustration_sets sets ON sets.id = segments.illustration_set_id
        WHERE sets.turn_id = $1 AND sets.is_active = true`,
      [turnId]
    );
    expect(rebuiltJobs.rows.every((job) => job.prompt.includes("dark green travel coat"))).toBe(true);
    expect(rebuiltJobs.rows.every((job) => (
      job.prompt.match(/CANONICAL CHARACTER REFERENCE:/g)?.length === 1
    ))).toBe(true);
    await expect(previewIllustrationBackfill(pool, imported.campaignId, "missing"))
      .resolves.toMatchObject({ settings: { segmentWordCount: 100, imagesPerSegment: 2, segmentPromptMode: "direct" } });

    const after = await pool.query(
      `SELECT narration, mechanics_private, state_snapshot_private, model_metadata, import_metadata,
              image_prompt, choices, turn_number, image_url
         FROM turns WHERE id = $1`,
      [turnId]
    );
    const memoriesAfter = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM chronicle_memories WHERE campaign_id = $1",
      [imported.campaignId]
    );
    expect(after.rows).toEqual(before.rows);
    expect(memoriesAfter.rows).toEqual(memoriesBefore.rows);
  });

  it("sends the visual reference to AI refinement and appends it once to the provider prompt", async () => {
    const imported = await campaign();
    const ownerUserId = await initialOwnerId(pool);
    await pool.query(
      `UPDATE campaigns
          SET character_profile = $3, character_profile_revision = 2, updated_at = now()
        WHERE id = $1 AND owner_user_id = $2`,
      [imported.campaignId, ownerUserId, JSON.stringify({
        name: "Mira",
        profile: {
          identity: { aliases: ["The Lantern Bearer"], pronouns: "she/her" },
          story: { role: "Guide" },
          appearance: { eyes: "gray", clothing: "weathered purple coat" },
          unclassifiedNotes: ""
        }
      })]
    );
    await setIllustrationConfig(pool, imported.campaignId, illustrationConfigSchema.parse({
      enabled: true,
      providerProfileId: imageProviderId,
      model: "synthetic-image-model",
      size: "1024x1024",
      aspectRatio: "1:1",
      quality: "auto",
      outputFormat: "png",
      maxAttempts: 3,
      segmentWordCount: 100,
      imagesPerSegment: 1,
      segmentPromptMode: "ai_refined"
    }));
    const turn = await pool.query<{ id: string }>(
      "SELECT id FROM turns WHERE campaign_id = $1 ORDER BY turn_number DESC LIMIT 1",
      [imported.campaignId]
    );
    const turnId = turn.rows[0]!.id;
    const refinementCountBefore = refinementRequests.length;
    const created = await generateTurnIllustrationSegments(
      pool,
      turnId,
      illustrationSegmentRequestSchema.parse({ mode: "missing" })
    );
    for (let index = 0; index < created.segmentCount + 2; index += 1) {
      if (!await runIllustrationPromptJob(pool, `refinement-worker-${crypto.randomUUID()}`, 30, credentialSecret)) break;
    }

    const submitted = refinementRequests.slice(refinementCountBefore).map((request) => JSON.stringify(request));
    expect(submitted).toHaveLength(created.segmentCount);
    expect(submitted.every((request) => request.includes("weathered purple coat"))).toBe(true);
    expect(submitted.every((request) => request.includes("STORY CONTEXT"))).toBe(true);
    const segments = await pool.query<{ direct_prompt: string; resolved_prompt: string; prompt: string }>(
      `SELECT segments.direct_prompt, segments.resolved_prompt, jobs.prompt
         FROM turn_illustration_segments segments
         JOIN image_jobs jobs ON jobs.segment_id = segments.id
        WHERE segments.turn_id = $1`,
      [turnId]
    );
    expect(segments.rows).toHaveLength(created.segmentCount);
    for (const row of segments.rows) {
      expect(row.direct_prompt).not.toContain("CANONICAL CHARACTER REFERENCE:");
      expect(row.resolved_prompt).not.toContain("CANONICAL CHARACTER REFERENCE:");
      expect(row.resolved_prompt).toContain("Mira, raising a lantern");
      expect(row.prompt).toContain("weathered purple coat");
      expect(row.prompt.match(/CANONICAL CHARACTER REFERENCE:/g)).toHaveLength(1);
    }
  });

  it("generates a world cover with the default image provider without campaign cost attribution", async () => {
    failImages = false;
    const title = `Synthetic cover world ${crypto.randomUUID()}`;
    const world = await createWorld(pool, worldCreateSchema.parse({
      title,
      content: worldContentSchema.parse({
        world: {
          title,
          genre: "fantasy",
          tone: "luminous",
          premise: "A fictional citadel hangs over a violet sea.",
          backgroundStory: "",
          firstAction: "",
          rules: ""
        }
      })
    }));
    const queued = await enqueueWorldCover(pool, world.id, worldCoverRequestSchema.parse({}));
    expect(queued).toMatchObject({ targetType: "world_cover", worldId: world.id, campaignId: null, turnId: null });
    await expect(getLatestWorldCoverJob(pool, world.id)).resolves.toMatchObject({ id: queued.id, status: "queued" });
    const completed = await processThroughTerminal(queued.id, "synthetic-world-cover-worker");
    expect(completed).toMatchObject({ status: "completed", assetUrl: expect.stringMatching(/^\/api\/v1\/assets\//) });
    await expect(getLatestWorldCoverJob(pool, world.id)).resolves.toMatchObject({ id: queued.id, status: "completed" });
    await expect(getWorld(pool, world.id)).resolves.toMatchObject({ imageUrl: completed.assetUrl });
    const generationContext = await pool.query<{
      target_type: string;
      fiction_prompt: string;
      provider_type: string;
      model: string;
      generation_parameters: Record<string, unknown>;
    }>(
      `SELECT target_type, fiction_prompt, provider_type, model, generation_parameters
         FROM asset_generation_contexts
        WHERE image_job_id = $1`,
      [queued.id]
    );
    expect(generationContext.rows).toEqual([expect.objectContaining({
      target_type: "world_cover", provider_type: "openai_compatible", model: "synthetic-image-model",
      fiction_prompt: expect.any(String),
      generation_parameters: expect.objectContaining({ size: "1024x1536", aspectRatio: "2:3", outputFormat: "png" })
    })]);
    const costs = await pool.query("SELECT id FROM provider_cost_events WHERE image_job_id = $1", [queued.id]);
    expect(costs.rowCount).toBe(0);
  });

  it("reuses retained generated assets for world covers and turn illustrations", async () => {
    failImages = false;
    const sourceTitle = `Synthetic library source ${crypto.randomUUID()}`;
    const sourceWorld = await createWorld(pool, worldCreateSchema.parse({ title: sourceTitle }));
    const queued = await enqueueWorldCover(pool, sourceWorld.id, worldCoverRequestSchema.parse({}));
    const completed = await processThroughTerminal(queued.id, "synthetic-library-worker");
    expect(completed.status).toBe("completed");
    const ownerUserId = await initialOwnerId(pool);
    const library = await listAssets(pool, ownerUserId);
    const asset = library.find((item) => item.url === completed.assetUrl);
    expect(asset).toBeDefined();
    expect(asset).toMatchObject({ width: 1, height: 1, origin: "generated", reviewStatus: "eligible" });
    const thumbnail = await readAssetDerivative(pool, { root: assetRoot }, ownerUserId, asset!.id, "thumbnail");
    expect(thumbnail.mimeType).toBe("image/webp");
    expect(thumbnail.bytes.length).toBeGreaterThan(0);

    const updated = await updateAssetMetadata(pool, ownerUserId, asset!.id, {
      expectedRevision: asset!.metadataRevision,
      title: "A luminous violet stone arch at night",
      tags: ["violet", "arch", "night"],
      reuseScope: "owner_library",
      automaticReuseEnabled: true,
      reviewStatus: "eligible",
      favorite: true
    });
    await expect(updateAssetMetadata(pool, ownerUserId, asset!.id, {
      expectedRevision: asset!.metadataRevision,
      title: "Stale edit"
    })).rejects.toMatchObject({ statusCode: 409 });
    const filtered = await queryAssets(pool, ownerUserId, assetListQuerySchema.parse({
      q: "violet arch", origin: ["generated"], tags: ["night"], reviewStatus: ["eligible"], reuseScope: ["owner_library"],
      favorite: true, sort: "newest", limit: 20
    }));
    expect(filtered.assets.map((item) => item.id)).toContain(asset!.id);
    expect(filtered.assets.find((item) => item.id === asset!.id)?.metadataRevision).toBe(updated.metadataRevision);
    expect(filtered.facets.tags.night).toBeGreaterThanOrEqual(1);
    await pool.query(
      `INSERT INTO assets (owner_user_id, content_hash, storage_driver, storage_path, mime_type, byte_length, pixel_width, pixel_height)
       VALUES ($1,$2,'filesystem',$3,'image/png',68,1,1), ($1,$4,'filesystem',$5,'image/png',68,1,1)`,
      [ownerUserId, "a".repeat(64), "aa/cursor-a.png", "b".repeat(64), "bb/cursor-b.png"]
    );
    const firstPageQuery = assetListQuerySchema.parse({ limit: 1 });
    const firstPage = await queryAssets(pool, ownerUserId, firstPageQuery);
    expect(firstPage.nextCursor).toBeTruthy();
    const secondPage = await queryAssets(pool, ownerUserId, { ...firstPageQuery, cursor: firstPage.nextCursor! });
    expect(secondPage.assets[0]?.id).not.toBe(firstPage.assets[0]?.id);
    await expect(queryAssets(pool, ownerUserId, {
      ...firstPageQuery, q: "different filter", cursor: firstPage.nextCursor!
    })).rejects.toMatchObject({ statusCode: 400 });

    const targetTitle = `Synthetic library target ${crypto.randomUUID()}`;
    const targetWorld = await createWorld(pool, worldCreateSchema.parse({ title: targetTitle }));
    await expect(selectWorldCover(pool, ownerUserId, targetWorld.id, asset!.id)).resolves.toEqual({ assetUrl: asset!.url });
    await expect(getWorld(pool, targetWorld.id)).resolves.toMatchObject({ imageUrl: asset!.url });

    const imported = await campaign();
    const turn = await pool.query<{ id: string }>("SELECT id FROM turns WHERE campaign_id = $1 ORDER BY turn_number DESC LIMIT 1", [imported.campaignId]);
    const turnId = turn.rows[0]!.id;
    await pool.query("UPDATE turns SET image_prompt = $2 WHERE id = $1", [turnId, "A luminous violet stone arch at night"]);
    await expect(selectTurnIllustration(pool, ownerUserId, turnId, asset!.id)).resolves.toEqual({ assetUrl: asset!.url });
    const selected = await pool.query<{ image_url: string }>("SELECT image_url FROM turns WHERE id = $1", [turnId]);
    expect(selected.rows[0]?.image_url).toBe(asset!.url);
    const reference = await pool.query(
      "SELECT id FROM asset_references WHERE owner_user_id = $1 AND asset_id = $2 AND turn_id = $3 AND asset_role = 'turn_illustration'",
      [ownerUserId, asset!.id, turnId]
    );
    expect(reference.rowCount).toBe(1);

    await pool.query(
      `INSERT INTO illustration_resolution_jobs (
         owner_user_id, campaign_id, turn_id, source_policy, matching_scope, confidence_profile, repetition_window
       ) VALUES ($1,$2,$3,'library_only','owner_library','broad',0)`,
      [ownerUserId, imported.campaignId, turnId]
    );
    await expect(runIllustrationResolutionJob(pool, "synthetic-library-match-worker", 30)).resolves.toBe(true);
    const resolution = await getTurnIllustrationResolution(pool, turnId) as { candidates: Array<{ score: number }> };
    expect(resolution.candidates[0]?.score).toBeGreaterThanOrEqual(0.38);
    expect(resolution).toMatchObject({
      status: "completed", selectedAssetId: asset!.id, reasonCode: "matched",
      candidates: [expect.objectContaining({ assetId: asset!.id, rank: 1 })]
    });
  });

  it.skip("queues after story commit, sends only the fiction prompt, and stores generated bytes", async () => {
    failImages = false;
    const imported = await campaign();
    await generate(imported.campaignId);
    const [imageJob] = await listCampaignImageJobs(pool, imported.campaignId);
    expect(imageJob).toMatchObject({ status: "queued", model: "synthetic-image-model" });
    expect(await processThroughTerminal(imageJob!.id, "synthetic-image-worker")).toMatchObject({ status: "completed", assetUrl: expect.stringMatching(/^\/api\/v1\/assets\//) });
    const imageRequest = imageRequests.at(-1);
    expect(imageRequest?.prompt).toBe("A quiet violet sky above a luminous stone arch in an empty valley.");
    expect(JSON.stringify(imageRequest)).not.toMatch(/roll|dice|check|scratchpad|Synthetic Location Image opens/i);
    const turn = await pool.query<{ image_url: string }>("SELECT image_url FROM turns WHERE campaign_id = $1 ORDER BY turn_number DESC LIMIT 1", [imported.campaignId]);
    expect(turn.rows[0]?.image_url).toMatch(/^\/api\/v1\/assets\//);
    const costSummary = await getCampaignCostSummary(pool, imported.campaignId);
    expect(costSummary.totals[0]?.byCategory.image).toBe("0.040000000000");
  });

  it("runs library-only resolution without an image provider", async () => {
    const imported = await campaign();
    await setIllustrationConfig(pool, imported.campaignId, illustrationConfigSchema.parse({
      sourcePolicy: "library_only", matchingScope: "campaign", confidenceProfile: "strict",
      providerProfileId: null, model: ""
    }));
    await expect(getIllustrationConfig(pool, imported.campaignId)).resolves.toMatchObject({
      sourcePolicy: "library_only", providerProfileId: null
    });
    const ownerUserId = await initialOwnerId(pool);
    const turn = await pool.query<{ id: string }>("SELECT id FROM turns WHERE campaign_id = $1 ORDER BY turn_number DESC LIMIT 1", [imported.campaignId]);
    const turnId = turn.rows[0]!.id;
    await pool.query("UPDATE turns SET image_prompt = $2, image_url = '' WHERE id = $1", [turnId, "An unmatched obsidian observatory in a snowstorm"]);
    const resolutionId = await withTransaction(pool, (client) => enqueueAcceptedTurnIllustration(
      client, ownerUserId, imported.campaignId, turnId, "An unmatched obsidian observatory in a snowstorm"
    ));
    expect(resolutionId).toBeTruthy();
    await expect(runIllustrationResolutionJob(pool, "synthetic-library-only-worker", 30)).resolves.toBe(true);
    await expect(getTurnIllustrationResolution(pool, turnId)).resolves.toMatchObject({ status: "no_match", imageJobId: null });
    const providerJobs = await pool.query("SELECT id FROM image_jobs WHERE turn_id = $1", [turnId]);
    expect(providerJobs.rowCount).toBe(0);
  });

  it("queues exactly one provider job after a durable library-first no-match", async () => {
    const imported = await campaign();
    await setIllustrationConfig(pool, imported.campaignId, illustrationConfigSchema.parse({
      sourcePolicy: "library_then_generate", matchingScope: "campaign", confidenceProfile: "strict",
      providerProfileId: imageProviderId, model: "synthetic-image-model"
    }));
    const ownerUserId = await initialOwnerId(pool);
    const turn = await pool.query<{ id: string }>("SELECT id FROM turns WHERE campaign_id = $1 ORDER BY turn_number DESC LIMIT 1", [imported.campaignId]);
    const turnId = turn.rows[0]!.id;
    await pool.query("UPDATE turns SET image_prompt = $2, image_url = '' WHERE id = $1", [turnId, "A singular copper lighthouse beneath green auroras"]);
    await withTransaction(pool, (client) => enqueueAcceptedTurnIllustration(
      client, ownerUserId, imported.campaignId, turnId, "A singular copper lighthouse beneath green auroras"
    ));
    await expect(runIllustrationResolutionJob(pool, "synthetic-library-first-worker", 30)).resolves.toBe(true);
    const resolution = await getTurnIllustrationResolution(pool, turnId) as { status: string; imageJobId: string | null };
    expect(resolution).toMatchObject({ status: "generation_queued", imageJobId: expect.any(String) });
    await expect(runIllustrationResolutionJob(pool, "synthetic-library-first-worker-duplicate", 30)).resolves.toBe(false);
    const providerJobs = await pool.query("SELECT id FROM image_jobs WHERE turn_id = $1", [turnId]);
    expect(providerJobs.rowCount).toBe(1);
    await pool.query("UPDATE image_jobs SET status = 'cancelled' WHERE turn_id = $1", [turnId]);
  });

  it.skip("preserves the accepted story when the independent image endpoint fails", async () => {
    failImages = true;
    const imported = await campaign(1);
    const storyJob = await generate(imported.campaignId);
    const acceptedBefore = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM turns WHERE campaign_id = $1", [imported.campaignId]);
    const [imageJob] = await listCampaignImageJobs(pool, imported.campaignId);
    expect(await processThroughTerminal(imageJob!.id, "synthetic-failing-image-worker")).toMatchObject({ status: "recoverable", errorCode: "image_generation_failed" });
    expect(await getGenerationJob(pool, storyJob.id)).toMatchObject({ status: "completed" });
    const acceptedAfter = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM turns WHERE campaign_id = $1", [imported.campaignId]);
    expect(acceptedAfter.rows[0]?.count).toBe(acceptedBefore.rows[0]?.count);
  });

  it("persists a Sogni workflow ID, resumes polling, and stores the downloaded artifact", async () => {
    const sogniProviderId = (await createProvider(pool, {
      name: `Synthetic Sogni ${crypto.randomUUID()}`,
      providerType: "sogni",
      providerRole: "image",
      baseUrl,
      defaultModel: "flux2",
      contextWindowTokens: 32768,
      maxOutputTokens: 4096,
      temperature: 0,
      requestTimeoutMs: 30_000,
      apiKey: "synthetic-sogni-token",
      enabled: true,
      configuration: {
        pollIntervalMs: 1_000,
        maximumPollIntervalMs: 1_000,
        generationTimeoutMs: 30_000,
        defaultImageCount: 1,
        allowPrivateArtifactHosts: true
      }
    }, credentialSecret)).id;
    const imported = await campaign();
    const turn = await pool.query<{ id: string }>("SELECT id FROM turns WHERE campaign_id = $1 ORDER BY turn_number DESC LIMIT 1", [imported.campaignId]);
    const turnId = turn.rows[0]!.id;
    const queued = await enqueueIllustration(pool, turnId, {
      providerProfileId: sogniProviderId,
      model: "flux2",
      prompt: "A quiet violet sky above a luminous stone arch in an empty valley.",
      replace: true
    });

    await runImageJob(pool, "sogni-submit-worker", 30, credentialSecret, { root: assetRoot });
    expect(await getImageJob(pool, queued.id)).toMatchObject({ status: "provider_pending", remoteJobId: "wf_integration-1" });
    await pool.query("UPDATE image_jobs SET next_poll_at = now() WHERE id = $1", [queued.id]);
    await runImageJob(pool, "sogni-poll-worker", 30, credentialSecret, { root: assetRoot });

    expect(await getImageJob(pool, queued.id)).toMatchObject({
      status: "completed",
      providerProgress: 100,
      assetUrl: expect.stringMatching(/^\/api\/v1\/assets\//)
    });
    expect(sogniRequests).toHaveLength(1);
    expect(sogniRequests[0]?.idempotencyKey).toBe(`${queued.id}:0`);
    expect(JSON.stringify(sogniRequests[0]?.body)).not.toContain("synthetic-sogni-token");
  });
});
