import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabasePool, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { generationRequestSchema, generationRetryLatestRequestSchema, illustrationConfigSchema } from "../../packages/contracts/src/generation.js";
import { importLegacyStory } from "../../services/api/src/import-service.js";
import { setIllustrationConfig } from "../../services/api/src/image-service.js";
import { createProvider } from "../../services/api/src/provider-service.js";
import { branchCampaign, cancelGeneration, enqueueGeneration, enqueueLatestReplacement, getGenerationJob, getGenerationResult, retryGeneration, rewindCampaign, runGenerationJob, syncPlayerCampaignConfig } from "../../services/api/src/generation-service.js";
import { buildContextPreview, setCampaignEmbeddingConfig } from "../../services/api/src/memory-service.js";
import { getCampaignCostSummary } from "../../services/api/src/cost-service.js";
import { getCampaignRuntimeState, updateCampaignRuntimeState } from "../../services/api/src/campaign-state-service.js";
import { logger } from "../../packages/logger/src/index.js";
import { installIntegrationProviderTransport } from "./provider-transport-test-helper.js";
import { createGenerationWorkflow } from "../../packages/client-core/src/index.js";
import {
  createBrowserGenerationSource,
  createNexusApiClient,
  createNoopSessionPort
} from "../../packages/client-web/src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const credentialSecret = "integration-test-credential-secret";

