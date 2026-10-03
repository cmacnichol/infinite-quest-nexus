import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTurnCorrectionApplication } from "../../packages/application/src/turn-corrections/index.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { generationRequestSchema } from "../../packages/contracts/src/generation.js";
import { createPostgresTurnCorrectionRepository } from "../../packages/database/src/turn-correction-repository.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { saveStoryMemoryEnrollment } from "../../packages/database/src/story-memory-policy-repository.js";
import { apiProviderGraph, createProvider } from "../helpers/provider-application-fixtures.js";
import { createApiGenerationApplication } from "../helpers/runtime-application-fixtures.js";
import { createApiGenerationApplication as composeApiGeneration } from "../../services/runtime/src/generation-api-composition.js";
import { memoryGeneration } from "../helpers/memory-applications.js";
import { importLegacyStoryWithMemoryOff as importLegacyStory } from "../helpers/memory-aware-services.js";
import { runGenerationJob } from "../helpers/generation-worker-harness.js";
import { installIntegrationProviderTransport } from "./provider-transport-test-helper.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const credentialSecret = "story-continuity-remediation-secret";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function story(narration: string, summary: string, threads: readonly string[] = []): string {
  return JSON.stringify({
    narration,
    choices: ["Continue carefully.", "Ask Captain Alia.", "Study the rule.", "Wait."],
    custom_action_suggestion: "Follow the lanterns.",
    scratchpad: "Private generated note.",
    tracker_updates: [],
    image_prompt: "A lantern-lit harbor at night.",
    continuity_summary: summary,
    canonical_facts: ["Captain Alia guards the harbor."],
    superseded_facts: [],
    canonical_fact_updates: [],
    open_threads: threads
  });
}

