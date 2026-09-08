import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { generationRequestSchema } from "../../packages/contracts/src/generation.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createProvider } from "../helpers/provider-application-fixtures.js";
import { createApiGenerationApplication } from "../helpers/runtime-application-fixtures.js";
import { enqueueChronicleReindex, importLegacyStory, runNextChronicle, setCampaignEmbeddingConfig } from "../helpers/memory-aware-services.js";
import { runGenerationJob } from "../helpers/generation-worker-harness.js";
import { installIntegrationProviderTransport } from "./provider-transport-test-helper.js";
import { estimatedInputSafetyAllowanceTokens } from "../../packages/story-engine/src/provider-request.js";
import { estimateStoryTokens } from "../../packages/story-engine/src/token-estimate.js";
import { logger } from "../../packages/logger/src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const credentialSecret = "generation-budget-growth-secret";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const providerContextWindowTokens = 1_048_576;
const providerMaxOutputTokens = 4_096;

type PromptSnapshot = Readonly<{
  budget: number;
  body: string;
  serializedContext: string;
  authorityFacts: readonly Readonly<{ id: string | null; content: string }>[];
  history: readonly Readonly<{ ordinal: number; content: string }>[];
  facts: readonly Readonly<{ ordinal: number; content: string; factIds: readonly string[] }>[];
  configuredImplementation: string;
  retrievalImplementation: string;
  fallbackCode: string | null;
}>;

function validStory(): string {
  return JSON.stringify({
    narration: "The archive lamp guides the company through the next passage.",
    choices: ["Follow the lamp.", "Study the archive.", "Ask the guide.", "Wait."],
    custom_action_suggestion: "Read the archive ledger.",
    scratchpad: "Private test note.",
    tracker_updates: [],
    image_prompt: "A lamp-lit archive corridor.",
    continuity_summary: "The company follows the archive lamp.",
    canonical_facts: [],
    superseded_facts: [],
    canonical_fact_updates: [],
    open_threads: []
  });
}

function canonicalFactIds(content: string): readonly string[] {
  return [...content.matchAll(/\[fact_id: ([0-9a-f-]{36})\]/giu)].map((match) => match[1]!);
}

function uniqueFactCount(snapshot: PromptSnapshot): number {
  return new Set(snapshot.facts.flatMap((record) => record.factIds)).size;
}

