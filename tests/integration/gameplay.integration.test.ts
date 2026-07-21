import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { buildServer } from "../../services/api/src/server.js";
import { createProvider } from "../../services/api/src/provider-service.js";
import { runGenerationJob } from "../../services/api/src/generation-service.js";
import { runImageJob } from "../../services/api/src/image-service.js";
import type { RuntimeConfig } from "../../packages/database/src/config.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const credentialSecret = "integration-test-credential-secret";

function makeConfig(databaseUrl: string): RuntimeConfig {
  return {
    role: "all",
    host: "127.0.0.1",
    port: 8080,
    databaseUrl,
    databaseMaxConnections: 5,
    migrationDirectory: resolve("database/migrations"),
    migrationWaitSeconds: 10,
    allowMaintenanceMigrations: false,
    workerPollIntervalMs: 1000,
    workerLeaseSeconds: 60,
    webRoot: resolve("apps/web/public"),
    legacyIndexPath: resolve("index.html"),
    assetStorageDriver: "filesystem",
    assetStorageRoot: resolve("local-data/assets"),
    credentialEncryptionKey: credentialSecret,
    corsAllowedOrigins: ["*"]
  };
}

function validStory(narration = "You step into the Ancient Observatory."): string {
  return JSON.stringify({
    narration,
    choices: ["Examine the telescope.", "Read the star maps.", "Light a torch.", "Leave the observatory."],
    custom_action_suggestion: "Look up at the glass dome.",
    scratchpad: "The observatory dome is cracked and reveals strange emerald constellations.",
    tracker_updates: [{ name: "Observatory Power", value: "Offline" }],
    image_prompt: "Ancient stone observatory with cracked glass dome and emerald starlight.",
    continuity_summary: "Player arrived at the Ancient Observatory and noticed the strange emerald constellations.",
    canonical_facts: ["The Ancient Observatory dome is cracked."],
    superseded_facts: [],
    open_threads: ["Find out how to restore power to the observatory."]
  });
}

