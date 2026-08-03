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

  function recordingRepository() {
    const statements: string[] = [];
    const recordQuery = (target: { query: (...argumentsList: unknown[]) => unknown }) => async (...argumentsList: unknown[]) => {
      const statement = argumentsList[0];
      if (typeof statement === "string") statements.push(statement);
      else if (statement && typeof statement === "object" && "text" in statement && typeof statement.text === "string") {
        statements.push(statement.text);
      }
      return target.query(...argumentsList);
    };
    const instrumentedPool = new Proxy(pool, {
      get(target, property, receiver) {
        if (property === "query") return recordQuery(target as unknown as { query: (...argumentsList: unknown[]) => unknown });
        if (property === "connect") return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(clientTarget, clientProperty, clientReceiver) {
              if (clientProperty === "query") return recordQuery(clientTarget as unknown as { query: (...argumentsList: unknown[]) => unknown });
              const value = Reflect.get(clientTarget, clientProperty, clientReceiver);
              return typeof value === "function" ? value.bind(clientTarget) : value;
            }
          });
        };
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as DatabasePool;
    return {
      commands: createPostgresGenerationCommandRepository(instrumentedPool, {
        resolvePromptSnapshot,
        promptProtocolVersion,
        readTurnReportedCosts: (scopeOwnerUserId, turnIds) => turnReportedCosts(pool, scopeOwnerUserId, [...turnIds])
      }),
      statements
    };
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

  async function latestTurnId(campaignId: string): Promise<string> {
    const result = await pool.query<{ id: string }>(
      "SELECT id FROM turns WHERE campaign_id = $1 AND owner_user_id = $2 ORDER BY turn_number DESC LIMIT 1",
      [campaignId, ownerUserId]
    );
    return result.rows[0]!.id;
  }

  async function authoritativeCampaignSnapshot(campaignId: string) {
    const result = await pool.query<{ snapshot: unknown }>(
      `SELECT jsonb_build_object(
         'acceptedTurns', COALESCE((
           SELECT jsonb_agg(to_jsonb(turn_row) ORDER BY turn_row.turn_number)
             FROM turns turn_row
            WHERE turn_row.campaign_id = $1
              AND turn_row.owner_user_id = $2
              AND turn_row.accepted_at IS NOT NULL
         ), '[]'::jsonb),
         'campaignState', COALESCE((
           SELECT to_jsonb(campaign_state_row)
             FROM campaign_state campaign_state_row
            WHERE campaign_state_row.campaign_id = $1
              AND campaign_state_row.owner_user_id = $2
         ), '{}'::jsonb),
         'chronicle', COALESCE((
           SELECT jsonb_agg(to_jsonb(memory_row) ORDER BY memory_row.ordinal, memory_row.id)
             FROM chronicle_memories memory_row
            WHERE memory_row.campaign_id = $1
              AND memory_row.owner_user_id = $2
         ), '[]'::jsonb),
         'completedResultRows', COALESCE((
           SELECT jsonb_agg(to_jsonb(completed_job) ORDER BY completed_job.created_at, completed_job.id)
             FROM generation_jobs completed_job
            WHERE completed_job.campaign_id = $1
              AND completed_job.owner_user_id = $2
              AND completed_job.status = 'completed'
         ), '[]'::jsonb)
       ) AS snapshot`,
      [campaignId, ownerUserId]
    );
    return result.rows[0]!.snapshot;
  }

  async function directGenerationJob(
    campaignId: string,
    status: string,
    options: Readonly<{ resultTurnId?: string | null; expectedTurnNumber?: number }> = {}
  ): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO generation_jobs (
         owner_user_id, campaign_id, provider_profile_id, idempotency_key, expected_turn_number,
         action, status, result_turn_id, completed_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $8::uuid IS NULL THEN NULL ELSE now() END) RETURNING id`,
      [ownerUserId, campaignId, providerProfileId, crypto.randomUUID(), options.expectedTurnNumber ?? 3,
        "Inspect the repository observatory.", status, options.resultTurnId ?? null]
    );
    return result.rows[0]!.id;
  }

  async function directTurnImageJob(campaignId: string, turnId: string, status: "queued" | "generating"): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO image_jobs (
         owner_user_id, campaign_id, turn_id, provider_profile_id, provider_type, requested_model,
         prompt, prompt_hash, target_type, status
       ) VALUES ($1,$2,$3,$4,'openai_compatible','repository-image-model',$5,$6,'turn_illustration',$7) RETURNING id`,
      [ownerUserId, campaignId, turnId, providerProfileId, "A quiet repository observatory.", sha256(`image-${crypto.randomUUID()}`), status]
    );
    return result.rows[0]!.id;
  }

  async function installGenerationInsertBarrier(campaignId: string, idempotencyKey?: string) {
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const trigger = `hold_generation_insert_${suffix}`;
    const classId = Number.parseInt(suffix.slice(0, 7), 16);
    const objectId = Number.parseInt(suffix.slice(7, 14), 16);
    const holder = await pool.connect();
    const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    await holder.query("SELECT pg_advisory_lock($1::integer, $2::integer)", [classId, objectId]);
    await pool.query(`CREATE FUNCTION ${trigger}_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(${classId}, ${objectId});
        RETURN NEW;
      END
    $$`);
    const idempotencyPredicate = idempotencyKey ? ` AND NEW.idempotency_key = '${idempotencyKey.replaceAll("'", "''")}'` : "";
    await pool.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON generation_jobs
      FOR EACH ROW WHEN (NEW.campaign_id = '${campaignId}'::uuid${idempotencyPredicate}) EXECUTE FUNCTION ${trigger}_fn()`);
    return {
      wait: async () => expect.poll(async () => pool.query<{ pid: number }>(
        `SELECT activity.pid FROM pg_stat_activity activity
           WHERE activity.datname = current_database()
             AND activity.wait_event_type = 'Lock'
             AND $1 = ANY(pg_blocking_pids(activity.pid))`,
        [holderPid]
      ).then((result) => result.rows[0]?.pid), { timeout: 5_000 }).toBeTypeOf("number"),
      release: async () => holder.query("SELECT pg_advisory_unlock($1::integer, $2::integer)", [classId, objectId]),
      cleanup: async () => {
        await holder.query("SELECT pg_advisory_unlock($1::integer, $2::integer)", [classId, objectId]).catch(() => undefined);
        holder.release();
        await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON generation_jobs`);
        await pool.query(`DROP FUNCTION IF EXISTS ${trigger}_fn()`);
      }
    };
  }

  async function provisionalIllustrationChildren(campaignId: string, generationJobId: string) {
    const set = await pool.query<{ id: string }>(
      `INSERT INTO turn_illustration_sets (
         owner_user_id, campaign_id, generation_job_id, source_text_hash, segment_word_count,
         images_per_segment, prompt_mode, status
       ) VALUES ($1,$2,$3,$4,500,1,'direct','provisional') RETURNING id`,
      [ownerUserId, campaignId, generationJobId, sha256(`set-${generationJobId}`)]
    );
    const segment = await pool.query<{ id: string }>(
      `INSERT INTO turn_illustration_segments (
         owner_user_id, illustration_set_id, campaign_id, generation_job_id, ordinal,
         start_offset, end_offset, start_word, end_word, source_text, source_text_hash,
         direct_prompt, resolved_prompt, status
       ) VALUES ($1,$2,$3,$4,0,0,26,0,4,$5,$6,$7,$7,'completed') RETURNING id`,
      [ownerUserId, set.rows[0]!.id, campaignId, generationJobId, "A provisional observatory scene.",
        sha256(`segment-${generationJobId}`), "A provisional observatory scene."]
    );
    const image = await pool.query<{ id: string }>(
      `INSERT INTO image_jobs (
         owner_user_id, campaign_id, provider_profile_id, provider_type, requested_model,
         prompt, prompt_hash, target_type, generation_job_id, status
       ) VALUES ($1,$2,$3,'openai_compatible','repository-image-model',$4,$5,
         'streaming_illustration',$6,'generating') RETURNING id`,
      [ownerUserId, campaignId, providerProfileId, "A streaming observatory illustration.",
        sha256(`streaming-image-${generationJobId}`), generationJobId]
    );
    const asset = await pool.query<{ id: string }>(
      `INSERT INTO assets (
         owner_user_id, campaign_id, content_hash, storage_driver, storage_path, mime_type, byte_length
       ) VALUES ($1,$2,$3,'filesystem',$4,'image/png',1) RETURNING id`,
      [ownerUserId, campaignId, sha256(`provisional-asset-${generationJobId}`), `provisional/${generationJobId}.png`]
    );
    await pool.query(
      `INSERT INTO turn_illustration_segment_assets (segment_id, owner_user_id, asset_id, image_job_id, variant_index)
       VALUES ($1,$2,$3,$4,0)`,
      [segment.rows[0]!.id, ownerUserId, asset.rows[0]!.id, image.rows[0]!.id]
    );
    const assetReference = await pool.query<{ id: string }>(
      `INSERT INTO asset_references (owner_user_id, asset_id, campaign_id, turn_id, asset_role)
       VALUES ($1,$2,$3,NULL,'turn_illustration') RETURNING id`,
      [ownerUserId, asset.rows[0]!.id, campaignId]
    );
    const prompt = await pool.query<{ id: string }>(
      `INSERT INTO illustration_prompt_jobs (
         owner_user_id, campaign_id, segment_id, provider_profile_id, status
       ) VALUES ($1,$2,$3,$4,'queued') RETURNING id`,
      [ownerUserId, campaignId, segment.rows[0]!.id, providerProfileId]
    );
    const resolution = await pool.query<{ id: string }>(
      `INSERT INTO illustration_resolution_jobs (
         owner_user_id, campaign_id, segment_id, source_policy, matching_scope,
         confidence_profile, query_context_snapshot, selected_asset_id, status
       ) VALUES ($1,$2,$3,'library_only','campaign','balanced','{}'::jsonb,$4,'queued') RETURNING id`,
      [ownerUserId, campaignId, segment.rows[0]!.id, asset.rows[0]!.id]
    );
    return {
      setId: set.rows[0]!.id,
      segmentId: segment.rows[0]!.id,
      imageId: image.rows[0]!.id,
      assetId: asset.rows[0]!.id,
      assetReferenceId: assetReference.rows[0]!.id,
      promptId: prompt.rows[0]!.id,
      resolutionId: resolution.rows[0]!.id
    };
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
      appendRequest("Open the repository observatory.", idempotencyKey)
    )).resolves.toMatchObject({ id: queued.id, duplicate: true, status: "queued", operationKind: "append" });
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

  it("keeps Auto-classification consumption scoped to the owner and campaign", async () => {
    const imported = await campaign();
    const { commands, statements } = recordingRepository();
    const action = "Open the owner-scoped Auto-classification observatory.";
    const classification = await pool.query<{ id: string }>(
      `INSERT INTO turn_input_classifications (
         owner_user_id, campaign_id, input_hash, classification, resolved_mode, confidence_band,
         provider_profile_id, provider_source, diagnostics
       ) VALUES ($1,$2,$3,'action','action','clear',$4,'story_text','{}'::jsonb) RETURNING id`,
      [ownerUserId, imported.campaignId, sha256(action), providerProfileId]
    );

    await commands.enqueueAppend(
      { ownerUserId, campaignId: imported.campaignId },
      autoRequest(action, classification.rows[0]!.id)
    );

    expect(statements.find((statement) => statement.startsWith("UPDATE turn_input_classifications")))
      .toContain("WHERE id = $1 AND owner_user_id = $2 AND campaign_id = $3");
  });

  it("rejects stale, missing, and actively illustrated latest turns while removing only queued latest-turn images", async () => {
    const commands = repository();
    const stale = await campaign();
    await expect(commands.enqueueReplacement(
      { ownerUserId, campaignId: stale.campaignId },
      generationRetryLatestRequestSchema.parse({
        ...replacementRequest("Rewrite a stale latest turn."),
        expectedCurrentTurnNumber: 1
      })
    )).rejects.toMatchObject({
      kind: "stale_turn",
      details: { reason: "stale_current_turn", expectedTurnNumber: 1, actualTurnNumber: 2 }
    });

    const missing = await campaign();
    await pool.query("DELETE FROM turns WHERE campaign_id = $1 AND owner_user_id = $2", [missing.campaignId, ownerUserId]);
    await expect(commands.enqueueReplacement(
      { ownerUserId, campaignId: missing.campaignId },
      replacementRequest("Rewrite a missing latest turn.")
    )).rejects.toMatchObject({ kind: "not_found", details: { reason: "missing_latest_turn" } });

    const activelyIllustrated = await campaign();
    const activeTurnId = await latestTurnId(activelyIllustrated.campaignId);
    await directTurnImageJob(activelyIllustrated.campaignId, activeTurnId, "generating");
    await expect(commands.enqueueReplacement(
      { ownerUserId, campaignId: activelyIllustrated.campaignId },
      replacementRequest("Rewrite while the illustration is generating.")
    )).rejects.toMatchObject({ kind: "active_job", details: { reason: "active_illustration" } });

    const queuedIllustration = await campaign();
    const queuedTurnId = await latestTurnId(queuedIllustration.campaignId);
    const queuedImageJobId = await directTurnImageJob(queuedIllustration.campaignId, queuedTurnId, "queued");
    await expect(commands.enqueueReplacement(
      { ownerUserId, campaignId: queuedIllustration.campaignId },
      replacementRequest("Rewrite after discarding the queued illustration.")
    )).resolves.toMatchObject({ status: "replacement_queued", duplicate: false });
    await expect(pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM image_jobs WHERE id = $1",
      [queuedImageJobId]
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });

  it("keeps concurrent append requests to one campaign to one active durable job", async () => {
    const imported = await campaign();
    const commands = repository();
    const results = await Promise.allSettled([
      commands.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, appendRequest("Open the concurrent append archive.")),
      commands.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, appendRequest("Open the concurrent append observatory."))
    ]);
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof commands.enqueueAppend>>> => result.status === "fulfilled"
    );
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.value).toMatchObject({ status: "queued", duplicate: false, operationKind: "append" });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ kind: "active_job", details: { reason: "active_generation" } });
  });

  it("formats completed results and reports their single-currency turn cost", async () => {
    const imported = await campaign();
    const turnId = await latestTurnId(imported.campaignId);
    await pool.query(
      "UPDATE turns SET narration = $3, accepted_at = COALESCE(accepted_at, now()) WHERE id = $1 AND owner_user_id = $2",
      [turnId, ownerUserId, "The observatory door opens.\n\nStars spill across the archive floor."]
    );
    const jobId = await directGenerationJob(imported.campaignId, "completed", { resultTurnId: turnId, expectedTurnNumber: 2 });
    await pool.query(
      `INSERT INTO provider_cost_events (
         owner_user_id, campaign_id, turn_id, provider_profile_id, generation_job_id, provider_type,
         category, operation, requested_model, resolved_model, amount, currency
       ) VALUES ($1,$2,$3,$4,$5,'openai_compatible','story','story_generation',
         'repository-test-model','repository-test-model',0.25,'USD')`,
      [ownerUserId, imported.campaignId, turnId, providerProfileId, jobId]
    );

    await expect(repository().getResult({ ownerUserId, jobId })).resolves.toMatchObject({
      id: jobId,
      status: "completed",
      narration: "The observatory door opens.\n\nStars spill across the archive floor.",
      reportedCost: {
        amount: "0.250000000000",
        currency: "USD",
        byCategory: { story: "0.250000000000", image: "0", memory: "0" }
      }
    });
  });

  it("retries recoverable jobs and discards failed jobs without changing their campaign scope", async () => {
    const retryCampaign = await campaign();
    const retryJobId = await directGenerationJob(retryCampaign.campaignId, "recoverable");
    const retryCompletedJobId = await directGenerationJob(retryCampaign.campaignId, "completed", {
      resultTurnId: await latestTurnId(retryCampaign.campaignId),
      expectedTurnNumber: 2
    });
    const retryCommands = repository();
    const retryBefore = await authoritativeCampaignSnapshot(retryCampaign.campaignId);
    const retryResultBefore = await retryCommands.getResult({ ownerUserId, jobId: retryCompletedJobId });
    await expect(retryCommands.retry({ ownerUserId, jobId: retryJobId })).resolves.toMatchObject({
      id: retryJobId,
      status: "queued",
      operationKind: "append",
      replacementTurnId: null
    });
    await expect(authoritativeCampaignSnapshot(retryCampaign.campaignId)).resolves.toEqual(retryBefore);
    await expect(retryCommands.getResult({ ownerUserId, jobId: retryCompletedJobId })).resolves.toEqual(retryResultBefore);

    const discardCampaign = await campaign();
    const discardJobId = await directGenerationJob(discardCampaign.campaignId, "failed");
    const discardCompletedJobId = await directGenerationJob(discardCampaign.campaignId, "completed", {
      resultTurnId: await latestTurnId(discardCampaign.campaignId),
      expectedTurnNumber: 2
    });
    const discardCommands = repository();
    const discardBefore = await authoritativeCampaignSnapshot(discardCampaign.campaignId);
    const discardResultBefore = await discardCommands.getResult({ ownerUserId, jobId: discardCompletedJobId });
    await expect(discardCommands.discard({ ownerUserId, jobId: discardJobId })).resolves.toMatchObject({
      id: discardJobId,
      status: "discarded",
      operationKind: "append",
      replacementTurnId: null
    });
    await expect(pool.query<{ status: string; campaign_id: string }>(
      "SELECT status, campaign_id FROM generation_jobs WHERE id = $1",
      [discardJobId]
    )).resolves.toMatchObject({ rows: [{ status: "discarded", campaign_id: discardCampaign.campaignId }] });
    await expect(authoritativeCampaignSnapshot(discardCampaign.campaignId)).resolves.toEqual(discardBefore);
    await expect(discardCommands.getResult({ ownerUserId, jobId: discardCompletedJobId })).resolves.toEqual(discardResultBefore);
  });

  it("leaves completed result data and authoritative campaign records intact on invalid mutations", async () => {
    const imported = await campaign();
    const turnId = await latestTurnId(imported.campaignId);
    const completedJobId = await directGenerationJob(imported.campaignId, "completed", { resultTurnId: turnId, expectedTurnNumber: 2 });
    const commands = repository();
    const before = await authoritativeCampaignSnapshot(imported.campaignId);
    const resultBefore = await commands.getResult({ ownerUserId, jobId: completedJobId });

    await expect(commands.retry({ ownerUserId, jobId: completedJobId }))
      .rejects.toMatchObject({ kind: "invalid_state", details: { reason: "retry_source_state" } });
    await expect(commands.cancel({ ownerUserId, jobId: completedJobId }))
      .rejects.toMatchObject({ kind: "invalid_state", details: { reason: "cancel_source_state" } });
    await expect(commands.discard({ ownerUserId, jobId: completedJobId }))
      .rejects.toMatchObject({ kind: "invalid_state", details: { reason: "discard_source_state" } });

    await expect(commands.getResult({ ownerUserId, jobId: completedJobId })).resolves.toEqual(resultBefore);
    await expect(authoritativeCampaignSnapshot(imported.campaignId)).resolves.toEqual(before);
  });

  it("uses exactly the required transaction boundaries for each command", async () => {
    const { commands, statements } = recordingRepository();
    const readCampaign = await campaign();
    const completedTurnId = await latestTurnId(readCampaign.campaignId);
    const completedJobId = await directGenerationJob(readCampaign.campaignId, "completed", { resultTurnId: completedTurnId, expectedTurnNumber: 2 });

    statements.length = 0;
    await commands.getJob({ ownerUserId, jobId: completedJobId });
    await commands.getResult({ ownerUserId, jobId: completedJobId });
    expect(statements.filter((statement) => /^(BEGIN|COMMIT|ROLLBACK)/.test(statement))).toEqual([]);

    const appendCampaign = await campaign();
    statements.length = 0;
    const queued = await commands.enqueueAppend(
      { ownerUserId, campaignId: appendCampaign.campaignId },
      appendRequest("Open the transaction-instrumented append observatory.")
    );
    expect(statements.filter((statement) => statement === "BEGIN")).toHaveLength(1);
    expect(statements.filter((statement) => statement === "COMMIT")).toHaveLength(1);
    expect(statements.filter((statement) => statement === "ROLLBACK")).toHaveLength(0);
    expect(statements.filter((statement) => statement === "SAVEPOINT enqueue_generation_insert")).toHaveLength(1);

    statements.length = 0;
    await commands.cancel({ ownerUserId, jobId: queued.id });
    expect(statements.filter((statement) => statement === "BEGIN")).toHaveLength(1);
    expect(statements.filter((statement) => statement === "COMMIT")).toHaveLength(1);
    expect(statements.filter((statement) => statement === "ROLLBACK")).toHaveLength(0);

    const retryCampaign = await campaign();
    const retryJobId = await directGenerationJob(retryCampaign.campaignId, "recoverable");
    statements.length = 0;
    await commands.retry({ ownerUserId, jobId: retryJobId });
    expect(statements).toHaveLength(1);
    expect(statements.filter((statement) => /^(BEGIN|COMMIT|ROLLBACK)/.test(statement))).toEqual([]);
    expect(statements.filter((statement) => statement.startsWith("WITH source AS"))).toHaveLength(1);

    const discardCampaign = await campaign();
    const discardJobId = await directGenerationJob(discardCampaign.campaignId, "failed");
    statements.length = 0;
    await commands.discard({ ownerUserId, jobId: discardJobId });
    expect(statements).toHaveLength(1);
    expect(statements.filter((statement) => /^(BEGIN|COMMIT|ROLLBACK)/.test(statement))).toEqual([]);
    expect(statements.filter((statement) => statement.startsWith("WITH source AS"))).toHaveLength(1);

    const replacementCampaign = await campaign();
    statements.length = 0;
    await commands.enqueueReplacement(
      { ownerUserId, campaignId: replacementCampaign.campaignId },
      replacementRequest("Open the transaction-instrumented replacement observatory.")
    );
    expect(statements.filter((statement) => statement === "BEGIN")).toHaveLength(1);
    expect(statements.filter((statement) => statement === "COMMIT")).toHaveLength(1);
    expect(statements.filter((statement) => statement === "ROLLBACK")).toHaveLength(0);
    expect(statements.filter((statement) => statement === "SAVEPOINT enqueue_replacement_insert")).toHaveLength(1);
  });

  it.each(["queued", "replacement_queued", "assessing", "generating", "validating", "committing"])(
    "cancels a %s generation job and only that same-owner campaign job",
    async (status) => {
      const targetCampaign = await campaign();
      const otherCampaign = await campaign();
      const targetJobId = await directGenerationJob(targetCampaign.campaignId, status);
      const otherJobId = await directGenerationJob(otherCampaign.campaignId, "queued");
      const completedJobId = await directGenerationJob(targetCampaign.campaignId, "completed", {
        resultTurnId: await latestTurnId(targetCampaign.campaignId),
        expectedTurnNumber: 2
      });
      const commands = repository();
      const targetBefore = await authoritativeCampaignSnapshot(targetCampaign.campaignId);
      const resultBefore = await commands.getResult({ ownerUserId, jobId: completedJobId });

      await expect(commands.cancel({ ownerUserId, jobId: targetJobId })).resolves.toMatchObject({
        id: targetJobId,
        status: "cancelled",
        operationKind: "append",
        replacementTurnId: null
      });
      await expect(pool.query<{ id: string; status: string }>(
        "SELECT id, status FROM generation_jobs WHERE id = ANY($1::uuid[]) ORDER BY id",
        [[targetJobId, otherJobId]]
      )).resolves.toMatchObject({ rows: expect.arrayContaining([
        { id: targetJobId, status: "cancelled" },
        { id: otherJobId, status: "queued" }
      ]) });
      await expect(authoritativeCampaignSnapshot(targetCampaign.campaignId)).resolves.toEqual(targetBefore);
      await expect(commands.getResult({ ownerUserId, jobId: completedJobId })).resolves.toEqual(resultBefore);
    }
  );

  it("cancels provisional illustration children while leaving another campaign's children intact", async () => {
    const targetCampaign = await campaign();
    const otherCampaign = await campaign();
    const targetJobId = await directGenerationJob(targetCampaign.campaignId, "generating");
    const otherJobId = await directGenerationJob(otherCampaign.campaignId, "generating");
    const targetChildren = await provisionalIllustrationChildren(targetCampaign.campaignId, targetJobId);
    const otherChildren = await provisionalIllustrationChildren(otherCampaign.campaignId, otherJobId);
    const targetBefore = await authoritativeCampaignSnapshot(targetCampaign.campaignId);
    const otherBefore = await authoritativeCampaignSnapshot(otherCampaign.campaignId);

    await repository().cancel({ ownerUserId, jobId: targetJobId });

    await expect(pool.query<{ status: string }>("SELECT status FROM image_jobs WHERE id = $1", [targetChildren.imageId]))
      .resolves.toMatchObject({ rows: [{ status: "cancelled" }] });
    await expect(pool.query<{ status: string }>("SELECT status FROM turn_illustration_sets WHERE id = $1", [targetChildren.setId]))
      .resolves.toMatchObject({ rows: [{ status: "orphaned" }] });
    await expect(pool.query<{ status: string }>("SELECT status FROM turn_illustration_segments WHERE id = $1", [targetChildren.segmentId]))
      .resolves.toMatchObject({ rows: [{ status: "failed" }] });
    await expect(pool.query<{ status: string }>("SELECT status FROM illustration_prompt_jobs WHERE id = $1", [targetChildren.promptId]))
      .resolves.toMatchObject({ rows: [{ status: "cancelled" }] });
    await expect(pool.query<{ status: string }>("SELECT status FROM illustration_resolution_jobs WHERE id = $1", [targetChildren.resolutionId]))
      .resolves.toMatchObject({ rows: [{ status: "cancelled" }] });
    await expect(pool.query("SELECT segment_id FROM turn_illustration_segment_assets WHERE segment_id = $1", [targetChildren.segmentId]))
      .resolves.toMatchObject({ rows: [] });
    await expect(pool.query("SELECT id FROM asset_references WHERE id = $1", [targetChildren.assetReferenceId]))
      .resolves.toMatchObject({ rows: [] });
    await expect(pool.query<{ status: string }>("SELECT status FROM image_jobs WHERE id = $1", [otherChildren.imageId]))
      .resolves.toMatchObject({ rows: [{ status: "generating" }] });
    await expect(pool.query<{ status: string }>("SELECT status FROM turn_illustration_sets WHERE id = $1", [otherChildren.setId]))
      .resolves.toMatchObject({ rows: [{ status: "provisional" }] });
    await expect(pool.query<{ status: string }>("SELECT status FROM turn_illustration_segments WHERE id = $1", [otherChildren.segmentId]))
      .resolves.toMatchObject({ rows: [{ status: "completed" }] });
    await expect(pool.query<{ status: string }>("SELECT status FROM illustration_prompt_jobs WHERE id = $1", [otherChildren.promptId]))
      .resolves.toMatchObject({ rows: [{ status: "queued" }] });
    await expect(pool.query<{ status: string }>("SELECT status FROM illustration_resolution_jobs WHERE id = $1", [otherChildren.resolutionId]))
      .resolves.toMatchObject({ rows: [{ status: "queued" }] });
    await expect(pool.query<{ id: string }>("SELECT id FROM assets WHERE id = $1 AND campaign_id = $2 AND owner_user_id = $3", [
      otherChildren.assetId,
      otherCampaign.campaignId,
      ownerUserId
    ])).resolves.toMatchObject({ rows: [{ id: otherChildren.assetId }] });
    await expect(pool.query<{ asset_id: string }>("SELECT asset_id FROM turn_illustration_segment_assets WHERE segment_id = $1", [otherChildren.segmentId]))
      .resolves.toMatchObject({ rows: [{ asset_id: otherChildren.assetId }] });
    await expect(pool.query<{ id: string }>("SELECT id FROM asset_references WHERE id = $1", [otherChildren.assetReferenceId]))
      .resolves.toMatchObject({ rows: [{ id: otherChildren.assetReferenceId }] });
    await expect(authoritativeCampaignSnapshot(targetCampaign.campaignId)).resolves.toEqual(targetBefore);
    await expect(authoritativeCampaignSnapshot(otherCampaign.campaignId)).resolves.toEqual(otherBefore);
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
    const requests = [
      replacementRequest("Rewrite the latest turn from the archive."),
      replacementRequest("Rewrite the latest turn from the observatory.")
    ];
    const results = await Promise.allSettled(requests.map((request) =>
      commands.enqueueReplacement({ ownerUserId, campaignId: imported.campaignId }, request)
    ));
    const fulfilled = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof commands.enqueueReplacement>>> => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.value).toMatchObject({ status: "replacement_queued", operationKind: "replace_latest", duplicate: false });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(GenerationApplicationError);
    expect(rejected[0]?.reason).toMatchObject({ kind: "active_job", details: { reason: "active_generation" } });
    expect((rejected[0]?.reason as Error).message).not.toContain("25P02");

    const winnerIndex = results.findIndex((result) => result.status === "fulfilled");
    const replay = await commands.enqueueReplacement(
      { ownerUserId, campaignId: imported.campaignId },
      requests[winnerIndex]!
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

  it("replays a same-key concurrent replacement deterministically after the unique conflict", async () => {
    const imported = await campaign();
    const commands = repository();
    const key = crypto.randomUUID();
    const request = replacementRequest("Rewrite the latest turn from the same-key archive.", key);
    const results = await Promise.allSettled([
      commands.enqueueReplacement({ ownerUserId, campaignId: imported.campaignId }, request),
      commands.enqueueReplacement({ ownerUserId, campaignId: imported.campaignId }, request)
    ]);
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof commands.enqueueReplacement>>> => result.status === "fulfilled"
    );

    expect(fulfilled).toHaveLength(2);
    expect(new Set(fulfilled.map((result) => result.value.id)).size).toBe(1);
    expect(fulfilled.map((result) => result.value.duplicate).sort()).toEqual([false, true]);
    expect(fulfilled.map((result) => result.value)).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "replacement_queued", operationKind: "replace_latest" })
    ]));
  });

  it("rejects a replacement idempotency-key reuse with a different fingerprint", async () => {
    const imported = await campaign();
    const commands = repository();
    const idempotencyKey = crypto.randomUUID();
    await commands.enqueueReplacement(
      { ownerUserId, campaignId: imported.campaignId },
      replacementRequest("Rewrite the observatory ledger.", idempotencyKey)
    );

    await expect(commands.enqueueReplacement(
      { ownerUserId, campaignId: imported.campaignId },
      replacementRequest("Rewrite the observatory ledger with a different intent.", idempotencyKey)
    )).rejects.toMatchObject({ kind: "conflict", details: { reason: "idempotency_mismatch" } });
  });

  it("rolls back a losing replacement's pre-insert cleanup and classification consumption", async () => {
    const imported = await campaign();
    const { commands, statements } = recordingRepository();
    const latestTurn = await latestTurnId(imported.campaignId);
    const queuedImageJobId = await directTurnImageJob(imported.campaignId, latestTurn, "queued");
    const competingJobId = await directGenerationJob(imported.campaignId, "failed");
    const losingAction = "Rewrite the turn with the losing Auto-classification request.";
    const losingIdempotencyKey = crypto.randomUUID();
    const classification = await pool.query<{ id: string }>(
      `INSERT INTO turn_input_classifications (
         owner_user_id, campaign_id, input_hash, classification, resolved_mode, confidence_band,
         provider_profile_id, provider_source, diagnostics
       ) VALUES ($1,$2,$3,'action','action','clear',$4,'story_text','{}'::jsonb) RETURNING id`,
      [ownerUserId, imported.campaignId, sha256(losingAction), providerProfileId]
    );
    const barrier = await installGenerationInsertBarrier(imported.campaignId, losingIdempotencyKey);
    const loser = commands.enqueueReplacement(
      { ownerUserId, campaignId: imported.campaignId },
      generationRetryLatestRequestSchema.parse({
        ...replacementRequest(losingAction, losingIdempotencyKey),
        requestedInputMode: "auto",
        resolvedInputMode: "action",
        inputModeSource: "auto",
        classificationId: classification.rows[0]!.id
      })
    );
    try {
      await barrier.wait();
      const queuedImageDuringLosingTransaction = await pool.query<{ id: string; status: string }>(
        "SELECT id, status FROM image_jobs WHERE id = $1",
        [queuedImageJobId]
      );
      expect(queuedImageDuringLosingTransaction.rows).toEqual([{ id: queuedImageJobId, status: "queued" }]);
      await expect(pool.query<{ id: string; status: string }>(
        "UPDATE generation_jobs SET status = 'queued' WHERE id = $1 AND status = 'failed' RETURNING id, status",
        [competingJobId]
      )).resolves.toMatchObject({ rows: [{ id: competingJobId, status: "queued" }] });
      await barrier.release();
      await expect(loser).rejects.toMatchObject({ kind: "active_job", details: { reason: "active_generation" } });
    } finally {
      await barrier.cleanup();
    }

    await expect(pool.query<{ consumed_at: string | null }>(
      "SELECT consumed_at FROM turn_input_classifications WHERE id = $1",
      [classification.rows[0]!.id]
    )).resolves.toMatchObject({ rows: [{ consumed_at: null }] });
    await expect(pool.query<{ id: string; status: string }>(
      "SELECT id, status FROM image_jobs WHERE id = $1",
      [queuedImageJobId]
    )).resolves.toMatchObject({ rows: [{ id: queuedImageJobId, status: "queued" }] });
    await expect(pool.query<{ id: string; status: string }>(
      "SELECT id, status FROM generation_jobs WHERE id = $1",
      [competingJobId]
    )).resolves.toMatchObject({ rows: [{ id: competingJobId, status: "queued" }] });

    const queuedImageDelete = statements.findIndex((statement) => statement.startsWith("DELETE FROM image_jobs"));
    const savepoint = statements.indexOf("SAVEPOINT enqueue_replacement_insert");
    const rollbackToSavepoint = statements.indexOf("ROLLBACK TO SAVEPOINT enqueue_replacement_insert");
    const releaseSavepoint = statements.indexOf("RELEASE SAVEPOINT enqueue_replacement_insert");
    const outerRollback = statements.indexOf("ROLLBACK");
    const replayLookup = statements.findIndex((statement, index) => index > outerRollback
      && statement.includes("FROM generation_jobs")
      && statement.includes("idempotency_key = $2"));
    const activeLookup = statements.findIndex((statement, index) => index > replayLookup
      && statement.includes("FROM generation_jobs WHERE campaign_id = $1 AND owner_user_id = $2"));
    expect(queuedImageDelete).toBeGreaterThan(-1);
    expect(queuedImageDelete).toBeLessThan(savepoint);
    expect(savepoint).toBeLessThan(rollbackToSavepoint);
    expect(rollbackToSavepoint).toBeLessThan(releaseSavepoint);
    expect(releaseSavepoint).toBeLessThan(outerRollback);
    expect(outerRollback).toBeLessThan(replayLookup);
    expect(replayLookup).toBeLessThan(activeLookup);
  });
});