integration("generation budget grows the actual provider Chronicle context", () => {
  let pool: DatabasePool;
  let server: Server;
  let providerId = "";
  let embeddingProviderId = "";
  let ownerUserId = "";
  const requests: Array<Readonly<{ parsed: Record<string, unknown>; body: string }>> = [];

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 6);
    await migrateDatabase(pool, resolve(repositoryRoot, "database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    const transport = installIntegrationProviderTransport();
    server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
        requests.push({ parsed, body });
        response.writeHead(200, { "content-type": "application/json" });
        if (request.url?.endsWith("/embeddings")) {
          const input = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
          response.end(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [1, 0] })) }));
          return;
        }
        response.end(JSON.stringify({
          id: crypto.randomUUID(),
          model: "deterministic-budget-growth",
          choices: [{ message: { content: validStory() }, finish_reason: "stop" }],
          usage: { prompt_tokens: 700, completion_tokens: 220, total_tokens: 920 }
        }));
      });
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Budget-growth provider did not expose a TCP address.");
    providerId = (await createProvider(pool, {
      name: `Budget growth provider ${crypto.randomUUID()}`,
      providerType: "openai_compatible",
      providerRole: "text",
      baseUrl: `http://127.0.0.1:${address.port}`,
      defaultModel: "deterministic-budget-growth",
      contextWindowTokens: providerContextWindowTokens,
      maxOutputTokens: providerMaxOutputTokens,
      temperature: 0,
      enabled: true,
      configuration: {}
    }, credentialSecret)).id;
    embeddingProviderId = (await createProvider(pool, {
      name: `Budget growth embedding ${crypto.randomUUID()}`,
      providerType: "openai_compatible",
      providerRole: "embedding",
      baseUrl: `http://127.0.0.1:${address.port}`,
      defaultModel: "chunk-embed-v1",
      contextWindowTokens: 32_768,
      maxOutputTokens: 512,
      temperature: 0,
      enabled: true,
      configuration: {}
    }, credentialSecret)).id;
    (server as Server & { __transport?: { close(): Promise<void> } }).__transport = transport;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    await (server as Server & { __transport?: { close(): Promise<void> } }).__transport?.close();
    await pool?.end();
  });

  async function seedEquivalentCampaign(
    budget: number,
    retrieval: "chunked_ready" | "chunked_fallback",
    options: Readonly<{ protectedAuthorityRecords?: number }> = {}
  ): Promise<string> {
    const fixture = JSON.parse(await readFile(resolve(repositoryRoot, "tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Budget growth corpus ${budget} ${crypto.randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({
      sourceName: "generation-budget-growth.story",
      story: fixture
    }));
    const campaignId = imported.campaignId;
    await setCampaignEmbeddingConfig(pool, campaignId, {
      enabled: false,
      providerProfileId: embeddingProviderId,
      model: "chunk-embed-v1",
      batchSize: 16,
      retrievalImplementation: "legacy_hybrid"
    });
    await pool.query("UPDATE campaigns SET story_context_budget_tokens=$2 WHERE id=$1", [campaignId, budget]);
    const historyPadding = "Measured archive history remains complete and distinct. ".repeat(50);
    await pool.query(
      `INSERT INTO turns (owner_user_id,campaign_id,turn_number,action,narration,state_snapshot_private,accepted_at)
       SELECT $1,$2,ordinal,'Review archive record ' || ordinal,
              $3 || '[history-tail-' || ordinal || ']',
              jsonb_build_object(
                'continuitySummary','Archive continuity remains current at turn ' || ordinal || '.',
                'canonicalFacts',jsonb_build_array(
                  'Archive fact ' || ordinal || '-0 remains authoritative [fact-tail-' || ordinal || '-0]',
                  'Archive fact ' || ordinal || '-1 remains authoritative [fact-tail-' || ordinal || '-1]',
                  'Archive fact ' || ordinal || '-2 remains authoritative [fact-tail-' || ordinal || '-2]'
                ) || COALESCE((
                  SELECT jsonb_agg(
                    'Archive fact ' || ordinal || '-' || fact_index || ' remains authoritative [fact-tail-'
                      || ordinal || '-' || fact_index || ']'
                  )
                  FROM generate_series(3,9) fact_index
                ), '[]'::jsonb),
                'canonicalFactUpdates','[]'::jsonb
              ),now()
         FROM generate_series(3,122) AS ordinal
      `,
      [ownerUserId, campaignId, historyPadding]
    );
    await enqueueChronicleReindex(pool, campaignId);
    while (await runNextChronicle(pool, `budget-growth-derived-${crypto.randomUUID()}`, 30, credentialSecret)) {
      // Rebuild derived Chronicle records from the accepted authoritative turn ledger.
    }
    const projected = await pool.query<{ facts: string; fiction: string }>(
      `SELECT
         count(*) FILTER (WHERE memory_kind='canonical_fact')::text AS facts,
         count(*) FILTER (WHERE memory_kind='turn_fiction')::text AS fiction
         FROM chronicle_memories WHERE campaign_id=$1`,
      [campaignId]
    );
    expect(Number(projected.rows[0]?.facts)).toBeGreaterThanOrEqual(120);
    expect(Number(projected.rows[0]?.fiction)).toBeGreaterThanOrEqual(120);
    if (retrieval === "chunked_ready") {
      await setCampaignEmbeddingConfig(pool, campaignId, {
        enabled: true,
        providerProfileId: embeddingProviderId,
        model: "chunk-embed-v1",
        batchSize: 16,
        retrievalImplementation: "chunked_hybrid"
      });
      while (await runNextChronicle(pool, `budget-growth-index-${crypto.randomUUID()}`, 30, credentialSecret)) {
        // Drain this campaign's bounded chunk-index work before exercising the
        // generation runtime path.
      }
      const indexJob = await pool.query<{ status: string; error: string | null }>(
        `SELECT status,error_message AS error FROM chronicle_chunk_jobs
          WHERE campaign_id=$1 ORDER BY updated_at DESC LIMIT 1`,
        [campaignId]
      );
      expect(indexJob.rows[0]).toMatchObject({ status: "completed", error: null });
      const coverage = await pool.query<{ parents: string; covered: string }>(
        `SELECT count(*)::text AS parents,
                count(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM chronicle_memory_chunks chunk
                   WHERE chunk.parent_memory_id=parent.id AND chunk.parent_content_hash=parent.content_hash
                ))::text AS covered
           FROM chronicle_memories parent WHERE parent.campaign_id=$1`,
        [campaignId]
      );
      expect(coverage.rows[0]?.parents).toBe(coverage.rows[0]?.covered);
    } else {
      await pool.query(
        `UPDATE campaign_memory_configs
            SET embedding_enabled=true,embedding_provider_profile_id=$2,embedding_model='chunk-embed-v1',
                retrieval_implementation='chunked_hybrid'
          WHERE campaign_id=$1`,
        [campaignId, embeddingProviderId]
      );
    }
    await pool.query("UPDATE campaigns SET active_turn_number=122 WHERE id=$1", [campaignId]);
    if (options.protectedAuthorityRecords) {
      await pool.query(
        `UPDATE turns
            SET state_snapshot_private = jsonb_set(
              state_snapshot_private,
              '{canonicalFacts}',
              (SELECT jsonb_agg(
                'Protected authority ' || ordinal || ': '
                  || repeat('The archive charter remains complete and authoritative. ', 20)
                  || '[protected-authority-tail-' || ordinal || ']'
              ) FROM generate_series(1,$3) ordinal)
            )
          WHERE owner_user_id=$1 AND campaign_id=$2 AND turn_number=122`,
        [ownerUserId, campaignId, options.protectedAuthorityRecords]
      );
    }
    return campaignId;
  }

  async function capturePrompt(
    budget: number,
    retrieval: "chunked_ready" | "chunked_fallback"
  ): Promise<PromptSnapshot> {
    const campaignId = await seedEquivalentCampaign(budget, retrieval);
    const application = createApiGenerationApplication(pool, credentialSecret);
    const requestOffset = requests.length;
    const job = await application.enqueueAppend({ ownerUserId, campaignId }, generationRequestSchema.parse({
      action: "Compare the complete archive record.",
      providerProfileId: providerId,
      idempotencyKey: crypto.randomUUID(),
      context: { budgetTokens: budget, compression: "full", recentTurns: 8 }
    }));
    expect(await runGenerationJob(pool, `budget-growth-${budget}`, 30, credentialSecret)).toBe(true);
    expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "completed" });
    const providerRequest = requests.slice(requestOffset).find((candidate) => Array.isArray(candidate.parsed.messages));
    expect(providerRequest).toBeDefined();
    const body = providerRequest!.body;
    const userMessage = (providerRequest!.parsed.messages as Array<{ role?: string; content?: string }>)
      .find((message) => message.role === "user");
    const payload = JSON.parse(userMessage?.content || "{}") as {
      authoritative_context?: {
        chronicle?: Array<{ kind?: string; ordinal?: number; content?: string }>;
        currentContinuity?: { canonicalFacts?: Array<{ id?: string | null; content?: string }> };
      };
    };
    const context = payload.authoritative_context;
    expect(context).toBeDefined();
    const chronicle = context?.chronicle ?? [];
    const authorityFacts = (context?.currentContinuity?.canonicalFacts ?? [])
      .map((fact) => ({ id: typeof fact.id === "string" ? fact.id : null, content: String(fact.content) }));
    const sourceRecords = await pool.query<{ kind: "turn_fiction" | "canonical_fact"; content: string }>(
      `SELECT memory_kind AS kind,content FROM chronicle_memories
        WHERE campaign_id=$1 AND memory_kind IN ('turn_fiction','canonical_fact')
       UNION ALL
       SELECT 'canonical_fact'::text AS kind,'- [fact_id: ' || id || '] ' || content
         FROM campaign_canonical_facts WHERE campaign_id=$1`,
      [campaignId]
    );
    const sourceHistory = new Set(sourceRecords.rows
      .filter((record) => record.kind === "turn_fiction").map((record) => record.content));
    const sourceFacts = new Set(sourceRecords.rows
      .filter((record) => record.kind === "canonical_fact").map((record) => record.content));
    const history = chronicle.filter((entry) => entry.kind === "turn_fiction")
      .map((entry) => ({ ordinal: Number(entry.ordinal), content: String(entry.content) }));
    const facts = chronicle.filter((entry) => entry.kind === "canonical_fact")
      .map((entry) => {
        const content = String(entry.content);
        return { ordinal: Number(entry.ordinal), content, factIds: canonicalFactIds(content) };
      });
    for (const record of history) expect(sourceHistory.has(record.content)).toBe(true);
    for (const record of facts) expect(sourceFacts.has(record.content)).toBe(true);
    const auditResult = await pool.query<{ audit: {
      configuredImplementation?: string;
      effectiveImplementation?: string;
      fallbackCode?: string | null;
    } }>(
      `SELECT model_metadata -> 'chronicleRetrieval' AS audit
         FROM turns WHERE campaign_id=$1 ORDER BY turn_number DESC LIMIT 1`,
      [campaignId]
    );
    return {
      budget,
      body,
      serializedContext: JSON.stringify(context),
      authorityFacts,
      history,
      facts,
      configuredImplementation: String(auditResult.rows[0]?.audit?.configuredImplementation || ""),
      retrievalImplementation: String(auditResult.rows[0]?.audit?.effectiveImplementation || ""),
      fallbackCode: auditResult.rows[0]?.audit?.fallbackCode ?? null
    };
  }

  async function assertGrowthFor(retrieval: "chunked_ready" | "chunked_fallback") {
    const foreignCampaignId = await seedEquivalentCampaign(32_000, retrieval);
    await pool.query(
      "UPDATE turns SET narration='OUT-OF-SCOPE-BUDGET-GROWTH' WHERE campaign_id=$1 AND turn_number=122",
      [foreignCampaignId]
    );
    await pool.query("UPDATE chronicle_memories SET content='OUT-OF-SCOPE-BUDGET-GROWTH' WHERE campaign_id=$1", [foreignCampaignId]);
    await pool.query("UPDATE campaign_canonical_facts SET content='OUT-OF-SCOPE-BUDGET-GROWTH' WHERE campaign_id=$1", [foreignCampaignId]);
    await pool.query(
      `UPDATE chronicle_memory_chunks
          SET content='OUT-OF-SCOPE-BUDGET-GROWTH',embedding=NULL,embedding_status='skipped',
              embedding_skip_reason='semantic_retrieval_disabled',embedding_provider_profile_id=NULL,
              embedding_model=NULL,embedding_dimensions=NULL,embedding_protocol_version=NULL,
              embedding_provider_fingerprint=NULL,embedding_content_hash=NULL,embedding_updated_at=NULL
        WHERE campaign_id=$1`,
      [foreignCampaignId]
    );
    // Use a separate, equivalent campaign for each setting, and run them in
    // sequence so the worker's shared durable queue cannot overlap commits.
    const small = await capturePrompt(32_000, retrieval);
    const medium = await capturePrompt(128_000, retrieval);
    const large = await capturePrompt(1_000_000, retrieval);
    logger.info({ event: "generation_budget_growth_measurement", retrieval,
      snapshots: [small, medium, large].map((snapshot) => ({
        budget: snapshot.budget,
        history: snapshot.history.length,
        factRecords: snapshot.facts.length,
        uniqueFacts: uniqueFactCount(snapshot),
        effectiveImplementation: snapshot.retrievalImplementation,
        fallbackCode: snapshot.fallbackCode,
        bodyChars: snapshot.body.length,
        contextChars: snapshot.serializedContext.length
      }))
    });

    expect(small.history.length).toBeGreaterThan(0);
    expect(medium.history.length).toBeGreaterThan(small.history.length);
    expect(large.history.length).toBeGreaterThan(medium.history.length);
    expect(uniqueFactCount(medium)).toBeGreaterThan(uniqueFactCount(small));
    expect(uniqueFactCount(large)).toBeGreaterThan(uniqueFactCount(medium));
    expect(small.configuredImplementation).toBe("chunked_hybrid");
    expect(small.retrievalImplementation).toBe(retrieval === "chunked_ready" ? "chunked_hybrid" : "legacy_hybrid");
    expect(medium.retrievalImplementation).toBe(small.retrievalImplementation);
    expect(large.retrievalImplementation).toBe(small.retrievalImplementation);
    if (retrieval === "chunked_fallback") {
      expect(small.fallbackCode).toBe("chunk_index_not_ready");
      expect(medium.fallbackCode).toBe(small.fallbackCode);
      expect(large.fallbackCode).toBe(small.fallbackCode);
    }

    for (const snapshot of [small, medium, large]) {
      const sent = `${snapshot.body}\n${snapshot.serializedContext}`;
      expect(sent).not.toContain("OUT-OF-SCOPE-BUDGET-GROWTH");
      expect(estimateStoryTokens(snapshot.serializedContext)).toBeLessThanOrEqual(snapshot.budget);
      const requestTokens = estimateStoryTokens(snapshot.body);
      expect(requestTokens + estimatedInputSafetyAllowanceTokens(requestTokens))
        .toBeLessThanOrEqual(providerContextWindowTokens - providerMaxOutputTokens);
      expect(snapshot.authorityFacts.map((fact) => fact.content)).toEqual(expect.arrayContaining([
        "Archive fact 122-0 remains authoritative [fact-tail-122-0]",
        "Archive fact 122-1 remains authoritative [fact-tail-122-1]",
        "Archive fact 122-2 remains authoritative [fact-tail-122-2]"
      ]));
      const syntheticRecords = [...snapshot.history, ...snapshot.facts].filter((record) => record.ordinal >= 3);
      expect(syntheticRecords.length).toBeGreaterThan(0);
      for (const record of syntheticRecords) {
        expect(record.content).toMatch(/\[(?:history|fact)-tail-\d+(?:-\d+)?\]$/);
      }
    }
    return [small, medium, large] as const;
  }

  it("grows actual context through ready chunked retrieval", async () => {
    await assertGrowthFor("chunked_ready");
  }, 120_000);

  it("grows actual context through configured chunked retrieval when its index is not ready", async () => {
    await assertGrowthFor("chunked_fallback");
  }, 120_000);

  it("does not reject complete protected authority solely because its characters exceed the campaign budget", async () => {
    const campaignId = await seedEquivalentCampaign(128_000, "chunked_ready", { protectedAuthorityRecords: 140 });
    const application = createApiGenerationApplication(pool, credentialSecret);
    const requestOffset = requests.length;
    const acceptedBefore = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM turns WHERE campaign_id=$1 AND accepted_at IS NOT NULL",
      [campaignId]
    );
    const job = await application.enqueueAppend({ ownerUserId, campaignId }, generationRequestSchema.parse({
      action: "Compare the complete protected archive authority.",
      providerProfileId: providerId,
      idempotencyKey: crypto.randomUUID(),
      context: { budgetTokens: 128_000, compression: "full", recentTurns: 8 }
    }));

    expect(await runGenerationJob(pool, `budget-growth-protected-authority-${crypto.randomUUID()}`, 30, credentialSecret)).toBe(true);
    const result = await application.getJob({ ownerUserId, jobId: job.id });
    expect(result).toMatchObject({ status: "completed" });
    const providerRequest = requests.slice(requestOffset).find((candidate) => Array.isArray(candidate.parsed.messages));
    expect(providerRequest).toBeDefined();
    expect(providerRequest!.body).toContain("[protected-authority-tail-1]");
    expect(providerRequest!.body).toContain("[protected-authority-tail-140]");
    const userMessage = (providerRequest!.parsed.messages as Array<{ role?: string; content?: string }>)
      .find((message) => message.role === "user");
    const payload = JSON.parse(userMessage?.content || "{}") as { authoritative_context?: unknown };
    const serializedContext = JSON.stringify(payload.authoritative_context);
    expect(serializedContext.length).toBeGreaterThan(128_000);
    expect(estimateStoryTokens(serializedContext)).toBeLessThanOrEqual(128_000);
    const authorityFacts = (payload.authoritative_context as {
      currentContinuity?: { canonicalFacts?: Array<{ content?: string }> };
    })?.currentContinuity?.canonicalFacts ?? [];
    expect(authorityFacts).toHaveLength(140);
    expect(authorityFacts.map((fact) => fact.content)).toEqual(Array.from({ length: 140 }, (_, index) =>
      expect.stringContaining(`[protected-authority-tail-${index + 1}]`)
    ));
    const acceptedAfter = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM turns WHERE campaign_id=$1 AND accepted_at IS NOT NULL",
      [campaignId]
    );
    expect(Number(acceptedAfter.rows[0]?.count)).toBe(Number(acceptedBefore.rows[0]?.count) + 1);
  }, 120_000);

  it("keeps accepted state and Chronicle unchanged when protected authority exceeds the estimated campaign budget", async () => {
    const campaignId = await seedEquivalentCampaign(128_000, "chunked_ready", { protectedAuthorityRecords: 500 });
    const application = createApiGenerationApplication(pool, credentialSecret);
    const requestOffset = requests.length;
    const before = await pool.query<{ state: unknown; acceptedTurns: unknown; chronicle: unknown }>(
      `SELECT
         (SELECT to_jsonb(state_row) FROM campaign_state state_row WHERE campaign_id=$1) AS state,
         (SELECT jsonb_agg(to_jsonb(turn_row) ORDER BY turn_number) FROM turns turn_row
           WHERE campaign_id=$1 AND accepted_at IS NOT NULL) AS "acceptedTurns",
         (SELECT jsonb_agg(jsonb_build_object('kind', memory_kind, 'content', content) ORDER BY memory_kind,id)
           FROM chronicle_memories WHERE campaign_id=$1) AS chronicle`,
      [campaignId]
    );
    const job = await application.enqueueAppend({ ownerUserId, campaignId }, generationRequestSchema.parse({
      action: "Compare the oversized protected archive authority.",
      providerProfileId: providerId,
      idempotencyKey: crypto.randomUUID(),
      context: { budgetTokens: 128_000, compression: "full", recentTurns: 8 }
    }));

    expect(await runGenerationJob(pool, `budget-growth-estimated-overflow-${crypto.randomUUID()}`, 30, credentialSecret)).toBe(true);
    await expect(application.getJob({ ownerUserId, jobId: job.id })).resolves.toMatchObject({
      status: "recoverable",
      errorCode: "context_budget_exceeded"
    });
    const diagnostic = await pool.query<{ value: unknown }>(
      "SELECT recovery_metadata->'diagnostic' AS value FROM generation_jobs WHERE id=$1",
      [job.id]
    );
    expect(diagnostic.rows[0]?.value).toMatchObject({
      scope: "campaign_context",
      countMode: "estimated",
      estimatorVersion: "story-token-estimate-v1"
    });
    expect(requests.slice(requestOffset).filter((candidate) => Array.isArray(candidate.parsed.messages))).toEqual([]);
    const after = await pool.query<{ state: unknown; acceptedTurns: unknown; chronicle: unknown }>(
      `SELECT
         (SELECT to_jsonb(state_row) FROM campaign_state state_row WHERE campaign_id=$1) AS state,
         (SELECT jsonb_agg(to_jsonb(turn_row) ORDER BY turn_number) FROM turns turn_row
           WHERE campaign_id=$1 AND accepted_at IS NOT NULL) AS "acceptedTurns",
         (SELECT jsonb_agg(jsonb_build_object('kind', memory_kind, 'content', content) ORDER BY memory_kind,id)
           FROM chronicle_memories WHERE campaign_id=$1) AS chronicle`,
      [campaignId]
    );
    expect(after.rows).toEqual(before.rows);
  }, 120_000);

  it("reports provider-request scope when campaign context fits but the provider window cannot hold the request and output reserve", async () => {
    const campaignId = await seedEquivalentCampaign(1_000_000, "chunked_ready", { protectedAuthorityRecords: 140 });
    await pool.query("UPDATE provider_profiles SET context_window_tokens=$2 WHERE id=$1", [providerId, 20_000]);
    const application = createApiGenerationApplication(pool, credentialSecret);
    const requestOffset = requests.length;
    const job = await application.enqueueAppend({ ownerUserId, campaignId }, generationRequestSchema.parse({
      action: "Check the provider-window limited archive authority.",
      providerProfileId: providerId,
      idempotencyKey: crypto.randomUUID(),
      context: { budgetTokens: 1_000_000, compression: "full", recentTurns: 8 }
    }));

    expect(await runGenerationJob(pool, `budget-growth-provider-window-${crypto.randomUUID()}`, 30, credentialSecret)).toBe(true);
    await expect(application.getJob({ ownerUserId, jobId: job.id })).resolves.toMatchObject({
      status: "recoverable",
      errorCode: "context_budget_exceeded"
    });
    const diagnostic = await pool.query<{ value: unknown }>(
      "SELECT recovery_metadata->'diagnostic' AS value FROM generation_jobs WHERE id=$1",
      [job.id]
    );
    expect(diagnostic.rows[0]?.value).toMatchObject({
      scope: "provider_request",
      countMode: "estimated",
      estimatorVersion: "story-token-estimate-v1"
    });
    expect(requests.slice(requestOffset).filter((candidate) => Array.isArray(candidate.parsed.messages))).toEqual([]);
  }, 120_000);
});