type MockReply = {
  content: string;
  finishReason?: string;
  streamChunks?: string[];
  streamChunkDelayMs?: number;
  onRequest?: () => void;
  waitFor?: Promise<void>;
};

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
  let providerTransport: ReturnType<typeof installIntegrationProviderTransport>;
  let baseUrl = "";
  let providerId = "";
  const replies: MockReply[] = [];
  const servedReplies: MockReply[] = [];
  const requests: Array<Record<string, any>> = [];

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 5);
    await migrateDatabase(pool, resolve("database/migrations"));
    providerTransport = installIntegrationProviderTransport();
    server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", async () => {
        const providerRequest = JSON.parse(body || "{}");
        requests.push(providerRequest);
        const isTextGeneration = request.method === "POST" && request.url?.endsWith("/chat/completions");
        const reply = isTextGeneration
          ? replies.shift() || { content: validStory() }
          : { content: JSON.stringify({ data: [] }) };
        if (isTextGeneration) servedReplies.push(reply);
        reply.onRequest?.();
        await reply.waitFor;
        if (providerRequest.stream === true && reply.streamChunks) {
          response.writeHead(200, { "content-type": "text/event-stream" });
          for (const [index, chunk] of reply.streamChunks.entries()) {
            if (index > 0 && reply.streamChunkDelayMs) {
              await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, reply.streamChunkDelayMs));
            }
            response.write(`data: ${JSON.stringify({
              id: crypto.randomUUID(),
              model: "deterministic-mock",
              choices: [{ delta: { content: chunk }, finish_reason: null }]
            })}\n\n`);
          }
          response.write(`data: ${JSON.stringify({
            id: crypto.randomUUID(),
            model: "deterministic-mock",
            choices: [{ delta: {}, finish_reason: reply.finishReason || "stop" }],
            usage: { prompt_tokens: 700, completion_tokens: 220, total_tokens: 920 }
          })}\n\n`);
          response.end("data: [DONE]\n\n");
          return;
        }
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
    if (server) await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    await providerTransport?.close();
    await pool.end();
  });

  async function campaign(
    storyLength?: "brief" | "standard" | "long" | "extended",
    title?: string
  ) {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = title ?? `Generated campaign ${crypto.randomUUID()}`;
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

  function replacementRequest(action: string, expectedCurrentTurnNumber = 2, selectedProviderId = providerId, idempotencyKey = crypto.randomUUID()) {
    return generationRetryLatestRequestSchema.parse({
      action,
      expectedCurrentTurnNumber,
      providerProfileId: selectedProviderId,
      idempotencyKey,
      context: { budgetTokens: 16000, compression: "full", recentTurns: 8 }
    });
  }

  it("sends the authoritative Chronicle snapshot and atomically commits fiction-only output", async () => {
    const imported = await campaign(undefined, "Generated campaign d100-title");
    await pool.query(
      `UPDATE world_versions
          SET content = jsonb_set(content, '{entities}', $2::jsonb, true)
        WHERE id = (SELECT world_version_id FROM campaigns WHERE id = $1)`,
      [imported.campaignId, JSON.stringify([
        { id: "test-character", name: "Test Character", kind: "character" },
        { id: "location-gamma", name: "Location Gamma", kind: "location" },
        { id: "marker-three", name: "Marker Three", kind: "artifact" }
      ])]
    );
    replies.push({ content: validStory() });
    const job = await queue(imported.campaignId);
    expect(await runGenerationJob(pool, "story-worker-a", 30, credentialSecret)).toBe(true);
    expect(await getGenerationJob(pool, job.id)).toMatchObject({ status: "completed", expectedTurnNumber: 3 });
    const lastRequest = requests.at(-1);
    const serialized = JSON.stringify(lastRequest);
    expect(serialized).toContain("Location Beta");
    expect(serialized).toContain("Object Gamma");
    expect(serialized).toContain("Use synthetic fixture markers only");
    expect(serialized).not.toContain("The d100 roll was 42");
    expect(serialized).not.toContain("Private synthetic state");
    const committed = await pool.query<{ narration: string; content: string }>(
      `SELECT t.narration, m.content FROM turns t JOIN chronicle_memories m ON m.turn_id = t.id
        WHERE t.campaign_id = $1 AND t.turn_number = 3`, [imported.campaignId]
    );
    expect(committed.rows[0]?.narration).toContain("Marker Three");
    expect(committed.rows[0]?.content).not.toMatch(/roll|dice|check/i);
    const entityMemories = await pool.query<{ memory_kind: string; entity_ids: string[] }>(
      `SELECT memory_kind, entity_ids
         FROM chronicle_memories
        WHERE campaign_id = $1 AND ordinal = 3
          AND memory_kind = ANY($2::text[])
        ORDER BY memory_kind`,
      [imported.campaignId, ["campaign_summary", "canonical_fact", "open_thread", "turn_fiction"]]
    );
    expect(entityMemories.rows).toEqual([
      {
        memory_kind: "campaign_summary",
        entity_ids: expect.arrayContaining([
          "world:test-character",
          "world:location-gamma",
          "world:marker-three"
        ])
      },
      { memory_kind: "canonical_fact", entity_ids: ["world:location-gamma"] },
      { memory_kind: "open_thread", entity_ids: ["world:marker-three"] },
      {
        memory_kind: "turn_fiction",
        entity_ids: expect.arrayContaining(["world:location-gamma", "world:marker-three"])
      }
    ]);
    const canonicalFacts = await pool.query<{ entity_ids: string[] }>(
      "SELECT entity_ids FROM campaign_canonical_facts WHERE campaign_id = $1 AND source_turn_number = 3",
      [imported.campaignId]
    );
    expect(canonicalFacts.rows).toEqual([{ entity_ids: ["world:location-gamma"] }]);
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

  it("assigns tracker IDs when committing an unchanged generated tracker snapshot", async () => {
    const imported = await campaign();
    await pool.query(
      "UPDATE campaign_state SET trackers = $2 WHERE campaign_id = $1",
      [imported.campaignId, JSON.stringify([
        { name: "Generated clue", value: "hidden", rules: "Update when revealed." },
        { name: "Generated clue", value: "found", rules: "Keep independently editable." }
      ])]
    );
    const story = JSON.parse(validStory());
    story.tracker_updates = [];
    replies.push({ content: JSON.stringify(story) });
    const job = await queue(imported.campaignId);

    expect(await runGenerationJob(pool, "story-worker-tracker-ids", 30, credentialSecret)).toBe(true);

    const persisted = await pool.query<{
      trackers: unknown;
      state_snapshot_private: { trackers?: unknown };
    }>(
      `SELECT cs.trackers, t.state_snapshot_private
         FROM campaign_state cs
         JOIN turns t ON t.campaign_id = cs.campaign_id
        WHERE cs.campaign_id = $1 AND t.turn_number = 3`,
      [imported.campaignId]
    );
    expect(persisted.rows[0]?.state_snapshot_private.trackers).toEqual([
      expect.objectContaining({ id: "Generated clue", name: "Generated clue", value: "hidden" }),
      expect.objectContaining({ id: "Generated clue-2", name: "Generated clue", value: "found" })
    ]);
    expect(persisted.rows[0]?.trackers).toEqual([
      expect.objectContaining({ id: "Generated clue", name: "Generated clue", value: "hidden" }),
      expect.objectContaining({ id: "Generated clue-2", name: "Generated clue", value: "found" })
    ]);
    expect(await getGenerationJob(pool, job.id)).toMatchObject({ status: "completed" });
  });

  it("allows exactly one concurrent generation to claim and commit a campaign turn", async () => {
    const imported = await campaign();
    const submissions = await Promise.allSettled([
      queue(imported.campaignId, "Take the eastern path."),
      queue(imported.campaignId, "Take the western path.")
    ]);
    const queued = submissions.filter((submission) => submission.status === "fulfilled");
    const conflicts = submissions.filter((submission) => submission.status === "rejected");

    expect(queued).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      reason: {
        statusCode: 409,
        details: { code: "active_generation_exists" }
      }
    });

    let signalProviderRequest!: () => void;
    const providerRequestStarted = new Promise<void>((resolveStarted) => {
      signalProviderRequest = resolveStarted;
    });
    let releaseProviderResponse!: () => void;
    const providerResponseGate = new Promise<void>((resolveResponse) => {
      releaseProviderResponse = resolveResponse;
    });
    replies.push({
      content: validStory("Only one path becomes the accepted campaign turn."),
      onRequest: signalProviderRequest,
      waitFor: providerResponseGate
    });

    const workerRuns = [
      runGenerationJob(pool, "story-worker-race-a", 30, credentialSecret),
      runGenerationJob(pool, "story-worker-race-b", 30, credentialSecret)
    ];
    await providerRequestStarted;

    let conflictTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const nonClaimingWorker = await Promise.race([
        ...workerRuns,
        new Promise<boolean>((_resolve, reject) => {
          conflictTimeout = setTimeout(
            () => reject(new Error("The second worker did not observe the claimed job.")),
            2_000
          );
        })
      ]);
      expect(nonClaimingWorker).toBe(false);
    } finally {
      if (conflictTimeout) clearTimeout(conflictTimeout);
      releaseProviderResponse();
    }

    const runResults = await Promise.all(workerRuns);
    expect(runResults.filter(Boolean)).toHaveLength(1);
    expect(runResults.filter((result) => !result)).toHaveLength(1);

    const winningSubmission = queued[0];
    if (winningSubmission?.status !== "fulfilled") throw new Error("Expected one generation submission to be queued.");
    expect(await getGenerationJob(pool, winningSubmission.value.id)).toMatchObject({ status: "completed" });
    const committedTurns = await pool.query<{ turn_number: number; narration: string }>(
      `SELECT turn_number, narration
         FROM turns
        WHERE campaign_id = $1 AND turn_number = 3`,
      [imported.campaignId]
    );
    expect(committedTurns.rows).toEqual([{
      turn_number: 3,
      narration: expect.any(String)
    }]);
  });

  it("commits the accepted turn when illustration enqueue hits a database error", async () => {
    const imported = await campaign();
    await setIllustrationConfig(pool, imported.campaignId, illustrationConfigSchema.parse({
      sourcePolicy: "library_only",
      matchingScope: "campaign",
      confidenceProfile: "strict",
      providerProfileId: null,
      model: ""
    }));
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const functionName = `reject_illustration_enqueue_${suffix}`;
    const triggerName = `reject_illustration_enqueue_trigger_${suffix}`;
    await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.campaign_id::text = '${imported.campaignId}' THEN
          RAISE EXCEPTION 'synthetic illustration enqueue failure' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END
    $$`);
    await pool.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON turn_illustration_sets
      FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
    try {
      const job = await queue(imported.campaignId, "Continue into the accepted scene.");

      await runGenerationJob(pool, "story-worker-illustration-enqueue-failure", 30, credentialSecret);

      expect(await getGenerationJob(pool, job.id)).toMatchObject({ status: "completed" });
      const committed = await pool.query<{ id: string; narration: string; memory_kinds: string[] }>(
        `SELECT turns.id, turns.narration,
                array_agg(chronicle_memories.memory_kind ORDER BY chronicle_memories.memory_kind) AS memory_kinds
           FROM turns
           LEFT JOIN chronicle_memories ON chronicle_memories.turn_id = turns.id
          WHERE turns.campaign_id = $1 AND turns.turn_number = 3
          GROUP BY turns.id`,
        [imported.campaignId]
      );
      expect(committed.rows).toEqual([{
        id: expect.any(String),
        narration: "Location Gamma opens and Marker Three becomes visible.",
        memory_kinds: ["canonical_fact", "turn_fiction"]
      }]);
      expect(await pool.query(
        `SELECT campaigns.active_turn_number, campaign_state.scratchpad_private
           FROM campaigns
           JOIN campaign_state ON campaign_state.campaign_id = campaigns.id
          WHERE campaigns.id = $1`,
        [imported.campaignId]
      )).toMatchObject({
        rows: [{
          active_turn_number: 3,
          scratchpad_private: "Private synthetic continuity marker."
        }]
      });
      expect(await pool.query(
        "SELECT id FROM turn_illustration_sets WHERE turn_id = $1",
        [committed.rows[0]?.id]
      )).toMatchObject({ rowCount: 0 });
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON turn_illustration_sets`);
      await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }
  });

  it("stages an idempotent latest-turn replacement and swaps it only after validated commit", async () => {
    const imported = await campaign();
    const before = await pool.query<{ id: string; narration: string }>(
      "SELECT id, narration FROM turns WHERE campaign_id = $1 AND turn_number = 2",
      [imported.campaignId]
    );
    const request = replacementRequest("Take the eastern path instead.");
    const job = await enqueueLatestReplacement(pool, imported.campaignId, request);
    const replay = await enqueueLatestReplacement(pool, imported.campaignId, request);

    expect(replay).toMatchObject({ id: job.id, duplicate: true, operationKind: "replace_latest" });
    await expect(enqueueLatestReplacement(pool, imported.campaignId, {
      ...request,
      action: "Attempt to reuse the key with different content."
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(await pool.query("SELECT id FROM turns WHERE campaign_id = $1 AND turn_number = 2", [imported.campaignId]))
      .toMatchObject({ rows: [{ id: before.rows[0]?.id }] });

    replies.push({ content: validStory("The eastern path opens into a newly validated replacement scene.") });
    const requestCount = requests.length;
    expect(await runGenerationJob(pool, "story-worker-replacement", 30, credentialSecret)).toBe(true);

    const after = await pool.query<{ id: string; action: string; narration: string }>(
      "SELECT id, action, narration FROM turns WHERE campaign_id = $1 AND turn_number = 2",
      [imported.campaignId]
    );
    expect(after.rows[0]).toMatchObject({
      action: "Take the eastern path instead."
    });
    expect(after.rows[0]?.narration).not.toBe(before.rows[0]?.narration);
    expect(after.rows[0]?.id).not.toBe(before.rows[0]?.id);
    expect(await getGenerationJob(pool, job.id)).toMatchObject({ status: "completed", operationKind: "replace_latest" });

    const replacementRequests = requests.slice(requestCount).map((entry) => JSON.stringify(entry)).join("\n");
    expect(replacementRequests).toContain("Marker One");
    expect(replacementRequests).not.toContain("Marker Two becomes visible");
    expect(replacementRequests).not.toContain("Object Gamma remains at Location Beta");
    expect(replacementRequests).not.toContain("Private synthetic state");
  });

  it("preserves the accepted latest turn when replacement generation has a provider transport failure", async () => {
    const imported = await campaign();
    const warnSpy = vi.spyOn(logger, "warn");
    const errorSpy = vi.spyOn(logger, "error");
    const unavailableProvider = await createProvider(pool, {
      name: `Unavailable replacement provider ${crypto.randomUUID()}`,
      providerType: "openai_compatible",
      providerRole: "text",
      baseUrl: "http://127.0.0.1:1",
      defaultModel: "unavailable-model",
      contextWindowTokens: 32768,
      maxOutputTokens: 4096,
      temperature: 0,
      enabled: true,
      configuration: {}
    }, credentialSecret);
    const before = await pool.query<{ id: string; narration: string; active_turn_number: number }>(
      `SELECT t.id, t.narration, c.active_turn_number
         FROM turns t JOIN campaigns c ON c.id = t.campaign_id
        WHERE t.campaign_id = $1 AND t.turn_number = 2`,
      [imported.campaignId]
    );
    const job = await enqueueLatestReplacement(
      pool,
      imported.campaignId,
      replacementRequest("Try a replacement that cannot reach its provider.", 2, unavailableProvider.id)
    );

    try {
      expect(await runGenerationJob(pool, "story-worker-replacement-transport", 30, credentialSecret)).toBe(true);
      expect(await getGenerationJob(pool, job.id)).toMatchObject({ status: "failed", errorCode: "generation_failed" });
      const events = [...warnSpy.mock.calls, ...errorSpy.mock.calls]
        .map(([event]) => event)
        .filter((event): event is Record<string, unknown> => {
          if (typeof event !== "object" || event === null) return false;
          const record = event as Record<string, unknown>;
          return record.generationJobId === job.id
            && (record.event === "turn_generation_provider_failed" || record.event === "turn_generation_failed");
        });
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: "turn_generation_provider_failed", errorCode: "transport_failure" }),
        expect.objectContaining({ event: "turn_generation_failed", errorCode: "provider_transport_error" })
      ]));
      for (const event of events) {
        expect(event).toMatchObject({
          campaignId: imported.campaignId,
          providerProfileId: unavailableProvider.id,
          expectedTurnNumber: 2,
          operationKind: "replace_latest",
          jobAttempt: 1
        });
      }
      expect(await pool.query(
        `SELECT t.id, t.narration, c.active_turn_number
           FROM turns t JOIN campaigns c ON c.id = t.campaign_id
          WHERE t.campaign_id = $1 AND t.turn_number = 2`,
        [imported.campaignId]
      )).toMatchObject({ rows: [before.rows[0]] });
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("replaces turn one from the initial campaign snapshot", async () => {
    const imported = await campaign();
    await rewindCampaign(pool, imported.campaignId, { targetTurnNumber: 1 });
    const before = await pool.query<{ id: string }>(
      "SELECT id FROM turns WHERE campaign_id = $1 AND turn_number = 1",
      [imported.campaignId]
    );
    const job = await enqueueLatestReplacement(
      pool,
      imported.campaignId,
      replacementRequest("Begin the adventure along a different path.", 1)
    );
    replies.push({ content: validStory("A different opening scene begins at Location Alpha.") });
    expect(await runGenerationJob(pool, "story-worker-replacement-turn-one", 30, credentialSecret)).toBe(true);
    const turns = await pool.query<{ id: string; turn_number: number; action: string }>(
      "SELECT id, turn_number, action FROM turns WHERE campaign_id = $1 ORDER BY turn_number",
      [imported.campaignId]
    );
    expect(turns.rows).toHaveLength(1);
    expect(turns.rows[0]).toMatchObject({ turn_number: 1, action: "Begin the adventure along a different path." });
    expect(turns.rows[0]?.id).not.toBe(before.rows[0]?.id);
    expect(await getGenerationJob(pool, job.id)).toMatchObject({ status: "completed" });
  });

  it("rolls back the replacement commit completely when its turn swap fails", async () => {
    const imported = await campaign();
    const before = await pool.query<{ id: string; narration: string }>(
      "SELECT id, narration FROM turns WHERE campaign_id = $1 AND turn_number = 2",
      [imported.campaignId]
    );
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const functionName = `reject_replacement_delete_${suffix}`;
    const triggerName = `reject_replacement_delete_trigger_${suffix}`;
    await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.campaign_id::text = '${imported.campaignId}' THEN RAISE EXCEPTION 'synthetic replacement delete failure'; END IF;
        RETURN OLD;
      END
    $$`);
    await pool.query(`CREATE TRIGGER ${triggerName} BEFORE DELETE ON turns FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
    try {
      const job = await enqueueLatestReplacement(pool, imported.campaignId, replacementRequest("Trigger a rollback-safe replacement."));
      replies.push({ content: validStory("This response must not survive the synthetic commit failure.") });
      expect(await runGenerationJob(pool, "story-worker-replacement-rollback", 30, credentialSecret)).toBe(true);
      expect(await getGenerationJob(pool, job.id)).toMatchObject({ status: "failed" });
      expect(await pool.query(
        "SELECT id, narration FROM turns WHERE campaign_id = $1 AND turn_number = 2",
        [imported.campaignId]
      )).toMatchObject({ rows: [before.rows[0]] });
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON turns`);
      await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }
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

  it("deletes provisional streaming image jobs when rewinding their generation", async () => {
    const imported = await campaign();
    const campaignRow = await pool.query<{ owner_user_id: string }>(
      "SELECT owner_user_id FROM campaigns WHERE id = $1",
      [imported.campaignId]
    );
    const ownerUserId = campaignRow.rows[0]?.owner_user_id;
    if (!ownerUserId) throw new Error("Synthetic campaign owner was not found.");
    const generationJob = await pool.query<{ id: string }>(
      `INSERT INTO generation_jobs (
         owner_user_id, campaign_id, provider_profile_id, idempotency_key, expected_turn_number,
         action, status, requested_model, completed_at
       ) VALUES ($1,$2,$3,$4,3,'Synthetic streaming fixture','completed','deterministic-mock',now())
       RETURNING id`,
      [ownerUserId, imported.campaignId, providerId, crypto.randomUUID()]
    );
    const generationJobId = generationJob.rows[0]?.id;
    if (!generationJobId) throw new Error("Synthetic generation job was not created.");
    const imageJob = await pool.query<{ id: string }>(
      `INSERT INTO image_jobs (
         owner_user_id, campaign_id, turn_id, provider_profile_id, requested_model, prompt,
         prompt_hash, status, provider_type, target_type, generation_job_id, completed_at
       ) VALUES ($1,$2,NULL,$3,'deterministic-mock','Synthetic provisional illustration',
                 'synthetic-provisional-illustration','completed','openai_compatible',
                 'streaming_illustration',$4,now()) RETURNING id`,
      [ownerUserId, imported.campaignId, providerId, generationJobId]
    );
    const imageJobId = imageJob.rows[0]?.id;
    if (!imageJobId) throw new Error("Synthetic streaming image job was not created.");

    await expect(rewindCampaign(pool, imported.campaignId, { targetTurnNumber: 1 })).resolves.toMatchObject({
      activeTurnNumber: 1,
      discardedTurnCount: 1
    });
    await expect(pool.query("SELECT id FROM image_jobs WHERE id = $1", [imageJobId]))
      .resolves.toMatchObject({ rows: [] });
  });

  it("branches an existing campaign up to a specific turn into a separate independent campaign", async () => {
    const imported = await campaign();
    const branchProfile = {
      name: "Branch Hero",
      profile: {
        identity: { aliases: ["The Split Path"], pronouns: "she/her" },
        story: { role: "Pathfinder" },
        appearance: { eyes: "amber" },
        unclassifiedNotes: ""
      }
    };
    await pool.query(
      "UPDATE campaigns SET character_profile = $2, character_profile_revision = 5, updated_at = now() WHERE id = $1",
      [imported.campaignId, JSON.stringify(branchProfile)]
    );
    replies.push({ content: validStory() });
    await queue(imported.campaignId);
    await runGenerationJob(pool, "story-worker-branch", 30, credentialSecret);

    const branched = await branchCampaign(pool, imported.campaignId, { targetTurnNumber: 2, title: "My Branch Story" });
    expect(branched).toMatchObject({
      title: "My Branch Story",
      status: "active",
      activeTurnNumber: 2
    });
    expect(branched.id).not.toBe(imported.campaignId);
    expect(await pool.query(
      `SELECT character_profile, character_profile_revision
         FROM campaigns WHERE id = $1`,
      [branched.id]
    )).toMatchObject({
      rows: [{ character_profile: branchProfile, character_profile_revision: 1 }]
    });
    expect(await pool.query(
      `SELECT revision, edit_source, next_profile
         FROM campaign_character_profile_edits WHERE campaign_id = $1`,
      [branched.id]
    )).toMatchObject({
      rows: [{ revision: 1, edit_source: "branch", next_profile: branchProfile }]
    });

    const parentCampaign = await pool.query<{ active_turn_number: number }>(
      "SELECT active_turn_number FROM campaigns WHERE id = $1",
      [imported.campaignId]
    );
    expect(parentCampaign.rows[0]?.active_turn_number).toBe(3);

    const branchTurns = await pool.query<{ turn_number: number }>(
      "SELECT turn_number FROM turns WHERE campaign_id = $1 ORDER BY turn_number ASC",
      [branched.id]
    );
    expect(branchTurns.rows.map((row) => row.turn_number)).toEqual([1, 2]);
  });

  it("canonicalizes branch materialized tracker state without rewriting accepted turns", async () => {
    const imported = await campaign();
    const acceptedTrackers = [
      { name: "Accepted path", value: "open", rules: "Update when the path closes." }
    ];
    const editedTrackers = [
      { label: "Edited oath", currentValue: "unbroken", updateRules: "Update when tested." }
    ];
    const defaultTriggers = [
      { name: "Branch promise", value: "pending", rules: "Update when fulfilled." }
    ];
    const initialTrackers = [
      { title: "Initial lantern", value: "lit", rules: "Update when extinguished." }
    ];
    await pool.query(
      `UPDATE turns
          SET state_snapshot_private = jsonb_set(
            coalesce(state_snapshot_private, '{}'::jsonb),
            '{trackers}',
            $2::jsonb,
            true
          )
        WHERE campaign_id = $1 AND turn_number = 1`,
      [imported.campaignId, JSON.stringify(acceptedTrackers)]
    );
    await pool.query(
      `UPDATE campaign_state
          SET default_triggers = $2::jsonb,
              initial_state_snapshot = jsonb_set(
                coalesce(initial_state_snapshot, '{}'::jsonb),
                '{trackers}',
                $3::jsonb,
                true
              )
        WHERE campaign_id = $1`,
      [imported.campaignId, JSON.stringify(defaultTriggers), JSON.stringify(initialTrackers)]
    );
    await pool.query(
      `INSERT INTO campaign_state_edits (
         owner_user_id, campaign_id, effective_turn_number, revision,
         state_snapshot_private, changed_fields
       )
       SELECT owner_user_id, id, 1, 1, $2::jsonb, '["trackers"]'::jsonb
         FROM campaigns WHERE id = $1`,
      [imported.campaignId, JSON.stringify({
        scratchpad: "The branch oath is current.",
        trackers: editedTrackers,
        eventTriggers: [],
        pendingEventTriggers: [],
        rpgStats: []
      })]
    );
    const acceptedBefore = await pool.query<{ state_snapshot_private: Record<string, unknown> }>(
      "SELECT state_snapshot_private FROM turns WHERE campaign_id = $1 AND turn_number = 1",
      [imported.campaignId]
    );

    const branched = await branchCampaign(pool, imported.campaignId, { targetTurnNumber: 1 });

    const branchState = await pool.query<{
      trackers: unknown;
      default_triggers: unknown;
      initial_state_snapshot: { trackers?: unknown };
    }>(
      `SELECT trackers, default_triggers, initial_state_snapshot
         FROM campaign_state WHERE campaign_id = $1`,
      [branched.id]
    );
    const branchEdit = await pool.query<{ state_snapshot_private: { trackers?: unknown } }>(
      "SELECT state_snapshot_private FROM campaign_state_edits WHERE campaign_id = $1",
      [branched.id]
    );
    const acceptedAfter = await pool.query<{ state_snapshot_private: Record<string, unknown> }>(
      "SELECT state_snapshot_private FROM turns WHERE campaign_id = $1 AND turn_number = 1",
      [imported.campaignId]
    );
    const copiedTurn = await pool.query<{ state_snapshot_private: Record<string, unknown> }>(
      "SELECT state_snapshot_private FROM turns WHERE campaign_id = $1 AND turn_number = 1",
      [branched.id]
    );

    expect(branchState.rows[0]).toMatchObject({
      trackers: [
        expect.objectContaining({ id: "Edited oath", name: "Edited oath" })
      ],
      default_triggers: [
        expect.objectContaining({ id: "Branch promise", name: "Branch promise" })
      ],
      initial_state_snapshot: {
        trackers: [
          expect.objectContaining({ id: "Initial lantern", name: "Initial lantern" })
        ]
      }
    });
    expect(branchEdit.rows[0]?.state_snapshot_private.trackers).toEqual([
      expect.objectContaining({ id: "Edited oath", name: "Edited oath" })
    ]);
    expect(acceptedAfter.rows[0]?.state_snapshot_private).toEqual(acceptedBefore.rows[0]?.state_snapshot_private);
    expect(copiedTurn.rows[0]?.state_snapshot_private).toEqual(acceptedBefore.rows[0]?.state_snapshot_private);
    expect(copiedTurn.rows[0]?.state_snapshot_private.trackers).toEqual(acceptedTrackers);
  });

  it("copies artwork references to mapped branch turns and preserves the blob after deleting the parent", async () => {
    const imported = await campaign();
    const source = await pool.query<{ owner_user_id: string; turn_id: string }>(
      `SELECT c.owner_user_id, t.id AS turn_id
         FROM campaigns c
         JOIN turns t ON t.campaign_id = c.id AND t.owner_user_id = c.owner_user_id
        WHERE c.id = $1 AND t.turn_number = 2`,
      [imported.campaignId]
    );
    const sourceRow = source.rows[0];
    if (!sourceRow) throw new Error("Synthetic source turn was not found.");
    const asset = await pool.query<{ id: string }>(
      `INSERT INTO assets (
         owner_user_id, campaign_id, turn_id, content_hash, storage_driver,
         storage_path, mime_type, byte_length
       ) VALUES ($1,$2,$3,$4,'filesystem',$5,'image/png',4) RETURNING id`,
      [sourceRow.owner_user_id, imported.campaignId, sourceRow.turn_id,
        `branch-artwork-${crypto.randomUUID()}`, `branch-artwork/${crypto.randomUUID()}.png`]
    );
    const assetId = asset.rows[0]?.id;
    if (!assetId) throw new Error("Synthetic asset was not created.");
    await pool.query(
      `INSERT INTO asset_references (owner_user_id, asset_id, campaign_id, turn_id, asset_role)
       VALUES ($1,$2,$3,$4,'turn_illustration')`,
      [sourceRow.owner_user_id, assetId, imported.campaignId, sourceRow.turn_id]
    );

    const branched = await branchCampaign(pool, imported.campaignId, { targetTurnNumber: 2 });
    const branchReference = await pool.query<{ turn_number: number }>(
      `SELECT t.turn_number
         FROM asset_references ar
         JOIN turns t ON t.id = ar.turn_id AND t.campaign_id = ar.campaign_id
        WHERE ar.asset_id = $1 AND ar.campaign_id = $2`,
      [assetId, branched.id]
    );
    expect(branchReference.rows).toEqual([{ turn_number: 2 }]);

    await pool.query("DELETE FROM campaigns WHERE id = $1", [imported.campaignId]);

    const surviving = await pool.query<{
      campaign_id: string | null;
      turn_id: string | null;
      reference_campaign_id: string;
      turn_number: number;
    }>(
      `SELECT a.campaign_id, a.turn_id, ar.campaign_id AS reference_campaign_id, t.turn_number
         FROM assets a
         JOIN asset_references ar ON ar.asset_id = a.id
         JOIN turns t ON t.id = ar.turn_id AND t.campaign_id = ar.campaign_id
        WHERE a.id = $1`,
      [assetId]
    );
    expect(surviving.rows).toEqual([{
      campaign_id: null,
      turn_id: null,
      reference_campaign_id: branched.id,
      turn_number: 2
    }]);
  });

  it("rejects rewinds with HTTP 409 when expectedCurrentTurnNumber does not match active_turn_number", async () => {
    const imported = await campaign();
    await expect(
      rewindCampaign(pool, imported.campaignId, {
        targetTurnNumber: 0,
        expectedCurrentTurnNumber: 99
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    const check = await pool.query<{ active_turn_number: number }>(
      "SELECT active_turn_number FROM campaigns WHERE id = $1",
      [imported.campaignId]
    );
    expect(check.rows[0]?.active_turn_number).toBe(2);
  });

  it("rewinds to turn zero, restoring initial_state_snapshot and allowing the next turn to commit at turn 1", async () => {
    const imported = await campaign();
    const costBefore = await pool.query<{ count: string; amount: string }>(
      `SELECT count(*)::text AS count, coalesce(sum(amount), 0)::text AS amount
         FROM provider_cost_events WHERE campaign_id = $1`,
      [imported.campaignId]
    );

    const rewound = await rewindCampaign(pool, imported.campaignId, { targetTurnNumber: 0 });
    expect(rewound).toMatchObject({
      campaignId: imported.campaignId,
      activeTurnNumber: 0,
      discardedTurnCount: 2,
      stateSnapshot: expect.objectContaining({
        scratchpad: "",
        trackers: expect.any(Array),
        eventTriggers: expect.any(Array)
      })
    });

    const check = await pool.query<{ active_turn_number: number }>(
      "SELECT active_turn_number FROM campaigns WHERE id = $1",
      [imported.campaignId]
    );
    expect(check.rows[0]?.active_turn_number).toBe(0);

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

    replies.push({ content: validStory("The turn one action after turn-zero rewind.") });
    const job = await queue(imported.campaignId, "Begin new turn 1 action.");
    await runGenerationJob(pool, "story-worker-rewind-zero", 30, credentialSecret);
    const result = await getGenerationResult(pool, job.id);
    expect(result).toMatchObject({ status: "completed", turnNumber: 1 });
  });

  it("rewinds through a retained state edit without duplicating canonical Chronicle memory", async () => {
    const imported = await campaign();
    await rewindCampaign(pool, imported.campaignId, { targetTurnNumber: 0 });

    replies.push({ content: validStory() });
    const retained = await queue(imported.campaignId, "Create the retained turn.");
    await runGenerationJob(pool, "story-worker-rewind-retained", 30, credentialSecret);
    expect(await getGenerationJob(pool, retained.id)).toMatchObject({ status: "completed", expectedTurnNumber: 1 });

    const before = await getCampaignRuntimeState(pool, imported.campaignId);
    expect(before.canonicalFacts).toEqual([
      expect.objectContaining({ content: "Location Gamma is open." })
    ]);
    await updateCampaignRuntimeState(pool, imported.campaignId, {
      expectedTurnNumber: 1,
      expectedRevision: before.revision,
      continuitySummary: "The retained correction confirms the moon-glass lens.",
      openThreads: ["Find the lighthouse keeper."],
      canonicalFacts: [...before.canonicalFacts, { id: null, content: "The lighthouse lens is moon glass." }],
      scratchpad: before.scratchpad,
      trackers: before.trackers,
      rpgStats: before.rpgStats,
      eventTriggers: before.eventTriggers,
      pendingEventTriggers: before.pendingEventTriggers
    });
    const retainedTurn = await pool.query<{ id: string }>(
      "SELECT id FROM turns WHERE campaign_id = $1 AND turn_number = 1",
      [imported.campaignId]
    );
    expect(retainedTurn.rows).toHaveLength(1);
    // Legacy campaigns can retain a manual correction with its surviving turn ID; rewind must rebuild derived indexes from it.
    const legacyCorrection = await pool.query(
      `UPDATE chronicle_memories
          SET turn_id = $2
        WHERE campaign_id = $1
          AND memory_kind = 'canonical_fact'
          AND metadata->>'manualCorrection' = 'true'`,
      [imported.campaignId, retainedTurn.rows[0]!.id]
    );
    expect(legacyCorrection.rowCount).toBe(1);
    replies.push({ content: validStory("A replacement path opens from the lighthouse.") });
    const replacement = await queue(imported.campaignId, "Take the replacement path.");
    await runGenerationJob(pool, "story-worker-rewind-state-edit", 30, credentialSecret);
    expect(await getGenerationJob(pool, replacement.id)).toMatchObject({ status: "completed", expectedTurnNumber: 2 });
    const discardedTurn = await pool.query<{ id: string }>(
      "SELECT id FROM turns WHERE campaign_id = $1 AND turn_number = 2",
      [imported.campaignId]
    );
    expect(discardedTurn.rows).toHaveLength(1);

    await expect(rewindCampaign(pool, imported.campaignId, { targetTurnNumber: 1 })).resolves.toMatchObject({
      activeTurnNumber: 1,
      discardedTurnCount: 1
    });
    const runtime = await getCampaignRuntimeState(pool, imported.campaignId);
    expect(runtime.canonicalFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: "The lighthouse lens is moon glass." })
    ]));
    const memories = await pool.query<{ memory_kind: string; turn_id: string | null; content: string; metadata: Record<string, unknown> }>(
      `SELECT memory_kind, turn_id, content, metadata
         FROM chronicle_memories
        WHERE campaign_id = $1 AND memory_kind = 'canonical_fact'`,
      [imported.campaignId]
    );
    expect(memories.rows).toEqual([expect.objectContaining({
      turn_id: null,
      content: expect.stringContaining("The lighthouse lens is moon glass."),
      metadata: expect.objectContaining({ manualCorrection: true })
    })]);
    expect(memories.rows).not.toContainEqual(expect.objectContaining({ turn_id: discardedTurn.rows[0]!.id }));
  });

  it("canonicalizes legacy tracker snapshots when rewinding without rewriting the accepted source turn", async () => {
    const imported = await campaign();
    const legacyTrackers = [
      { name: "Rewind oath", value: "unbroken", rules: "Update when tested." }
    ];
    await pool.query(
      `UPDATE turns
          SET state_snapshot_private = jsonb_set(
            coalesce(state_snapshot_private, '{}'::jsonb),
            '{trackers}',
            $2::jsonb,
            true
          )
        WHERE campaign_id = $1 AND turn_number = 1`,
      [imported.campaignId, JSON.stringify(legacyTrackers)]
    );
    const acceptedBefore = await pool.query<{ state_snapshot_private: Record<string, unknown> }>(
      "SELECT state_snapshot_private FROM turns WHERE campaign_id = $1 AND turn_number = 1",
      [imported.campaignId]
    );

    const rewound = await rewindCampaign(pool, imported.campaignId, { targetTurnNumber: 1 });

    const state = await pool.query<{ trackers: unknown }>(
      "SELECT trackers FROM campaign_state WHERE campaign_id = $1",
      [imported.campaignId]
    );
    const acceptedAfter = await pool.query<{ state_snapshot_private: Record<string, unknown> }>(
      "SELECT state_snapshot_private FROM turns WHERE campaign_id = $1 AND turn_number = 1",
      [imported.campaignId]
    );
    expect(rewound.stateSnapshot.trackers).toEqual([
      expect.objectContaining({ id: "Rewind oath", name: "Rewind oath" })
    ]);
    expect(state.rows[0]?.trackers).toEqual([
      expect.objectContaining({ id: "Rewind oath", name: "Rewind oath" })
    ]);
    expect(acceptedAfter.rows[0]?.state_snapshot_private).toEqual(acceptedBefore.rows[0]?.state_snapshot_private);
    expect(acceptedAfter.rows[0]?.state_snapshot_private.trackers).toEqual(legacyTrackers);
  });

  it("canonicalizes trackers when player configuration refreshes turn-zero initial state", async () => {
    const imported = await campaign();
    await rewindCampaign(pool, imported.campaignId, { targetTurnNumber: 0 });
    await pool.query(
      "UPDATE campaign_state SET trackers = $2::jsonb WHERE campaign_id = $1",
      [imported.campaignId, JSON.stringify([
        { label: "Turn-zero promise", currentValue: "pending", updateRules: "Update when fulfilled." }
      ])]
    );
    await syncPlayerCampaignConfig(pool, imported.campaignId, {
      expectedTurnNumber: 0,
      useRpgStats: true,
      suppressEventTriggers: false,
      rpgStats: [{ id: "stat1", name: "Strength", value: 18, note: "" }],
      eventTriggers: [],
      pendingEventTriggers: []
    });
    const stateRow = await pool.query<{
      initial_state_snapshot: {
        trackers: unknown;
        rpgStats: Array<{ id: string; name: string; value: number; note: string }>;
      };
    }>(
      "SELECT initial_state_snapshot FROM campaign_state WHERE campaign_id = $1",
      [imported.campaignId]
    );
    expect(stateRow.rows[0]?.initial_state_snapshot?.trackers).toEqual([
      expect.objectContaining({ id: "Turn-zero promise", name: "Turn-zero promise" })
    ]);
    expect(stateRow.rows[0]?.initial_state_snapshot?.rpgStats).toEqual([{ id: "stat1", name: "Strength", value: 18, note: "" }]);
  });

  it("edits current runtime state with revision checks and preserves the accepted turn snapshot", async () => {
    const imported = await campaign();
    const before = await getCampaignRuntimeState(pool, imported.campaignId);
    const historicalBefore = await getCampaignRuntimeState(pool, imported.campaignId, 1);
    const edited = await updateCampaignRuntimeState(pool, imported.campaignId, {
      expectedTurnNumber: before.activeTurnNumber,
      expectedRevision: before.revision,
      continuitySummary: before.continuitySummary,
      openThreads: before.openThreads,
      canonicalFacts: before.canonicalFacts,
      scratchpad: "Location Beta contains a hidden silver doorway.",
      trackers: [{ id: "doorway", name: "Silver doorway", value: "hidden", rules: "Update when its visibility changes." }],
      rpgStats: before.rpgStats,
      eventTriggers: before.eventTriggers,
      pendingEventTriggers: before.pendingEventTriggers
    });

    expect(edited).toMatchObject({
      scratchpad: "Location Beta contains a hidden silver doorway.",
      revision: before.revision + 1,
      trackers: [{ id: "doorway", name: "Silver doorway", value: "hidden" }]
    });
    await expect(updateCampaignRuntimeState(pool, imported.campaignId, {
      expectedTurnNumber: before.activeTurnNumber,
      expectedRevision: before.revision,
      continuitySummary: before.continuitySummary,
      openThreads: before.openThreads,
      canonicalFacts: before.canonicalFacts,
      scratchpad: "A stale edit.",
      trackers: [],
      rpgStats: before.rpgStats,
      eventTriggers: before.eventTriggers,
      pendingEventTriggers: before.pendingEventTriggers
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(await getCampaignRuntimeState(pool, imported.campaignId, 1)).toMatchObject({
      scratchpad: historicalBefore.scratchpad
    });

    const requestOffset = requests.length;
    replies.push({ content: validStory("The silver doorway becomes visible in Location Beta.") });
    const job = await queue(imported.campaignId, "Search Location Beta.");
    await runGenerationJob(pool, "story-worker-edited-state", 30, credentialSecret);
    expect(await getGenerationJob(pool, job.id)).toMatchObject({ status: "completed" });
    const storyRequest = requests.slice(requestOffset).find((request) => JSON.stringify(request).includes("fiction writer for Infinite Quest"));
    expect(JSON.stringify(storyRequest)).toContain("hidden silver doorway");

    await rewindCampaign(pool, imported.campaignId, { targetTurnNumber: before.activeTurnNumber });
    expect(await getCampaignRuntimeState(pool, imported.campaignId)).toMatchObject({
      scratchpad: "Location Beta contains a hidden silver doorway."
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
    expect(turnResult.mechanics).toMatchObject({ roll: { statId: "test_stat", target: 99 } });
    const storyRequest = requests.slice(requestOffset).find((request) => JSON.stringify(request).includes("fiction writer for Infinite Quest"));
    const storyUserMessage = storyRequest?.messages?.find((message: any) => message.role === "user");
    const storyPayload = JSON.parse(storyUserMessage?.content || "{}");
    const outcomeGuidance = JSON.stringify(storyPayload.fiction_only_outcome_guidance || []);
    expect(outcomeGuidance).toMatch(/Marker Five (becomes active|remains inactive)/);
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
    const beforeEvents = result.mechanics?.beforeEvents;
    const afterEvents = result.mechanics?.afterEvents;
    const pendingEventTriggers = result.stateSnapshot.pendingEventTriggers;
    const eventTriggers = result.stateSnapshot.eventTriggers;
    expect(Array.isArray(beforeEvents)).toBe(true);
    expect(Array.isArray(afterEvents)).toBe(true);
    expect(Array.isArray(pendingEventTriggers)).toBe(true);
    expect(Array.isArray(eventTriggers)).toBe(true);
    if (!Array.isArray(beforeEvents) || !Array.isArray(afterEvents)
        || !Array.isArray(pendingEventTriggers) || !Array.isArray(eventTriggers)) {
      throw new Error("Expected completed generation result to include trigger arrays.");
    }
    expect(beforeEvents).toHaveLength(1);
    expect(afterEvents).toHaveLength(1);
    expect(pendingEventTriggers).toHaveLength(1);
    expect(eventTriggers.every((trigger) => (
      typeof trigger === "object" && trigger !== null && "triggeredCount" in trigger && trigger.triggeredCount === 1
    ))).toBe(true);
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

  it("streams only the initial story request when validation starts an internal recovery", async () => {
    const imported = await campaign();
    await pool.query("UPDATE campaign_memory_configs SET embedding_enabled = false WHERE campaign_id = $1", [imported.campaignId]);
    const streamedDraft = validStory("Private streamed marker: she rolls a 17 and opens Location Gamma.");
    const acceptedStory = validStory("Her practiced touch opens Location Gamma.");
    const requestOffset = requests.length;
    await pool.query("UPDATE provider_profiles SET configuration = $2::jsonb WHERE id = $1", [providerId, JSON.stringify({ streaming: true })]);
    try {
      replies.push(
        {
          content: streamedDraft,
          streamChunks: [streamedDraft.slice(0, 220), streamedDraft.slice(220, 440), streamedDraft.slice(440)],
          streamChunkDelayMs: 400
        },
        { content: acceptedStory }
      );
      const job = await queue(imported.campaignId);
      await runGenerationJob(pool, "story-worker-streamed-recovery", 30, credentialSecret);

      const turnRequests = requests.slice(requestOffset).filter((request) => Array.isArray(request.messages));
      expect(turnRequests).toHaveLength(2);
      expect(turnRequests[0]?.stream).toBe(true);
      expect(turnRequests[1]?.stream).not.toBe(true);
      expect(await getGenerationJob(pool, job.id)).toMatchObject({ status: "completed" });
      const turn = await pool.query<{ narration: string }>("SELECT narration FROM turns WHERE campaign_id = $1 AND turn_number = 3", [imported.campaignId]);
      expect(turn.rows[0]?.narration).toBe("Her practiced touch opens Location Gamma.");
    } finally {
      await pool.query("UPDATE provider_profiles SET configuration = $2::jsonb WHERE id = $1", [providerId, JSON.stringify({})]);
    }
  });

  it("logs correlated generation lifecycle and recovery metadata without private story content", async () => {
    const imported = await campaign();
    await pool.query("UPDATE campaign_memory_configs SET embedding_enabled = false WHERE campaign_id = $1", [imported.campaignId]);
    const streamedDraft = validStory("Private streamed marker: she rolls a 17 and opens Location Gamma.");
    const acceptedStory = validStory("Her practiced touch opens Location Gamma.");
    const infoSpy = vi.spyOn(logger, "info");
    const warnSpy = vi.spyOn(logger, "warn");
    const errorSpy = vi.spyOn(logger, "error");
    try {
      await pool.query("UPDATE provider_profiles SET configuration = $2::jsonb WHERE id = $1", [providerId, JSON.stringify({ streaming: true })]);
      replies.push(
        { content: streamedDraft, streamChunks: [streamedDraft] },
        { content: acceptedStory }
      );
      const job = await queue(imported.campaignId);
      await runGenerationJob(pool, "story-worker-lifecycle-logs", 30, credentialSecret);

      const events = [
        ...infoSpy.mock.calls.map(([event], index) => ({ event, order: infoSpy.mock.invocationCallOrder[index] ?? 0 })),
        ...warnSpy.mock.calls.map(([event], index) => ({ event, order: warnSpy.mock.invocationCallOrder[index] ?? 0 })),
        ...errorSpy.mock.calls.map(([event], index) => ({ event, order: errorSpy.mock.invocationCallOrder[index] ?? 0 }))
      ]
        .sort((left, right) => left.order - right.order)
        .map(({ event }) => event)
        .filter((event): event is Record<string, unknown> => typeof event === "object" && event !== null && "event" in event);
      const phaseEvents = events.filter((event) => String(event.event).startsWith("turn_generation_phase_"));
      const legacyEvents = events.filter((event) => !String(event.event).startsWith("turn_generation_phase_"));

      expect(legacyEvents.map((event) => event.event)).toEqual([
        "turn_generation_claimed",
        "turn_generation_started",
        "turn_generation_provider_started",
        "turn_generation_stream_progress",
        "turn_generation_provider_completed",
        "turn_generation_validation_completed",
        "turn_generation_recovery_started",
        "turn_generation_provider_started",
        "turn_generation_provider_completed",
        "turn_generation_validation_completed",
        "turn_generation_completed"
      ]);

      expect(phaseEvents.map((event) => ({ event: event.event, phase: event.phase }))).toEqual([
        { event: "turn_generation_phase_started", phase: "provider_loading" },
        { event: "turn_generation_phase_completed", phase: "provider_loading" },
        { event: "turn_generation_phase_started", phase: "input_preparation" },
        { event: "turn_generation_phase_completed", phase: "input_preparation" },
        { event: "turn_generation_phase_started", phase: "context_retrieval" },
        { event: "turn_generation_phase_completed", phase: "context_retrieval" },
        { event: "turn_generation_phase_started", phase: "orchestration_loading" },
        { event: "turn_generation_phase_completed", phase: "orchestration_loading" },
        { event: "turn_generation_phase_started", phase: "rpg_assessment" },
        { event: "turn_generation_phase_completed", phase: "rpg_assessment" },
        { event: "turn_generation_phase_started", phase: "before_event_evaluation" },
        { event: "turn_generation_phase_completed", phase: "before_event_evaluation" },
        { event: "turn_generation_phase_started", phase: "prompt_preparation" },
        { event: "turn_generation_phase_completed", phase: "prompt_preparation" },
        { event: "turn_generation_phase_started", phase: "streaming_illustration_setup" },
        { event: "turn_generation_phase_completed", phase: "streaming_illustration_setup" },
        { event: "turn_generation_phase_started", phase: "story_generation" },
        { event: "turn_generation_phase_completed", phase: "story_generation" },
        { event: "turn_generation_phase_started", phase: "story_validation" },
        { event: "turn_generation_phase_completed", phase: "story_validation" },
        { event: "turn_generation_phase_started", phase: "story_recovery" },
        { event: "turn_generation_phase_completed", phase: "story_recovery" },
        { event: "turn_generation_phase_started", phase: "story_validation" },
        { event: "turn_generation_phase_completed", phase: "story_validation" },
        { event: "turn_generation_phase_started", phase: "after_event_evaluation" },
        { event: "turn_generation_phase_completed", phase: "after_event_evaluation" },
        { event: "turn_generation_phase_started", phase: "turn_commit" },
        { event: "turn_generation_phase_completed", phase: "turn_commit" }
      ]);
      for (const event of phaseEvents) {
        expect(event).toMatchObject({
          generationJobId: job.id,
          campaignId: imported.campaignId,
          providerProfileId: providerId,
          expectedTurnNumber: 3,
          operationKind: "append",
          jobAttempt: 1,
          workerId: "story-worker-lifecycle-logs",
          phase: expect.any(String),
          totalDurationMs: expect.any(Number)
        });
      }
      for (const event of phaseEvents.filter((event) => event.event !== "turn_generation_phase_started")) {
        expect(event.durationMs).toEqual(expect.any(Number));
      }
      expect(legacyEvents.filter((event) => event.event === "turn_generation_stream_progress")).toHaveLength(1);
      for (const event of legacyEvents) {
        expect(event).toMatchObject({
          generationJobId: job.id,
          campaignId: imported.campaignId,
          providerProfileId: providerId,
          expectedTurnNumber: 3,
          operationKind: "append",
          jobAttempt: 1
        });
      }
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: "turn_generation_provider_started", storyOperation: "story_generation", streaming: true }),
        expect.objectContaining({ event: "turn_generation_recovery_started", recoveryKind: "mechanics_cleanup" }),
        expect.objectContaining({ event: "turn_generation_provider_started", storyOperation: "story_recovery", streaming: false }),
        expect.objectContaining({ event: "turn_generation_completed", resultTurnId: expect.any(String) })
      ]));

      const serializedLogs = JSON.stringify(events);
      expect(serializedLogs).not.toContain("Private streamed marker");
      expect(serializedLogs).not.toContain("Private synthetic continuity marker");
      expect(serializedLogs).not.toContain(credentialSecret);
      expect(serializedLogs).not.toContain(streamedDraft);
      expect(serializedLogs).not.toContain(acceptedStory);
      expect(serializedLogs).not.toContain("Open Location Gamma.");
    } finally {
      await pool.query("UPDATE provider_profiles SET configuration = $2::jsonb WHERE id = $1", [providerId, JSON.stringify({})]);
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("sanitizes provider and terminal error codes and skips an unmatched failed transition log", async () => {
    const imported = await campaign();
    const unsafeCode = "https://credential.example/private-token";
    const infoSpy = vi.spyOn(logger, "info");
    const warnSpy = vi.spyOn(logger, "warn");
    const errorSpy = vi.spyOn(logger, "error");
    const originalQuery = pool.query.bind(pool) as (...args: any[]) => Promise<any>;
    const querySpy = vi.spyOn(pool, "query");
    querySpy.mockImplementation((async (...args: any[]) => {
      const statement = String(args[0]);
      if (statement.includes("INSERT INTO provider_cost_events")) {
        throw Object.assign(new Error("Synthetic provider cost failure."), { code: unsafeCode });
      }
      if (statement.includes("UPDATE generation_jobs SET status = 'failed'")) {
        return { rows: [], rowCount: 0 };
      }
      return originalQuery(...args);
    }) as any);
    try {
      replies.push({ content: validStory("The provider cost write fails after a valid response.") });
      const job = await queue(imported.campaignId);
      await runGenerationJob(pool, "story-worker-safe-error-codes", 30, credentialSecret);

      const events = [...infoSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
        .map(([event]) => event)
        .filter((event): event is Record<string, unknown> => typeof event === "object" && event !== null && "event" in event);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: "turn_generation_provider_failed", errorCode: "unclassified_error" })
      ]));
      expect(events).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ event: "turn_generation_failed" })
      ]));
      expect(JSON.stringify(events)).not.toContain(unsafeCode);
      expect(job.id).toEqual(expect.any(String));
    } finally {
      querySpy.mockRestore();
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("samples stream progress and persistence warnings without logging unsafe persistence codes", async () => {
    const imported = await campaign();
    await syncPlayerCampaignConfig(pool, imported.campaignId, {
      expectedTurnNumber: 2,
      useRpgStats: false,
      suppressEventTriggers: true,
      rpgStats: [],
      eventTriggers: [],
      pendingEventTriggers: []
    });
    const unsafeCode = "https://credential.example/stream-token";
    const streamedStory = validStory("A measured stream reaches Location Gamma safely.");
    const streamChunks = [streamedStory.slice(0, 220), streamedStory.slice(220, 440), streamedStory.slice(440)];
    const infoSpy = vi.spyOn(logger, "info");
    const warnSpy = vi.spyOn(logger, "warn");
    const errorSpy = vi.spyOn(logger, "error");
    const originalQuery = pool.query.bind(pool) as (...args: any[]) => Promise<any>;
    const querySpy = vi.spyOn(pool, "query");
    querySpy.mockImplementation((async (...args: any[]) => {
      if (String(args[0]).includes("UPDATE generation_jobs SET partial_output")) {
        throw Object.assign(new Error("Synthetic stream persistence failure."), { code: unsafeCode });
      }
      return originalQuery(...args);
    }) as any);
    try {
      await pool.query("UPDATE provider_profiles SET configuration = $2::jsonb WHERE id = $1", [providerId, JSON.stringify({ streaming: true })]);
      replies.push({ content: streamedStory, streamChunks, streamChunkDelayMs: 400 });
      const job = await queue(imported.campaignId);
      await runGenerationJob(pool, "story-worker-stream-sampling", 30, credentialSecret);

      expect(requests.at(-1)?.stream).toBe(true);
      expect(servedReplies.at(-1)?.streamChunks).toEqual(streamChunks);
      const events = [...infoSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
        .map(([event]) => event)
        .filter((event): event is Record<string, unknown> => typeof event === "object" && event !== null && "event" in event);
      expect(events.filter((event) => event.event === "turn_generation_stream_progress")).toHaveLength(0);
      expect(events.filter((event) => event.event === "turn_generation_stream_persist_failed")).toEqual([
        expect.objectContaining({ generationJobId: job.id, errorCode: "unclassified_error" })
      ]);
      expect(JSON.stringify(events)).not.toContain(unsafeCode);
    } finally {
      await pool.query("UPDATE provider_profiles SET configuration = $2::jsonb WHERE id = $1", [providerId, JSON.stringify({})]);
      querySpy.mockRestore();
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("does not log scene recovery after a lost-lease transition", async () => {
    const imported = await campaign();
    const infoSpy = vi.spyOn(logger, "info");
    const warnSpy = vi.spyOn(logger, "warn");
    const errorSpy = vi.spyOn(logger, "error");
    const originalQuery = pool.query.bind(pool) as (...args: any[]) => Promise<any>;
    const querySpy = vi.spyOn(pool, "query");
    let jobId = "";
    querySpy.mockImplementation((async (...args: any[]) => {
      const statement = String(args[0]);
      if (statement.includes("error_code = 'scene_coverage'")) {
        await originalQuery("UPDATE generation_jobs SET lease_owner = 'lost-lease' WHERE id = $1", [jobId]);
        return { rows: [], rowCount: 0 };
      }
      return originalQuery(...args);
    }) as any);
    try {
      replies.push(
        { content: validStory("The scene begins at Location Gamma.") },
        { content: JSON.stringify({ covered: false, missing_required_beats: ["Private required beat"], contradictions: [] }) },
        { content: validStory("The rewrite remains incomplete.") },
        { content: JSON.stringify({ covered: false, missing_required_beats: ["Private rewrite beat"], contradictions: [] }) }
      );
      const job = await enqueueGeneration(pool, imported.campaignId, generationRequestSchema.parse({
        action: "Write a scene where the party reaches Location Gamma.",
        requestedInputMode: "scene",
        resolvedInputMode: "scene",
        inputModeSource: "explicit",
        providerProfileId: providerId,
        idempotencyKey: crypto.randomUUID(),
        context: { budgetTokens: 16000, compression: "full", recentTurns: 8 }
      }));
      jobId = job.id;
      await runGenerationJob(pool, "story-worker-lost-scene-lease", 30, credentialSecret);

      const events = [...infoSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
        .map(([event]) => event)
        .filter((event): event is Record<string, unknown> => typeof event === "object" && event !== null && "event" in event);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: "turn_generation_scene_coverage_completed", generationJobId: job.id }),
        expect.objectContaining({ event: "turn_generation_recovery_started", recoveryKind: "scene_coverage_rewrite" })
      ]));
      expect(events).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ event: "turn_generation_recoverable" })
      ]));
      expect(events).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ event: "turn_generation_failed" })
      ]));
    } finally {
      querySpy.mockRestore();
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("logs recoverable retry lifecycle in chronological attempt order", async () => {
    const imported = await campaign();
    await syncPlayerCampaignConfig(pool, imported.campaignId, {
      expectedTurnNumber: 2,
      useRpgStats: false,
      suppressEventTriggers: true,
      rpgStats: [],
      eventTriggers: [],
      pendingEventTriggers: []
    });
    const infoSpy = vi.spyOn(logger, "info");
    const warnSpy = vi.spyOn(logger, "warn");
    const errorSpy = vi.spyOn(logger, "error");
    try {
      replies.push(
        { content: '{"narration":"First partial', finishReason: "length" },
        { content: '{"narration":"Second partial', finishReason: "length" }
      );
      const job = await queue(imported.campaignId);
      await runGenerationJob(pool, "story-worker-requeued-a", 30, credentialSecret);
      await retryGeneration(pool, job.id);
      replies.push({ content: validStory("The retry reaches Location Gamma safely.") });
      await runGenerationJob(pool, "story-worker-requeued-b", 30, credentialSecret);

      const events = [
        ...infoSpy.mock.calls.map(([event], index) => ({ event, order: infoSpy.mock.invocationCallOrder[index] ?? 0 })),
        ...warnSpy.mock.calls.map(([event], index) => ({ event, order: warnSpy.mock.invocationCallOrder[index] ?? 0 })),
        ...errorSpy.mock.calls.map(([event], index) => ({ event, order: errorSpy.mock.invocationCallOrder[index] ?? 0 }))
      ]
        .sort((left, right) => left.order - right.order)
        .map(({ event }) => event)
        .filter((event): event is Record<string, unknown> => {
          if (typeof event !== "object" || event === null) return false;
          const record = event as Record<string, unknown>;
          return record.generationJobId === job.id
            && typeof record.event === "string"
            && record.event.startsWith("turn_generation_");
        });
      const eventNames = events.map((event) => event.event);
      expect(eventNames.indexOf("turn_generation_recoverable")).toBeLessThan(eventNames.indexOf("turn_generation_requeued"));
      expect(eventNames.indexOf("turn_generation_requeued")).toBeLessThan(eventNames.lastIndexOf("turn_generation_claimed"));
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: "turn_generation_recoverable", jobAttempt: 1, errorCode: "output_limit" }),
        expect.objectContaining({ event: "turn_generation_requeued", jobAttempt: 1 }),
        expect.objectContaining({ event: "turn_generation_claimed", jobAttempt: 2, workerId: "story-worker-requeued-b" }),
        expect.objectContaining({ event: "turn_generation_completed", jobAttempt: 2 })
      ]));
      for (const event of events) {
        expect(event).toMatchObject({
          campaignId: imported.campaignId,
          providerProfileId: providerId,
          expectedTurnNumber: 3,
          operationKind: "append"
        });
      }
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
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

  it("retains the first streamed preview and buffers later durable attempts", async () => {
    const imported = await campaign();
    await pool.query("UPDATE campaign_memory_configs SET embedding_enabled = false WHERE campaign_id = $1", [imported.campaignId]);
    const streamedDraft = validStory("First visible streamed draft: she rolls a 17 and opens Location Gamma.");
    const hiddenRepairDraft = '{"narration":"Hidden repair draft';
    const acceptedStory = validStory("The third response becomes the accepted story.");
    const requestOffset = requests.length;
    await pool.query("UPDATE provider_profiles SET configuration = $2::jsonb WHERE id = $1", [providerId, JSON.stringify({ streaming: true })]);
    try {
      replies.push(
        { content: streamedDraft, streamChunks: [streamedDraft] },
        { content: hiddenRepairDraft }
      );
      const job = await queue(imported.campaignId);
      await runGenerationJob(pool, "story-worker-preview-a", 30, credentialSecret);

      const recoverable = await getGenerationJob(pool, job.id);
      expect(recoverable).toMatchObject({ status: "recoverable" });
      expect(recoverable.partialOutput).toContain("First visible streamed draft");
      expect(recoverable.partialOutput).not.toContain("Hidden repair draft");

      await retryGeneration(pool, job.id);
      replies.push({ content: acceptedStory });
      await runGenerationJob(pool, "story-worker-preview-b", 30, credentialSecret);

      const turnRequests = requests.slice(requestOffset).filter((request) => Array.isArray(request.messages));
      expect(turnRequests).toHaveLength(3);
      expect(turnRequests[2]?.stream).not.toBe(true);
      expect(await getGenerationJob(pool, job.id)).toMatchObject({ status: "completed" });
      const turn = await pool.query<{ narration: string }>("SELECT narration FROM turns WHERE campaign_id = $1 AND turn_number = 3", [imported.campaignId]);
      expect(turn.rows[0]?.narration).toBe("The third response becomes the accepted story.");
    } finally {
      await pool.query("UPDATE provider_profiles SET configuration = $2::jsonb WHERE id = $1", [providerId, JSON.stringify({})]);
    }
  });

  it("streams only the initial scene request and preserves its preview through a scene recovery retry", async () => {
    const imported = await campaign();
    await pool.query("UPDATE campaign_memory_configs SET embedding_enabled = false WHERE campaign_id = $1", [imported.campaignId]);
    const streamedDraft = validStory("First visible scene preview reaches Location Gamma.");
    const hiddenSceneRewrite = '{"narration":"Hidden scene rewrite';
    const acceptedStory = validStory("The accepted scene resolves at Location Gamma.");
    const requestOffset = requests.length;
    await pool.query("UPDATE provider_profiles SET configuration = $2::jsonb WHERE id = $1", [providerId, JSON.stringify({ streaming: true })]);
    try {
      replies.push(
        { content: streamedDraft, streamChunks: [streamedDraft] },
        { content: JSON.stringify({ covered: false, missing_required_beats: ["Location Gamma must be reached."], contradictions: [] }) },
        { content: hiddenSceneRewrite }
      );
      const job = await enqueueGeneration(pool, imported.campaignId, generationRequestSchema.parse({
        action: "Write a scene where the party reaches Location Gamma.",
        requestedInputMode: "scene",
        resolvedInputMode: "scene",
        inputModeSource: "explicit",
        providerProfileId: providerId,
        idempotencyKey: crypto.randomUUID(),
        context: { budgetTokens: 16000, compression: "full", recentTurns: 8 }
      }));
      await runGenerationJob(pool, "story-worker-scene-preview-a", 30, credentialSecret);

      const initialRequests = requests.slice(requestOffset);
      expect(initialRequests).toHaveLength(3);
      expect(initialRequests[0]?.stream).toBe(true);
      expect(initialRequests.slice(1).every((request) => request.stream !== true)).toBe(true);
      const recoverable = await getGenerationJob(pool, job.id);
      expect(recoverable).toMatchObject({ status: "recoverable", errorCode: "scene_coverage" });
      expect(recoverable.partialOutput).toContain("First visible scene preview");
      expect(recoverable.partialOutput).not.toContain("Hidden scene rewrite");

      await retryGeneration(pool, job.id);
      const retried = await getGenerationJob(pool, job.id);
      expect(retried).toMatchObject({ status: "queued" });
      expect(retried.partialOutput).toContain("First visible scene preview");
      expect(retried.partialOutput).not.toContain("Hidden scene rewrite");

      replies.push(
        { content: acceptedStory },
        { content: JSON.stringify({ covered: true, missing_required_beats: [], contradictions: [] }) }
      );
      await runGenerationJob(pool, "story-worker-scene-preview-b", 30, credentialSecret);

      const allRequests = requests.slice(requestOffset);
      expect(allRequests).toHaveLength(5);
      expect(allRequests.filter((request) => request.stream === true)).toHaveLength(1);
      expect(allRequests.slice(1).every((request) => request.stream !== true)).toBe(true);
      expect(await getGenerationJob(pool, job.id)).toMatchObject({ status: "completed" });
      const turn = await pool.query<{ narration: string }>("SELECT narration FROM turns WHERE campaign_id = $1 AND turn_number = 3", [imported.campaignId]);
      expect(turn.rows[0]?.narration).toBe("The accepted scene resolves at Location Gamma.");
    } finally {
      await pool.query("UPDATE provider_profiles SET configuration = $2::jsonb WHERE id = $1", [providerId, JSON.stringify({})]);
    }
  });

  it("cancels a queued generation and its provisional streaming image work without changing accepted state", async () => {
    const imported = await campaign();
    const beforeTurns = await pool.query("SELECT id FROM turns WHERE campaign_id = $1 ORDER BY turn_number", [imported.campaignId]);
    const beforeState = await pool.query("SELECT revision FROM campaign_state WHERE campaign_id = $1", [imported.campaignId]);
    const job = await queue(imported.campaignId, "Do not accept this action.");
    await pool.query(
      `INSERT INTO image_jobs (
         owner_user_id, campaign_id, provider_profile_id, requested_model, prompt, prompt_hash,
         status, provider_type, target_type, generation_job_id
       ) SELECT owner_user_id, campaign_id, $2, 'deterministic-mock', 'Provisional scene',
                'cancel-streaming-' || id::text, 'queued', 'openai_compatible',
                'streaming_illustration', id
           FROM generation_jobs WHERE id = $1`,
      [job.id, providerId]
    );
    const provisionalSet = await pool.query<{ id: string }>(
      `INSERT INTO turn_illustration_sets (
         owner_user_id, campaign_id, generation_job_id, source_text_hash, segment_word_count,
         images_per_segment, prompt_mode, status
       ) SELECT owner_user_id, campaign_id, id, 'cancel-provisional-' || id::text, 500, 1, 'direct', 'provisional'
           FROM generation_jobs WHERE id = $1 RETURNING id`,
      [job.id]
    );
    const acceptedTurn = await pool.query<{ id: string }>(
      "SELECT id FROM turns WHERE campaign_id = $1 ORDER BY turn_number DESC LIMIT 1",
      [imported.campaignId]
    );
    const acceptedIllustration = await pool.query<{ id: string }>(
      `INSERT INTO image_jobs (
         owner_user_id, campaign_id, turn_id, provider_profile_id, requested_model, prompt, prompt_hash,
         status, provider_type, target_type
       ) SELECT owner_user_id, campaign_id, $2, $3, 'deterministic-mock', 'Accepted scene',
                'cancel-accepted-' || id::text, 'queued', 'openai_compatible', 'turn_illustration'
           FROM turns WHERE id = $2 AND campaign_id = $1 RETURNING id`,
      [imported.campaignId, acceptedTurn.rows[0]!.id, providerId]
    );

    await expect(cancelGeneration(pool, job.id)).resolves.toMatchObject({ id: job.id, status: "cancelled" });
    await expect(cancelGeneration(pool, job.id)).resolves.toMatchObject({ id: job.id, status: "cancelled" });
    expect(await getGenerationJob(pool, job.id)).toMatchObject({ status: "cancelled", partialOutput: null });
    await expect(pool.query("SELECT id FROM turns WHERE campaign_id = $1 ORDER BY turn_number", [imported.campaignId]))
      .resolves.toMatchObject({ rows: beforeTurns.rows });
    await expect(pool.query("SELECT revision FROM campaign_state WHERE campaign_id = $1", [imported.campaignId]))
      .resolves.toMatchObject({ rows: beforeState.rows });
    await expect(pool.query(
      "SELECT status FROM image_jobs WHERE generation_job_id = $1", [job.id]
    )).resolves.toMatchObject({ rows: [{ status: "cancelled" }] });
    expect(await pool.query("SELECT status FROM turn_illustration_sets WHERE id = $1", [provisionalSet.rows[0]!.id]))
      .toMatchObject({ rows: [{ status: "orphaned" }] });
    expect(await pool.query("SELECT status FROM image_jobs WHERE id = $1", [acceptedIllustration.rows[0]!.id]))
      .toMatchObject({ rows: [{ status: "queued" }] });
    expect(await runGenerationJob(pool, "cancelled-worker", 30, credentialSecret)).toBe(false);
  });

  it("prevents an in-flight worker from committing after cancellation", async () => {
    const imported = await campaign();
    const job = await queue(imported.campaignId, "Do not accept this in-flight action.");
    const beforeTurns = await pool.query("SELECT id FROM turns WHERE campaign_id = $1 ORDER BY turn_number", [imported.campaignId]);
    const beforeState = await pool.query("SELECT revision FROM campaign_state WHERE campaign_id = $1", [imported.campaignId]);
    const beforeMemories = await pool.query("SELECT id FROM chronicle_memories WHERE campaign_id = $1 AND ordinal = 3", [imported.campaignId]);
    const streamedStory = validStory("The worker must discard this completed provider output after cancellation.");
    const streamChunks = [streamedStory.slice(0, 160), streamedStory.slice(160)];
    await pool.query("UPDATE provider_profiles SET configuration = $2::jsonb WHERE id = $1", [providerId, JSON.stringify({ streaming: true })]);
    try {
      replies.push({ content: streamedStory, streamChunks, streamChunkDelayMs: 800 });
      const inFlightWorker = runGenerationJob(pool, "in-flight-cancel-worker", 30, credentialSecret);
      await vi.waitFor(async () => {
        const current = await pool.query<{ partial_output: string | null }>("SELECT partial_output FROM generation_jobs WHERE id = $1", [job.id]);
        expect(current.rows[0]?.partial_output).toContain(streamChunks[0]);
      });

      await expect(cancelGeneration(pool, job.id)).resolves.toMatchObject({ id: job.id, status: "cancelled" });
      expect(await inFlightWorker).toBe(true);
    } finally {
      await pool.query("UPDATE provider_profiles SET configuration = $2::jsonb WHERE id = $1", [providerId, JSON.stringify({})]);
    }

    expect(await getGenerationJob(pool, job.id)).toMatchObject({ status: "cancelled", partialOutput: null });
    await expect(pool.query("SELECT id FROM turns WHERE campaign_id = $1 ORDER BY turn_number", [imported.campaignId]))
      .resolves.toMatchObject({ rows: beforeTurns.rows });
    await expect(pool.query("SELECT revision FROM campaign_state WHERE campaign_id = $1", [imported.campaignId]))
      .resolves.toMatchObject({ rows: beforeState.rows });
    await expect(pool.query("SELECT id FROM chronicle_memories WHERE campaign_id = $1 AND ordinal = 3", [imported.campaignId]))
      .resolves.toMatchObject({ rows: beforeMemories.rows });
  });

  it("rejects cancellation of non-cancelled terminal and foreign generation jobs without changing them", async () => {
    const imported = await campaign();
    const terminalStatuses = ["completed", "failed", "discarded"] as const;
    for (const status of terminalStatuses) {
      const job = await queue(imported.campaignId, `Do not cancel ${status}.`);
      await pool.query("UPDATE generation_jobs SET status = $2 WHERE id = $1", [job.id, status]);
      await expect(cancelGeneration(pool, job.id)).rejects.toMatchObject({ statusCode: 409 });
      expect(await getGenerationJob(pool, job.id)).toMatchObject({ status });
    }

    const originalOwner = await pool.query<{ id: string }>("SELECT id FROM users WHERE system_key = 'initial-owner'");
    const foreignOwner = await pool.query<{ id: string }>(
      "INSERT INTO users (display_name, status) VALUES ('Cancellation foreign owner', 'active') RETURNING id"
    );
    let foreignJob: { id: string };
    try {
      await pool.query("UPDATE users SET system_key = NULL WHERE id = $1", [originalOwner.rows[0]!.id]);
      await pool.query("UPDATE users SET system_key = 'initial-owner' WHERE id = $1", [foreignOwner.rows[0]!.id]);
      const foreignCampaign = await campaign(undefined, `Foreign cancellation campaign ${crypto.randomUUID()}`);
      const foreignProvider = await createProvider(pool, {
        name: `Foreign cancellation provider ${crypto.randomUUID()}`,
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
      foreignJob = await enqueueGeneration(pool, foreignCampaign.campaignId, generationRequestSchema.parse({
        action: "Foreign generation.",
        providerProfileId: foreignProvider.id,
        idempotencyKey: crypto.randomUUID(),
        context: { budgetTokens: 16000, compression: "full", recentTurns: 8 }
      }));
    } finally {
      await pool.query("UPDATE users SET system_key = NULL WHERE id = $1", [foreignOwner.rows[0]!.id]);
      await pool.query("UPDATE users SET system_key = 'initial-owner' WHERE id = $1", [originalOwner.rows[0]!.id]);
    }
    await expect(cancelGeneration(pool, foreignJob!.id)).rejects.toMatchObject({ statusCode: 404 });
    const foreignStatus = await pool.query<{ status: string }>("SELECT status FROM generation_jobs WHERE id = $1", [foreignJob!.id]);
    expect(foreignStatus.rows).toEqual([{ status: "queued" }]);
    await pool.query("UPDATE generation_jobs SET status = 'discarded' WHERE id = $1", [foreignJob!.id]);
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
    expect(result.mechanics).toMatchObject({ roll: persistedRoll });
    expect(requests.length - requestCount).toBe(1);
  });
});

describe("generation HTTP route-to-workflow boundary", () => {
  it("rejects a malformed generation snapshot before the workflow can observe it", async () => {
    const routeCampaignId = "10000000-0000-4000-8000-000000000001";
    const routeJobId = "20000000-0000-4000-8000-000000000001";
    const routeRequests: string[] = [];
    const routeServer = createServer((request, response) => {
      routeRequests.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      if (request.method === "POST" && request.url === `/api/v1/campaigns/${routeCampaignId}/generations`) {
        response.end(JSON.stringify({
          id: routeJobId,
          status: "queued",
          duplicate: false,
          operationKind: "append",
          replacementTurnId: null,
          expectedTurnNumber: 1,
          createdAt: "2026-08-02T12:00:00.000Z"
        }));
        return;
      }
      if (request.method === "GET" && request.url === `/api/v1/generation-jobs/${routeJobId}`) {
        response.setHeader("x-correlation-id", "malformed-snapshot-route");
        response.end(JSON.stringify({
          id: routeJobId,
          campaignId: routeCampaignId,
          expectedTurnNumber: 1,
          action: "Open the dome.",
          status: "generating",
          attempts: 0,
          createdAt: "2026-08-02T12:00:00.000Z",
          updatedAt: "2026-08-02T12:00:00.000Z"
        }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "Not found" }));
    });

    await new Promise<void>((resolveListen) => routeServer.listen(0, "127.0.0.1", resolveListen));
    try {
      const address = routeServer.address();
      if (!address || typeof address === "string") throw new Error("Test route did not expose a TCP address.");
      const origin = `http://127.0.0.1:${address.port}`;
      const session = createNoopSessionPort();
      const api = createNexusApiClient({
        basePath: "/api/v1",
        session,
        fetchImpl: (input, init) => fetch(`${origin}${String(input)}`, init)
      });
      const source = createBrowserGenerationSource({
        api: api.generation,
        basePath: "/api/v1",
        session,
        clock: { now: () => Date.parse("2026-08-02T12:00:00.000Z") },
        delay: { wait: async () => { throw new Error("Malformed snapshots must not be retried."); } },
        visibility: { isHidden: () => false, waitUntilVisible: async () => undefined },
        eventSourceFactory: null,
        random: () => 0.5
      });
      const pending = new Map<string, unknown>();
      const workflow = createGenerationWorkflow({
        api: api.generation,
        source,
        clock: { now: () => Date.parse("2026-08-02T12:00:00.000Z") },
        pendingSubmissions: {
          load: (campaignId) => (pending.get(campaignId) ?? null) as never,
          save: (campaignId, value) => { pending.set(campaignId, value); },
          clear: (campaignId) => { pending.delete(campaignId); }
        }
      });
      const run = await workflow.submit(routeCampaignId, {
        operationKind: "append",
        expectedTurnNumber: 1,
        request: generationRequestSchema.parse({
          action: "Open the dome.",
          idempotencyKey: "malformed-route-key"
        })
      });

      const rejection = await run.watch(new AbortController().signal)[Symbol.asyncIterator]().next()
        .catch((error: unknown) => error);
      expect(rejection).toMatchObject({
        name: "GenerationWorkflowProtocolError",
        kind: "invalid_snapshot",
        cause: {
          name: "ApiContractError",
          correlationId: "malformed-snapshot-route"
        }
      });
      expect(routeRequests).toEqual([
        `POST /api/v1/campaigns/${routeCampaignId}/generations`,
        `GET /api/v1/generation-jobs/${routeJobId}`
      ]);
    } finally {
      await new Promise<void>((resolveClose, reject) => routeServer.close((error) => error ? reject(error) : resolveClose()));
    }
  });
});