integration("gameplay: complete Story Engine & Story Player API integration", () => {
  let pool: DatabasePool;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let mockServer: Server;
  let baseUrl = "";
  let textProviderId = "";
  let imageProviderId = "";
  const replies: Array<{ content?: string; b64_json?: string; finishReason?: string }> = [];
  const requests: Array<Record<string, any>> = [];

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 5);
    await migrateDatabase(pool, resolve("database/migrations"));
    const config = makeConfig(databaseUrl!);
    app = await buildServer({ config, pool });

    mockServer = createServer((req, res) => {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        try {
          if (body) requests.push(JSON.parse(body));
        } catch (_) {}
        const nextReply = replies.shift() || { content: validStory() };
        res.writeHead(200, { "content-type": "application/json" });
        if (req.url?.includes("/images/generations")) {
          res.end(JSON.stringify({
            created: Math.floor(Date.now() / 1000),
            data: [{ b64_json: nextReply.b64_json || "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }]
          }));
        } else {
          res.end(JSON.stringify({
            id: "chatcmpl-mock",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "deterministic-mock",
            choices: [{
              index: 0,
              message: { role: "assistant", content: nextReply.content || validStory() },
              finish_reason: nextReply.finishReason || "stop"
            }],
            usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 }
          }));
        }
      });
    });

    await new Promise<void>((resolveListen) => mockServer.listen(0, "127.0.0.1", resolveListen));
    const address = mockServer.address();
    if (!address || typeof address === "string") throw new Error("Mock server did not expose TCP address.");
    baseUrl = `http://127.0.0.1:${address.port}`;

    const textProvider = await createProvider(pool, {
      name: `Mock Text ${crypto.randomUUID()}`,
      providerType: "openai_compatible",
      providerRole: "text",
      baseUrl,
      defaultModel: "deterministic-mock",
      contextWindowTokens: 32768,
      maxOutputTokens: 4096,
      temperature: 0,
      enabled: true,
      configuration: {}
    }, credentialSecret);
    textProviderId = textProvider.id;

    const imageProvider = await createProvider(pool, {
      name: `Mock Image ${crypto.randomUUID()}`,
      providerType: "openai_compatible",
      providerRole: "image",
      baseUrl,
      defaultModel: "dall-e-3",
      contextWindowTokens: 4096,
      maxOutputTokens: 1024,
      temperature: 0,
      enabled: true,
      configuration: {}
    }, credentialSecret);
    imageProviderId = imageProvider.id;
  });

  afterAll(async () => {
    if (mockServer) await new Promise<void>((resolveClose, reject) => mockServer.close(error => error ? reject(error) : resolveClose()));
    await pool.end();
  });

  it("orchestrates end-to-end Story Player turn submission, worker execution, and turn retrieval", async () => {
    // 1. Import a baseline campaign
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Integration Story Player ${crypto.randomUUID()}`;

    const importResponse = await app.inject({
      method: "POST",
      url: "/api/v1/imports/legacy-story",
      payload: { sourceName: "gameplay.story", story: fixture }
    });
    expect(importResponse.statusCode).toBe(201);
    const { campaignId, worldVersionId } = importResponse.json();
    expect(campaignId).toBeDefined();

    // 2. Fetch campaign initial state as story.js does on load
    const campaignResponse = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaignId}`
    });
    expect(campaignResponse.statusCode).toBe(200);
    const campaignData = campaignResponse.json();
    expect(campaignData.id).toBe(campaignId);
    expect(campaignData.worldVersionId).toBe(worldVersionId);

    const turnsResponse = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaignId}/turns`
    });
    expect(turnsResponse.statusCode).toBe(200);
    const initialTurns = turnsResponse.json().turns;
    expect(initialTurns.length).toBeGreaterThan(0);

    // 3. Submit action via POST /api/v1/campaigns/:campaignId/generations
    replies.push({ content: validStory("You step into the Ancient Observatory and hear a hum.") });
    const genResponse = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/generations`,
      payload: {
        action: "Examine the telescope.",
        providerProfileId: textProviderId,
        idempotencyKey: crypto.randomUUID(),
        context: { budgetTokens: 16000, compression: "auto", recentTurns: 10 }
      }
    });
    expect(genResponse.statusCode).toBe(202);
    const job = genResponse.json();
    expect(job.id).toBeDefined();
    expect(job.status).toBe("pending");

    // 4. Simulate worker executing the generation job
    const workerRan = await runGenerationJob(pool, "worker-gameplay-1", 30, credentialSecret);
    expect(workerRan).toBe(true);

    // 5. Poll generation status via API
    const pollResponse = await app.inject({
      method: "GET",
      url: `/api/v1/generation-jobs/${job.id}`
    });
    expect(pollResponse.statusCode).toBe(200);
    expect(pollResponse.json().status).toBe("completed");

    // 6. Verify that the turn list now contains the generated turn with structured choices and trackers
    const turnsResponseAfter = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaignId}/turns`
    });
    expect(turnsResponseAfter.statusCode).toBe(200);
    const turnsAfter = turnsResponseAfter.json().turns;
    const latestTurn = turnsAfter[turnsAfter.length - 1];
    expect(latestTurn.narration).toContain("Ancient Observatory");
    expect(latestTurn.choices).toContain("Examine the telescope.");
  });

  it("supports scratchpad and tracker config updates via PUT /api/v1/campaigns/:id/player-config", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    const importResponse = await app.inject({
      method: "POST",
      url: "/api/v1/imports/legacy-story",
      payload: { sourceName: "gameplay.story", story: fixture }
    });
    const { campaignId } = importResponse.json();

    const configUpdate = await app.inject({
      method: "PUT",
      url: `/api/v1/campaigns/${campaignId}/player-config`,
      payload: {
        scratchpad: "Updated continuity scratchpad notes.",
        trackers: [
          { name: "Artifact Power", value: "Charging", rules: "Update when energy is absorbed." }
        ]
      }
    });
    expect(configUpdate.statusCode).toBe(200);
    expect(configUpdate.json().scratchpad).toBe("Updated continuity scratchpad notes.");

    const campaignResponse = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaignId}`
    });
    expect(campaignResponse.json().playerConfig.scratchpad).toBe("Updated continuity scratchpad notes.");
  });

  it("handles campaign rewind via POST /api/v1/campaigns/:id/rewind", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    const importResponse = await app.inject({
      method: "POST",
      url: "/api/v1/imports/legacy-story",
      payload: { sourceName: "gameplay.story", story: fixture }
    });
    const { campaignId } = importResponse.json();

    // Rewind back to turn 1
    const rewindResponse = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/rewind`,
      payload: { targetTurnNumber: 1 }
    });
    expect(rewindResponse.statusCode).toBe(200);

    const turnsResponse = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaignId}/turns`
    });
    const turns = turnsResponse.json().turns;
    expect(turns.length).toBe(1);
    expect(turns[0].turnNumber).toBe(1);
  });

  it("implements JSON, HTML, and Markdown exports via GET /api/v1/campaigns/:id/export", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    const importResponse = await app.inject({
      method: "POST",
      url: "/api/v1/imports/legacy-story",
      payload: { sourceName: "gameplay.story", story: fixture }
    });
    const { campaignId } = importResponse.json();

    // JSON export
    const jsonExport = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaignId}/export?format=campaign_json`
    });
    expect(jsonExport.statusCode).toBe(200);
    const exportedJson = JSON.parse(jsonExport.payload);
    expect(exportedJson.campaign.id).toBe(campaignId);
    expect(exportedJson.turns).toBeInstanceOf(Array);

    // HTML export
    const htmlExport = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaignId}/export?format=html`
    });
    expect(htmlExport.statusCode).toBe(200);
    expect(htmlExport.headers["content-type"]).toContain("text/html");
    expect(htmlExport.payload).toContain("<!DOCTYPE html>");

    // Markdown export
    const mdExport = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaignId}/export?format=markdown`
    });
    expect(mdExport.statusCode).toBe(200);
    expect(mdExport.headers["content-type"]).toContain("text/markdown");
    expect(mdExport.payload).toContain("# ");
  });
});
