import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generationRequestSchema, illustrationConfigSchema, illustrationSegmentRequestSchema, worldCoverRequestSchema } from "../../packages/contracts/src/generation.js";
import { assetListQuerySchema } from "../../packages/contracts/src/assets.js";
import { worldContentSchema, worldCreateSchema } from "../../packages/contracts/src/world-library.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, withTransaction, type DatabasePool } from "../../packages/database/src/pool.js";
import { runGenerationJob } from "../helpers/generation-worker-harness.js";
import { createApiGenerationApplication } from "../../services/runtime/src/generation-api-composition.js";
import { createWorkerIllustrationApplication } from "../../services/runtime/src/illustration-composition.js";
import { enqueueAcceptedTurnIllustration, enqueueIllustration, enqueueWorldCover, getIllustrationConfig, getImageJob, getLatestWorldCoverJob, listCampaignImageJobs, retryImageJob, runImageJob, setIllustrationConfig } from "../../services/runtime/src/illustration-image-job-adapter.js";
import { importLegacyStory } from "../../services/api/src/import-service.js";
import { createProvider } from "../../services/api/src/provider-service.js";
import { listAssets, persistOriginalImage, queryAssets, readAssetDerivative, runAssetMetadataBackfill, selectTurnIllustration, selectWorldCover, updateAssetMetadata } from "../../services/api/src/asset-service.js";
import { getTurnIllustrationResolution, runIllustrationResolutionJob } from "../../services/runtime/src/illustration-resolution-job-adapter.js";
import {
  createProvisionalSegment,
  createProvisionalSet,
  generateTurnIllustrationSegments,
  listCampaignIllustrationSegments,
  loadConfig,
  previewIllustrationBackfill,
  runIllustrationPromptJob
} from "../../services/runtime/src/illustration-segment-job-adapter.js";
import { getCampaignCostSummary } from "../../services/api/src/cost-service.js";
import { createWorld, getWorld } from "../../services/api/src/world-service.js";
import { installIntegrationProviderTransport } from "./provider-transport-test-helper.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const credentialSecret = "synthetic-image-integration-secret";
const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function generationCommands(pool: DatabasePool) {
  const ownerUserId = await initialOwnerId(pool);
  const application = createApiGenerationApplication(pool);
  return {
    enqueueGeneration: (campaignId: string, request: Parameters<typeof application.enqueueAppend>[1]) =>
      application.enqueueAppend({ ownerUserId, campaignId }, request),
    getGenerationJob: (jobId: string) => application.getJob({ ownerUserId, jobId }),
    cancelGeneration: (jobId: string) => application.cancel({ ownerUserId, jobId })
  };
}

async function enqueueGeneration(pool: DatabasePool, campaignId: string, request: Parameters<Awaited<ReturnType<typeof generationCommands>>["enqueueGeneration"]>[1]) {
  return (await generationCommands(pool)).enqueueGeneration(campaignId, request);
}

async function getGenerationJob(pool: DatabasePool, jobId: string) {
  return (await generationCommands(pool)).getGenerationJob(jobId);
}

async function cancelGeneration(pool: DatabasePool, jobId: string) {
  return (await generationCommands(pool)).cancelGeneration(jobId);
}

function storyOutput() {
  return JSON.stringify({
    narration: [
      "Synthetic Location Image opens beneath a quiet violet sky.",
      "Beyond the luminous stone arch, silver grass bends around a path of blue glass while small lanterns glow beside weathered statues.",
      "The party crosses slowly, watching pale clouds gather above distant towers and listening as water moves through hidden channels under the road.",
      "At the valley floor, an empty pavilion reflects the stars in polished walls, and a line of white trees marks the way toward a silent observatory."
    ].join(" "),
    choices: ["Enter the arch.", "Study the sky.", "Wait nearby.", "Call the guide."],
    custom_action_suggestion: "Inspect the luminous boundary.",
    scratchpad: "Synthetic fiction continuity only.",
    tracker_updates: [],
    image_prompt: "A quiet violet sky above a luminous stone arch in an empty valley.",
    continuity_summary: "A luminous stone arch stands open beneath the violet sky.",
    canonical_facts: ["The luminous stone arch is open."],
    superseded_facts: [],
    open_threads: ["Explore beyond the luminous arch."]
  });
}

