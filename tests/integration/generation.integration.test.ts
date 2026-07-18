import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { generationRequestSchema } from "../../packages/contracts/src/generation.js";
import { importLegacyStory } from "../../services/api/src/import-service.js";
import { createProvider } from "../../services/api/src/provider-service.js";
import { enqueueGeneration, getGenerationJob, getGenerationResult, retryGeneration, runGenerationJob, syncPlayerCampaignConfig } from "../../services/api/src/generation-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const credentialSecret = "integration-test-credential-secret";

type MockReply = { content: string; finishReason?: string };

function validStory(narration = "Location Gamma opens and Marker Three becomes visible."): string {
  return JSON.stringify({
    narration,
    choices: ["Enter Location Gamma.", "Call Test Character.", "Study Marker Three.", "Wait."],
    custom_action_suggestion: "Inspect Object Delta.",
    scratchpad: "Private synthetic continuity marker.",
    tracker_updates: [{ name: "Location Gamma", value: "open" }],
    image_prompt: "Synthetic Location Gamma with Marker Three visible."
  });
}

integration("durable Story Engine integration", () => {
  let pool: DatabasePool;
  let server: Server;
  let baseUrl = "";
  let providerId = "";
  const replies: MockReply[] = [];
  const requests: Array<Record<string, any>> = [];

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 5);
    await migrateDatabase(pool, resolve("database/migrations"));
    server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        requests.push(JSON.parse(body || "{}"));
        const reply = replies.shift() || { content: validStory() };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: crypto.randomUUID(),
          model: "deterministic-mock",
          choices: [{ message: { content: reply.content }, finish_reason: reply.finishReason || "stop" }],
          usage: { prompt_tokens: 700, completion_tokens: 220, total_tokens: 920 }
        }));
      });
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Mock provider did not expose a TCP address.");
    baseUrl = `http://127.0.0.1:${address.port}`;
    const provider = await createProvider(pool, {
      name: `Deterministic mock ${crypto.randomUUID()}`,
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
    providerId = provider.id;
  });

  afterAll(async () => {
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    await pool.end();
  });

  async function campaign() {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Generated campaign ${crypto.randomUUID()}`;
    return importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "generation.story", story: fixture }));
  }

  async function queue(campaignId: string, action = "Open Location Gamma.") {
    return enqueueGeneration(pool, campaignId, generationRequestSchema.parse({
      action,
      providerProfileId: providerId,
      idempotencyKey: crypto.randomUUID(),
      context: { budgetTokens: 16000, compression: "full", recentTurns: 8 }
    }));
  }

  it("sends the authoritative Chronicle snapshot and atomically commits fiction-only output", async () => {
    const imported = await campaign();
    replies.push({ content: validStory() });
    const job = await queue(imported.campaignId);
    expect(await runGenerationJob(pool, "story-worker-a", 30, credentialSecret)).toBe(true);
    expect(await getGenerationJob(pool, job.id)).toMatchObject({ status: "completed", expectedTurnNumber: 3 });
    const lastRequest = requests.at(-1);
    const serialized = JSON.stringify(lastRequest);
    expect(serialized).toContain("Location Beta");
    expect(serialized).toContain("Object Gamma");
    expect(serialized).not.toContain("d100");
    expect(serialized).not.toContain("Private synthetic state");
    const committed = await pool.query<{ narration: string; content: string }>(
      `SELECT t.narration, m.content FROM turns t JOIN chronicle_memories m ON m.turn_id = t.id
        WHERE t.campaign_id = $1 AND t.turn_number = 3`, [imported.campaignId]
    );
    expect(committed.rows[0]?.narration).toContain("Marker Three");
    expect(committed.rows[0]?.content).not.toMatch(/roll|dice|check/i);
    expect(await getGenerationResult(pool, job.id)).toMatchObject({
      status: "completed",
      campaignId: imported.campaignId,
      turnNumber: 3,
      narration: expect.stringContaining("Marker Three")
    });
  });

  it("resolves an RPG action privately and passes only its fictional consequence into narration", async () => {
    const imported = await campaign();
    await syncPlayerCampaignConfig(pool, imported.campaignId, {
      expectedTurnNumber: 2,
      useRpgStats: true,
      suppressEventTriggers: false,
      rpgStats: [{ id: "finesse", name: "Finesse", value: 99, note: "delicate locks and careful movement" }],
      eventTriggers: [],
      pendingEventTriggers: []
    });
    replies.push(
      { content: JSON.stringify({
        stat_id: "finesse",
        difficulty_modifier: 0,
        rationale: "The lock calls for a delicate touch.",
        favorable_outcome: "The catch yields, but the hinges announce the character's arrival.",
        setback_outcome: "The catch jams, and the hinges announce the character's arrival."
      }) },
      { content: validStory("Location Gamma opens and Marker Three appears.") }
    );
    const requestOffset = requests.length;
    const job = await queue(imported.campaignId, "Open Location Gamma.");
    await runGenerationJob(pool, "story-worker-guidance", 30, credentialSecret);
    expect(await getGenerationJob(pool, job.id)).toMatchObject({ status: "completed" });
    const turnResult = await getGenerationResult(pool, job.id);
    expect(turnResult.mechanics.roll).toMatchObject({ statId: "finesse", target: 99 });
    const storyRequest = requests.slice(requestOffset).find((request) => JSON.stringify(request).includes("fiction writer for Infinite Quest"));
    const serialized = JSON.stringify(storyRequest);
    expect(serialized).toContain("hinges announce");
    expect(serialized).not.toMatch(/d20|\broll(?:s|ed|ing)?\b|\bdice?\b|finesse|difficulty_modifier|target.{0,10}99/i);
  });

  it("evaluates before and after triggers privately and commits deferred trigger state", async () => {
    const imported = await campaign();
    await syncPlayerCampaignConfig(pool, imported.campaignId, {
      expectedTurnNumber: 2,
      useRpgStats: false,
      suppressEventTriggers: false,
      rpgStats: [],
      eventTriggers: [
        { id: "before-location", label: "Before marker", timing: "before", condition: "The player opens Location Gamma", effect: "Marker Four becomes active.", addTextAfter: false, triggeredCount: 0, lastTriggeredTurn: null, lastTriggeredAt: null },
        { id: "after-object", label: "After marker", timing: "after", condition: "The new narration reveals Marker Three", effect: "Object Delta changes state.", addTextAfter: false, triggeredCount: 0, lastTriggeredTurn: null, lastTriggeredAt: null }
      ],
      pendingEventTriggers: []
    });
    replies.push(
      { content: JSON.stringify({ activated_trigger_ids: ["before-location"], reasons: { "before-location": "Location Gamma is being opened." } }) },
      { content: validStory("Marker Four activates as Location Gamma opens.") },
      { content: JSON.stringify({ activated_trigger_ids: ["after-object"], reasons: { "after-object": "Marker Three is now visible." } }) }
    );
    const requestOffset = requests.length;
    const job = await queue(imported.campaignId);
    await runGenerationJob(pool, "story-worker-triggers", 30, credentialSecret);
    const result = await getGenerationResult(pool, job.id);
    expect(result.mechanics.beforeEvents).toHaveLength(1);
    expect(result.mechanics.afterEvents).toHaveLength(1);
    expect(result.stateSnapshot.pendingEventTriggers).toHaveLength(1);
    expect(result.stateSnapshot.eventTriggers.every((trigger: any) => trigger.triggeredCount === 1)).toBe(true);
    const storyRequest = requests.slice(requestOffset).find((request) => JSON.stringify(request).includes("fiction writer for Infinite Quest"));
    expect(JSON.stringify(storyRequest)).toContain("Marker Four becomes active");
    expect(JSON.stringify(storyRequest)).not.toContain("activation_reason");
  });

  it("recovers an output-limited response with a compact second request", async () => {
    const imported = await campaign();
    replies.push(
      { content: '{"narration":"Location Gamma opens', finishReason: "length" },
      { content: validStory("Location Gamma opens in a compact, complete response.") }
    );
    const job = await queue(imported.campaignId);
    await runGenerationJob(pool, "story-worker-b", 30, credentialSecret);
    expect(await getGenerationJob(pool, job.id)).toMatchObject({ status: "completed" });
    const attempts = await pool.query<{ recovery_kind: string }>("SELECT recovery_kind FROM generation_attempts WHERE generation_job_id = $1 ORDER BY attempt_number", [job.id]);
    expect(attempts.rows.map((row) => row.recovery_kind)).toEqual(["initial", "compact_completion"]);
    expect(JSON.stringify(requests.at(-1))).toContain("compact, complete JSON object");
  });

  it("rewrites mechanics-contaminated output before committing it", async () => {
    const imported = await campaign();
    replies.push(
      { content: validStory("She rolls a 17 and the lock opens.") },
      { content: validStory("Her practiced touch finds the catch, and the lock opens.") }
    );
    const job = await queue(imported.campaignId);
    await runGenerationJob(pool, "story-worker-c", 30, credentialSecret);
    expect(await getGenerationJob(pool, job.id)).toMatchObject({ status: "completed" });
    const turn = await pool.query<{ narration: string }>("SELECT narration FROM turns WHERE campaign_id = $1 AND turn_number = 3", [imported.campaignId]);
    expect(turn.rows[0]?.narration).not.toMatch(/roll|dice|check/i);
  });

  it("leaves the accepted ledger unchanged when compact recovery is also truncated", async () => {
    const imported = await campaign();
    replies.push(
      { content: '{"narration":"First partial', finishReason: "length" },
      { content: '{"narration":"Second partial', finishReason: "length" }
    );
    const job = await queue(imported.campaignId);
    await runGenerationJob(pool, "story-worker-d", 30, credentialSecret);
    expect(await getGenerationJob(pool, job.id)).toMatchObject({ status: "recoverable", errorCode: "output_limit" });
    const campaignRow = await pool.query<{ active_turn_number: number }>("SELECT active_turn_number FROM campaigns WHERE id = $1", [imported.campaignId]);
    expect(campaignRow.rows[0]?.active_turn_number).toBe(2);
  });

  it("reuses the persisted private roll when a recoverable story job is retried", async () => {
    const imported = await campaign();
    await syncPlayerCampaignConfig(pool, imported.campaignId, {
      expectedTurnNumber: 2,
      useRpgStats: true,
      suppressEventTriggers: false,
      rpgStats: [{ id: "finesse", name: "Finesse", value: 70, note: "delicate locks" }],
      eventTriggers: [],
      pendingEventTriggers: []
    });
    replies.push(
      { content: JSON.stringify({
        stat_id: "finesse",
        difficulty_modifier: 0,
        rationale: "The mechanism requires a careful touch.",
        favorable_outcome: "The lock yields quietly.",
        setback_outcome: "The lock jams and draws attention."
      }) },
      { content: '{"narration":"First partial', finishReason: "length" },
      { content: '{"narration":"Second partial', finishReason: "length" }
    );
    const job = await queue(imported.campaignId);
    await runGenerationJob(pool, "story-worker-reroll-a", 30, credentialSecret);
    const recoverable = await getGenerationJob(pool, job.id);
    expect(recoverable).toMatchObject({ status: "recoverable" });
    const privateState = await pool.query<{ orchestration_private: { roll: unknown } }>(
      "SELECT orchestration_private FROM generation_jobs WHERE id = $1",
      [job.id]
    );
    const persistedRoll = privateState.rows[0]?.orchestration_private.roll;
    const requestCount = requests.length;

    await retryGeneration(pool, job.id);
    replies.push({ content: validStory("The same resolved attempt now returns a complete scene.") });
    await runGenerationJob(pool, "story-worker-reroll-b", 30, credentialSecret);
    const result = await getGenerationResult(pool, job.id);
    expect(result.mechanics.roll).toEqual(persistedRoll);
    expect(requests.length - requestCount).toBe(1);
  });
});
