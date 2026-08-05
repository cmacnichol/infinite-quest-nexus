import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { availableParallelism, hostname, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_WARMUPS = 5;
const DEFAULT_SAMPLES = 30;
const FIXTURE_SHAPES = Object.freeze({
  small: Object.freeze({ turns: 12, generationJobs: 4, imageJobs: 3 }),
  medium: Object.freeze({ turns: 200, generationJobs: 40, imageJobs: 20 }),
  long: Object.freeze({ turns: 2_000, generationJobs: 400, imageJobs: 100 })
});

function rounded(value, digits = 3) {
  return Number(value.toFixed(digits));
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const rank = Math.max(0, Math.ceil(fraction * ordered.length) - 1);
  return ordered[Math.min(rank, ordered.length - 1)] ?? 0;
}

function varianceRatio(values) {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function positiveInteger(value, fallback, maximum, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return parsed;
}

function temporaryDatabaseName() {
  const name = `iq_play_benchmark_${process.pid}_${randomBytes(4).toString("hex")}`;
  if (!/^iq_play_benchmark_\d+_[0-9a-f]{8}$/u.test(name)) {
    throw new Error("Refusing to use an unsafe play-loop benchmark database name.");
  }
  return name;
}

function quoteDatabaseName(name) {
  if (!/^iq_play_benchmark_\d+_[0-9a-f]{8}$/u.test(name)) {
    throw new Error("Refusing to quote an unsafe play-loop benchmark database name.");
  }
  return `"${name}"`;
}

function cgroupMemoryLimitGiB() {
  if (process.platform !== "linux") return null;
  for (const path of [
    "/sys/fs/cgroup/memory.max",
    "/sys/fs/cgroup/memory/memory.limit_in_bytes"
  ]) {
    try {
      const raw = readFileSync(path, "utf8").trim();
      if (raw === "max" || !/^\d+$/u.test(raw)) continue;
      const bytes = BigInt(raw);
      if (bytes <= 0n || bytes >= (1n << 60n)) continue;
      return rounded(Number(bytes) / (1024 ** 3));
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }
  return null;
}

function runtimeConfig(databaseUrl) {
  return {
    role: "api",
    host: "127.0.0.1",
    port: 8080,
    databaseUrl,
    databaseMaxConnections: 12,
    migrationDirectory: resolve("database/migrations"),
    migrationWaitSeconds: 30,
    allowMaintenanceMigrations: false,
    workerPollIntervalMs: 2_000,
    workerLeaseSeconds: 60,
    workerGenerationConcurrency: 1,
    legacyWebRoot: resolve("apps/web/public"),
    nextWebRoot: resolve("apps/web-next"),
    assetStorageDriver: "filesystem",
    assetStorageRoot: resolve("local-data/assets"),
    archiveStorageRoot: resolve("local-data/archives"),
    archivePreviewTtlSeconds: 1_800,
    systemArchiveArtifactTtlSeconds: 86_400,
    campaignArchiveLimits: {
      maxCompressedBytes: 2_147_483_648,
      maxUncompressedBytes: 21_474_836_480,
      maxEntries: 100_000,
      maxExpansionRatio: 100,
      maxManifestBytes: 5_242_880,
      maxJsonEntryBytes: 1_073_741_824,
      maxOriginalImageBytes: 26_214_400
    },
    systemArchiveLimits: {
      maxCompressedBytes: 53_687_091_200,
      maxUncompressedBytes: 214_748_364_800,
      maxEntries: 1_000_000,
      maxExpansionRatio: 100,
      maxManifestBytes: 5_242_880,
      maxJsonEntryBytes: 1_073_741_824,
      maxOriginalImageBytes: 26_214_400
    },
    credentialEncryptionKey: "play-loop-benchmark-only",
    security: {
      corsAllowedOrigins: [],
      providerNetworkAllowlist: ["localhost", "127.0.0.0/8", "::1/128"],
      cspImageAllowedOrigins: [],
      apiDefaultBodyLimitBytes: 1_048_576,
      apiImportBodyLimitBytes: 16_777_216,
      apiAssetBodyLimitBytes: 33_554_432,
      apiRateLimitWindowSeconds: 60,
      apiRateLimitProviderRequests: 10,
      apiRateLimitGenerationRequests: 12,
      apiRateLimitImportRequests: 4,
      apiConcurrencyProviderRequests: 2,
      apiConcurrencyImportRequests: 1,
      trustProxyHops: 0
    }
  };
}

function inertGenerationEvents() {
  return {
    async subscribe() {
      return {
        [Symbol.asyncIterator]() {
          return { next: async () => new Promise(() => undefined) };
        },
        async close() {}
      };
    }
  };
}

function statementText(query) {
  if (typeof query === "string") return query;
  if (query && typeof query === "object" && typeof query.text === "string") return query.text;
  return String(query);
}

function createQueryTracker() {
  let statements = [];
  return {
    record(query, values) {
      statements.push({ text: statementText(query), values: Array.isArray(values) ? [...values] : [] });
    },
    reset() {
      statements = [];
    },
    snapshot() {
      return statements.map((statement) => ({ ...statement, values: [...statement.values] }));
    }
  };
}

function trackedClient(client, tracker) {
  return new Proxy(client, {
    get(target, property) {
      if (property === "query") {
        return (query, values) => {
          tracker.record(query, values);
          return target.query(query, values);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

function trackedPool(pool, tracker) {
  return new Proxy(pool, {
    get(target, property) {
      if (property === "query") {
        return (query, values) => {
          tracker.record(query, values);
          return target.query(query, values);
        };
      }
      if (property === "connect") {
        return async () => trackedClient(await target.connect(), tracker);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

async function insertProvider(pool, ownerUserId) {
  const result = await pool.query(
    `INSERT INTO provider_profiles (
       owner_user_id, name, provider_type, provider_role, base_url, default_model,
       context_window_tokens, max_output_tokens, temperature, configuration, enabled
     ) VALUES ($1,$2,'openai_compatible','text','http://127.0.0.1:1','benchmark-model',
               32768,4096,0,'{}'::jsonb,true)
     RETURNING id`,
    [ownerUserId, `Play-loop benchmark ${randomBytes(6).toString("hex")}`]
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("Could not create the benchmark provider profile.");
  return id;
}

async function seedCampaign({ pool, importLegacyStory, memory, storyTemplate, ownerUserId, providerProfileId, label, shape }) {
  const identity = randomBytes(8).toString("hex");
  const story = structuredClone(storyTemplate);
  story.world.title = `Play Loop ${label} ${identity}`;
  const imported = await importLegacyStory(pool, {
    sourceName: `play-loop-${label}-${identity}.json`,
    story
  }, memory.generation);
  const { campaignId, worldId, worldVersionId } = imported;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM summary_checkpoints WHERE owner_user_id = $1 AND campaign_id = $2", [ownerUserId, campaignId]);
    await client.query("DELETE FROM chronicle_memories WHERE owner_user_id = $1 AND campaign_id = $2", [ownerUserId, campaignId]);
    await client.query("DELETE FROM turns WHERE owner_user_id = $1 AND campaign_id = $2", [ownerUserId, campaignId]);
    await client.query(
      `INSERT INTO turns (
         owner_user_id, campaign_id, turn_number, action, narration, choices,
         custom_action_suggestion, image_prompt, image_url, accepted_at, created_at
       )
       SELECT $1, $2, sequence,
              'Benchmark action ' || sequence,
              'Benchmark narration ' || sequence || ' preserves a deterministic fictional event in the observatory.',
              jsonb_build_array('Continue ' || sequence, 'Observe ' || sequence, 'Wait', 'Return'),
              'Continue through the observatory.',
              'A quiet observatory scene with emerald starlight.', '',
              timestamptz '2026-01-01 00:00:00+00' + sequence * interval '1 minute',
              timestamptz '2026-01-01 00:00:00+00' + sequence * interval '1 minute'
         FROM generate_series(1, $3::integer) sequence`,
      [ownerUserId, campaignId, shape.turns]
    );
    await client.query(
      `INSERT INTO chronicle_memories (
         owner_user_id, campaign_id, world_version_id, turn_id, memory_kind, ordinal,
         content, token_estimate, importance, entities, metadata
       )
       SELECT $1, $2, $3, turns.id, 'turn_fiction', turns.turn_number,
              'Chronicle benchmark memory for turn ' || turns.turn_number,
              12, 0.5, ARRAY['Observatory'], '{"benchmark":true}'::jsonb
         FROM turns
        WHERE owner_user_id = $1 AND campaign_id = $2`,
      [ownerUserId, campaignId, worldVersionId]
    );
    await client.query(
      `INSERT INTO provider_cost_events (
         owner_user_id, campaign_id, turn_id, provider_profile_id, local_call_id,
         provider_type, category, operation, requested_model, resolved_model,
         amount, currency, usage_metadata, occurred_at
       )
       SELECT $1, $2, turns.id, $3, gen_random_uuid(), 'openai_compatible',
              CASE turns.turn_number % 3 WHEN 0 THEN 'memory' WHEN 1 THEN 'story' ELSE 'image' END,
              'benchmark', 'benchmark-model', 'benchmark-model', 0.001, 'USD',
              jsonb_build_object('turnNumber', turns.turn_number), turns.accepted_at
         FROM turns
        WHERE owner_user_id = $1 AND campaign_id = $2`,
      [ownerUserId, campaignId, providerProfileId]
    );
    await client.query(
      `INSERT INTO generation_jobs (
         owner_user_id, campaign_id, provider_profile_id, idempotency_key,
         expected_turn_number, action, status, requested_model, result_turn_id,
         created_at, updated_at, completed_at
       )
       SELECT $1, $2, $3, 'benchmark-' || $4 || '-' || sequence,
              turns.turn_number, 'Generated benchmark turn ' || turns.turn_number,
              'completed', 'benchmark-model', turns.id,
              timestamptz '2026-02-01 00:00:00+00' + sequence * interval '1 minute',
              timestamptz '2026-02-01 00:00:00+00' + sequence * interval '1 minute',
              timestamptz '2026-02-01 00:00:00+00' + sequence * interval '1 minute'
         FROM generate_series(1, $5::integer) sequence
         JOIN turns ON turns.owner_user_id = $1 AND turns.campaign_id = $2
                   AND turns.turn_number = ((sequence - 1) % $6::integer) + 1`,
      [ownerUserId, campaignId, providerProfileId, identity, shape.generationJobs, shape.turns]
    );
    await client.query(
      `INSERT INTO image_jobs (
         owner_user_id, campaign_id, turn_id, provider_profile_id, requested_model,
         prompt, prompt_hash, status, provider_type, target_type, completed_at,
         created_at, updated_at
       )
       SELECT $1, $2, turns.id, $3, 'benchmark-image',
              'Fiction-only benchmark image prompt ' || turns.turn_number,
              md5($4 || ':' || turns.turn_number), 'completed', 'openai_compatible',
              'turn_illustration', timestamptz '2026-03-01 00:00:00+00' + turns.turn_number * interval '1 minute',
              timestamptz '2026-03-01 00:00:00+00' + turns.turn_number * interval '1 minute',
              timestamptz '2026-03-01 00:00:00+00' + turns.turn_number * interval '1 minute'
         FROM turns
        WHERE turns.owner_user_id = $1 AND turns.campaign_id = $2
          AND turns.turn_number <= $5::integer`,
      [ownerUserId, campaignId, providerProfileId, identity, shape.imageJobs]
    );
    await client.query(
      `UPDATE campaigns
          SET active_turn_number = $3,
              updated_at = timestamptz '2026-04-01 00:00:00+00'
        WHERE owner_user_id = $1 AND id = $2`,
      [ownerUserId, campaignId, shape.turns]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  const generation = await pool.query(
    `SELECT id FROM generation_jobs
      WHERE owner_user_id = $1 AND campaign_id = $2
      ORDER BY updated_at DESC, id DESC LIMIT 1`,
    [ownerUserId, campaignId]
  );
  const generationJobId = generation.rows[0]?.id;
  if (!generationJobId) throw new Error(`Could not seed the ${label} benchmark generation job.`);
  return { campaignId, worldId, worldVersionId, generationJobId };
}

async function seedFixtures(pool, dependencies) {
  const ownerUserId = await dependencies.initialOwnerId(pool);
  const providerProfileId = await insertProvider(pool, ownerUserId);
  const storyTemplate = JSON.parse(readFileSync(resolve("tests/fixtures/legacy-story.json"), "utf8"));
  const memory = dependencies.createApiMemoryApplication(pool, {
    credentialSecret: "play-loop-benchmark-only"
  });
  const campaigns = {};
  for (const [label, shape] of Object.entries(FIXTURE_SHAPES)) {
    campaigns[label] = await seedCampaign({
      pool,
      importLegacyStory: dependencies.importLegacyStory,
      memory,
      storyTemplate,
      ownerUserId,
      providerProfileId,
      label,
      shape
    });
  }
  await pool.query("ANALYZE");
  return { ownerUserId, providerProfileId, campaigns };
}

function summarizeSamples(samples) {
  const durations = samples.map((sample) => sample.durationMs);
  const payloads = samples.map((sample) => sample.payloadBytes);
  const queryCounts = [...new Set(samples.map((sample) => sample.queryCount))].sort((left, right) => left - right);
  return {
    sampleCount: samples.length,
    p50Ms: rounded(percentile(durations, 0.5)),
    p95Ms: rounded(percentile(durations, 0.95)),
    latencyVarianceRatio: rounded(varianceRatio(durations), 6),
    payloadBytesP50: percentile(payloads, 0.5),
    payloadBytesP95: percentile(payloads, 0.95),
    queryCount: Math.max(...queryCounts),
    queryCounts,
    errorRate: rounded(samples.filter((sample) => !sample.ok).length / Math.max(samples.length, 1), 6)
  };
}

async function measureRoute({ tracker, warmups, samples, request }) {
  for (let index = 0; index < warmups; index += 1) {
    tracker.reset();
    await request();
  }
  const measurements = [];
  for (let index = 0; index < samples; index += 1) {
    tracker.reset();
    const startedAt = performance.now();
    const responses = await request();
    const durationMs = performance.now() - startedAt;
    const list = Array.isArray(responses) ? responses : [responses];
    measurements.push({
      durationMs,
      payloadBytes: list.reduce((total, response) => total + Buffer.byteLength(response.body), 0),
      queryCount: tracker.snapshot().length,
      ok: list.every((response) => response.statusCode >= 200 && response.statusCode < 400)
    });
  }
  return summarizeSamples(measurements);
}

function collectPlanNodes(node, output) {
  output.push(node);
  for (const child of node.Plans ?? []) collectPlanNodes(child, output);
}

async function explainStatement(pool, name, statement) {
  const result = await pool.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.text}`,
    statement.values
  );
  const document = result.rows[0]?.["QUERY PLAN"]?.[0];
  const root = document?.Plan;
  if (!document || !root) throw new Error(`PostgreSQL did not return an EXPLAIN plan for ${name}.`);
  const nodes = [];
  collectPlanNodes(root, nodes);
  const sum = (key) => nodes.reduce((total, node) => total + Number(node[key] ?? 0), 0);
  return {
    name,
    planningTimeMs: rounded(Number(document["Planning Time"] ?? 0)),
    executionTimeMs: rounded(Number(document["Execution Time"] ?? 0)),
    actualRows: Number(root["Actual Rows"] ?? 0),
    nodeTypes: [...new Set(nodes.map((node) => String(node["Node Type"])))],
    sharedHitBlocks: sum("Shared Hit Blocks"),
    sharedReadBlocks: sum("Shared Read Blocks"),
    sharedWrittenBlocks: sum("Shared Written Blocks"),
    temporaryReadBlocks: sum("Temp Read Blocks"),
    temporaryWrittenBlocks: sum("Temp Written Blocks")
  };
}

async function captureStatements(tracker, request) {
  tracker.reset();
  const response = await request();
  if (response.statusCode < 200 || response.statusCode >= 400) {
    throw new Error(`Could not capture a successful route query plan: HTTP ${response.statusCode}.`);
  }
  return tracker.snapshot();
}

function findStatement(statements, predicate, name) {
  const statement = statements.find((candidate) => predicate(candidate.text));
  if (!statement) throw new Error(`Could not find the ${name} SQL statement in the measured route.`);
  return statement;
}

async function benchmarkDatabase(pool, databaseUrl, settings, dependencies) {
  const seeded = await seedFixtures(pool, dependencies);
  const tracker = createQueryTracker();
  const measuredPool = trackedPool(pool, tracker);
  const memory = dependencies.createApiMemoryApplication(measuredPool, {
    credentialSecret: "play-loop-benchmark-only"
  });
  const app = await dependencies.buildServer({
    config: runtimeConfig(databaseUrl),
    pool: measuredPool,
    generation: dependencies.createApiGenerationApplication(measuredPool),
    memory,
    worldCampaign: dependencies.createApiWorldCampaignApplication(measuredPool, {
      credentialSecret: "play-loop-benchmark-only"
    }),
    generationEvents: inertGenerationEvents()
  });
  try {
    await dependencies.initialOwnerId(measuredPool);
    tracker.reset();
    const longCampaign = seeded.campaigns.long;
    const firstPageResponse = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${longCampaign.campaignId}/turns?limit=50`
    });
    if (firstPageResponse.statusCode !== 200) throw new Error("Could not read the first benchmark history page.");
    const firstPage = firstPageResponse.json();
    if (!firstPage.nextCursor) throw new Error("The long benchmark campaign did not produce a continuation cursor.");
    const middleUrl = `/api/v1/campaigns/${longCampaign.campaignId}/turns?limit=50&before=${encodeURIComponent(firstPage.nextCursor)}`;
    const middlePageResponse = await app.inject({ method: "GET", url: middleUrl });
    const middlePage = middlePageResponse.json();
    if (!middlePage.nextCursor) throw new Error("The long benchmark campaign did not produce a middle cursor.");

    let lastUrl = middleUrl;
    let cursor = middlePage.nextCursor;
    let lastPage = middlePage;
    while (cursor) {
      lastUrl = `/api/v1/campaigns/${longCampaign.campaignId}/turns?limit=50&before=${encodeURIComponent(cursor)}`;
      const response = await app.inject({ method: "GET", url: lastUrl });
      if (response.statusCode !== 200) throw new Error("Could not walk the long benchmark history.");
      lastPage = response.json();
      cursor = lastPage.nextCursor;
    }

    const initialSyncResponse = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${longCampaign.campaignId}/sync-status`
    });
    if (initialSyncResponse.statusCode !== 200) throw new Error("Could not establish the benchmark sync token.");
    const initialSync = initialSyncResponse.json();
    const unchangedSyncUrl = `/api/v1/campaigns/${longCampaign.campaignId}/sync-status?since=${encodeURIComponent(initialSync.syncToken)}`;
    const firstHistoryUrl = `/api/v1/campaigns/${longCampaign.campaignId}/turns?limit=50`;
    const syncReplaceUrl = `/api/v1/campaigns/${longCampaign.campaignId}/sync-status`;
    const routes = {};
    const scenarios = {
      "campaign-list": () => app.inject({ method: "GET", url: "/api/v1/campaigns" }),
      dashboard: () => app.inject({ method: "GET", url: "/api/v1/dashboard/stats" }),
      "sync-replace": () => app.inject({ method: "GET", url: syncReplaceUrl }),
      "sync-unchanged": () => app.inject({ method: "GET", url: unchangedSyncUrl }),
      "history-first": () => app.inject({ method: "GET", url: firstHistoryUrl }),
      "history-middle": () => app.inject({ method: "GET", url: middleUrl }),
      "history-last": () => app.inject({ method: "GET", url: lastUrl }),
      "generation-poll": () => app.inject({ method: "GET", url: `/api/v1/generation-jobs/${longCampaign.generationJobId}` }),
      "generation-result": () => app.inject({ method: "GET", url: `/api/v1/generation-jobs/${longCampaign.generationJobId}/result` }),
      "initial-hydration": async () => [
        await app.inject({ method: "GET", url: "/api/v1/campaigns" }),
        await app.inject({ method: "GET", url: syncReplaceUrl })
      ]
    };
    for (const [name, request] of Object.entries(scenarios)) {
      routes[name] = await measureRoute({ tracker, ...settings, request });
    }

    const campaignStatements = await captureStatements(tracker, scenarios["campaign-list"]);
    const syncStatements = await captureStatements(tracker, scenarios["sync-replace"]);
    const historyStatements = await captureStatements(tracker, scenarios["history-middle"]);
    const plans = await Promise.all([
      explainStatement(pool, "campaign-list", findStatement(
        campaignStatements,
        (sql) => sql.includes('AS "costInformation"'),
        "campaign-list"
      )),
      explainStatement(pool, "sync-status", findStatement(
        syncStatements,
        (sql) => sql.includes('AS "pendingGenerationId"'),
        "sync-status"
      )),
      explainStatement(pool, "history-fingerprint", findStatement(
        historyStatements,
        (sql) => sql.includes('AS "historyVersion"'),
        "history-fingerprint"
      )),
      explainStatement(pool, "history-page", findStatement(
        historyStatements,
        (sql) => sql.includes('AS "turnNumber"') && sql.includes("LIMIT $5"),
        "history-page"
      ))
    ]);
    const version = await pool.query("SELECT version() AS version");
    const counts = await pool.query(
      `SELECT campaigns.id,
              (SELECT count(*)::int
                 FROM turns
                WHERE turns.campaign_id = campaigns.id
                  AND turns.owner_user_id = campaigns.owner_user_id) AS turns,
              (SELECT count(*)::int
                 FROM generation_jobs
                WHERE generation_jobs.campaign_id = campaigns.id
                  AND generation_jobs.owner_user_id = campaigns.owner_user_id) AS generation_jobs,
              (SELECT count(*)::int
                 FROM image_jobs
                WHERE image_jobs.campaign_id = campaigns.id
                  AND image_jobs.owner_user_id = campaigns.owner_user_id) AS image_jobs,
              (SELECT count(*)::int
                 FROM chronicle_memories
                WHERE chronicle_memories.campaign_id = campaigns.id
                  AND chronicle_memories.owner_user_id = campaigns.owner_user_id) AS chronicle_memories
         FROM campaigns
        WHERE campaigns.owner_user_id = $1 AND campaigns.id = ANY($2::uuid[])
        ORDER BY campaigns.id`,
      [seeded.ownerUserId, Object.values(seeded.campaigns).map((campaign) => campaign.campaignId)]
    );
    const countByCampaign = new Map(counts.rows.map((row) => [row.id, row]));
    return {
      postgresVersion: String(version.rows[0]?.version ?? "unknown"),
      routes,
      plans,
      fixture: {
        seed: "task-13b-c0-play-loop-v1",
        campaigns: Object.fromEntries(Object.entries(seeded.campaigns).map(([label, campaign]) => {
          const row = countByCampaign.get(campaign.campaignId);
          return [label, {
            turns: Number(row?.turns ?? 0),
            generationJobs: Number(row?.generation_jobs ?? 0),
            imageJobs: Number(row?.image_jobs ?? 0),
            chronicleMemories: Number(row?.chronicle_memories ?? 0)
          }];
        }))
      },
      boundedReadEvidence: {
        requestedLimit: 50,
        firstPageTurns: firstPage.turns.length,
        middlePageTurns: middlePage.turns.length,
        lastPageTurns: lastPage.turns.length,
        firstPageHasCursor: Boolean(firstPage.nextCursor),
        lastPageHasCursor: Boolean(lastPage.nextCursor),
        syncInitialTurns: initialSync.turns?.turns?.length ?? 0,
        syncInitialMode: initialSync.turnWindowMode
      }
    };
  } finally {
    await app.close();
  }
}

export async function runPlayLoopBenchmark(options = {}) {
  const databaseUrl = options.databaseUrl ?? process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for the play-loop benchmark.");
  process.env.LOG_LEVEL = "silent";
  const warmups = positiveInteger(
    options.warmups ?? process.env.PLAY_LOOP_BENCHMARK_WARMUPS,
    DEFAULT_WARMUPS,
    20,
    "PLAY_LOOP_BENCHMARK_WARMUPS"
  );
  const samples = positiveInteger(
    options.samples ?? process.env.PLAY_LOOP_BENCHMARK_SAMPLES,
    DEFAULT_SAMPLES,
    100,
    "PLAY_LOOP_BENCHMARK_SAMPLES"
  );
  const [poolModule, migrateModule, importModule, serverModule, compositionModule, memoryCompositionModule, worldCampaignCompositionModule] = await Promise.all([
    import("../packages/database/src/pool.ts"),
    import("../packages/database/src/migrate.ts"),
    import("../services/api/src/import-service.ts"),
    import("../services/api/src/server.ts"),
    import("../services/runtime/src/generation-api-composition.ts"),
    import("../services/runtime/src/memory-composition.ts"),
    import("../services/runtime/src/world-campaign-composition.ts")
  ]);
  const adminPool = poolModule.createDatabasePool(databaseUrl, 1);
  const databaseName = temporaryDatabaseName();
  const quotedName = quoteDatabaseName(databaseName);
  const benchmarkUrl = new URL(databaseUrl);
  benchmarkUrl.pathname = `/${databaseName}`;
  let pool;
  try {
    await adminPool.query(`CREATE DATABASE ${quotedName}`);
    pool = poolModule.createDatabasePool(benchmarkUrl.toString(), 12);
    await migrateModule.migrateDatabase(pool, resolve("database/migrations"));
    const measured = await benchmarkDatabase(pool, benchmarkUrl.toString(), { warmups, samples }, {
      initialOwnerId: poolModule.initialOwnerId,
      importLegacyStory: importModule.importLegacyStory,
      buildServer: serverModule.buildServer,
      createApiGenerationApplication: compositionModule.createApiGenerationApplication,
      createApiMemoryApplication: memoryCompositionModule.createApiMemoryApplication,
      createApiWorldCampaignApplication: worldCampaignCompositionModule.createApiWorldCampaignApplication
    });
    const cpuCount = availableParallelism();
    const memoryLimitGiB = cgroupMemoryLimitGiB();
    return {
      benchmark: "play-loop-reads-v1",
      generatedAt: new Date().toISOString(),
      profile: {
        target: { cpu: "2 vCPU", memory: "4 GiB" },
        targetSatisfied: cpuCount === 2 && memoryLimitGiB === 4,
        actual: {
          hostname: hostname(),
          availableCpuCount: cpuCount,
          cgroupMemoryLimitGiB: memoryLimitGiB,
          hostTotalMemoryGiB: rounded(totalmem() / (1024 ** 3)),
          platform: process.platform,
          architecture: process.arch,
          node: process.version
        }
      },
      warmups,
      samples,
      ...measured
    };
  } finally {
    if (pool) await pool.end().catch(() => undefined);
    try {
      await adminPool.query(`DROP DATABASE IF EXISTS ${quotedName}`);
    } finally {
      await adminPool.end();
    }
  }
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (invokedDirectly) {
  runPlayLoopBenchmark()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
