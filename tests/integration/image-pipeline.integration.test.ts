import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generationRequestSchema, illustrationConfigSchema, worldCoverRequestSchema } from "../../packages/contracts/src/generation.js";
import { worldContentSchema, worldCreateSchema } from "../../packages/contracts/src/world-library.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { enqueueGeneration, getGenerationJob, runGenerationJob } from "../../services/api/src/generation-service.js";
import { enqueueIllustration, enqueueWorldCover, getImageJob, listCampaignImageJobs, runImageJob, setIllustrationConfig } from "../../services/api/src/image-service.js";
import { importLegacyStory } from "../../services/api/src/import-service.js";
import { createProvider } from "../../services/api/src/provider-service.js";
import { listAssets, selectTurnIllustration, selectWorldCover } from "../../services/api/src/asset-service.js";
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
    const completed = await processThroughTerminal(queued.id, "synthetic-world-cover-worker");
    expect(completed).toMatchObject({ status: "completed", assetUrl: expect.stringMatching(/^\/api\/v1\/assets\//) });
    await expect(getWorld(pool, world.id)).resolves.toMatchObject({ imageUrl: completed.assetUrl });
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

    const targetTitle = `Synthetic library target ${crypto.randomUUID()}`;
    const targetWorld = await createWorld(pool, worldCreateSchema.parse({ title: targetTitle }));
    await expect(selectWorldCover(pool, ownerUserId, targetWorld.id, asset!.id)).resolves.toEqual({ assetUrl: asset!.url });
    await expect(getWorld(pool, targetWorld.id)).resolves.toMatchObject({ imageUrl: asset!.url });

    const imported = await campaign();
    const turn = await pool.query<{ id: string }>("SELECT id FROM turns WHERE campaign_id = $1 ORDER BY turn_number DESC LIMIT 1", [imported.campaignId]);
    const turnId = turn.rows[0]!.id;
    await expect(selectTurnIllustration(pool, ownerUserId, turnId, asset!.id)).resolves.toEqual({ assetUrl: asset!.url });
    const selected = await pool.query<{ image_url: string }>("SELECT image_url FROM turns WHERE id = $1", [turnId]);
    expect(selected.rows[0]?.image_url).toBe(asset!.url);
    const reference = await pool.query(
      "SELECT id FROM asset_references WHERE owner_user_id = $1 AND asset_id = $2 AND turn_id = $3 AND asset_role = 'turn_illustration'",
      [ownerUserId, asset!.id, turnId]
    );
    expect(reference.rowCount).toBe(1);
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
        sensitiveContentFilter: "provider-default",
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