integration("independent illustration pipeline", () => {
  let pool: DatabasePool;
  let server: Server;
  let providerTransport: ReturnType<typeof installIntegrationProviderTransport>;
  let baseUrl = "";
  let textProviderId = "";
  let imageProviderId = "";
  let assetRoot = "";
  let failImages = false;
  let imageResponseBarrier: { signalStarted: () => void; release: Promise<void> } | null = null;
  const imageRequests: Array<Record<string, unknown>> = [];
  const refinementRequests: Array<Record<string, unknown>> = [];
  const sogniRequests: Array<{ body: Record<string, unknown>; idempotencyKey: string }> = [];
  const storyRequests: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 5);
    await migrateDatabase(pool, resolve("database/migrations"));
    providerTransport = installIntegrationProviderTransport();
    assetRoot = await mkdtemp(join(tmpdir(), "infinitequest-image-test-"));
    server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        if (request.method === "POST" && request.url === "/v1/creative-agent/workflows") {
          sogniRequests.push({ body: parsed, idempotencyKey: String(request.headers["idempotency-key"] || "") });
          response.writeHead(201, { "content-type": "application/json" });
          response.end(JSON.stringify({ status: "success", data: { workflow: { workflowId: "wf_integration-1", status: "queued" } } }));
          return;
        }
        if (request.method === "GET" && request.url === "/v1/creative-agent/workflows/wf_integration-1") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ status: "success", data: { workflow: {
            workflowId: "wf_integration-1",
            status: "completed",
            steps: [{ status: "completed", artifacts: [{ url: `${baseUrl}/sogni-artifact.png`, mimeType: "image/png" }] }],
            usage: { images: 1 }
          } } }));
          return;
        }
        if (request.method === "GET" && request.url === "/sogni-artifact.png") {
          response.writeHead(200, { "content-type": "image/png", "content-length": Buffer.byteLength(tinyPng, "base64") });
          response.end(Buffer.from(tinyPng, "base64"));
          return;
        }
        if (request.url?.endsWith("/images/generations")) {
          imageRequests.push(parsed);
          if (parsed.model === "synthetic-text-only-model") {
            response.writeHead(422, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: { message: "The selected model cannot generate images." } }));
            return;
          }
          if (failImages) {
            response.writeHead(503, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: { message: "Synthetic image endpoint unavailable." } }));
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          const body = JSON.stringify({ id: crypto.randomUUID(), data: [{ b64_json: tinyPng }], usage: { cost: 0.04 } });
          if (imageResponseBarrier) {
            imageResponseBarrier.signalStarted();
            void imageResponseBarrier.release.then(() => response.end(body));
          } else response.end(body);
          return;
        }
        if (JSON.stringify(parsed).includes("expert visual translator and prompt engineer")) {
          refinementRequests.push(parsed);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({
            id: crypto.randomUUID(),
            model: "synthetic-text-model",
            choices: [{
              message: { content: "Mira, raising a lantern, fogbound road, eerie moonlight, cinematic fantasy illustration" },
              finish_reason: "stop"
            }],
            usage: { prompt_tokens: 300, completion_tokens: 40, total_tokens: 340 }
          }));
          return;
        }
        storyRequests.push(parsed);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: crypto.randomUUID(),
          model: "synthetic-text-model",
          choices: [{ message: { content: storyOutput() }, finish_reason: "stop" }],
          usage: { prompt_tokens: 500, completion_tokens: 150, total_tokens: 650 }
        }));
      });
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Synthetic provider did not expose a TCP address.");
    baseUrl = `http://127.0.0.1:${address.port}`;
    textProviderId = (await createProvider(pool, {
      name: `Synthetic text ${crypto.randomUUID()}`,
      providerType: "openai_compatible",
      providerRole: "text",
      baseUrl,
      defaultModel: "synthetic-text-model",
      contextWindowTokens: 32768,
      maxOutputTokens: 4096,
      temperature: 0,
      enabled: true,
      isDefault: true,
      configuration: {}
    }, credentialSecret)).id;
    imageProviderId = (await createProvider(pool, {
      name: `Synthetic image ${crypto.randomUUID()}`,
      providerType: "openai_compatible",
      providerRole: "image",
      baseUrl,
      defaultModel: "synthetic-image-model",
      contextWindowTokens: 32768,
      maxOutputTokens: 4096,
      temperature: 0,
      enabled: true,
      isDefault: true,
      configuration: {}
    }, credentialSecret)).id;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    if (providerTransport) await providerTransport.close();
    await pool.end();
    await rm(assetRoot, { recursive: true, force: true });
  });

  async function campaign(maxAttempts = 3) {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Synthetic illustrated campaign ${crypto.randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "synthetic-image.story", story: fixture }));
    await setIllustrationConfig(pool, imported.campaignId, illustrationConfigSchema.parse({
      enabled: true,
      providerProfileId: imageProviderId,
      model: "synthetic-image-model",
      size: "1024x1024",
      aspectRatio: "1:1",
      quality: "auto",
      outputFormat: "png",
      sourcePolicy: "generate_only",
      maxAttempts,
      segmentWordCount: 100,
      imagesPerSegment: 1,
      segmentPromptMode: "direct"
    }));
    return imported;
  }

  async function generate(campaignId: string) {
    const job = await enqueueGeneration(pool, campaignId, generationRequestSchema.parse({
      action: "Approach Synthetic Location Image.",
      providerProfileId: textProviderId,
      idempotencyKey: crypto.randomUUID(),
      context: { budgetTokens: 16000, compression: "full", recentTurns: 8 }
    }));
    await runGenerationJob(pool, `synthetic-story-${crypto.randomUUID()}`, 30, credentialSecret);
    expect(await getGenerationJob(pool, job.id)).toMatchObject({ status: "completed" });
    return job;
  }

  async function processThroughTerminal(jobId: string, workerPrefix: string) {
    for (let index = 0; index < 20; index += 1) {
      const current = await getImageJob(pool, jobId);
      if (["completed", "recoverable", "failed"].includes(current.status)) return current;
      await runImageJob(pool, `${workerPrefix}-${index}`, 30, credentialSecret, { root: assetRoot });
    }
    return getImageJob(pool, jobId);
  }

  async function acceptedStorySnapshot(campaignId: string, generationJobId: string) {
    const [generation, turns, state, memories, generationJobs] = await Promise.all([
      pool.query(
        "SELECT id, status, result_turn_id FROM generation_jobs WHERE id = $1 AND campaign_id = $2",
        [generationJobId, campaignId]
      ),
      pool.query(
        `SELECT id, turn_number, narration, choices, state_snapshot_private
           FROM turns WHERE campaign_id = $1 ORDER BY turn_number, id`,
        [campaignId]
      ),
      pool.query(
        `SELECT campaigns.active_turn_number, campaign_state.revision,
                campaign_state.scratchpad_private, campaign_state.trackers,
                campaign_state.event_triggers, campaign_state.pending_event_triggers,
                campaign_state.rpg_stats
           FROM campaigns
           JOIN campaign_state ON campaign_state.campaign_id = campaigns.id
          WHERE campaigns.id = $1`,
        [campaignId]
      ),
      pool.query(
        `SELECT id, turn_id, ordinal, memory_kind, content
           FROM chronicle_memories WHERE campaign_id = $1 ORDER BY ordinal, memory_kind, id`,
        [campaignId]
      ),
      pool.query(
        `SELECT id, status, result_turn_id
           FROM generation_jobs WHERE campaign_id = $1 ORDER BY created_at, id`,
        [campaignId]
      )
    ]);
    return {
      generation: generation.rows,
      turns: turns.rows,
      state: state.rows,
      memories: memories.rows,
      generationJobs: generationJobs.rows
    };
  }

  async function illustrationWorkCounts(campaignId: string) {
    return pool.query<{
      image_jobs: number;
      illustration_sets: number;
      illustration_segments: number;
      prompt_jobs: number;
      resolution_jobs: number;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM image_jobs WHERE campaign_id = $1) AS image_jobs,
         (SELECT count(*)::integer FROM turn_illustration_sets WHERE campaign_id = $1) AS illustration_sets,
         (SELECT count(*)::integer FROM turn_illustration_segments WHERE campaign_id = $1) AS illustration_segments,
         (SELECT count(*)::integer FROM illustration_prompt_jobs WHERE campaign_id = $1) AS prompt_jobs,
         (SELECT count(*)::integer FROM illustration_resolution_jobs WHERE campaign_id = $1) AS resolution_jobs`,
      [campaignId]
    ).then((result) => result.rows[0]!);
  }

  async function installInsertBarrier(table: string, predicate: string) {
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const trigger = `hold_${table}_${suffix}`;
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
    await pool.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table}
      FOR EACH ROW WHEN (${predicate}) EXECUTE FUNCTION ${trigger}_fn()`);
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
        await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`);
        await pool.query(`DROP FUNCTION IF EXISTS ${trigger}_fn()`);
      }
    };
  }

  it("does not complete a stale streaming image worker after parent cancellation", async () => {
    const imported = await campaign();
    const generation = await enqueueGeneration(pool, imported.campaignId, generationRequestSchema.parse({
      action: "Cancel the stale streaming worker.", providerProfileId: textProviderId, idempotencyKey: crypto.randomUUID(),
      context: { budgetTokens: 16000, compression: "full", recentTurns: 8 }
    }));
    const ownerUserId = await initialOwnerId(pool);
    const imageJob = await pool.query<{ id: string }>(
      `INSERT INTO image_jobs (
         owner_user_id, campaign_id, provider_profile_id, requested_model, prompt, prompt_hash,
         status, provider_type, target_type, generation_job_id
       ) VALUES ($1,$2,$3,'synthetic-image-model','A stale provisional scene.',
                 'cancel-stale-image','queued','openai_compatible','streaming_illustration',$4) RETURNING id`,
      [ownerUserId, imported.campaignId, imageProviderId, generation.id]
    );
    let releaseProviderResponse!: () => void;
    const providerRequestStarted = new Promise<void>((resolveStarted) => {
      imageResponseBarrier = {
        signalStarted: resolveStarted,
        release: new Promise<void>((resolveRelease) => { releaseProviderResponse = resolveRelease; })
      };
    });
    try {
      const worker = runImageJob(pool, "stale-streaming-image-worker", 30, credentialSecret, { root: assetRoot });
      await providerRequestStarted;
      await expect.poll(async () => getImageJob(pool, imageJob.rows[0]!.id)).toMatchObject({ status: "generating" });
      await expect(cancelGeneration(pool, generation.id)).resolves.toMatchObject({ status: "cancelled" });
      releaseProviderResponse();
      await expect(worker).resolves.toBe(true);
    } finally {
      imageResponseBarrier = null;
      releaseProviderResponse();
    }
    expect(await getImageJob(pool, imageJob.rows[0]!.id)).toMatchObject({ status: "cancelled", assetId: null });
  });

  it("does not create provisional set or segment work after cancellation between streamed output and child delivery", async () => {
    const imported = await campaign();
    const generation = await enqueueGeneration(pool, imported.campaignId, generationRequestSchema.parse({
      action: "Cancel after streamed narration before illustration delivery.",
      providerProfileId: textProviderId,
      idempotencyKey: crypto.randomUUID(),
      context: { budgetTokens: 16000, compression: "full", recentTurns: 8 }
    }));
    const ownerUserId = await initialOwnerId(pool);
    const config = await loadConfig(pool, ownerUserId, imported.campaignId);

    await expect(cancelGeneration(pool, generation.id)).resolves.toMatchObject({ status: "cancelled" });
    await expect(createProvisionalSet(pool, ownerUserId, imported.campaignId, generation.id)).resolves.toBeNull();
    await expect(createProvisionalSegment(
      pool, ownerUserId, imported.campaignId, generation.id, crypto.randomUUID(),
      { ordinal: 0, startOffset: 0, endOffset: 61, startWord: 0, endWord: 11, wordCount: 11, text: "A lantern reveals a silent causeway beneath violet clouds tonight." },
      config
    )).resolves.toBe(false);
    await expect(pool.query(
      "SELECT id FROM turn_illustration_sets WHERE generation_job_id = $1 UNION ALL SELECT id FROM turn_illustration_segments WHERE generation_job_id = $1 UNION ALL SELECT id FROM image_jobs WHERE generation_job_id = $1",
      [generation.id]
    )).resolves.toMatchObject({ rows: [] });
  });

  async function installResolutionFailureBarrier(resolutionJobId: string) {
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const trigger = `hold_resolution_failure_${suffix}`;
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
    await pool.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE OF status ON illustration_resolution_jobs
      FOR EACH ROW WHEN (OLD.id = '${resolutionJobId}'::uuid AND OLD.status = 'matching' AND NEW.status = 'failed')
      EXECUTE FUNCTION ${trigger}_fn()`);
    return {
      wait: async () => {
        let resolutionBackendPid: number | undefined;
        await expect.poll(async () => pool.query<{ pid: number }>(
          `SELECT activity.pid
             FROM pg_stat_activity activity
             JOIN pg_locks advisory_lock ON advisory_lock.pid = activity.pid
             JOIN pg_locks resolution_relation_lock ON resolution_relation_lock.pid = activity.pid
            WHERE activity.datname = current_database()
              AND activity.query LIKE 'UPDATE illustration_resolution_jobs%'
              AND activity.wait_event_type = 'Lock' AND activity.wait_event = 'advisory'
              AND $1 = ANY(pg_blocking_pids(activity.pid))
              AND advisory_lock.locktype = 'advisory' AND NOT advisory_lock.granted
              AND advisory_lock.classid = $2 AND advisory_lock.objid = $3 AND advisory_lock.objsubid = 2
              AND resolution_relation_lock.locktype = 'relation'
              AND resolution_relation_lock.relation = 'illustration_resolution_jobs'::regclass
              AND resolution_relation_lock.mode = 'RowExclusiveLock' AND resolution_relation_lock.granted`,
          [holderPid, classId, objectId]
        ).then((result) => {
          resolutionBackendPid = result.rows[0]?.pid;
          return resolutionBackendPid;
        }), { timeout: 5_000 }).toBeTypeOf("number");
        return resolutionBackendPid!;
      },
      release: async () => holder.query("SELECT pg_advisory_unlock($1::integer, $2::integer)", [classId, objectId]),
      cleanup: async () => {
        await holder.query("SELECT pg_advisory_unlock($1::integer, $2::integer)", [classId, objectId]).catch(() => undefined);
        holder.release();
        await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON illustration_resolution_jobs`);
        await pool.query(`DROP FUNCTION IF EXISTS ${trigger}_fn()`);
      }
    };
  }

  async function waitForCancellationAttempt(jobId: string) {
    await expect.poll(async () => {
      const result = await pool.query<{ cancelled: boolean; waiting: boolean }>(
        `SELECT jobs.status = 'cancelled' AS cancelled,
                EXISTS (
                  SELECT 1 FROM pg_stat_activity activity
                   WHERE activity.datname = current_database()
                     AND activity.query LIKE 'UPDATE generation_jobs%'
                     AND activity.wait_event_type = 'Lock'
                ) AS waiting
           FROM generation_jobs jobs WHERE jobs.id = $1`,
        [jobId]
      );
      return Boolean(result.rows[0]?.cancelled || result.rows[0]?.waiting);
    }, { timeout: 5_000 }).toBe(true);
  }

  async function startCancellationSession(jobId: string) {
    const applicationName = `iq-cancel:${jobId}`;
    const cancellationUrl = new URL(databaseUrl!);
    cancellationUrl.searchParams.set("application_name", applicationName);
    const cancellationPool = createDatabasePool(cancellationUrl.toString(), 1);
    const backendPid = (await cancellationPool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    return {
      applicationName,
      backendPid,
      cancellation: cancelGeneration(cancellationPool, jobId),
      close: async () => cancellationPool.end()
    };
  }

  async function waitForCancellationBlockedByResolution(input: {
    applicationName: string;
    cancellationBackendPid: number;
    resolutionBackendPid: number;
    generationJobId: string;
    resolutionJobId: string;
  }) {
    await expect.poll(async () => pool.query<{ blocked: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_stat_activity cancellation
           JOIN pg_locks generation_relation_lock ON generation_relation_lock.pid = cancellation.pid
           JOIN pg_stat_activity resolution_failure ON resolution_failure.pid = $3
          WHERE cancellation.datname = current_database()
            AND cancellation.pid = $1
            AND cancellation.application_name = $2
            AND cancellation.query LIKE 'UPDATE generation_jobs%'
            AND cancellation.wait_event_type = 'Lock'
            AND $3 = ANY(pg_blocking_pids(cancellation.pid))
            AND generation_relation_lock.locktype = 'relation'
            AND generation_relation_lock.relation = 'generation_jobs'::regclass
            AND generation_relation_lock.mode = 'RowExclusiveLock' AND generation_relation_lock.granted
            AND resolution_failure.datname = current_database()
            AND resolution_failure.query LIKE 'UPDATE illustration_resolution_jobs%'
            AND resolution_failure.wait_event_type = 'Lock' AND resolution_failure.wait_event = 'advisory'
            AND EXISTS (
              SELECT 1
                FROM illustration_resolution_jobs resolution
                JOIN turn_illustration_segments segment ON segment.id = resolution.segment_id
               WHERE resolution.id = $4 AND segment.generation_job_id = $5
            )
       ) AS blocked`,
      [input.cancellationBackendPid, input.applicationName, input.resolutionBackendPid,
        input.resolutionJobId, input.generationJobId]
    ).then((result) => result.rows[0]?.blocked), { timeout: 5_000 }).toBe(true);
  }

  it("atomically fences provisional set, segment, and direct-image creation against cancellation", async () => {
    const imported = await campaign();
    const ownerUserId = await initialOwnerId(pool);
    const config = await loadConfig(pool, ownerUserId, imported.campaignId);

    const setGeneration = await enqueueGeneration(pool, imported.campaignId, generationRequestSchema.parse({
      action: "Race provisional set creation.", providerProfileId: textProviderId, idempotencyKey: crypto.randomUUID(),
      context: { budgetTokens: 16000, compression: "full", recentTurns: 8 }
    }));
    await pool.query("UPDATE generation_jobs SET status = 'generating' WHERE id = $1", [setGeneration.id]);
    const setBarrier = await installInsertBarrier(
      "turn_illustration_sets",
      `NEW.generation_job_id = '${setGeneration.id}'::uuid`
    );
    try {
      const creation = createProvisionalSet(pool, ownerUserId, imported.campaignId, setGeneration.id);
      await setBarrier.wait();
      const cancellation = cancelGeneration(pool, setGeneration.id);
      await waitForCancellationAttempt(setGeneration.id);
      await setBarrier.release();
      await creation;
      await cancellation;
    } finally {
      await setBarrier.cleanup();
    }
    expect(await pool.query(
      "SELECT id FROM turn_illustration_sets WHERE generation_job_id = $1 AND status <> 'orphaned'",
      [setGeneration.id]
    )).toMatchObject({ rows: [] });

    const childGeneration = await enqueueGeneration(pool, imported.campaignId, generationRequestSchema.parse({
      action: "Race provisional direct-image creation.", providerProfileId: textProviderId, idempotencyKey: crypto.randomUUID(),
      context: { budgetTokens: 16000, compression: "full", recentTurns: 8 }
    }));
    await pool.query("UPDATE generation_jobs SET status = 'generating' WHERE id = $1", [childGeneration.id]);
    const setId = await createProvisionalSet(pool, ownerUserId, imported.campaignId, childGeneration.id);
    expect(setId).toBeTruthy();
    const imageBarrier = await installInsertBarrier("image_jobs", `NEW.generation_job_id = '${childGeneration.id}'::uuid`);
    try {
      const creation = createProvisionalSegment(
        pool, ownerUserId, imported.campaignId, childGeneration.id, setId!,
        { ordinal: 0, startOffset: 0, endOffset: 67, startWord: 0, endWord: 12, wordCount: 12,
          text: "A lantern reveals a silent causeway beneath violet clouds tonight." },
        config
      );
      await imageBarrier.wait();
      const cancellation = cancelGeneration(pool, childGeneration.id);
      await waitForCancellationAttempt(childGeneration.id);
      await imageBarrier.release();
      await creation;
      await cancellation;
    } finally {
      await imageBarrier.cleanup();
    }
    expect(await pool.query(
      `SELECT jobs.id FROM image_jobs jobs WHERE jobs.generation_job_id = $1
         AND jobs.status IN ('queued','generating','provider_pending','downloading','completed')`,
      [childGeneration.id]
    )).toMatchObject({ rows: [] });
    expect(await pool.query(
      "SELECT status FROM turn_illustration_sets WHERE generation_job_id = $1", [childGeneration.id]
    )).toMatchObject({ rows: [{ status: "orphaned" }] });
  });

  it("fences claimed library attachment against provisional generation cancellation", async () => {
    const imported = await campaign();
    const ownerUserId = await initialOwnerId(pool);
    const generation = await enqueueGeneration(pool, imported.campaignId, generationRequestSchema.parse({
      action: "Race a claimed library attachment.", providerProfileId: textProviderId, idempotencyKey: crypto.randomUUID(),
      context: { budgetTokens: 16000, compression: "full", recentTurns: 8 }
    }));
    await pool.query("UPDATE generation_jobs SET status = 'generating' WHERE id = $1", [generation.id]);
    const acceptedTurn = await pool.query<{ id: string }>(
      "SELECT id FROM turns WHERE campaign_id = $1 ORDER BY turn_number DESC LIMIT 1", [imported.campaignId]
    );
    const world = await pool.query<{ world_id: string; world_version_id: string }>(
      `SELECT versions.world_id, campaigns.world_version_id FROM campaigns
        JOIN world_versions versions ON versions.id = campaigns.world_version_id
       WHERE campaigns.id = $1`,
      [imported.campaignId]
    );
    const asset = await pool.query<{ id: string }>(
      `INSERT INTO assets (owner_user_id, content_hash, storage_driver, storage_path, mime_type, byte_length)
       VALUES ($1,$2,'filesystem',$3,'image/png',68) RETURNING id`,
      [ownerUserId, crypto.randomUUID().replaceAll("-", "").padEnd(64, "0").slice(0, 64), `race/${crypto.randomUUID()}.png`]
    );
    await pool.query(
      `INSERT INTO asset_references (owner_user_id, asset_id, campaign_id, turn_id, asset_role)
       VALUES ($1,$2,$3,$4,'turn_illustration')`,
      [ownerUserId, asset.rows[0]!.id, imported.campaignId, acceptedTurn.rows[0]!.id]
    );
    await pool.query(
      `UPDATE asset_library_entries SET title = 'violet lantern causeway', tags = ARRAY['violet','lantern','causeway'],
              reuse_scope = 'owner_library', automatic_reuse_enabled = true, review_status = 'eligible'
        WHERE asset_id = $1 AND owner_user_id = $2`,
      [asset.rows[0]!.id, ownerUserId]
    );
    await pool.query(
      `INSERT INTO asset_generation_contexts (
         owner_user_id, asset_id, created_by_user_id, world_id, world_version_id, campaign_id,
         target_type, fiction_prompt
       ) VALUES ($1,$2,$1,$3,$4,$5,'turn_illustration','A violet lantern illuminates the silent causeway')`,
      [ownerUserId, asset.rows[0]!.id, world.rows[0]!.world_id, world.rows[0]!.world_version_id, imported.campaignId]
    );
    const acceptedSet = await pool.query<{ id: string }>(
      `INSERT INTO turn_illustration_sets (
         owner_user_id, campaign_id, turn_id, generation_job_id, source_text_hash, segment_word_count,
         images_per_segment, prompt_mode, status, is_active, completed_at
       ) VALUES ($1,$2,$3,$4,'accepted-library-race-set',500,1,'direct','completed',false,now()) RETURNING id`,
      [ownerUserId, imported.campaignId, acceptedTurn.rows[0]!.id, generation.id]
    );
    const acceptedSegment = await pool.query<{ id: string }>(
      `INSERT INTO turn_illustration_segments (
         owner_user_id, illustration_set_id, campaign_id, turn_id, generation_job_id, ordinal,
         start_offset, end_offset, start_word, end_word, source_text, source_text_hash,
         direct_prompt, resolved_prompt, prompt_source, status
       ) VALUES ($1,$2,$3,$4,$5,999,0,48,0,8,'Accepted violet lantern artwork.','accepted-library-race-segment',
                 'Accepted violet lantern artwork.','Accepted violet lantern artwork.','direct','completed') RETURNING id`,
      [ownerUserId, acceptedSet.rows[0]!.id, imported.campaignId, acceptedTurn.rows[0]!.id, generation.id]
    );
    await pool.query(
      `INSERT INTO turn_illustration_segment_assets (segment_id, owner_user_id, asset_id, variant_index)
       VALUES ($1,$2,$3,0)`,
      [acceptedSegment.rows[0]!.id, ownerUserId, asset.rows[0]!.id]
    );
    const set = await pool.query<{ id: string }>(
      `INSERT INTO turn_illustration_sets (
         owner_user_id, campaign_id, generation_job_id, source_text_hash, segment_word_count,
         images_per_segment, prompt_mode, status
       ) VALUES ($1,$2,$3,'library-race-set',500,1,'direct','provisional') RETURNING id`,
      [ownerUserId, imported.campaignId, generation.id]
    );
    const segment = await pool.query<{ id: string }>(
      `INSERT INTO turn_illustration_segments (
         owner_user_id, illustration_set_id, campaign_id, generation_job_id, ordinal,
         start_offset, end_offset, start_word, end_word, source_text, source_text_hash,
         direct_prompt, resolved_prompt, prompt_source, status
       ) VALUES ($1,$2,$3,$4,0,0,60,0,10,'A violet lantern illuminates the silent causeway.','library-race-segment',
                 'A violet lantern illuminates the silent causeway.','A violet lantern illuminates the silent causeway.','direct','generating') RETURNING id`,
      [ownerUserId, set.rows[0]!.id, imported.campaignId, generation.id]
    );
    await pool.query(
      `INSERT INTO illustration_resolution_jobs (
         owner_user_id, campaign_id, turn_id, segment_id, source_policy, matching_scope,
         confidence_profile, repetition_window, query_context_snapshot
       ) VALUES ($1,$2,NULL,$3,'library_only','owner_library','broad',0,$4)`,
      [ownerUserId, imported.campaignId, segment.rows[0]!.id,
        JSON.stringify({ imagePrompt: "A violet lantern illuminates the silent causeway." })]
    );
    const barrier = await installInsertBarrier(
      "turn_illustration_segment_assets",
      `NEW.segment_id = '${segment.rows[0]!.id}'::uuid`
    );
    try {
      const resolution = runIllustrationResolutionJob(pool, `library-race-${crypto.randomUUID()}`, 30);
      await barrier.wait();
      const cancellation = cancelGeneration(pool, generation.id);
      await waitForCancellationAttempt(generation.id);
      await barrier.release();
      await resolution;
      await cancellation;
    } finally {
      await barrier.cleanup();
    }
    expect(await pool.query("SELECT asset_id FROM turn_illustration_segment_assets WHERE segment_id = $1", [segment.rows[0]!.id]))
      .toMatchObject({ rows: [] });
    expect(await pool.query(
      "SELECT id FROM asset_references WHERE asset_id = $1 AND campaign_id = $2 AND turn_id IS NULL",
      [asset.rows[0]!.id, imported.campaignId]
    )).toMatchObject({ rows: [] });
    expect(await pool.query("SELECT status FROM turn_illustration_sets WHERE id = $1", [set.rows[0]!.id]))
      .toMatchObject({ rows: [{ status: "orphaned" }] });
    expect(await pool.query("SELECT status FROM turn_illustration_segments WHERE id = $1", [segment.rows[0]!.id]))
      .toMatchObject({ rows: [{ status: "failed" }] });
    expect(await pool.query(
      "SELECT id FROM asset_references WHERE asset_id = $1 AND turn_id = $2",
      [asset.rows[0]!.id, acceptedTurn.rows[0]!.id]
    )).toMatchObject({ rowCount: 1 });
    expect(await pool.query(
      "SELECT asset_id FROM turn_illustration_segment_assets WHERE segment_id = $1",
      [acceptedSegment.rows[0]!.id]
    )).toMatchObject({ rows: [{ asset_id: asset.rows[0]!.id }] });
    await pool.query("DELETE FROM turn_illustration_segments WHERE id = $1", [acceptedSegment.rows[0]!.id]);
    await pool.query("DELETE FROM assets WHERE id = $1 AND owner_user_id = $2", [asset.rows[0]!.id, ownerUserId]);
  });

  it("serializes resolution failure with cancellation without reverse parent-child locking", async () => {
    const imported = await campaign();
    const ownerUserId = await initialOwnerId(pool);
    const generation = await enqueueGeneration(pool, imported.campaignId, generationRequestSchema.parse({
      action: "Race resolution failure with cancellation.", providerProfileId: textProviderId, idempotencyKey: crypto.randomUUID(),
      context: { budgetTokens: 16000, compression: "full", recentTurns: 8 }
    }));
    await pool.query("UPDATE generation_jobs SET status = 'generating' WHERE id = $1", [generation.id]);
    const set = await pool.query<{ id: string }>(
      `INSERT INTO turn_illustration_sets (
         owner_user_id, campaign_id, generation_job_id, source_text_hash, segment_word_count,
         images_per_segment, prompt_mode, status
       ) VALUES ($1,$2,$3,'resolution-failure-race-set',500,1,'direct','provisional') RETURNING id`,
      [ownerUserId, imported.campaignId, generation.id]
    );
    const segment = await pool.query<{ id: string }>(
      `INSERT INTO turn_illustration_segments (
         owner_user_id, illustration_set_id, campaign_id, generation_job_id, ordinal,
         start_offset, end_offset, start_word, end_word, source_text, source_text_hash,
         direct_prompt, resolved_prompt, prompt_source, status
       ) VALUES ($1,$2,$3,$4,0,0,48,0,8,'Unsafe resolution failure race.','resolution-failure-race-segment',
                 'Unsafe resolution failure race.','','direct','generating') RETURNING id`,
      [ownerUserId, set.rows[0]!.id, imported.campaignId, generation.id]
    );
    const resolution = await pool.query<{ id: string }>(
      `INSERT INTO illustration_resolution_jobs (
         owner_user_id, campaign_id, segment_id, source_policy, matching_scope,
         confidence_profile, repetition_window, query_context_snapshot
       ) VALUES ($1,$2,$3,'library_only','campaign','balanced',0,'{}'::jsonb) RETURNING id`,
      [ownerUserId, imported.campaignId, segment.rows[0]!.id]
    );
    const barrier = await installResolutionFailureBarrier(resolution.rows[0]!.id);
    let cancellationSession: Awaited<ReturnType<typeof startCancellationSession>> | undefined;
    try {
      const failure = runIllustrationResolutionJob(pool, `resolution-failure-race-${crypto.randomUUID()}`, 30);
      const resolutionBackendPid = await barrier.wait();
      cancellationSession = await startCancellationSession(generation.id);
      await waitForCancellationBlockedByResolution({
        applicationName: cancellationSession.applicationName,
        cancellationBackendPid: cancellationSession.backendPid,
        resolutionBackendPid,
        generationJobId: generation.id,
        resolutionJobId: resolution.rows[0]!.id
      });
      await barrier.release();
      await expect(Promise.all([failure, cancellationSession.cancellation])).resolves.toEqual([
        true,
        expect.objectContaining({ status: "cancelled" })
      ]);
    } finally {
      await barrier.cleanup();
      if (cancellationSession) {
        await cancellationSession.cancellation.catch(() => undefined);
        await cancellationSession.close();
      }
    }
    expect(await pool.query("SELECT status FROM generation_jobs WHERE id = $1", [generation.id]))
      .toMatchObject({ rows: [{ status: "cancelled" }] });
    expect(await pool.query("SELECT status FROM illustration_resolution_jobs WHERE id = $1", [resolution.rows[0]!.id]))
      .toMatchObject({ rows: [{ status: "failed" }] });
    expect(await pool.query("SELECT status FROM turn_illustration_sets WHERE id = $1", [set.rows[0]!.id]))
      .toMatchObject({ rows: [{ status: "orphaned" }] });
    expect(await pool.query("SELECT status FROM turn_illustration_segments WHERE id = $1", [segment.rows[0]!.id]))
      .toMatchObject({ rows: [{ status: "failed" }] });
    expect(await pool.query(
      `SELECT id FROM illustration_resolution_jobs WHERE id = $1 AND status IN ('queued','matching','recoverable','generation_queued')
       UNION ALL SELECT id FROM image_jobs WHERE generation_job_id = $2 AND status IN ('queued','generating','provider_pending','downloading','completed')
       UNION ALL SELECT id FROM illustration_prompt_jobs WHERE generation_job_id = $2 AND status IN ('queued','refining','recoverable','fallback')`,
      [resolution.rows[0]!.id, generation.id]
    )).toMatchObject({ rows: [] });
  });

  it("prevents AI-refinement delivery from enqueueing an image after cancellation", async () => {
    const imported = await campaign();
    const ownerUserId = await initialOwnerId(pool);
    await setIllustrationConfig(pool, imported.campaignId, illustrationConfigSchema.parse({
      enabled: true, providerProfileId: imageProviderId, model: "synthetic-image-model",
      sourcePolicy: "generate_only", segmentPromptMode: "ai_refined"
    }));
    const generation = await enqueueGeneration(pool, imported.campaignId, generationRequestSchema.parse({
      action: "Race AI-refinement delivery.", providerProfileId: textProviderId, idempotencyKey: crypto.randomUUID(),
      context: { budgetTokens: 16000, compression: "full", recentTurns: 8 }
    }));
    const config = await loadConfig(pool, ownerUserId, imported.campaignId);
    await pool.query("UPDATE generation_jobs SET status = 'generating' WHERE id = $1", [generation.id]);
    const setId = await createProvisionalSet(pool, ownerUserId, imported.campaignId, generation.id);
    await createProvisionalSegment(
      pool, ownerUserId, imported.campaignId, generation.id, setId!,
      { ordinal: 0, startOffset: 0, endOffset: 67, startWord: 0, endWord: 12, wordCount: 12,
        text: "A lantern reveals a silent causeway beneath violet clouds tonight." }, config
    );
    const barrier = await installInsertBarrier("image_jobs", `NEW.generation_job_id = '${generation.id}'::uuid`);
    try {
      const refinement = runIllustrationPromptJob(pool, `prompt-race-${crypto.randomUUID()}`, 30, credentialSecret);
      await barrier.wait();
      const cancellation = cancelGeneration(pool, generation.id);
      await waitForCancellationAttempt(generation.id);
      await barrier.release();
      await refinement;
      await cancellation;
    } finally {
      await barrier.cleanup();
    }
    expect(await pool.query(
      `SELECT id FROM image_jobs WHERE generation_job_id = $1
         AND status IN ('queued','generating','provider_pending','downloading','completed')`, [generation.id]
    )).toMatchObject({ rows: [] });
    const promptStatus = await pool.query<{ status: string }>(
      "SELECT status FROM illustration_prompt_jobs WHERE generation_job_id = $1", [generation.id]
    );
    expect(["cancelled", "completed"]).toContain(promptStatus.rows[0]?.status);
  });

  it("terminalizes provisional refinement and resolution work when cancelling a generation", async () => {
    const imported = await campaign();
    const generation = await enqueueGeneration(pool, imported.campaignId, generationRequestSchema.parse({
      action: "Cancel provisional non-direct illustration work.",
      providerProfileId: textProviderId,
      idempotencyKey: crypto.randomUUID(),
      context: { budgetTokens: 16000, compression: "full", recentTurns: 8 }
    }));
    const ownerUserId = await initialOwnerId(pool);
    const set = await pool.query<{ id: string }>(
      `INSERT INTO turn_illustration_sets (
         owner_user_id, campaign_id, generation_job_id, source_text_hash, segment_word_count,
         images_per_segment, prompt_mode, status
       ) VALUES ($1,$2,$3,'cancel-non-direct-set',500,1,'ai_refined','provisional') RETURNING id`,
      [ownerUserId, imported.campaignId, generation.id]
    );
    const segment = await pool.query<{ id: string }>(
      `INSERT INTO turn_illustration_segments (
         owner_user_id, illustration_set_id, campaign_id, generation_job_id, ordinal,
         start_offset, end_offset, start_word, end_word, source_text, source_text_hash,
         direct_prompt, resolved_prompt, prompt_source, status
       ) VALUES ($1,$2,$3,$4,0,0,65,0,12,'A violet dawn crosses the silent causeway.','cancel-non-direct-segment',
                 'A violet dawn crosses the silent causeway.','','direct','refining') RETURNING id`,
      [ownerUserId, set.rows[0]!.id, imported.campaignId, generation.id]
    );
    const prompt = await pool.query<{ id: string }>(
      `INSERT INTO illustration_prompt_jobs (
         owner_user_id, campaign_id, generation_job_id, segment_id, provider_profile_id, requested_model
       ) VALUES ($1,$2,$3,$4,$5,'synthetic-text-model') RETURNING id`,
      [ownerUserId, imported.campaignId, generation.id, segment.rows[0]!.id, textProviderId]
    );
    const resolution = await pool.query<{ id: string }>(
      `INSERT INTO illustration_resolution_jobs (
         owner_user_id, campaign_id, segment_id, source_policy, matching_scope, confidence_profile, repetition_window
       ) VALUES ($1,$2,$3,'library_then_generate','campaign','balanced',0) RETURNING id`,
      [ownerUserId, imported.campaignId, segment.rows[0]!.id]
    );

    await expect(cancelGeneration(pool, generation.id)).resolves.toMatchObject({ status: "cancelled" });
    await expect(pool.query("SELECT status FROM illustration_prompt_jobs WHERE id = $1", [prompt.rows[0]!.id]))
      .resolves.toMatchObject({ rows: [{ status: "cancelled" }] });
    await expect(pool.query("SELECT status FROM illustration_resolution_jobs WHERE id = $1", [resolution.rows[0]!.id]))
      .resolves.toMatchObject({ rows: [{ status: "cancelled" }] });
    await expect(runIllustrationPromptJob(pool, "cancelled-prompt-worker", 30, credentialSecret)).resolves.toBe(false);
    await expect(runIllustrationResolutionJob(pool, "cancelled-resolution-worker", 30)).resolves.toBe(false);
    await expect(pool.query("SELECT id FROM image_jobs WHERE generation_job_id = $1", [generation.id]))
      .resolves.toMatchObject({ rows: [] });
  });

  it("cancels a streaming image completion that holds its row lock without retaining provisional artwork", async () => {
    const imported = await campaign();
    const generation = await enqueueGeneration(pool, imported.campaignId, generationRequestSchema.parse({
      action: "Cancel the streaming image completion.",
      providerProfileId: textProviderId,
      idempotencyKey: crypto.randomUUID(),
      context: { budgetTokens: 16000, compression: "full", recentTurns: 8 }
    }));
    const ownerUserId = await initialOwnerId(pool);
    const illustrationSet = await pool.query<{ id: string }>(
      `INSERT INTO turn_illustration_sets (
         owner_user_id, campaign_id, generation_job_id, source_text_hash, segment_word_count,
         images_per_segment, prompt_mode, status
       ) VALUES ($1,$2,$3,'cancel-completion-set',500,1,'direct','provisional') RETURNING id`,
      [ownerUserId, imported.campaignId, generation.id]
    );
    const segment = await pool.query<{ id: string }>(
      `INSERT INTO turn_illustration_segments (
         owner_user_id, illustration_set_id, campaign_id, generation_job_id, ordinal,
         start_offset, end_offset, start_word, end_word, source_text, source_text_hash,
         direct_prompt, resolved_prompt, prompt_source, status
       ) VALUES ($1,$2,$3,$4,0,0,64,0,12,'A provisional scene for cancellation testing.','cancel-completion-segment',
                 'A provisional scene for cancellation testing.','A provisional scene for cancellation testing.','direct','generating') RETURNING id`,
      [ownerUserId, illustrationSet.rows[0]!.id, imported.campaignId, generation.id]
    );
    const imageJob = await pool.query<{ id: string }>(
      `INSERT INTO image_jobs (
         owner_user_id, campaign_id, provider_profile_id, requested_model, prompt, prompt_hash,
         status, provider_type, target_type, segment_id, generation_job_id
       ) VALUES ($1,$2,$3,'synthetic-image-model','A provisional scene for cancellation testing.',
                 'cancel-completion-image','queued','openai_compatible','streaming_illustration',$4,$5) RETURNING id`,
      [ownerUserId, imported.campaignId, imageProviderId, segment.rows[0]!.id, generation.id]
    );
    const trigger = `hold_streaming_completion_${crypto.randomUUID().replaceAll("-", "")}`;
    const advisoryLockClassId = Number.parseInt(crypto.randomUUID().replaceAll("-", "").slice(0, 7), 16);
    const advisoryLockObjectId = Number.parseInt(crypto.randomUUID().replaceAll("-", "").slice(0, 7), 16);
    const lockHolder = await pool.connect();
    await lockHolder.query("SELECT pg_advisory_lock($1::integer, $2::integer)", [advisoryLockClassId, advisoryLockObjectId]);
    await pool.query(`CREATE FUNCTION ${trigger}_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(${advisoryLockClassId}, ${advisoryLockObjectId});
        RETURN NEW;
      END
    $$`);
    await pool.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE OF status ON image_jobs
      FOR EACH ROW WHEN (NEW.status = 'downloading' AND NEW.id = '${imageJob.rows[0]!.id}'::uuid) EXECUTE FUNCTION ${trigger}_fn()`);
    try {
      const worker = runImageJob(pool, "streaming-image-cancel-worker", 30, credentialSecret, { root: assetRoot });
      await expect.poll(async () => getImageJob(pool, imageJob.rows[0]!.id)).toMatchObject({ status: "generating" });
      let workerBackendPid: number | undefined;
      await expect.poll(async () => pool.query<{ pid: number }>(
        `SELECT activity.pid
           FROM pg_stat_activity activity
           JOIN pg_locks advisory_lock ON advisory_lock.pid = activity.pid
           JOIN pg_locks image_jobs_lock ON image_jobs_lock.pid = activity.pid
          WHERE activity.datname = current_database()
            AND activity.wait_event_type = 'Lock' AND activity.wait_event = 'advisory'
            AND advisory_lock.locktype = 'advisory' AND NOT advisory_lock.granted
            AND advisory_lock.classid = $1 AND advisory_lock.objid = $2 AND advisory_lock.objsubid = 2
            AND image_jobs_lock.locktype = 'relation' AND image_jobs_lock.relation = 'image_jobs'::regclass
            AND image_jobs_lock.mode = 'RowExclusiveLock' AND image_jobs_lock.granted`,
        [advisoryLockClassId, advisoryLockObjectId]
      ).then((result) => {
        workerBackendPid = result.rows[0]?.pid;
        return workerBackendPid;
      }), { timeout: 5_000 }).toBeTypeOf("number");
      const cancellation = cancelGeneration(pool, generation.id);
      let cancellationBackendPid: number | undefined;
      await expect.poll(async () => pool.query<{ pid: number }>(
        `SELECT cancellation.pid
           FROM pg_stat_activity cancellation
          WHERE cancellation.datname = current_database()
            AND cancellation.wait_event_type = 'Lock'
            AND cancellation.query LIKE 'UPDATE image_jobs%'
            AND $1 = ANY(pg_blocking_pids(cancellation.pid))`,
        [workerBackendPid]
      ).then((result) => {
        cancellationBackendPid = result.rows[0]?.pid;
        return cancellationBackendPid;
      })).toBeTypeOf("number");
      expect(cancellationBackendPid).not.toBe(workerBackendPid);
      await lockHolder.query("SELECT pg_advisory_unlock($1::integer, $2::integer)", [advisoryLockClassId, advisoryLockObjectId]);
      await expect(worker).resolves.toBe(true);
      await expect(cancellation).resolves.toMatchObject({ status: "cancelled" });
    } finally {
      await lockHolder.query("SELECT pg_advisory_unlock($1::integer, $2::integer)", [advisoryLockClassId, advisoryLockObjectId]).catch(() => undefined);
      lockHolder.release();
      await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON image_jobs`);
      await pool.query(`DROP FUNCTION IF EXISTS ${trigger}_fn()`);
    }

    expect(await getImageJob(pool, imageJob.rows[0]!.id)).toMatchObject({ status: "cancelled", assetId: null });
    expect(await pool.query("SELECT status FROM turn_illustration_sets WHERE id = $1", [illustrationSet.rows[0]!.id]))
      .toMatchObject({ rows: [{ status: "orphaned" }] });
    expect(await pool.query("SELECT asset_id FROM turn_illustration_segment_assets WHERE image_job_id = $1", [imageJob.rows[0]!.id]))
      .toMatchObject({ rows: [] });
  });

  it("creates historical segment jobs without changing accepted turn or Chronicle state", async () => {
    const imported = await campaign();
    const ownerUserId = await initialOwnerId(pool);
    const eligibleHistoricalNarration = [
      "Mira raises the lantern as the violet sky settles over the ancient causeway.",
      "Synthetic Location Image glows ahead with glassy towers, moss-covered statues, quiet archways, silver leaves, and patient shadows.",
      "The party studies painted doors, rain-dark stone, and a trail of blue sparks curling toward an unopened observatory.",
      "Every step reveals another visual clue: braided ropes, brass mirrors, damp banners, chalk symbols, broken masks, and a shallow pool reflecting unfamiliar stars.",
      "The scene remains calm but charged with discovery, giving the illustration pipeline enough concrete story detail to segment the accepted historical turn without changing the ledger."
    ].join(" ");
    await pool.query(
      `UPDATE turns
          SET narration = $2
        WHERE campaign_id = $1
          AND turn_number = (SELECT active_turn_number FROM campaigns WHERE id = $1)`,
      [imported.campaignId, eligibleHistoricalNarration]
    );
    const profile = {
      name: "Mira",
      profile: {
        identity: { aliases: ["The Lantern Bearer"], pronouns: "she/her" },
        story: { role: "Guide" },
        appearance: { hair: "black braid", clothing: "weathered blue cloak" },
        unclassifiedNotes: ""
      }
    };
    await pool.query(
      `UPDATE campaigns
          SET character_profile = $3, character_profile_revision = 3, updated_at = now()
        WHERE id = $1 AND owner_user_id = $2`,
      [imported.campaignId, ownerUserId, JSON.stringify(profile)]
    );
    await setIllustrationConfig(pool, imported.campaignId, illustrationConfigSchema.parse({
      enabled: true,
      providerProfileId: imageProviderId,
      model: "synthetic-image-model",
      size: "1024x1024",
      aspectRatio: "1:1",
      quality: "auto",
      outputFormat: "png",
      maxAttempts: 3,
      segmentWordCount: 100,
      imagesPerSegment: 2,
      segmentPromptMode: "direct"
    }));
    const turn = await pool.query<{ id: string }>(
      "SELECT id FROM turns WHERE campaign_id = $1 ORDER BY turn_number DESC LIMIT 1",
      [imported.campaignId]
    );
    expect(turn.rows[0]).toBeDefined();
    const turnId = turn.rows[0]!.id;
    const before = await pool.query(
      `SELECT narration, mechanics_private, state_snapshot_private, model_metadata, import_metadata,
              image_prompt, choices, turn_number, image_url
         FROM turns WHERE id = $1`,
      [turnId]
    );
    const memoriesBefore = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM chronicle_memories WHERE campaign_id = $1",
      [imported.campaignId]
    );

    const result = await generateTurnIllustrationSegments(pool, turnId, illustrationSegmentRequestSchema.parse({ mode: "missing" }));
    expect(result).toMatchObject({ duplicate: false, segmentCount: expect.any(Number) });
    expect(result.segmentCount).toBeGreaterThan(0);
    const segments = (await listCampaignIllustrationSegments(pool, imported.campaignId)).segments.filter(
      (segment: any) => segment.turnId === turnId
    );
    expect(segments).toHaveLength(result.segmentCount);
    const jobs = await pool.query<{ image_count: number; prompt: string }>(
      "SELECT image_count, prompt FROM image_jobs WHERE segment_id = ANY($1::uuid[]) ORDER BY created_at",
      [segments.map((segment: any) => segment.id)]
    );
    expect(jobs.rows).toHaveLength(result.segmentCount);
    expect(jobs.rows.every((job) => job.image_count === 2)).toBe(true);
    expect(jobs.rows.every((job) => job.prompt.includes("weathered blue cloak"))).toBe(true);
    expect(jobs.rows.every((job) => (
      job.prompt.match(/CANONICAL CHARACTER REFERENCE:/g)?.length === 1
    ))).toBe(true);
    const originalSet = await pool.query<{ id: string; character_visual_reference: string }>(
      `SELECT id, character_visual_reference FROM turn_illustration_sets
        WHERE turn_id = $1 AND is_active = true`,
      [turnId]
    );
    expect(originalSet.rows[0]?.character_visual_reference).toContain("weathered blue cloak");
    expect(segments.every((segment: any) => !segment.resolvedPrompt.includes("CANONICAL CHARACTER REFERENCE:"))).toBe(true);

    const revisedProfile = {
      ...profile,
      profile: {
        ...profile.profile,
        appearance: { ...profile.profile.appearance, clothing: "dark green travel coat" }
      }
    };
    await pool.query(
      `UPDATE campaigns
          SET character_profile = $3, character_profile_revision = 4, updated_at = now()
        WHERE id = $1 AND owner_user_id = $2`,
      [imported.campaignId, ownerUserId, JSON.stringify(revisedProfile)]
    );
    const rebuilt = await generateTurnIllustrationSegments(
      pool,
      turnId,
      illustrationSegmentRequestSchema.parse({ mode: "rebuild" })
    );
    expect(rebuilt.duplicate).toBe(false);
    const sets = await pool.query<{ id: string; is_active: boolean; character_visual_reference: string }>(
      `SELECT id, is_active, character_visual_reference
         FROM turn_illustration_sets WHERE turn_id = $1 ORDER BY created_at`,
      [turnId]
    );
    expect(sets.rows.find((set) => set.id === originalSet.rows[0]?.id)).toMatchObject({
      is_active: false,
      character_visual_reference: expect.stringContaining("weathered blue cloak")
    });
    expect(sets.rows.find((set) => set.is_active)).toMatchObject({
      character_visual_reference: expect.stringContaining("dark green travel coat")
    });
    const rebuiltJobs = await pool.query<{ prompt: string }>(
      `SELECT jobs.prompt FROM image_jobs jobs
         JOIN turn_illustration_segments segments ON segments.id = jobs.segment_id
         JOIN turn_illustration_sets sets ON sets.id = segments.illustration_set_id
        WHERE sets.turn_id = $1 AND sets.is_active = true`,
      [turnId]
    );
    expect(rebuiltJobs.rows.every((job) => job.prompt.includes("dark green travel coat"))).toBe(true);
    expect(rebuiltJobs.rows.every((job) => (
      job.prompt.match(/CANONICAL CHARACTER REFERENCE:/g)?.length === 1
    ))).toBe(true);
    await expect(previewIllustrationBackfill(pool, imported.campaignId, "missing"))
      .resolves.toMatchObject({ settings: { segmentWordCount: 100, imagesPerSegment: 2, segmentPromptMode: "direct" } });

    const after = await pool.query(
      `SELECT narration, mechanics_private, state_snapshot_private, model_metadata, import_metadata,
              image_prompt, choices, turn_number, image_url
         FROM turns WHERE id = $1`,
      [turnId]
    );
    const memoriesAfter = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM chronicle_memories WHERE campaign_id = $1",
      [imported.campaignId]
    );
    expect(after.rows).toEqual(before.rows);
    expect(memoriesAfter.rows).toEqual(memoriesBefore.rows);
  });

  it("sends the visual reference to AI refinement and appends it once to the provider prompt", async () => {
    const imported = await campaign();
    const ownerUserId = await initialOwnerId(pool);
    const privateScratchpad = `PRIVATE_ILLUSTRATION_SCRATCHPAD_${crypto.randomUUID()}`;
    const privateTrackers = `PRIVATE_ILLUSTRATION_TRACKERS_${crypto.randomUUID()}`;
    const privateMechanics = `PRIVATE_ILLUSTRATION_MECHANICS_${crypto.randomUUID()}`;
    await pool.query(
      `UPDATE campaigns
          SET character_profile = $3, character_profile_revision = 2, updated_at = now()
        WHERE id = $1 AND owner_user_id = $2`,
      [imported.campaignId, ownerUserId, JSON.stringify({
        name: "Mira",
        profile: {
          identity: { aliases: ["The Lantern Bearer"], pronouns: "she/her" },
          story: { role: "Guide" },
          appearance: { eyes: "gray", clothing: "weathered purple coat" },
          unclassifiedNotes: ""
        }
      })]
    );
    await pool.query(
      `UPDATE campaign_state
          SET scratchpad_private = $3,
              scratchpad_safe_for_prompt = true,
              trackers = jsonb_build_array($4::text),
              rpg_stats = jsonb_build_object('private', $5::text)
        WHERE campaign_id = $1 AND owner_user_id = $2`,
      [imported.campaignId, ownerUserId, privateScratchpad, privateTrackers, privateMechanics]
    );
    await setIllustrationConfig(pool, imported.campaignId, illustrationConfigSchema.parse({
      enabled: true,
      providerProfileId: imageProviderId,
      model: "synthetic-image-model",
      size: "1024x1024",
      aspectRatio: "1:1",
      quality: "auto",
      outputFormat: "png",
      maxAttempts: 3,
      segmentWordCount: 100,
      imagesPerSegment: 1,
      segmentPromptMode: "ai_refined",
      // Exercise the default lane order end-to-end: refinement -> library
      // resolution -> image transport/artifact/asset fallback.
      sourcePolicy: "library_then_generate",
      matchingScope: "campaign"
    }));
    const turn = await pool.query<{ id: string }>(
      "SELECT id FROM turns WHERE campaign_id = $1 ORDER BY turn_number DESC LIMIT 1",
      [imported.campaignId]
    );
    const turnId = turn.rows[0]!.id;
    const refinementCountBefore = refinementRequests.length;
    const imageCountBefore = imageRequests.length;
    const created = await generateTurnIllustrationSegments(
      pool,
      turnId,
      illustrationSegmentRequestSchema.parse({ mode: "missing" })
    );
    // Run the default runtime composition, rather than directly invoking a
    // legacy handler, so this PostgreSQL case captures the real typed port
    // path for both refinement and image generation.
    const worker = createWorkerIllustrationApplication(pool, credentialSecret, { root: assetRoot });
    for (let index = 0; index < created.segmentCount * 3 + 4; index += 1) {
      if (!await worker.runNextIllustration({ workerId: `refinement-worker-${crypto.randomUUID()}`, leaseSeconds: 30 })) break;
    }

    const submitted = refinementRequests.slice(refinementCountBefore).map((request) => JSON.stringify(request));
    const imageSubmitted = imageRequests.slice(imageCountBefore).map((request) => JSON.stringify(request));
    const campaignImageSubmitted = imageSubmitted.filter((request) => request.includes("weathered purple coat"));
    expect(submitted).toHaveLength(created.segmentCount);
    expect(campaignImageSubmitted).toHaveLength(created.segmentCount);
    expect(submitted.every((request) => request.includes("weathered purple coat"))).toBe(true);
    expect(submitted.every((request) => request.includes("STORY CONTEXT"))).toBe(true);
    // Private campaign state is never illustration context, even when an
    // unrelated narrative path marks its scratchpad safe for text prompts.
    for (const request of [...submitted, ...campaignImageSubmitted]) {
      expect(request).not.toContain(privateScratchpad);
      expect(request).not.toContain(privateTrackers);
      expect(request).not.toContain(privateMechanics);
    }
    await expect(pool.query(
      `SELECT status, reason_code
         FROM illustration_resolution_jobs
        WHERE campaign_id = $1
        ORDER BY created_at`,
      [imported.campaignId]
    )).resolves.toMatchObject({
      rows: Array.from({ length: created.segmentCount }, () => ({ status: "completed", reason_code: "generated" }))
    });
    await expect(pool.query(
      `SELECT count(*)::int AS count
         FROM provider_cost_events
        WHERE campaign_id = $1 AND operation = 'image_generation'`,
      [imported.campaignId]
    )).resolves.toMatchObject({ rows: [{ count: created.segmentCount }] });
    await expect(pool.query(
      `SELECT count(*)::int AS count
         FROM provider_cost_events
        WHERE campaign_id = $1 AND operation = 'prompt_refinement'`,
      [imported.campaignId]
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
    const segments = await pool.query<{ direct_prompt: string; resolved_prompt: string; prompt: string }>(
      `SELECT segments.direct_prompt, segments.resolved_prompt, jobs.prompt
         FROM turn_illustration_segments segments
         JOIN image_jobs jobs ON jobs.segment_id = segments.id
        WHERE segments.turn_id = $1`,
      [turnId]
    );
    expect(segments.rows).toHaveLength(created.segmentCount);
    for (const row of segments.rows) {
      expect(row.direct_prompt).not.toContain("CANONICAL CHARACTER REFERENCE:");
      expect(row.resolved_prompt).not.toContain("CANONICAL CHARACTER REFERENCE:");
      expect(row.resolved_prompt).toContain("Mira, raising a lantern");
      expect(row.prompt).toContain("weathered purple coat");
      expect(row.prompt.match(/CANONICAL CHARACTER REFERENCE:/g)).toHaveLength(1);
    }
  });

  it("generates a world cover with the default image provider without campaign cost attribution", async () => {
    failImages = false;
    const title = `Synthetic cover world ${crypto.randomUUID()}`;
    const world = await createWorld(pool, worldCreateSchema.parse({
      title,
      content: worldContentSchema.parse({
        world: {
          title,
          genre: "fantasy",
          tone: "luminous",
          premise: "A fictional citadel hangs over a violet sea.",
          backgroundStory: "",
          firstAction: "",
          rules: ""
        }
      })
    }));
    const queued = await enqueueWorldCover(pool, world.id, worldCoverRequestSchema.parse({}));
    expect(queued).toMatchObject({ targetType: "world_cover", worldId: world.id, campaignId: null, turnId: null });
    await expect(getLatestWorldCoverJob(pool, world.id)).resolves.toMatchObject({ id: queued.id, status: "queued" });
    const completed = await processThroughTerminal(queued.id, "synthetic-world-cover-worker");
    expect(completed).toMatchObject({ status: "completed", assetUrl: expect.stringMatching(/^\/api\/v1\/assets\//) });
    await expect(getLatestWorldCoverJob(pool, world.id)).resolves.toMatchObject({ id: queued.id, status: "completed" });
    await expect(getWorld(pool, world.id)).resolves.toMatchObject({ imageUrl: completed.assetUrl });
    const generationContext = await pool.query<{
      target_type: string;
      fiction_prompt: string;
      provider_type: string;
      model: string;
      generation_parameters: Record<string, unknown>;
    }>(
      `SELECT target_type, fiction_prompt, provider_type, model, generation_parameters
         FROM asset_generation_contexts
        WHERE image_job_id = $1`,
      [queued.id]
    );
    expect(generationContext.rows).toEqual([expect.objectContaining({
      target_type: "world_cover", provider_type: "openai_compatible", model: "synthetic-image-model",
      fiction_prompt: expect.any(String),
      generation_parameters: expect.objectContaining({ size: "1024x1536", aspectRatio: "2:3", outputFormat: "png" })
    })]);
    const costs = await pool.query("SELECT id FROM provider_cost_events WHERE image_job_id = $1", [queued.id]);
    expect(costs.rowCount).toBe(0);
  });

  it("reuses retained generated assets for world covers and turn illustrations", async () => {
    failImages = false;
    const sourceTitle = `Synthetic library source ${crypto.randomUUID()}`;
    const sourceWorld = await createWorld(pool, worldCreateSchema.parse({ title: sourceTitle }));
    const queued = await enqueueWorldCover(pool, sourceWorld.id, worldCoverRequestSchema.parse({}));
    const completed = await processThroughTerminal(queued.id, "synthetic-library-worker");
    expect(completed.status).toBe("completed");
    const ownerUserId = await initialOwnerId(pool);
    const library = await listAssets(pool, ownerUserId);
    const asset = library.find((item) => item.url === completed.assetUrl);
    expect(asset).toBeDefined();
    expect(asset).toMatchObject({ width: 1, height: 1, origin: "generated", reviewStatus: "eligible" });
    const thumbnail = await readAssetDerivative(pool, { root: assetRoot }, ownerUserId, asset!.id, "thumbnail");
    expect(thumbnail.mimeType).toBe("image/webp");
    expect(thumbnail.bytes.length).toBeGreaterThan(0);

    const updated = await updateAssetMetadata(pool, ownerUserId, asset!.id, {
      expectedRevision: asset!.metadataRevision,
      title: "A luminous violet stone arch at night",
      tags: ["violet", "arch", "night"],
      reuseScope: "owner_library",
      automaticReuseEnabled: true,
      reviewStatus: "eligible",
      favorite: true
    });
    await expect(updateAssetMetadata(pool, ownerUserId, asset!.id, {
      expectedRevision: asset!.metadataRevision,
      title: "Stale edit"
    })).rejects.toMatchObject({ statusCode: 409 });
    const filtered = await queryAssets(pool, ownerUserId, assetListQuerySchema.parse({
      q: "violet arch", origin: ["generated"], tags: ["night"], reviewStatus: ["eligible"], reuseScope: ["owner_library"],
      favorite: true, sort: "newest", limit: 20
    }));
    expect(filtered.assets.map((item) => item.id)).toContain(asset!.id);
    expect(filtered.assets.find((item) => item.id === asset!.id)?.metadataRevision).toBe(updated.metadataRevision);
    expect(filtered.facets.tags.night).toBeGreaterThanOrEqual(1);
    const cursorAssetHashA = crypto.randomUUID().replaceAll("-", "").repeat(2);
    const cursorAssetHashB = crypto.randomUUID().replaceAll("-", "").repeat(2);
    await pool.query(
      `INSERT INTO assets (owner_user_id, content_hash, storage_driver, storage_path, mime_type, byte_length, pixel_width, pixel_height)
       VALUES ($1,$2,'filesystem',$3,'image/png',68,1,1), ($1,$4,'filesystem',$5,'image/png',68,1,1)`,
      [ownerUserId, cursorAssetHashA, "aa/cursor-a.png", cursorAssetHashB, "bb/cursor-b.png"]
    );
    const firstPageQuery = assetListQuerySchema.parse({ limit: 1 });
    const firstPage = await queryAssets(pool, ownerUserId, firstPageQuery);
    expect(firstPage.nextCursor).toBeTruthy();
    const secondPage = await queryAssets(pool, ownerUserId, { ...firstPageQuery, cursor: firstPage.nextCursor! });
    expect(secondPage.assets[0]?.id).not.toBe(firstPage.assets[0]?.id);
    await expect(queryAssets(pool, ownerUserId, {
      ...firstPageQuery, q: "different filter", cursor: firstPage.nextCursor!
    })).rejects.toMatchObject({ statusCode: 400 });

    const targetTitle = `Synthetic library target ${crypto.randomUUID()}`;
    const targetWorld = await createWorld(pool, worldCreateSchema.parse({ title: targetTitle }));
    await expect(selectWorldCover(pool, ownerUserId, targetWorld.id, asset!.id)).resolves.toEqual({ assetUrl: asset!.url });
    await expect(getWorld(pool, targetWorld.id)).resolves.toMatchObject({ imageUrl: asset!.url });

    const imported = await campaign();
    const turn = await pool.query<{ id: string }>("SELECT id FROM turns WHERE campaign_id = $1 ORDER BY turn_number DESC LIMIT 1", [imported.campaignId]);
    const turnId = turn.rows[0]!.id;
    await pool.query("UPDATE turns SET image_prompt = $2 WHERE id = $1", [turnId, "A luminous violet stone arch at night"]);
    await expect(selectTurnIllustration(pool, ownerUserId, turnId, asset!.id)).resolves.toEqual({ assetUrl: asset!.url });
    const selected = await pool.query<{ image_url: string }>("SELECT image_url FROM turns WHERE id = $1", [turnId]);
    expect(selected.rows[0]?.image_url).toBe(asset!.url);
    const reference = await pool.query(
      "SELECT id FROM asset_references WHERE owner_user_id = $1 AND asset_id = $2 AND turn_id = $3 AND asset_role = 'turn_illustration'",
      [ownerUserId, asset!.id, turnId]
    );
    expect(reference.rowCount).toBe(1);

    await pool.query(
      `INSERT INTO illustration_resolution_jobs (
         owner_user_id, campaign_id, turn_id, source_policy, matching_scope, confidence_profile, repetition_window
       ) VALUES ($1,$2,$3,'library_only','owner_library','broad',0)`,
      [ownerUserId, imported.campaignId, turnId]
    );
    await expect(runIllustrationResolutionJob(pool, "synthetic-library-match-worker", 30)).resolves.toBe(true);
    const resolution = await getTurnIllustrationResolution(pool, turnId) as { candidates: Array<{ score: number }> };
    expect(resolution.candidates[0]?.score).toBeGreaterThanOrEqual(0.38);
    expect(resolution).toMatchObject({
      status: "completed", selectedAssetId: asset!.id, reasonCode: "matched"
    });
    expect(resolution.candidates).toContainEqual(expect.objectContaining({ assetId: asset!.id, rank: 1 }));
  });

  it("restores an original without a thumbnail and lets metadata backfill regenerate it", async () => {
    const ownerUserId = await initialOwnerId(pool);
    const restoredBytes = await sharp({
      create: { width: 2, height: 3, channels: 4, background: `#${crypto.randomUUID().replaceAll("-", "").slice(0, 6)}` }
    }).png().toBuffer();
    const restored = await withTransaction(pool, (client) => persistOriginalImage(client, { root: assetRoot }, ownerUserId, {
      bytes: restoredBytes, mimeType: "image/png", createThumbnail: false
    }));
    const before = await pool.query(
      "SELECT count(*)::int AS count FROM asset_derivatives WHERE owner_user_id = $1 AND source_asset_id = $2 AND derivative_kind = 'thumbnail'",
      [ownerUserId, restored.id]
    );
    expect(before.rows[0]?.count).toBe(0);
    await expect(runAssetMetadataBackfill(pool, { root: assetRoot }, 10)).resolves.toBe(true);
    const after = await pool.query(
      "SELECT count(*)::int AS count FROM asset_derivatives WHERE owner_user_id = $1 AND source_asset_id = $2 AND derivative_kind = 'thumbnail'",
      [ownerUserId, restored.id]
    );
    expect(after.rows[0]?.count).toBe(1);
  });

  it("keeps paginated asset results and facet counts aligned for combined library filters", async () => {
    const ownerUserId = await initialOwnerId(pool);
    const imported = await campaign();
    const campaignContext = await pool.query<{ world_id: string; world_version_id: string }>(
      `SELECT world_versions.world_id, campaigns.world_version_id
         FROM campaigns
         JOIN world_versions ON world_versions.id = campaigns.world_version_id
          AND world_versions.owner_user_id = campaigns.owner_user_id
        WHERE campaigns.id = $1 AND campaigns.owner_user_id = $2`,
      [imported.campaignId, ownerUserId]
    );
    const context = campaignContext.rows[0]!;
    const token = `assetcharacterization${crypto.randomUUID().replaceAll("-", "")}`;

    async function retainAsset(title: string, tags: string[], createdAt: string) {
      const asset = await pool.query<{ id: string }>(
        `INSERT INTO assets (
           owner_user_id, content_hash, storage_driver, storage_path, mime_type, byte_length,
           pixel_width, pixel_height, created_at
         ) VALUES ($1,$2,'filesystem',$3,'image/png',68,1200,600,$4)
         RETURNING id`,
        [ownerUserId, crypto.randomUUID().replaceAll("-", ""), `${crypto.randomUUID()}.png`, createdAt]
      );
      const assetId = asset.rows[0]!.id;
      await pool.query(
        `UPDATE asset_library_entries
            SET title = $3, tags = $4, origin = 'generated', reuse_scope = 'owner_library',
                automatic_reuse_enabled = true, review_status = 'eligible', favorite = true, created_at = $5
          WHERE asset_id = $1 AND owner_user_id = $2`,
        [assetId, ownerUserId, title, tags, createdAt]
      );
      await pool.query(
        `INSERT INTO asset_generation_contexts (
           owner_user_id, asset_id, created_by_user_id, world_id, world_version_id, campaign_id,
           fiction_prompt, entities, locations, provider_type, model
         ) VALUES ($1,$2,$1,$3,$4,$5,$6,$7::jsonb,$8::jsonb,'synthetic-image','landscape-v1')`,
        [ownerUserId, assetId, context.world_id, context.world_version_id, imported.campaignId,
          `${token} moonlit fiction prompt`, JSON.stringify(["oracle"]), JSON.stringify(["moon-gate"])]
      );
      await pool.query(
        `INSERT INTO asset_references (owner_user_id, asset_id, campaign_id, asset_role)
         VALUES ($1,$2,$3,'world_asset')`,
        [ownerUserId, assetId, imported.campaignId]
      );
      return assetId;
    }

    const firstAssetId = await retainAsset(`${token} moon gate`, ["moon", "gate"], "2025-01-01T00:00:00.000Z");
    const secondAssetId = await retainAsset(`${token} moon shrine`, ["moon", "shrine"], "2025-01-02T00:00:00.000Z");
    const query = assetListQuerySchema.parse({
      q: `${token} moon`, scope: "campaign", campaignId: imported.campaignId,
      worldId: context.world_id, worldVersionId: context.world_version_id,
      origin: ["generated"], tags: ["moon"], allTags: true,
      entityIds: ["oracle"], locationIds: ["moon-gate"], provider: ["synthetic-image"], model: ["landscape-v1"],
      reviewStatus: ["eligible"], reuseScope: ["owner_library"], eligible: true, favorite: true,
      mimeType: ["image/png"], aspect: ["landscape"],
      createdFrom: "2024-12-31T00:00:00.000Z", createdTo: "2025-12-31T23:59:59.999Z",
      sort: "oldest", limit: 1
    });

    const firstPage = await queryAssets(pool, ownerUserId, query);
    expect(firstPage).toMatchObject({
      assets: [expect.objectContaining({ id: firstAssetId })],
      total: 2,
      facets: {
        origin: { generated: 2 },
        reviewStatus: { eligible: 2 },
        reuseScope: { owner_library: 2 },
        tags: { moon: 2, gate: 1, shrine: 1 }
      }
    });
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondPage = await queryAssets(pool, ownerUserId, { ...query, cursor: firstPage.nextCursor! });
    expect(secondPage).toMatchObject({
      assets: [expect.objectContaining({ id: secondAssetId })],
      nextCursor: null,
      total: 2,
      facets: firstPage.facets
    });
  });

  it("queues after story commit, sends only the fiction prompt, and stores generated bytes", async () => {
    failImages = false;
    const imported = await campaign();
    await generate(imported.campaignId);
    const [imageJob] = await listCampaignImageJobs(pool, imported.campaignId);
    expect(imageJob).toMatchObject({ status: "queued", model: "synthetic-image-model" });
    const completedImageJob = await processThroughTerminal(imageJob!.id, "synthetic-image-worker");
    expect(completedImageJob).toMatchObject({ status: "completed", assetUrl: expect.stringMatching(/^\/api\/v1\/assets\//) });
    const imageRequest = imageRequests.at(-1);
    expect(imageRequest?.prompt).toContain("Synthetic Location Image opens beneath a quiet violet sky.");
    expect(JSON.stringify(imageRequest)).not.toMatch(/roll|dice|check|scratchpad/i);
    const acceptedTurn = await pool.query<{
      mechanics_private: Record<string, unknown>;
      state_snapshot_private: { scratchpad: string };
    }>(
      `SELECT mechanics_private, state_snapshot_private
         FROM turns WHERE campaign_id = $1 ORDER BY turn_number DESC LIMIT 1`,
      [imported.campaignId]
    );
    expect(acceptedTurn.rows[0]?.state_snapshot_private.scratchpad).toBe("Synthetic fiction continuity only.");
    expect(Object.hasOwn(acceptedTurn.rows[0]?.mechanics_private ?? {}, "roll")).toBe(true);
    expect(JSON.stringify(imageRequest)).not.toContain(acceptedTurn.rows[0]!.state_snapshot_private.scratchpad);
    const ownerUserId = await initialOwnerId(pool);
    const generatedAsset = (await listAssets(pool, ownerUserId)).find((asset) => asset.url === completedImageJob.assetUrl);
    expect(generatedAsset).toMatchObject({ origin: "generated", reviewStatus: "eligible" });
    const delivered = await readAssetDerivative(pool, { root: assetRoot }, ownerUserId, generatedAsset!.id, "thumbnail");
    expect(delivered.mimeType).toBe("image/webp");
    expect(delivered.bytes.length).toBeGreaterThan(0);
    const costSummary = await getCampaignCostSummary(pool, imported.campaignId);
    expect(costSummary.totals[0]?.byCategory.image).toBe("0.040000000000");
  });

  it("runs library-only resolution without an image provider", async () => {
    const imported = await campaign();
    await setIllustrationConfig(pool, imported.campaignId, illustrationConfigSchema.parse({
      sourcePolicy: "library_only", matchingScope: "campaign", confidenceProfile: "strict",
      providerProfileId: null, model: ""
    }));
    await expect(getIllustrationConfig(pool, imported.campaignId)).resolves.toMatchObject({
      sourcePolicy: "library_only", providerProfileId: null
    });
    const ownerUserId = await initialOwnerId(pool);
    const turn = await pool.query<{ id: string }>("SELECT id FROM turns WHERE campaign_id = $1 ORDER BY turn_number DESC LIMIT 1", [imported.campaignId]);
    const turnId = turn.rows[0]!.id;
    await pool.query("UPDATE turns SET image_prompt = $2, image_url = '' WHERE id = $1", [turnId, "An unmatched obsidian observatory in a snowstorm"]);
    const resolutionId = await withTransaction(pool, (client) => enqueueAcceptedTurnIllustration(
      client, ownerUserId, imported.campaignId, turnId, "An unmatched obsidian observatory in a snowstorm"
    ));
    expect(resolutionId).toBeTruthy();
    await expect(runIllustrationResolutionJob(pool, "synthetic-library-only-worker", 30)).resolves.toBe(true);
    await expect(getTurnIllustrationResolution(pool, turnId)).resolves.toMatchObject({ status: "no_match", imageJobId: null });
    const providerJobs = await pool.query("SELECT id FROM image_jobs WHERE turn_id = $1", [turnId]);
    expect(providerJobs.rowCount).toBe(0);
  });

  it("queues exactly one provider job after a durable library-first no-match", async () => {
    const imported = await campaign();
    await setIllustrationConfig(pool, imported.campaignId, illustrationConfigSchema.parse({
      sourcePolicy: "library_then_generate", matchingScope: "campaign", confidenceProfile: "strict",
      providerProfileId: imageProviderId, model: "synthetic-image-model"
    }));
    const ownerUserId = await initialOwnerId(pool);
    const turn = await pool.query<{ id: string }>("SELECT id FROM turns WHERE campaign_id = $1 ORDER BY turn_number DESC LIMIT 1", [imported.campaignId]);
    const turnId = turn.rows[0]!.id;
    await pool.query("UPDATE turns SET image_prompt = $2, image_url = '' WHERE id = $1", [turnId, "A singular copper lighthouse beneath green auroras"]);
    await withTransaction(pool, (client) => enqueueAcceptedTurnIllustration(
      client, ownerUserId, imported.campaignId, turnId, "A singular copper lighthouse beneath green auroras"
    ));
    await expect(runIllustrationResolutionJob(pool, "synthetic-library-first-worker", 30)).resolves.toBe(true);
    const resolution = await getTurnIllustrationResolution(pool, turnId) as { status: string; imageJobId: string | null };
    expect(resolution).toMatchObject({ status: "generation_queued", imageJobId: expect.any(String) });
    await expect(runIllustrationResolutionJob(pool, "synthetic-library-first-worker-duplicate", 30)).resolves.toBe(false);
    const providerJobs = await pool.query("SELECT id FROM image_jobs WHERE turn_id = $1", [turnId]);
    expect(providerJobs.rowCount).toBe(1);
    await pool.query("UPDATE image_jobs SET status = 'cancelled' WHERE turn_id = $1", [turnId]);
  });

  it("commits accepted story state and Chronicle memory without illustration work when illustrations are disabled", async () => {
    const imported = await campaign();
    await setIllustrationConfig(pool, imported.campaignId, illustrationConfigSchema.parse({
      enabled: false,
      sourcePolicy: "off",
      providerProfileId: null,
      model: ""
    }));
    const storyJob = await generate(imported.campaignId);

    const accepted = await acceptedStorySnapshot(imported.campaignId, storyJob.id);
    expect(accepted.generation).toEqual([{
      id: storyJob.id,
      status: "completed",
      result_turn_id: expect.any(String)
    }]);
    const resultTurnId = accepted.generation[0]!.result_turn_id;
    expect(accepted.turns).toHaveLength(3);
    expect(accepted.turns.at(-1)).toMatchObject({
      id: resultTurnId,
      turn_number: 3,
      narration: expect.stringContaining("Synthetic Location Image opens beneath a quiet violet sky.")
    });
    expect(accepted.state).toEqual([expect.objectContaining({
      active_turn_number: 3,
      revision: 1,
      scratchpad_private: "Synthetic fiction continuity only."
    })]);
    expect(accepted.memories.some((memory) => memory.turn_id === resultTurnId && memory.memory_kind === "turn_fiction")).toBe(true);
    expect(await illustrationWorkCounts(imported.campaignId)).toEqual({
      image_jobs: 0,
      illustration_sets: 0,
      illustration_segments: 0,
      prompt_jobs: 0,
      resolution_jobs: 0
    });
  });

  it("leaves an accepted story unchanged when its configured image model is incompatible", async () => {
    const imported = await campaign(1);
    await setIllustrationConfig(pool, imported.campaignId, illustrationConfigSchema.parse({
      enabled: true,
      sourcePolicy: "generate_only",
      providerProfileId: imageProviderId,
      model: "synthetic-text-only-model",
      maxAttempts: 1,
      segmentWordCount: 100,
      imagesPerSegment: 1,
      segmentPromptMode: "direct"
    }));
    const storyJob = await generate(imported.campaignId);
    const acceptedBefore = await acceptedStorySnapshot(imported.campaignId, storyJob.id);
    const [imageJob] = await listCampaignImageJobs(pool, imported.campaignId);
    expect(imageJob).toMatchObject({ status: "queued", model: "synthetic-text-only-model" });

    const unsuccessful = await processThroughTerminal(imageJob!.id, "synthetic-incompatible-model-worker");

    expect(["recoverable", "failed"]).toContain(unsuccessful.status);
    expect(imageRequests.at(-1)).toMatchObject({ model: "synthetic-text-only-model" });
    expect(await acceptedStorySnapshot(imported.campaignId, storyJob.id)).toEqual(acceptedBefore);
  });

  it("retries an unsuccessful image independently without rerunning or mutating its accepted story", async () => {
    failImages = true;
    try {
      const imported = await campaign(1);
      const storyJob = await generate(imported.campaignId);
      const [imageJob] = await listCampaignImageJobs(pool, imported.campaignId);
      expect(imageJob).toMatchObject({ status: "queued", model: "synthetic-image-model" });
      expect(await processThroughTerminal(imageJob!.id, "synthetic-image-retry-failure-worker"))
        .toMatchObject({ status: "recoverable", errorCode: "image_generation_failed" });
      const acceptedBeforeRetry = await acceptedStorySnapshot(imported.campaignId, storyJob.id);
      const storyRequestCount = storyRequests.length;

      failImages = false;
      await expect(retryImageJob(pool, imageJob!.id)).resolves.toMatchObject({
        id: imageJob!.id,
        status: "queued",
        attempts: 0
      });
      await expect(processThroughTerminal(imageJob!.id, "synthetic-image-retry-success-worker"))
        .resolves.toMatchObject({ status: "completed", assetUrl: expect.stringMatching(/^\/api\/v1\/assets\//) });

      expect(await acceptedStorySnapshot(imported.campaignId, storyJob.id)).toEqual(acceptedBeforeRetry);
      expect(storyRequests).toHaveLength(storyRequestCount);
    } finally {
      failImages = false;
    }
  });

  it("exhausts automatic image attempts without retrying narration or mutating its accepted story", async () => {
    failImages = true;
    try {
      const imported = await campaign(2);
      const storyJob = await generate(imported.campaignId);
      const acceptedBeforeFailures = await acceptedStorySnapshot(imported.campaignId, storyJob.id);
      const storyRequestCount = storyRequests.length;
      const [imageJob] = await listCampaignImageJobs(pool, imported.campaignId);
      expect(imageJob).toMatchObject({ status: "queued", attempts: 0, maxAttempts: 2 });

      await expect(runImageJob(
        pool,
        "synthetic-image-exhaustion-first-worker",
        30,
        credentialSecret,
        { root: assetRoot }
      )).resolves.toBe(true);
      await expect(getImageJob(pool, imageJob!.id)).resolves.toMatchObject({
        status: "queued",
        attempts: 1,
        maxAttempts: 2,
        errorCode: "image_generation_failed"
      });
      await pool.query("UPDATE image_jobs SET next_attempt_at = now() WHERE id = $1", [imageJob!.id]);

      await expect(runImageJob(
        pool,
        "synthetic-image-exhaustion-final-worker",
        30,
        credentialSecret,
        { root: assetRoot }
      )).resolves.toBe(true);
      await expect(getImageJob(pool, imageJob!.id)).resolves.toMatchObject({
        status: "recoverable",
        attempts: 2,
        maxAttempts: 2,
        errorCode: "image_generation_failed"
      });
      await expect(runImageJob(
        pool,
        "synthetic-image-exhaustion-extra-worker",
        30,
        credentialSecret,
        { root: assetRoot }
      )).resolves.toBe(false);

      expect(await acceptedStorySnapshot(imported.campaignId, storyJob.id)).toEqual(acceptedBeforeFailures);
      expect(storyRequests).toHaveLength(storyRequestCount);
    } finally {
      failImages = false;
    }
  });

  it("preserves the accepted story when the independent image endpoint fails", async () => {
    failImages = true;
    try {
      const imported = await campaign(1);
      const storyJob = await generate(imported.campaignId);
      const acceptedBefore = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM turns WHERE campaign_id = $1", [imported.campaignId]);
      const [imageJob] = await listCampaignImageJobs(pool, imported.campaignId);
      expect(imageJob).toMatchObject({ status: "queued", model: "synthetic-image-model" });
      expect(await processThroughTerminal(imageJob!.id, "synthetic-failing-image-worker")).toMatchObject({ status: "recoverable", errorCode: "image_generation_failed" });
      expect(await getGenerationJob(pool, storyJob.id)).toMatchObject({ status: "completed" });
      const acceptedAfter = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM turns WHERE campaign_id = $1", [imported.campaignId]);
      expect(acceptedAfter.rows[0]?.count).toBe(acceptedBefore.rows[0]?.count);
    } finally {
      failImages = false;
    }
  });

  it("persists a Sogni workflow ID, resumes polling, and stores the downloaded artifact", async () => {
    const sogniProviderId = (await createProvider(pool, {
      name: `Synthetic Sogni ${crypto.randomUUID()}`,
      providerType: "sogni",
      providerRole: "image",
      baseUrl,
      defaultModel: "flux2",
      contextWindowTokens: 32768,
      maxOutputTokens: 4096,
      temperature: 0,
      requestTimeoutMs: 30_000,
      apiKey: "synthetic-sogni-token",
      enabled: true,
      configuration: {
        pollIntervalMs: 1_000,
        maximumPollIntervalMs: 1_000,
        generationTimeoutMs: 30_000,
        defaultImageCount: 1,
        allowPrivateArtifactHosts: true
      }
    }, credentialSecret)).id;
    const imported = await campaign();
    const turn = await pool.query<{ id: string }>("SELECT id FROM turns WHERE campaign_id = $1 ORDER BY turn_number DESC LIMIT 1", [imported.campaignId]);
    const turnId = turn.rows[0]!.id;
    const queued = await enqueueIllustration(pool, turnId, {
      providerProfileId: sogniProviderId,
      model: "flux2",
      prompt: "A quiet violet sky above a luminous stone arch in an empty valley.",
      replace: true
    });

    await runImageJob(pool, "sogni-submit-worker", 30, credentialSecret, { root: assetRoot });
    expect(await getImageJob(pool, queued.id)).toMatchObject({ status: "provider_pending", remoteJobId: "wf_integration-1" });
    await pool.query("UPDATE image_jobs SET next_poll_at = now() WHERE id = $1", [queued.id]);
    await runImageJob(pool, "sogni-poll-worker", 30, credentialSecret, { root: assetRoot });

    expect(await getImageJob(pool, queued.id)).toMatchObject({
      status: "completed",
      providerProgress: 100,
      assetUrl: expect.stringMatching(/^\/api\/v1\/assets\//)
    });
    expect(sogniRequests).toHaveLength(1);
    expect(sogniRequests[0]?.idempotencyKey).toBe(`${queued.id}:0`);
    expect(JSON.stringify(sogniRequests[0]?.body)).not.toContain("synthetic-sogni-token");
  });
});