integration("prompt-memory remediation composed workflow", () => {
  let pool: DatabasePool;
  let server: Server;
  let providerId = "";
  const replies: string[] = [];
  const requests: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 5);
    await migrateDatabase(pool, resolve(repositoryRoot, "database/migrations"));
    const transport = installIntegrationProviderTransport();
    server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        requests.push(JSON.parse(body || "{}") as Record<string, unknown>);
        response.writeHead(200, { "content-type": "application/json" });
        if (!(request.method === "POST" && request.url?.endsWith("/chat/completions"))) {
          response.end(JSON.stringify({ data: [] }));
          return;
        }
        response.end(JSON.stringify({
          id: crypto.randomUUID(), model: "deterministic-continuity",
          choices: [{ message: { content: replies.shift() ?? story("Fallback narration.", "Fallback summary.") }, finish_reason: "stop" }],
          usage: { prompt_tokens: 700, completion_tokens: 220, total_tokens: 920 }
        }));
      });
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Deterministic provider did not expose a TCP address.");
    const provider = await createProvider(pool, {
      name: `Continuity provider ${crypto.randomUUID()}`, providerType: "openai_compatible", providerRole: "text",
      baseUrl: `http://127.0.0.1:${address.port}`, defaultModel: "deterministic-continuity",
      contextWindowTokens: 1_048_576, maxOutputTokens: 4_096, temperature: 0, enabled: true,
      configuration: { textResponseFormatPolicy: "auto" }
    }, credentialSecret);
    providerId = provider.id;
    (server as Server & { __transport?: { close(): Promise<void> } }).__transport = transport;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    await (server as Server & { __transport?: { close(): Promise<void> } }).__transport?.close();
    await pool?.end();
  });

  it("keeps corrected complete authority through accepted turns, provider requests, and replay", async () => {
    const fixture = JSON.parse(await readFile(resolve(repositoryRoot, "tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Continuity composed ${crypto.randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "continuity.story", story: fixture }));
    const ownerUserId = await initialOwnerId(pool);
    await pool.query(
      `UPDATE world_versions SET content = jsonb_set(content, '{world,rules}', '"The final harbor rule is never broken."'::jsonb, true)
        WHERE id = (SELECT world_version_id FROM campaigns WHERE id = $1)`, [imported.campaignId]
    );
    const latePassword = "late-harbor-password";
    await pool.query(
      "UPDATE campaign_state SET scratchpad_private=$2,scratchpad_safe_for_prompt=true WHERE campaign_id=$1",
      [imported.campaignId, `Earlier private material. ${"x".repeat(10_000)} ${latePassword}`]
    );
    const application = createApiGenerationApplication(pool, credentialSecret);
    const enqueue = async (action: string) => application.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse({
      action, providerProfileId: providerId, idempotencyKey: crypto.randomUUID(),
      context: { budgetTokens: 1_000_000, compression: "full", recentTurns: 8 }
    }));
    const accepted = async (action: string, reply: string, worker: string) => {
      replies.push(reply);
      const job = await enqueue(action);
      expect(await runGenerationJob(pool, worker, 30, credentialSecret)).toBe(true);
      expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "completed" });
      return job;
    };

    await accepted("Ask Captain Alia for the password.", story(
      `Captain Alia reveals ${latePassword} beside the harbor lantern.`, "Captain Alia shared the late password.", ["Use the late password at the sealed gate."]
    ), "continuity-worker-one");
    await accepted("Witness the final consequence.", story(
      "Captain Alia falls defending the sealed gate. Captain Alia dies.", "Captain Alia died after defending the gate.", ["Use the late password at the sealed gate."]
    ), "continuity-worker-two");

    const latest = await pool.query<{ id: string; turn_number: number }>(
      "SELECT id,turn_number FROM turns WHERE campaign_id=$1 ORDER BY turn_number DESC LIMIT 1", [imported.campaignId]
    );
    const corrections = createTurnCorrectionApplication({
      corrections: createPostgresTurnCorrectionRepository(pool, { memory: memoryGeneration(pool, credentialSecret) })
    });
    await corrections.correctNarration({ ownerUserId, campaignId: imported.campaignId }, {
      turnId: latest.rows[0]!.id, narration: `Captain Alia dies after securing ${latePassword} at the sealed gate.`,
      expectedCorrectionRevision: 0, expectedActiveTurnNumber: latest.rows[0]!.turn_number, source: "user_edit"
    });
    const finalJob = await accepted("Resolve the sealed gate thread.", story(
      `The sealed gate opens with ${latePassword}; Captain Alia's sacrifice is honored.`, "The password opened the gate and the thread is resolved."
    ), "continuity-worker-three");

    const serializedFinalRequest = JSON.stringify(requests.at(-1));
    expect(serializedFinalRequest).toContain(latePassword);
    expect(serializedFinalRequest).toContain("Captain Alia dies after securing");
    expect(serializedFinalRequest).toContain("The final harbor rule is never broken.");
    const state = await pool.query<{ scratchpad_private: string }>("SELECT scratchpad_private FROM campaign_state WHERE campaign_id=$1", [imported.campaignId]);
    expect(state.rows[0]?.scratchpad_private).toBe("Private generated note.");
    await expect(pool.query<{ narration: string }>("SELECT narration FROM turns WHERE id=$1", [latest.rows[0]!.id]))
      .resolves.toMatchObject({ rows: [{ narration: "Captain Alia falls defending the sealed gate. Captain Alia dies." }] });
    await expect(pool.query<{ count: string }>("SELECT count(*)::text AS count FROM turns WHERE campaign_id=$1 AND turn_number=5", [imported.campaignId]))
      .resolves.toMatchObject({ rows: [{ count: "1" }] });
    await expect(pool.query<{ attempts: string }>("SELECT count(*)::text AS attempts FROM generation_attempts WHERE generation_job_id=$1", [finalJob.id]))
      .resolves.toMatchObject({ rows: [{ attempts: "1" }] });
  });

  it("recalls an older fact omitted from protection, accepts its transmitted supersession, and replays the replacement", async () => {
    const fixture = JSON.parse(await readFile(resolve(repositoryRoot, "tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Retrieved fact replay ${crypto.randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "retrieved-fact.story", story: fixture }));
    const ownerUserId = await initialOwnerId(pool);
    const operatorConfig = { installedCapability: "r3" as const, enforceEnabled: true, castContextEnabled: true, historyCoverageEnabled: true };
    await saveStoryMemoryEnrollment(pool, { ownerUserId, campaignId: imported.campaignId }, { capability: "r3", reviewMode: "observe" }, operatorConfig);
    const application = composeApiGeneration(pool, apiProviderGraph(pool, credentialSecret).generation, undefined, operatorConfig);
    const oldFact = "The lunar archive key preserves the oldest vault oath.";
    const reviewPass = JSON.stringify({ version: "story-continuity-review-v1", verdict: "pass", findings: [] });
    const acceptFactTurn = async (action: string, facts: readonly string[], workerId: string) => {
      const output = JSON.parse(story("The archive inventory is recorded.", "The archive inventory is recorded."));
      output.canonical_facts = facts;
      output.canonical_fact_updates = [];
      replies.push(JSON.stringify(output), reviewPass);
      const job = await application.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse({
        action, providerProfileId: providerId, idempotencyKey: crypto.randomUUID(),
        context: { budgetTokens: 1_000_000, compression: "full", recentTurns: 8 }
      }));
      expect(await runGenerationJob(pool, workerId, 30, credentialSecret)).toBe(true);
      await expect(application.getJob({ ownerUserId, jobId: job.id })).resolves.toMatchObject({ status: "completed" });
    };
    await acceptFactTurn("Record the old lunar archive key oath.", [oldFact], `retrieved-fact-seed-old-${crypto.randomUUID()}`);
    const oldFactRow = await pool.query<{ id: string; turn_number: number }>(
      "SELECT id,source_turn_number AS turn_number FROM campaign_canonical_facts WHERE campaign_id=$1 AND content=$2", [imported.campaignId, oldFact]);
    expect(oldFactRow.rows).toHaveLength(1);
    const oldFactId = oldFactRow.rows[0]!.id;
    const newerFacts = Array.from({ length: 80 }, (_, index) => `Unrelated archive inventory ${index + 1}: ${"x".repeat(3_800)}`);
    await acceptFactTurn("Record forty unrelated archive inventories.", newerFacts, `retrieved-fact-seed-new-${crypto.randomUUID()}`);
    const activeTurnNumber = (await pool.query<{ active_turn_number: number }>(
      "SELECT active_turn_number FROM campaigns WHERE id=$1", [imported.campaignId])).rows[0]!.active_turn_number;
    expect(activeTurnNumber).toBeGreaterThan(oldFactRow.rows[0]!.turn_number);
    const authorityBefore = await pool.query<{ id: string; content: string }>(
      "SELECT id,content FROM campaign_canonical_facts WHERE campaign_id=$1 ORDER BY id", [imported.campaignId]);
    const snapshotsBefore = await pool.query<{ id: string; snapshot: unknown }>(
      "SELECT id,state_snapshot_private AS snapshot FROM turns WHERE campaign_id=$1 ORDER BY turn_number", [imported.campaignId]);
    const reply = JSON.parse(story("The archive opens under the moonlight.", "The lunar archive key opened the western vault."));
    reply.canonical_facts = [];
    reply.canonical_fact_updates = [{ content: "The lunar archive key now opens the western archive.", supersedes_fact_ids: [oldFactId] }];
    const requestStart = requests.length;
    replies.push(JSON.stringify(reply), reviewPass);
    const first = await application.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse({
      action: "Use the lunar archive key to open the archive.", providerProfileId: providerId, idempotencyKey: crypto.randomUUID(),
      context: { budgetTokens: 8_000, compression: "full", recentTurns: 8 }
    }));
    expect(await runGenerationJob(pool, `retrieved-fact-${crypto.randomUUID()}`, 30, credentialSecret)).toBe(true);
    const firstJob = await application.getJob({ ownerUserId, jobId: first.id });
    expect(firstJob).toMatchObject({ status: "completed" });
    const providerRequests = requests.slice(requestStart).filter((request) => Array.isArray(request.messages));
    const hasAuthoritativeContext = (request: Record<string, unknown>): boolean => {
      const messages = request.messages as Array<{ role?: unknown; content?: unknown }>;
      return messages.some((message) => {
        if (message.role !== "user" || typeof message.content !== "string") return false;
        try { return Boolean((JSON.parse(message.content) as { authoritative_context?: unknown }).authoritative_context); } catch { return false; }
      });
    };
    const storyRequests = providerRequests.filter(hasAuthoritativeContext);
    expect(storyRequests).toHaveLength(1);
    const writerRequest = storyRequests[0];
    expect(writerRequest).toBeDefined();
    const factPaths: string[] = [];
    const collectFactPaths = (value: unknown, path: string): void => {
      if (typeof value === "string") {
        const count = value.split(oldFact).length - 1;
        if (count > 0) factPaths.push(`${path}#${count}`);
      } else if (Array.isArray(value)) {
        value.forEach((entry, index) => collectFactPaths(entry, `${path}[${index}]`));
      } else if (value && typeof value === "object") {
        Object.entries(value).forEach(([key, entry]) => collectFactPaths(entry, `${path}.${key}`));
      }
    };
    const userMessage = (writerRequest.messages as Array<{ role?: unknown; content?: unknown }>).find((message) => message.role === "user");
    expect(typeof userMessage?.content).toBe("string");
    let parsedUserContent: unknown;
    try { parsedUserContent = JSON.parse(userMessage!.content as string); } catch { parsedUserContent = userMessage!.content; }
    const authoritativeContext = (parsedUserContent as { authoritative_context: Record<string, unknown> }).authoritative_context;
    expect(authoritativeContext.storyLedger).toMatchObject({ version: "story-ledger-v1" });
    expect(authoritativeContext.protectedFacts).toEqual(expect.any(Array));
    expect((authoritativeContext.protectedFacts as Array<{ content: string }>).some((fact) => fact.content === oldFact)).toBe(false);
    const continuityFacts = (authoritativeContext.currentContinuity as { canonicalFacts: Array<{ content: string }> }).canonicalFacts;
    expect(continuityFacts.some((fact) => fact.content === oldFact)).toBe(false);
    collectFactPaths(parsedUserContent, "user");
    const persistedEvidence = await pool.query<{ primary_result: {
      requestBody?: string; sentFactIds?: string[]; chronicleRetrieval?: { effectiveMode?: string; fallbackCode?: string };
      contextDiagnostics?: { layers?: { history?: { version?: string; candidates?: { selectedCount?: number; fallbackReason?: string | null } } } };
    }; manifest: { entries?: Array<{ canonicalFactId?: string | null; selectionGroup?: string; source?: { kind?: string } }> } }>(
      "SELECT orchestration_private->'primaryResult' AS primary_result, orchestration_private->'sourceEvidenceManifest' AS manifest FROM generation_jobs WHERE id=$1", [first.id]);
    expect(persistedEvidence.rows).toHaveLength(1);
    const persistedResult = persistedEvidence.rows[0]!.primary_result;
    expect(persistedResult.sentFactIds).toContain(oldFactId);
    expect(JSON.parse(persistedResult.requestBody!)).toEqual(writerRequest);
    expect(persistedResult.chronicleRetrieval).toMatchObject({ effectiveMode: "lexical_only", fallbackCode: "semantic_retrieval_unavailable" });
    expect(persistedResult.contextDiagnostics?.layers?.history?.version).toBe("history-coverage-diagnostics-v1");
    expect(persistedResult.contextDiagnostics?.layers?.history?.candidates).toMatchObject({ selectedCount: 1, fallbackReason: "semantic_retrieval_unavailable" });
    expect(persistedEvidence.rows[0]?.manifest.entries?.some((entry) => entry.canonicalFactId === oldFactId
      && entry.source?.kind === "canonical_fact")).toBe(true);
    expect(factPaths).toHaveLength(1);
    expect(factPaths[0]).toMatch(/^user\.authoritative_context\.chronicle\[\d+\]\.content#1$/);
    expect(Number(factPaths[0]!.slice(factPaths[0]!.lastIndexOf("#") + 1))).toBe(1);
    const persisted = await pool.query<{ id: string; content: string; valid_until_turn: number | null; superseded_by_fact_id: string | null }>(
      "SELECT id,content,valid_until_turn,superseded_by_fact_id FROM campaign_canonical_facts WHERE campaign_id=$1 AND (id=$2 OR content=$3)",
      [imported.campaignId, oldFactId, "The lunar archive key now opens the western archive."]);
    expect(persisted.rows).toHaveLength(2);
    const superseded = persisted.rows.find((fact) => fact.id === oldFactId);
    const replacement = persisted.rows.find((fact) => fact.content === "The lunar archive key now opens the western archive.");
    expect(superseded).toMatchObject({ valid_until_turn: activeTurnNumber + 1 });
    expect(superseded?.superseded_by_fact_id).toBe(replacement?.id);
    expect(replacement?.superseded_by_fact_id).toBeNull();
    const snapshotsAfter = await pool.query("SELECT id,state_snapshot_private AS snapshot FROM turns WHERE id=ANY($1::uuid[]) ORDER BY turn_number",
      [snapshotsBefore.rows.map((turn) => turn.id)]);
    expect(snapshotsAfter.rows).toEqual(snapshotsBefore.rows);
    await expect(pool.query("SELECT id,content FROM campaign_canonical_facts WHERE campaign_id=$1 ORDER BY id", [imported.campaignId]))
      .resolves.toMatchObject({ rows: expect.arrayContaining(authorityBefore.rows) });

    const replayStart = requests.length;
    replies.push(story("The western archive is open.", "The lunar archive key now opens the western archive."));
    replies.push(JSON.stringify({ version: "story-continuity-review-v1", verdict: "pass", findings: [] }));
    const replay = await application.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse({
      action: "Describe what is inside the western archive.", providerProfileId: providerId, idempotencyKey: crypto.randomUUID(),
      context: { budgetTokens: 8_000, compression: "full", recentTurns: 8 }
    }));
    expect(await runGenerationJob(pool, `retrieved-fact-replay-${crypto.randomUUID()}`, 30, credentialSecret)).toBe(true);
    await expect(application.getJob({ ownerUserId, jobId: replay.id })).resolves.toMatchObject({ status: "completed" });
    const replayRequest = requests.slice(replayStart).filter((request) => Array.isArray(request.messages)).find(hasAuthoritativeContext);
    expect(JSON.stringify(replayRequest)).toContain("The lunar archive key now opens the western archive.");
    expect(JSON.stringify(replayRequest)).not.toContain(oldFact);
  });

  it.each([
    ["omitted no-op arrays", (value: Record<string, unknown>) => { delete value.superseded_facts; delete value.canonical_fact_updates; }],
    ["content-only fact wrapper", (value: Record<string, unknown>) => { value.canonical_facts = [{ content: "The format beacon is lit." }]; }]
  ])("accepts %s once, preserves raw evidence, and replays accepted authority", async (_label, format) => {
    const fixture = JSON.parse(await readFile(resolve(repositoryRoot, "tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Normalization composed ${crypto.randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "normalization.story", story: fixture }));
    const ownerUserId = await initialOwnerId(pool);
    const application = createApiGenerationApplication(pool, credentialSecret);
    const seededFact = "The beacon keeper trusts the dawn watch.";
    const seededThread = "Return to the beacon after dawn.";
    const newFact = "The format beacon is lit.";
    const storyDispatches = () => requests.filter((request) => Array.isArray(request.messages)).length;
    const seedOutput = JSON.parse(story("The beacon keeper entrusts the dawn watch.", "The dawn watch has begun.", [seededThread]));
    seedOutput.canonical_facts = [seededFact];
    const beforeSeed = storyDispatches();
    replies.push(JSON.stringify(seedOutput));
    const seed = await application.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse({
      action: "Begin the dawn watch.", providerProfileId: providerId, idempotencyKey: crypto.randomUUID(),
      context: { budgetTokens: 1_000_000, compression: "full", recentTurns: 8 }
    }));
    expect(await runGenerationJob(pool, `normalization-seed-${crypto.randomUUID()}`, 30, credentialSecret)).toBe(true);
    expect(storyDispatches()).toBe(beforeSeed + 1);
    await expect(application.getJob({ ownerUserId, jobId: seed.id })).resolves.toMatchObject({ status: "completed" });

    const output = JSON.parse(story("The format beacon is lit above the gate.", "The format beacon is lit.", [seededThread]));
    output.canonical_facts = [newFact];
    format(output);
    const beforeRequests = storyDispatches();
    replies.push(JSON.stringify(output));
    const job = await application.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse({
      action: "Light the format beacon.", providerProfileId: providerId, idempotencyKey: crypto.randomUUID(),
      context: { budgetTokens: 1_000_000, compression: "full", recentTurns: 8 }
    }));
    expect(await runGenerationJob(pool, `normalization-worker-${crypto.randomUUID()}`, 30, credentialSecret)).toBe(true);
    expect(storyDispatches()).toBe(beforeRequests + 1);
    await expect(application.getJob({ ownerUserId, jobId: job.id })).resolves.toMatchObject({ status: "completed" });
    await expect(pool.query<{ content: string }>(
      "SELECT content FROM campaign_canonical_facts WHERE campaign_id=$1 AND content = ANY($2::text[]) ORDER BY content",
      [imported.campaignId, [newFact, seededFact]]
    )).resolves.toMatchObject({ rows: [{ content: seededFact }, { content: newFact }] });
    await expect(pool.query<{ raw: string }>("SELECT raw_output AS raw FROM generation_attempts WHERE generation_job_id=$1", [job.id]))
      .resolves.toMatchObject({ rows: [{ raw: JSON.stringify(output) }] });
    await expect(pool.query<{ snapshot: { openThreads: string[] } }>("SELECT state_snapshot_private AS snapshot FROM turns WHERE id=(SELECT result_turn_id FROM generation_jobs WHERE id=$1)", [job.id]))
      .resolves.toMatchObject({ rows: [{ snapshot: { openThreads: [seededThread] } }] });

    const beforeReplay = storyDispatches();
    replies.push(story("Dawn reaches the beacon.", "The beacon remains lit.", [seededThread]));
    const replay = await application.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse({
      action: "Return to the beacon.", providerProfileId: providerId, idempotencyKey: crypto.randomUUID(),
      context: { budgetTokens: 1_000_000, compression: "full", recentTurns: 8 }
    }));
    expect(await runGenerationJob(pool, `normalization-replay-${crypto.randomUUID()}`, 30, credentialSecret)).toBe(true);
    expect(storyDispatches()).toBe(beforeReplay + 1);
    await expect(application.getJob({ ownerUserId, jobId: replay.id })).resolves.toMatchObject({ status: "completed" });
    const replayRequest = JSON.stringify(requests.filter((request) => Array.isArray(request.messages)).at(-1));
    expect(replayRequest).toContain(seededFact);
    expect(replayRequest).toContain(newFact);
    expect(replayRequest).toContain(seededThread);
  });

  it.each([
    ["metadata-bearing fact wrapper", (value: Record<string, unknown>) => { value.canonical_facts = [{ content: "The beacon is lit.", supersedes_fact_ids: [] }]; }],
    ["missing complete scratchpad", (value: Record<string, unknown>) => { delete value.scratchpad; }],
    ["mechanics-bearing fact wrapper", (value: Record<string, unknown>) => { value.canonical_facts = [{ content: "The d20 roll is 18." }]; }],
    ["unsupplied structured supersession", (value: Record<string, unknown>) => { value.canonical_fact_updates = [{ content: "The beacon is lit.", supersedes_fact_ids: ["11111111-1111-4111-8111-111111111111"] }]; }]
  ])("rejects %s without mutating accepted authority", async (_label, corrupt) => {
    const fixture = JSON.parse(await readFile(resolve(repositoryRoot, "tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Normalization rejection ${crypto.randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "normalization-rejection.story", story: fixture }));
    const ownerUserId = await initialOwnerId(pool);
    const application = createApiGenerationApplication(pool, credentialSecret);
    const before = await pool.query<{ turns: number; facts: number; memories: number; state: unknown }>(
      `SELECT (SELECT count(*)::int FROM turns WHERE campaign_id=$1) AS turns,
              (SELECT count(*)::int FROM campaign_canonical_facts WHERE campaign_id=$1) AS facts,
              (SELECT count(*)::int FROM chronicle_memories WHERE campaign_id=$1) AS memories,
              (SELECT to_jsonb(campaign_state) FROM campaign_state WHERE campaign_id=$1) AS state`, [imported.campaignId]
    );
    const output = JSON.parse(story("The beacon is lit.", "The beacon is lit."));
    corrupt(output);
    const beforeDispatches = requests.filter((request) => Array.isArray(request.messages)).length;
    replies.push(JSON.stringify(output));
    const job = await application.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse({
      action: "Light the beacon.", providerProfileId: providerId, idempotencyKey: crypto.randomUUID(),
      context: { budgetTokens: 1_000_000, compression: "full", recentTurns: 8 }
    }));
    expect(await runGenerationJob(pool, `normalization-reject-${crypto.randomUUID()}`, 30, credentialSecret)).toBe(true);
    expect(requests.filter((request) => Array.isArray(request.messages))).toHaveLength(beforeDispatches + 1);
    await expect(application.getJob({ ownerUserId, jobId: job.id })).resolves.toMatchObject({ status: expect.stringMatching(/^(recoverable|failed)$/u) });
    await expect(pool.query<{ turns: number; facts: number; memories: number; state: unknown }>(
      `SELECT (SELECT count(*)::int FROM turns WHERE campaign_id=$1) AS turns,
              (SELECT count(*)::int FROM campaign_canonical_facts WHERE campaign_id=$1) AS facts,
              (SELECT count(*)::int FROM chronicle_memories WHERE campaign_id=$1) AS memories,
              (SELECT to_jsonb(campaign_state) FROM campaign_state WHERE campaign_id=$1) AS state`, [imported.campaignId]
    )).resolves.toEqual(before);
  });
});
