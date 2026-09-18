import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generationRequestSchema } from "../../packages/contracts/src/generation.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createApiGenerationApplication } from "../../services/runtime/src/generation-api-composition.js";
import { createProvider, apiProviderGraph } from "../helpers/provider-application-fixtures.js";
import { importLegacyStory } from "../helpers/memory-aware-services.js";
import { runGenerationJob } from "../helpers/generation-worker-harness.js";
import { installIntegrationProviderTransport } from "./provider-transport-test-helper.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const credentialSecret = "response-contract-workflow-fixture-secret";

function storyResponse() {
  return JSON.stringify({
    narration: "Mira opens the observatory archive.",
    choices: ["Read the ledger.", "Listen outside.", "Wait.", "Leave."],
    custom_action_suggestion: "Study the archive.",
    scratchpad: "private fixture",
    tracker_updates: [],
    image_prompt: "An observatory archive.",
    continuity_summary: "Mira opened the archive.",
    canonical_facts: [],
    superseded_facts: [],
    canonical_fact_updates: [],
    open_threads: []
  });
}

integration("response-contract composed generation workflow", () => {
  let pool: DatabasePool;
  let server: Server;
  let ownerUserId = "";
  const completions: string[] = [];

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    const transport = installIntegrationProviderTransport();
    server = createServer((request, response) => {
      if (request.url === "/v1/models" || request.url === "/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "workflow-model" }] }));
        return;
      }
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        if (request.url?.endsWith("/chat/completions")) completions.push(body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: randomUUID(), model: "workflow-model",
          choices: [{ message: { content: storyResponse() }, finish_reason: "stop" }],
          usage: { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110 }
        }));
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    (server as Server & { transport?: { close(): Promise<void> } }).transport = transport;
  });

  afterAll(async () => {
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
    await (server as Server & { transport?: { close(): Promise<void> } }).transport?.close();
    await pool.end();
  });

  async function provider(policy: "auto" | "required" | "legacy") {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("workflow provider did not bind");
    return createProvider(pool, {
      name: `response-contract-workflow-${policy}-${randomUUID()}`,
      providerType: "openai_compatible",
      providerRole: "text",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      defaultModel: "workflow-model",
      contextWindowTokens: 32_768,
      maxOutputTokens: 4_096,
      temperature: 0,
      enabled: true,
      configuration: policy === "legacy" ? {} : { textResponseFormatPolicy: policy }
    }, credentialSecret);
  }

  async function campaign() {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `response-contract-workflow-${randomUUID()}`;
    return importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "response-contract-workflow.story", story: fixture }));
  }

  async function enqueue(policy: "auto" | "required" | "legacy") {
    const [profile, imported] = await Promise.all([provider(policy), campaign()]);
    const application = createApiGenerationApplication(
      pool,
      apiProviderGraph(pool, credentialSecret).generation,
      undefined,
      { installedCapability: "r3", enforceEnabled: true }
    );
    const job = await application.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse({
      action: "Open the observatory archive.", providerProfileId: profile.id, idempotencyKey: randomUUID(),
      context: { budgetTokens: 16_000, compression: "full", recentTurns: 8 }
    }));
    return { application, campaignId: imported.campaignId, job };
  }

  async function authoritySnapshot(campaignId: string) {
    const result = await pool.query(`SELECT
      COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.turn_number,t.id) FROM turns t WHERE t.campaign_id=$1 AND t.accepted_at IS NOT NULL), '[]'::jsonb) AS turns,
      (SELECT to_jsonb(cs) FROM campaign_state cs WHERE cs.campaign_id=$1) AS campaign_state,
      COALESCE((SELECT jsonb_agg(to_jsonb(f) ORDER BY f.source_turn_number,f.source_fact_index,f.id) FROM campaign_canonical_facts f WHERE f.campaign_id=$1), '[]'::jsonb) AS facts,
      COALESCE((SELECT jsonb_agg(to_jsonb(j) ORDER BY j.id) FROM chronicle_jobs j WHERE j.campaign_id=$1), '[]'::jsonb) AS chronicle_jobs,
      COALESCE((SELECT jsonb_agg(to_jsonb(j) ORDER BY j.id) FROM chronicle_chunk_jobs j WHERE j.campaign_id=$1), '[]'::jsonb) AS chronicle_chunk_jobs`, [campaignId]);
    return result.rows[0];
  }

  it("freezes an auto contract before the one composed primary dispatch and retains its completed durable invocation", async () => {
    const fixture = await enqueue("auto");
    const callsBefore = completions.length;

    await expect(runGenerationJob(pool, `response-contract-auto-${randomUUID()}`, 30, credentialSecret)).resolves.toBe(true);

    const row = await pool.query<{ status: string; orchestrationPrivate: Record<string, any>; attempts: number; resultTurnId: string | null }>(
      "SELECT status,attempts,result_turn_id AS \"resultTurnId\",orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [fixture.job.id]
    );
    expect(row.rows[0]).toMatchObject({ status: "completed", resultTurnId: expect.any(String) });
    expect(completions).toHaveLength(callsBefore + 1);
    expect(row.rows[0]!.orchestrationPrivate.queuedResponsePolicy).toMatchObject({ policy: "auto", invocationKeys: ["story:nonstream"] });
    expect(row.rows[0]!.orchestrationPrivate.frozenResponseContracts).toMatchObject({ contracts: { "story:nonstream": { mode: "json_object", operation: "story", streaming: false } } });
    expect(row.rows[0]!.orchestrationPrivate.responseContractInvocations).toEqual([
      expect.objectContaining({ invocationKey: "story:nonstream", operation: "story_generation", status: "completed", requestPayloadHash: expect.any(String) })
    ]);
    expect(await runGenerationJob(pool, `response-contract-auto-idempotent-${randomUUID()}`, 30, credentialSecret)).toBe(false);
    expect(completions).toHaveLength(callsBefore + 1);
  }, 60_000);

  it("rejects required selection before dispatch and leaves accepted and derived authority unchanged", async () => {
    const fixture = await enqueue("required");
    const before = await authoritySnapshot(fixture.campaignId);
    const callsBefore = completions.length;

    await expect(runGenerationJob(pool, `response-contract-required-${randomUUID()}`, 30, credentialSecret)).resolves.toBe(true);

    const row = await pool.query<{ status: string; errorCode: string | null; orchestrationPrivate: Record<string, unknown> }>(
      "SELECT status,error_code AS \"errorCode\",orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [fixture.job.id]
    );
    expect(row.rows[0]).toMatchObject({ status: "recoverable", errorCode: "response_contract_unavailable" });
    expect(row.rows[0]!.orchestrationPrivate.queuedResponsePolicy).toMatchObject({ policy: "required" });
    expect(row.rows[0]!.orchestrationPrivate.frozenResponseContracts).toBeUndefined();
    expect(row.rows[0]!.orchestrationPrivate.responseContractInvocations).toBeUndefined();
    expect(completions).toHaveLength(callsBefore);
    expect(await authoritySnapshot(fixture.campaignId)).toEqual(before);
  }, 60_000);

  it("runs a legacy job through the composed provider without inventing a response-contract envelope", async () => {
    const fixture = await enqueue("legacy");
    const callsBefore = completions.length;

    await expect(runGenerationJob(pool, `response-contract-legacy-${randomUUID()}`, 30, credentialSecret)).resolves.toBe(true);

    const row = await pool.query<{ status: string; orchestrationPrivate: Record<string, unknown>; resultTurnId: string | null }>(
      "SELECT status,result_turn_id AS \"resultTurnId\",orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [fixture.job.id]
    );
    expect(row.rows[0]).toMatchObject({ status: "completed", resultTurnId: expect.any(String) });
    expect(row.rows[0]!.orchestrationPrivate.queuedResponsePolicy).toBeUndefined();
    expect(row.rows[0]!.orchestrationPrivate.frozenResponseContracts).toBeUndefined();
    expect(row.rows[0]!.orchestrationPrivate.responseContractInvocations).toBeUndefined();
    expect(completions).toHaveLength(callsBefore + 1);
  }, 60_000);
});
