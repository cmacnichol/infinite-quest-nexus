import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generationRequestSchema, illustrationConfigSchema } from "../../packages/contracts/src/generation.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, type DatabasePool } from "../../packages/database/src/pool.js";
import { enqueueGeneration, getGenerationJob, runGenerationJob } from "../../services/api/src/generation-service.js";
import { getImageJob, listCampaignImageJobs, runImageJob, setIllustrationConfig } from "../../services/api/src/image-service.js";
import { importLegacyStory } from "../../services/api/src/import-service.js";
import { createProvider } from "../../services/api/src/provider-service.js";
import { getCampaignCostSummary } from "../../services/api/src/cost-service.js";

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

  it("queues after story commit, sends only the fiction prompt, and stores generated bytes", async () => {
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

  it("preserves the accepted story when the independent image endpoint fails", async () => {
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
});
