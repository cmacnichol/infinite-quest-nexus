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
import { enqueueGeneration, getGenerationJob, getGenerationResult, retryGeneration, rewindCampaign, runGenerationJob, syncPlayerCampaignConfig } from "../../services/api/src/generation-service.js";
import { buildContextPreview, setCampaignEmbeddingConfig } from "../../services/api/src/memory-service.js";
import { getCampaignCostSummary } from "../../services/api/src/cost-service.js";

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
    image_prompt: "Synthetic Location Gamma with Marker Three visible.",
    continuity_summary: "Test Character has reached Location Gamma after discovering Marker Three.",
    canonical_facts: ["Location Gamma is open."],
    superseded_facts: [],
    open_threads: ["Determine what Marker Three unlocks."]
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
          usage: { prompt_tokens: 700, completion_tokens: 220, total_tokens: 920, cost: 0.00125 }
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

  async function campaign(storyLength?: "brief" | "standard" | "long" | "extended") {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Generated campaign ${crypto.randomUUID()}`;
    if (storyLength) fixture.settings.storyLength = storyLength;
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
    expect(serialized).toContain("Use synthetic fixture markers only");
    expect(serialized).not.toContain("d100");
    expect(serialized).not.toContain("Private synthetic state");
    const committed = await pool.query<{ narration: string; content: string }>(
      `SELECT t.narration, m.content FROM turns t JOIN chronicle_memories m ON m.turn_id = t.id
        WHERE t.campaign_id = $1 AND t.turn_number = 3`, [imported.campaignId]
    );
    expect(committed.rows[0]?.narration).toContain("Marker Three");
    expect(committed.rows[0]?.content).not.toMatch(/roll|dice|check/i);
    const generationResult = await getGenerationResult(pool, job.id);
    expect(generationResult).toMatchObject({
      status: "completed",
      campaignId: imported.campaignId,
      turnNumber: 3,
      narration: expect.stringContaining("Marker Three"),
      reportedCost: { currency: "USD" }
    });
    expect(Number(generationResult.reportedCost?.amount || 0)).toBeGreaterThan(0);
    const costSummary = await getCampaignCostSummary(pool, imported.campaignId);
    expect(costSummary).toMatchObject({ campaignId: imported.campaignId, hasReportedCosts: true });
    expect(Number(costSummary.totals[0]?.byCategory.story || 0)).toBeGreaterThan(0);
    expect(Number(costSummary.totals[0]?.otherCampaignOperations || 0)).toBe(0);
    const nextContext = await buildContextPreview(pool, imported.campaignId, {
      budgetTokens: 8000,
      compression: "auto",
      query: "Marker Three unlocks",
      recentTurns: 8
    });
    const nextSerialized = JSON.stringify(nextContext.scopes);
    expect(nextSerialized).toContain("Private synthetic continuity marker");
    expect(nextSerialized).toContain("Location Gamma");
    expect(nextSerialized).toContain("Determine what Marker Three unlocks");
  });

  it("continues remote story generation when a separate local embedding provider is unavailable", async () => {
    const imported = await campaign();
    const embeddingProvider = await createProvider(pool, {
      name: `Unavailable local embeddings ${crypto.randomUUID()}`,
      providerType: "lmstudio",
      providerRole: "embedding",
      baseUrl: "http://127.0.0.1:1",
      defaultModel: "text-embedding-nomic-embed-text-v1.5",
      contextWindowTokens: 8192,
      maxOutputTokens: 1024,
      temperature: 0,
      enabled: true,
      configuration: {}
    }, credentialSecret);
    await setCampaignEmbeddingConfig(pool, imported.campaignId, {
      enabled: true,
      providerProfileId: embeddingProvider.id,
      model: "text-embedding-nomic-embed-text-v1.5",
      batchSize: 8
    });
    replies.push({ content: validStory("Remote story generation remains available through lexical Chronicle retrieval.") });
    const job = await queue(imported.campaignId, "Continue despite unavailable local embeddings.");

    await runGenerationJob(pool, "story-worker-provider-separation", 30, credentialSecret);

    expect(await getGenerationJob(pool, job.id)).toMatchObject({ status: "completed" });
    expect(await getGenerationResult(pool, job.id)).toMatchObject({
      status: "completed",
      narration: expect.stringContaining("lexical Chronicle retrieval")
    });
    await pool.query(
      "DELETE FROM chronicle_jobs WHERE campaign_id = $1",
      [imported.campaignId]
    );
  });

  it("records every durable generation phase in order", async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const auditTable = `generation_status_audit_${suffix}`;
    const auditFunction = `record_generation_status_${suffix}`;
    const insertTrigger = `generation_status_insert_${suffix}`;
    const updateTrigger = `generation_status_update_${suffix}`;
    await pool.query(`CREATE TABLE ${auditTable} (
      sequence bigserial PRIMARY KEY,
      generation_job_id uuid NOT NULL,
      status text NOT NULL
    )`);
    await pool.query(`CREATE FUNCTION ${auditFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO ${auditTable} (generation_job_id, status) VALUES (NEW.id, NEW.status);
        RETURN NEW;
      END
    $$`);
    await pool.query(`CREATE TRIGGER ${insertTrigger} AFTER INSERT ON generation_jobs
      FOR EACH ROW EXECUTE FUNCTION ${auditFunction}()`);
    await pool.query(`CREATE TRIGGER ${updateTrigger} AFTER UPDATE OF status ON generation_jobs
      FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION ${auditFunction}()`);
    try {
      const imported = await campaign();
      replies.push({ content: validStory() });
      const job = await queue(imported.campaignId);
      await runGenerationJob(pool, `story-worker-progress-${suffix}`, 30, credentialSecret);
      const statuses = await pool.query<{ status: string }>(
        `SELECT status FROM ${auditTable} WHERE generation_job_id = $1 ORDER BY sequence`,
        [job.id]
      );
      expect(statuses.rows.map((row) => row.status)).toEqual([
        "queued",
        "assessing",
        "generating",
        "validating",
        "committing",
        "completed"
      ]);
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${insertTrigger} ON generation_jobs`);
      await pool.query(`DROP TRIGGER IF EXISTS ${updateTrigger} ON generation_jobs`);
      await pool.query(`DROP FUNCTION IF EXISTS ${auditFunction}()`);
      await pool.query(`DROP TABLE IF EXISTS ${auditTable}`);
    }
  });

  it("rewinds the existing campaign without copying its world or campaign", async () => {
    const imported = await campaign();
    replies.push({ content: validStory() });
    const job = await queue(imported.campaignId);
    await runGenerationJob(pool, "story-worker-rewind", 30, credentialSecret);
    const before = await pool.query<{ worlds: string; campaigns: string }>(
      `SELECT (SELECT count(*) FROM worlds)::text AS worlds,
              (SELECT count(*) FROM campaigns)::text AS campaigns`
    );
    const costBefore = await pool.query<{ count: string; amount: string }>(
      `SELECT count(*)::text AS count, coalesce(sum(amount), 0)::text AS amount
         FROM provider_cost_events WHERE campaign_id = $1`,
      [imported.campaignId]
    );

    const rewound = await rewindCampaign(pool, imported.campaignId, { targetTurnNumber: 2 });

    expect(rewound).toMatchObject({
      campaignId: imported.campaignId,
      activeTurnNumber: 2,
      discardedTurnCount: 1,
      stateSnapshot: { scratchpad: "Private synthetic continuity marker." }
    });
    const after = await pool.query<{ worlds: string; campaigns: string }>(
      `SELECT (SELECT count(*) FROM worlds)::text AS worlds,
              (SELECT count(*) FROM campaigns)::text AS campaigns`
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    const campaignState = await pool.query<{ active_turn_number: number; scratchpad_private: string }>(
      `SELECT c.active_turn_number, cs.scratchpad_private
         FROM campaigns c JOIN campaign_state cs ON cs.campaign_id = c.id
        WHERE c.id = $1`,
      [imported.campaignId]
    );
    expect(campaignState.rows[0]).toEqual({
      active_turn_number: 2,
      scratchpad_private: "Private synthetic continuity marker."
    });
    const ledger = await pool.query<{ turn_number: number }>(
      "SELECT turn_number FROM turns WHERE campaign_id = $1 ORDER BY turn_number",
      [imported.campaignId]
    );
    expect(ledger.rows.map((row) => row.turn_number)).toEqual([1, 2]);
    const discardedArtifacts = await pool.query<{ jobs: string; memories: string }>(
      `SELECT
         (SELECT count(*) FROM generation_jobs WHERE id = $2)::text AS jobs,
         (SELECT count(*) FROM chronicle_memories WHERE campaign_id = $1 AND content LIKE '%Marker Three%')::text AS memories`,
      [imported.campaignId, job.id]
    );
    expect(discardedArtifacts.rows[0]).toEqual({ jobs: "0", memories: "0" });
    const costAfter = await pool.query<{ count: string; amount: string; attributed: string }>(
      `SELECT count(*)::text AS count, coalesce(sum(amount), 0)::text AS amount,
              count(*) FILTER (WHERE turn_id IS NOT NULL)::text AS attributed
         FROM provider_cost_events WHERE campaign_id = $1`,
      [imported.campaignId]
    );
    expect(costAfter.rows[0]).toMatchObject({
      count: costBefore.rows[0]?.count,
      amount: costBefore.rows[0]?.amount,
      attributed: "0"
    });
  });

  it("accepts a post-rewind story when the provider omits only derived Chronicle fields", async () => {
    const imported = await campaign();
    replies.push({ content: validStory("The first path reaches Marker Three.") });
    const firstJob = await queue(imported.campaignId, "Take the first path.");
    await runGenerationJob(pool, "story-worker-branch-source", 30, credentialSecret);
    expect(await getGenerationJob(pool, firstJob.id)).toMatchObject({ status: "completed" });
    await rewindCampaign(pool, imported.campaignId, { targetTurnNumber: 2 });

    const branchStory = JSON.parse(validStory("The reply opens a different path through Location Gamma."));
    delete branchStory.continuity_summary;
    delete branchStory.canonical_facts;
    delete branchStory.superseded_facts;
    delete branchStory.open_threads;
    replies.push({ content: JSON.stringify(branchStory) });
    const branchJob = await queue(imported.campaignId, "Reply.");
    await runGenerationJob(pool, "story-worker-branch-reply", 30, credentialSecret);

    expect(await getGenerationJob(pool, branchJob.id)).toMatchObject({ status: "completed", expectedTurnNumber: 3 });
    expect(await getGenerationResult(pool, branchJob.id)).toMatchObject({
      status: "completed",
      narration: expect.stringContaining("different path")
    });
  });

  it("creates an optional campaign branch on the same immutable world version", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Branch source ${crypto.randomUUID()}`;
    const source = await importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "branch-source.story", story: fixture }));
    const before = await pool.query<{ worlds: string; campaigns: string }>(
      `SELECT (SELECT count(*) FROM worlds)::text AS worlds,
              (SELECT count(*) FROM campaigns)::text AS campaigns`
    );
    fixture.turns = fixture.turns.slice(0, 1);
    const branch = await importLegacyStory(pool, storyImportRequestSchema.parse({
      sourceName: "branch-copy.story",
      story: fixture,
      targetWorldVersionId: source.worldVersionId
    }));
    const after = await pool.query<{ worlds: string; campaigns: string }>(
      `SELECT (SELECT count(*) FROM worlds)::text AS worlds,
              (SELECT count(*) FROM campaigns)::text AS campaigns`
    );

    expect(branch.worldId).toBe(source.worldId);
    expect(branch.worldVersionId).toBe(source.worldVersionId);
    expect(branch.campaignId).not.toBe(source.campaignId);
    expect(after.rows[0]?.worlds).toBe(before.rows[0]?.worlds);
    expect(Number(after.rows[0]?.campaigns)).toBe(Number(before.rows[0]?.campaigns) + 1);
  });

  it("snapshots the campaign story-length profile into the durable job and prompt", async () => {
    const imported = await campaign("extended");
    replies.push({ content: validStory() });
    const requestOffset = requests.length;
    const job = await queue(imported.campaignId);
    await pool.query("UPDATE campaigns SET story_length_profile = 'brief' WHERE id = $1", [imported.campaignId]);

    await runGenerationJob(pool, "story-worker-length", 30, credentialSecret);
    const snapshot = await pool.query<{ context_options: Record<string, unknown> }>(
      "SELECT context_options FROM generation_jobs WHERE id = $1",
      [job.id]
    );
    expect(snapshot.rows[0]?.context_options).toMatchObject({
      storyLengthProfile: "extended",
      narrationMinWords: 1200,
      narrationMaxWords: 2000
    });
    const storyRequest = requests.slice(requestOffset).find((request) => JSON.stringify(request).includes("fiction writer for Infinite Quest"));
    const storyUserMessage = storyRequest?.messages?.find((message: any) => message.role === "user");
    const storyPayload = JSON.parse(storyUserMessage?.content || "{}");
    expect(storyPayload.narration_length).toEqual({
      profile: "extended",
      target_min_words: 1200,
      target_max_words: 2000
    });
  });

  it("resolves an RPG action privately and passes only its fictional consequence into narration", async () => {
    const imported = await campaign();
    await syncPlayerCampaignConfig(pool, imported.campaignId, {
      expectedTurnNumber: 2,
      useRpgStats: true,
      suppressEventTriggers: false,
      rpgStats: [{ id: "test_stat", name: "Test Stat", value: 99, note: "synthetic fixture value" }],
      eventTriggers: [],
      pendingEventTriggers: []
    });
    replies.push(
      { content: JSON.stringify({
        stat_id: "test_stat",
        difficulty_modifier: 0,
        rationale: "Synthetic assessment rationale.",
        favorable_outcome: "Marker Five becomes active.",
        setback_outcome: "Marker Five remains inactive."
      }) },
      { content: validStory("Location Gamma opens and Marker Three appears.") }
    );
    const requestOffset = requests.length;
    const job = await queue(imported.campaignId, "Open Location Gamma.");
    await runGenerationJob(pool, "story-worker-guidance", 30, credentialSecret);
    expect(await getGenerationJob(pool, job.id)).toMatchObject({ status: "completed" });
    const turnResult = await getGenerationResult(pool, job.id);
    expect(turnResult.mechanics.roll).toMatchObject({ statId: "test_stat", target: 99 });
    const storyRequest = requests.slice(requestOffset).find((request) => JSON.stringify(request).includes("fiction writer for Infinite Quest"));
    const storyUserMessage = storyRequest?.messages?.find((message: any) => message.role === "user");
    const storyPayload = JSON.parse(storyUserMessage?.content || "{}");
    const outcomeGuidance = JSON.stringify(storyPayload.fiction_only_outcome_guidance || []);
    expect(outcomeGuidance).toContain("Marker Five becomes active");
    expect(outcomeGuidance).not.toMatch(/d20|\broll(?:s|ed|ing)?\b|\bdice?\b|test_stat|difficulty_modifier|target/i);
    expect(storyPayload).not.toHaveProperty("mechanics");
    expect(storyPayload).not.toHaveProperty("rpgStats");
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
    const imported = await campaign("long");
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
    expect(JSON.stringify(requests.at(-1))).toContain("400-600 narration words");
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
    const recoveryMessages = requests.at(-1)?.messages || [];
    expect(recoveryMessages.at(-2)?.content).toContain("She rolls a 17");
    expect(recoveryMessages.at(-1)?.content).toContain('"rolls a 17"');
  });

  it("accepts ordinary loading-dock language without invoking recovery", async () => {
    const imported = await campaign();
    const requestCount = requests.length;
    replies.push({ content: validStory("A roll-up door closes while a cart approaches on rolling wheels.") });
    const job = await queue(imported.campaignId);
    await runGenerationJob(pool, "story-worker-benign-roll", 30, credentialSecret);
    expect(await getGenerationJob(pool, job.id)).toMatchObject({ status: "completed" });
    expect(requests.length - requestCount).toBe(1);
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
      rpgStats: [{ id: "test_stat", name: "Test Stat", value: 70, note: "synthetic fixture value" }],
      eventTriggers: [],
      pendingEventTriggers: []
    });
    replies.push(
      { content: JSON.stringify({
        stat_id: "test_stat",
        difficulty_modifier: 0,
        rationale: "Synthetic assessment rationale.",
        favorable_outcome: "Marker Five becomes active.",
        setback_outcome: "Marker Five remains inactive."
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
