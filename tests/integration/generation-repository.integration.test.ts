import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenerationApplicationError } from "../../packages/application/src/index.js";
import { generationRequestSchema, generationRetryLatestRequestSchema } from "../../packages/contracts/src/generation.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { createPostgresGenerationCommandRepository } from "../../packages/database/src/generation-repository.js";
import { sha256 } from "../../packages/domain/src/index.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { turnReportedCosts } from "../../services/api/src/cost-service.js";
import { importLegacyStory } from "../../services/api/src/import-service.js";
import { promptProtocolVersion, resolvePromptSnapshot } from "../../services/api/src/prompt-library-service.js";
import { createProvider } from "../../services/api/src/provider-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const credentialSecret = "generation-repository-test-secret";

integration("PostgreSQL generation command repository", () => {
  let pool: DatabasePool;
  let ownerUserId = "";
  let providerProfileId = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 5);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    providerProfileId = (await createProvider(pool, {
      name: `Generation repository ${crypto.randomUUID()}`,
      providerType: "openai_compatible",
      providerRole: "text",
      baseUrl: "http://127.0.0.1:9911",
      defaultModel: "repository-test-model",
      contextWindowTokens: 32768,
      maxOutputTokens: 4096,
      temperature: 0,
      enabled: true,
      configuration: {}
    }, credentialSecret)).id;
  });

  afterAll(async () => {
    await pool.end();
  });

  function repository() {
    return createPostgresGenerationCommandRepository(pool, {
      resolvePromptSnapshot,
      promptProtocolVersion,
      readTurnReportedCosts: (scopeOwnerUserId, turnIds) => turnReportedCosts(pool, scopeOwnerUserId, [...turnIds])
    });
  }

  async function campaign() {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Generation repository ${crypto.randomUUID()}`;
    return importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "generation-repository.story", story: fixture }));
  }

  function appendRequest(action: string, idempotencyKey = crypto.randomUUID()) {
    return generationRequestSchema.parse({
      action,
      providerProfileId,
      idempotencyKey,
      context: { budgetTokens: 16_000, compression: "full", recentTurns: 8 }
    });
  }

  function replacementRequest(action: string, idempotencyKey = crypto.randomUUID()) {
    return generationRetryLatestRequestSchema.parse({
      action,
      providerProfileId,
      idempotencyKey,
      expectedCurrentTurnNumber: 2,
      context: { budgetTokens: 16_000, compression: "full", recentTurns: 8 }
    });
  }

  function autoRequest(action: string, classificationId: string) {
    return generationRequestSchema.parse({
      action,
      requestedInputMode: "auto",
      resolvedInputMode: "action",
      inputModeSource: "auto",
      classificationId,
      providerProfileId,
      idempotencyKey: crypto.randomUUID(),
      context: { budgetTokens: 16_000, compression: "full", recentTurns: 8 }
    });
  }

  it("implements owner-scoped append reads and command state guards without transactions for reads", async () => {
    const imported = await campaign();
    const commands = repository();
    const idempotencyKey = crypto.randomUUID();
    const queued = await commands.enqueueAppend(
      { ownerUserId, campaignId: imported.campaignId },
      appendRequest("Open the repository observatory.", idempotencyKey)
    );

    expect(queued).toMatchObject({ status: "queued", duplicate: false, operationKind: "append", replacementTurnId: null });
    await expect(commands.enqueueAppend(
      { ownerUserId, campaignId: imported.campaignId },
      appendRequest("Open a different repository observatory.", idempotencyKey)
    )).rejects.toMatchObject({ kind: "conflict", details: { reason: "idempotency_mismatch" } });
    await expect(commands.getJob({ ownerUserId, jobId: queued.id })).resolves.toMatchObject({ id: queued.id, status: "queued" });
    await expect(commands.getResult({ ownerUserId, jobId: queued.id }))
      .rejects.toMatchObject({ kind: "invalid_state", details: { reason: "result_not_completed", generationStatus: "queued" } });
    await expect(commands.retry({ ownerUserId, jobId: queued.id }))
      .rejects.toMatchObject({ kind: "invalid_state", details: { reason: "retry_source_state" } });
    await expect(commands.cancel({ ownerUserId, jobId: queued.id })).resolves.toMatchObject({ id: queued.id, status: "cancelled" });
    await expect(commands.cancel({ ownerUserId, jobId: queued.id })).resolves.toMatchObject({ id: queued.id, status: "cancelled" });
    await expect(commands.discard({ ownerUserId, jobId: queued.id }))
      .rejects.toMatchObject({ kind: "invalid_state", details: { reason: "discard_source_state" } });
  });

  it("classifies missing and resolved-mode-mismatched Auto classifications as conflicts", async () => {
    const imported = await campaign();
    const commands = repository();
    const action = "Open the Auto-classification observatory.";

    await expect(commands.enqueueAppend(
      { ownerUserId, campaignId: imported.campaignId },
      autoRequest(action, crypto.randomUUID())
    )).rejects.toMatchObject({ kind: "conflict", details: { reason: "classification_missing_or_expired" } });

    const classification = await pool.query<{ id: string }>(
      `INSERT INTO turn_input_classifications (
         owner_user_id, campaign_id, input_hash, classification, resolved_mode, confidence_band,
         provider_profile_id, provider_source, diagnostics
       ) VALUES ($1,$2,$3,'scene','scene','clear',$4,'story_text','{}'::jsonb) RETURNING id`,
      [ownerUserId, imported.campaignId, sha256(action), providerProfileId]
    );
    await expect(commands.enqueueAppend(
      { ownerUserId, campaignId: imported.campaignId },
      autoRequest(action, classification.rows[0]!.id)
    )).rejects.toMatchObject({ kind: "conflict", details: { reason: "classification_mode_mismatch" } });
  });

  it("does not reveal or mutate a known foreign-owner job through any command or query", async () => {
    const foreignUser = await pool.query<{ id: string }>(
      "INSERT INTO users (display_name) VALUES ('Generation repository foreign owner') RETURNING id"
    );
    const foreignOwnerUserId = foreignUser.rows[0]!.id;
    const foreignWorld = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id, title) VALUES ($1, 'Foreign generation repository world') RETURNING id",
      [foreignOwnerUserId]
    );
    const foreignWorldVersion = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id, owner_user_id, version_number, content)
       VALUES ($1,$2,1,'{}'::jsonb) RETURNING id`,
      [foreignWorld.rows[0]!.id, foreignOwnerUserId]
    );
    const foreignCampaign = await pool.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id, world_version_id, title) VALUES ($1,$2,'Foreign generation repository campaign') RETURNING id",
      [foreignOwnerUserId, foreignWorldVersion.rows[0]!.id]
    );
    const foreignProvider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles (owner_user_id, name, provider_type, provider_role, base_url, default_model)
       VALUES ($1,'Foreign generation repository provider','openai_compatible','text','http://127.0.0.1:9912','foreign-model')
       RETURNING id`,
      [foreignOwnerUserId]
    );
    const foreignJob = await pool.query<{ id: string }>(
      `INSERT INTO generation_jobs (
         owner_user_id, campaign_id, provider_profile_id, idempotency_key, expected_turn_number, action
       ) VALUES ($1,$2,$3,$4,1,'Open the foreign observatory.') RETURNING id`,
      [foreignOwnerUserId, foreignCampaign.rows[0]!.id, foreignProvider.rows[0]!.id, crypto.randomUUID()]
    );
    const commands = repository();
    const foreignJobId = foreignJob.rows[0]!.id;

    await expect(commands.enqueueAppend(
      { ownerUserId, campaignId: foreignCampaign.rows[0]!.id },
      appendRequest("Attempt to reach the foreign observatory.")
    )).rejects.toMatchObject({ kind: "not_found", details: { campaignId: foreignCampaign.rows[0]!.id } });
    await expect(commands.enqueueReplacement(
      { ownerUserId, campaignId: foreignCampaign.rows[0]!.id },
      replacementRequest("Attempt to replace the foreign observatory.")
    )).rejects.toMatchObject({ kind: "not_found", details: { campaignId: foreignCampaign.rows[0]!.id } });
    await expect(commands.getJob({ ownerUserId, jobId: foreignJobId }))
      .rejects.toMatchObject({ kind: "not_found", details: { jobId: foreignJobId } });
    await expect(commands.getResult({ ownerUserId, jobId: foreignJobId }))
      .rejects.toMatchObject({ kind: "not_found", details: { jobId: foreignJobId } });
    await expect(commands.retry({ ownerUserId, jobId: foreignJobId }))
      .rejects.toMatchObject({ kind: "not_found", details: { jobId: foreignJobId } });
    await expect(commands.cancel({ ownerUserId, jobId: foreignJobId }))
      .rejects.toMatchObject({ kind: "not_found", details: { jobId: foreignJobId } });
    await expect(commands.discard({ ownerUserId, jobId: foreignJobId }))
      .rejects.toMatchObject({ kind: "not_found", details: { jobId: foreignJobId } });
    await expect(pool.query<{ status: string }>("SELECT status FROM generation_jobs WHERE id = $1", [foreignJobId]))
      .resolves.toMatchObject({ rows: [{ status: "queued" }] });
  });

  it("recovers replacement unique conflicts with its savepoint and leaves one durable active job", async () => {
    const imported = await campaign();
    const commands = repository();
    const firstKey = crypto.randomUUID();
    const [first, second] = await Promise.allSettled([
      commands.enqueueReplacement({ ownerUserId, campaignId: imported.campaignId }, replacementRequest("Rewrite the latest turn from the archive.", firstKey)),
      commands.enqueueReplacement({ ownerUserId, campaignId: imported.campaignId }, replacementRequest("Rewrite the latest turn from the observatory."))
    ]);
    const fulfilled = [first, second].filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof commands.enqueueReplacement>>> => item.status === "fulfilled");
    const rejected = [first, second].filter((item): item is PromiseRejectedResult => item.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.value).toMatchObject({ status: "replacement_queued", operationKind: "replace_latest", duplicate: false });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(GenerationApplicationError);
    expect(rejected[0]?.reason).toMatchObject({ kind: "active_job", details: { reason: "active_generation" } });
    expect((rejected[0]?.reason as Error).message).not.toContain("25P02");

    const replay = await commands.enqueueReplacement(
      { ownerUserId, campaignId: imported.campaignId },
      replacementRequest("Rewrite the latest turn from the archive.", firstKey)
    );
    expect(replay).toMatchObject({ id: fulfilled[0]?.value.id, duplicate: true, operationKind: "replace_latest" });
    const active = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM generation_jobs
        WHERE campaign_id = $1 AND owner_user_id = $2
          AND status IN ('queued','replacement_queued','assessing','generating','validating','committing','recoverable')`,
      [imported.campaignId, ownerUserId]
    );
    expect(active.rows[0]?.count).toBe("1");
  });
});
