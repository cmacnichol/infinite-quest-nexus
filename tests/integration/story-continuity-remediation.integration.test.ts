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
import { createProvider } from "../helpers/provider-application-fixtures.js";
import { createApiGenerationApplication } from "../helpers/runtime-application-fixtures.js";
import { memoryGeneration } from "../helpers/memory-applications.js";
import { importLegacyStory } from "../helpers/memory-aware-services.js";
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
      contextWindowTokens: 1_048_576, maxOutputTokens: 4_096, temperature: 0, enabled: true, configuration: {}
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
});
