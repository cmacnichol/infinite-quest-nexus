import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { availableParallelism, cpus, hostname, totalmem } from "node:os";
import { performance } from "node:perf_hooks";

const CONCURRENCY_POINTS = [1, 2, 4];
const DEFAULT_WARMUPS = 5;
const DEFAULT_SAMPLES = 30;
const DEFAULT_GENERATION_JOBS = 12;
const DEFAULT_OPTIONAL_JOBS_PER_LANE = 3;
const DEFAULT_PROVIDER_DELAY_MS = 24;
const DEFAULT_OPTIONAL_DELAY_MS = 8;
const VARIANCE_RERUN_THRESHOLD = 0.05;
const OPTIONAL_LANES = ["illustration", "chronicle", "asset"];

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / Math.max(values.length, 1);
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  if (ordered.length === 0) return 0;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

function maximum(values) {
  return values.length === 0 ? 0 : Math.max(...values);
}

function rounded(value, digits = 6) {
  return Number(value.toFixed(digits));
}

export function summarizeConcurrencySamples(samples) {
  const throughputs = samples.map((sample) => sample.throughputJobsPerSecond);
  const throughputMean = mean(throughputs);
  const variance = mean(throughputs.map((value) => (value - throughputMean) ** 2));
  const throughputStandardDeviation = Math.sqrt(variance);
  return {
    sampleCount: samples.length,
    throughputMean: rounded(throughputMean),
    throughputMedian: rounded(median(throughputs)),
    throughputVarianceRatio: rounded(
      throughputMean === 0 ? 0 : throughputStandardDeviation / throughputMean
    ),
    durationMedianMs: rounded(median(samples.map((sample) => sample.durationMs ?? 0)), 3),
    queueLatencyMedianMs: rounded(median(samples.map((sample) => sample.queueLatencyMedianMs ?? 0)), 3),
    queueLatencyP95Ms: rounded(maximum(samples.map((sample) => sample.queueLatencyP95Ms ?? 0)), 3),
    databasePeakConnections: maximum(samples.map((sample) => sample.databasePeakConnections ?? 0)),
    databasePeakActiveConnections: maximum(samples.map((sample) => sample.databasePeakActiveConnections ?? 0)),
    peakGeneration: maximum(samples.map((sample) => sample.peakGeneration ?? 0)),
    peakIllustration: maximum(samples.map((sample) => sample.peakIllustration ?? 0)),
    peakChronicle: maximum(samples.map((sample) => sample.peakChronicle ?? 0)),
    peakAsset: maximum(samples.map((sample) => sample.peakAsset ?? 0)),
    completedGenerationJobs: samples.reduce((total, sample) => total + (sample.completedGenerationJobs ?? 0), 0),
    completedIllustrationJobs: samples.reduce((total, sample) => total + (sample.completedIllustrationJobs ?? 0), 0),
    completedChronicleJobs: samples.reduce((total, sample) => total + (sample.completedChronicleJobs ?? 0), 0),
    completedAssetJobs: samples.reduce((total, sample) => total + (sample.completedAssetJobs ?? 0), 0)
  };
}

export function assertNoDuplicateTurns(rows) {
  const duplicate = rows.find((row) => Number(row.commit_count) > 1);
  if (duplicate) {
    throw new Error(
      `Duplicate turn commit detected for campaign ${duplicate.campaign_id} turn ${duplicate.turn_number}.`
    );
  }
}

export function parseCgroupMemoryLimitGiB(rawLimit) {
  const normalized = rawLimit.trim();
  if (normalized === "max" || !/^\d+$/u.test(normalized)) return null;
  const bytes = BigInt(normalized);
  // Cgroup v1 represents an unlimited controller with a large sentinel;
  // cgroup v2 uses the `max` token handled above.
  if (bytes <= 0n || bytes >= (1n << 60n)) return null;
  return rounded(Number(bytes) / (1024 ** 3), 3);
}

function selfTest() {
  let duplicateGuard = "missed";
  try {
    assertNoDuplicateTurns([{
      campaign_id: "00000000-0000-4000-8000-000000000001",
      turn_number: 1,
      commit_count: 2
    }]);
  } catch {
    duplicateGuard = "rejected";
  }
  return {
    mode: "self-test",
    duplicateGuard,
    cgroupMemoryLimitParsing: {
      fourGiB: parseCgroupMemoryLimitGiB("4294967296\n"),
      unlimited: parseCgroupMemoryLimitGiB("max\n"),
      invalid: parseCgroupMemoryLimitGiB("not-a-limit\n")
    },
    summary: summarizeConcurrencySamples([
      { throughputJobsPerSecond: 10 },
      { throughputJobsPerSecond: 12 },
      { throughputJobsPerSecond: 14 }
    ])
  };
}

function positiveIntegerEnvironment(name, fallback, maximum) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/u.test(raw.trim())) throw new Error(`${name} must be a positive integer.`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}.`);
  }
  return parsed;
}

function processAddressSpaceLimitGiB() {
  if (process.platform !== "linux") return null;
  const line = readFileSync("/proc/self/limits", "utf8")
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith("Max address space"));
  if (!line) return null;
  const fields = line.trim().split(/\s+/u);
  const softLimit = fields.at(-3);
  if (!softLimit || softLimit === "unlimited") return null;
  const bytes = Number(softLimit);
  return Number.isFinite(bytes) ? rounded(bytes / (1024 ** 3), 3) : null;
}

function cgroupMemoryLimitGiB() {
  if (process.platform !== "linux") return null;
  for (const path of [
    "/sys/fs/cgroup/memory.max",
    "/sys/fs/cgroup/memory/memory.limit_in_bytes"
  ]) {
    try {
      const limit = parseCgroupMemoryLimitGiB(readFileSync(path, "utf8"));
      if (limit !== null) return limit;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }
  return null;
}

function uuidFromSeed(seed) {
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function safeSchemaName() {
  const schema = `worker_benchmark_${process.pid}_${randomBytes(4).toString("hex")}`;
  if (!/^worker_benchmark_\d+_[0-9a-f]{8}$/u.test(schema)) {
    throw new Error("Refusing to use an unsafe benchmark schema name.");
  }
  return schema;
}

function quotedSchema(schema) {
  if (!/^worker_benchmark_\d+_[0-9a-f]{8}$/u.test(schema)) {
    throw new Error("Refusing to quote an unsafe benchmark schema name.");
  }
  return `"${schema}"`;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function createBenchmarkTables(pool, schema) {
  const namespace = quotedSchema(schema);
  await pool.query(`CREATE SCHEMA ${namespace}`);
  await pool.query(`CREATE TABLE ${namespace}.generation_jobs (
    id uuid PRIMARY KEY,
    campaign_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    provider_profile_id uuid NOT NULL,
    expected_turn_number integer NOT NULL,
    status text NOT NULL CHECK (status IN ('queued','assessing','completed')),
    worker_id text,
    created_at timestamptz NOT NULL,
    claimed_at timestamptz,
    completed_at timestamptz
  )`);
  await pool.query(`CREATE TABLE ${namespace}.turn_commits (
    campaign_id uuid NOT NULL,
    turn_number integer NOT NULL,
    generation_job_id uuid NOT NULL UNIQUE,
    committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (campaign_id, turn_number)
  )`);
  await pool.query(`CREATE TABLE ${namespace}.optional_jobs (
    id uuid PRIMARY KEY,
    lane text NOT NULL CHECK (lane IN ('illustration','chronicle','asset')),
    status text NOT NULL CHECK (status IN ('queued','running','completed')),
    created_at timestamptz NOT NULL,
    claimed_at timestamptz,
    completed_at timestamptz
  )`);
}

async function seedSample(pool, schema, seed, generationJobCount, optionalJobsPerLane) {
  const namespace = quotedSchema(schema);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`TRUNCATE ${namespace}.turn_commits, ${namespace}.generation_jobs, ${namespace}.optional_jobs`);
    for (let index = 0; index < generationJobCount; index += 1) {
      await client.query(
        `INSERT INTO ${namespace}.generation_jobs (
           id, campaign_id, owner_user_id, provider_profile_id,
           expected_turn_number, status, created_at
         ) VALUES ($1,$2,$3,$4,1,'queued',clock_timestamp() + ($5::text || ' microseconds')::interval)`,
        [
          uuidFromSeed(`${seed}:job:${index}`),
          uuidFromSeed(`${seed}:campaign:${index}`),
          uuidFromSeed(`${seed}:owner`),
          uuidFromSeed(`${seed}:provider`),
          index
        ]
      );
    }
    for (const lane of OPTIONAL_LANES) {
      for (let index = 0; index < optionalJobsPerLane; index += 1) {
        await client.query(
          `INSERT INTO ${namespace}.optional_jobs (id, lane, status, created_at)
           VALUES ($1,$2,'queued',clock_timestamp() + ($3::text || ' microseconds')::interval)`,
          [uuidFromSeed(`${seed}:${lane}:${index}`), lane, index]
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function createMetrics() {
  return {
    generation: { active: 0, peak: 0, completed: 0 },
    illustration: { active: 0, peak: 0, completed: 0 },
    chronicle: { active: 0, peak: 0, completed: 0 },
    asset: { active: 0, peak: 0, completed: 0 }
  };
}

function enterMetric(metric) {
  metric.active += 1;
  metric.peak = Math.max(metric.peak, metric.active);
}

function leaveMetric(metric, completed) {
  metric.active -= 1;
  if (completed) metric.completed += 1;
}

function createGenerationApplication(pool, schema, metrics, providerDelayMs) {
  const namespace = quotedSchema(schema);
  return {
    async claimNext({ workerId }) {
      const result = await pool.query(
        `WITH candidate AS (
           SELECT id FROM ${namespace}.generation_jobs
            WHERE status = 'queued'
            ORDER BY created_at, id
            FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE ${namespace}.generation_jobs jobs
            SET status = 'assessing', worker_id = $1, claimed_at = clock_timestamp()
           FROM candidate WHERE jobs.id = candidate.id
         RETURNING jobs.id, jobs.campaign_id, jobs.owner_user_id,
                   jobs.provider_profile_id, jobs.expected_turn_number`,
        [workerId]
      );
      const row = result.rows[0];
      return row ? {
        jobId: row.id,
        campaignId: row.campaign_id,
        ownerUserId: row.owner_user_id,
        providerProfileId: row.provider_profile_id,
        expectedTurnNumber: row.expected_turn_number,
        operationKind: "append",
        replacementTurnId: null,
        attempts: 1
      } : null;
    },
    async executeClaimed({ workerId, claim }) {
      enterMetric(metrics.generation);
      let committed = false;
      try {
        const deterministicOffset = Number.parseInt(claim.jobId.at(-1), 16) % 3;
        await delay(providerDelayMs + deterministicOffset);
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const guarded = await client.query(
            `UPDATE ${namespace}.generation_jobs
                SET status = 'completed', completed_at = clock_timestamp()
              WHERE id = $1 AND worker_id = $2 AND status = 'assessing'
              RETURNING campaign_id, expected_turn_number`,
            [claim.jobId, workerId]
          );
          if (!guarded.rows[0]) {
            await client.query("ROLLBACK");
            return false;
          }
          await client.query(
            `INSERT INTO ${namespace}.turn_commits (
               campaign_id, turn_number, generation_job_id
             ) VALUES ($1,$2,$3)`,
            [guarded.rows[0].campaign_id, guarded.rows[0].expected_turn_number, claim.jobId]
          );
          await client.query("COMMIT");
          committed = true;
          return true;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      } finally {
        leaveMetric(metrics.generation, committed);
      }
    }
  };
}

function createOptionalLane(pool, schema, lane, metrics, optionalDelayMs) {
  const namespace = quotedSchema(schema);
  return async () => {
    const claimed = await pool.query(
      `WITH candidate AS (
         SELECT id FROM ${namespace}.optional_jobs
          WHERE lane = $1 AND status = 'queued'
          ORDER BY created_at, id
          FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE ${namespace}.optional_jobs jobs
          SET status = 'running', claimed_at = clock_timestamp()
         FROM candidate WHERE jobs.id = candidate.id
       RETURNING jobs.id`,
      [lane]
    );
    const jobId = claimed.rows[0]?.id;
    if (!jobId) return false;
    const metric = metrics[lane];
    enterMetric(metric);
    let completed = false;
    try {
      await delay(optionalDelayMs + OPTIONAL_LANES.indexOf(lane));
      const result = await pool.query(
        `UPDATE ${namespace}.optional_jobs
            SET status = 'completed', completed_at = clock_timestamp()
          WHERE id = $1 AND status = 'running' RETURNING id`,
        [jobId]
      );
      completed = result.rows.length === 1;
      return completed;
    } finally {
      leaveMetric(metric, completed);
    }
  };
}

async function sampleDatabaseUsage(pool, applicationName, samples, running) {
  while (running.value) {
    const result = await pool.query(
      `SELECT count(*)::int AS connections,
              count(*) FILTER (WHERE state = 'active')::int AS active_connections
         FROM pg_stat_activity WHERE application_name = $1`,
      [applicationName]
    );
    samples.push({
      connections: Number(result.rows[0]?.connections ?? 0),
      activeConnections: Number(result.rows[0]?.active_connections ?? 0)
    });
    await delay(2);
  }
}

async function waitForCompletion(pool, schema, generationJobCount, optionalJobCount, timeoutMs) {
  const namespace = quotedSchema(schema);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM ${namespace}.generation_jobs WHERE status = 'completed') AS generations,
         (SELECT count(*)::int FROM ${namespace}.optional_jobs WHERE status = 'completed') AS optional_jobs`
    );
    if (Number(result.rows[0]?.generations) === generationJobCount
      && Number(result.rows[0]?.optional_jobs) === optionalJobCount) return;
    await delay(2);
  }
  throw new Error(`Worker benchmark sample did not complete within ${timeoutMs} ms.`);
}

async function runSample({
  pool,
  schema,
  applicationName,
  concurrency,
  seed,
  generationJobCount,
  optionalJobsPerLane,
  providerDelayMs,
  optionalDelayMs,
  runWorker
}) {
  await seedSample(pool, schema, seed, generationJobCount, optionalJobsPerLane);
  const metrics = createMetrics();
  const controller = new AbortController();
  const databaseSamples = [];
  const databaseSamplerState = { value: true };
  const databaseSampler = sampleDatabaseUsage(
    pool,
    applicationName,
    databaseSamples,
    databaseSamplerState
  );
  const startedAt = performance.now();
  const running = runWorker(pool, {
    workerGenerationConcurrency: concurrency,
    workerLeaseSeconds: 30,
    workerPollIntervalMs: 2,
    credentialEncryptionKey: "benchmark-no-provider-secret",
    assetStorageRoot: "/tmp/infinite-quest-benchmark-unused"
  }, controller.signal, {
    generation: createGenerationApplication(pool, schema, metrics, providerDelayMs),
    optionalLanes: {
      illustration: createOptionalLane(pool, schema, "illustration", metrics, optionalDelayMs),
      chronicle: createOptionalLane(pool, schema, "chronicle", metrics, optionalDelayMs),
      asset: createOptionalLane(pool, schema, "asset", metrics, optionalDelayMs)
    }
  });

  try {
    await waitForCompletion(
      pool,
      schema,
      generationJobCount,
      optionalJobsPerLane * OPTIONAL_LANES.length,
      30_000
    );
  } finally {
    controller.abort();
    await running;
    databaseSamplerState.value = false;
    await databaseSampler;
  }
  const durationMs = performance.now() - startedAt;
  const namespace = quotedSchema(schema);
  const latency = await pool.query(
    `SELECT
       percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (claimed_at - created_at)) * 1000)::double precision AS median_ms,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (claimed_at - created_at)) * 1000)::double precision AS p95_ms
       FROM ${namespace}.generation_jobs`
  );
  const duplicates = await pool.query(
    `SELECT campaign_id, turn_number, count(*)::int AS commit_count
       FROM ${namespace}.turn_commits
      GROUP BY campaign_id, turn_number HAVING count(*) > 1`
  );
  assertNoDuplicateTurns(duplicates.rows);
  if (metrics.generation.completed !== generationJobCount) {
    throw new Error(`Expected ${generationJobCount} completed generations, got ${metrics.generation.completed}.`);
  }
  if (metrics.generation.peak > concurrency) {
    throw new Error(`Provider concurrency ${metrics.generation.peak} exceeded configured limit ${concurrency}.`);
  }
  for (const lane of OPTIONAL_LANES) {
    if (metrics[lane].peak > 1 || metrics[lane].completed !== optionalJobsPerLane) {
      throw new Error(`Optional lane ${lane} violated its capacity or completion contract.`);
    }
  }
  return {
    durationMs: rounded(durationMs, 3),
    throughputJobsPerSecond: rounded(generationJobCount / (durationMs / 1000)),
    queueLatencyMedianMs: rounded(Number(latency.rows[0]?.median_ms ?? 0), 3),
    queueLatencyP95Ms: rounded(Number(latency.rows[0]?.p95_ms ?? 0), 3),
    databasePeakConnections: maximum(databaseSamples.map((sample) => sample.connections)),
    databasePeakActiveConnections: maximum(databaseSamples.map((sample) => sample.activeConnections)),
    peakGeneration: metrics.generation.peak,
    peakIllustration: metrics.illustration.peak,
    peakChronicle: metrics.chronicle.peak,
    peakAsset: metrics.asset.peak,
    completedGenerationJobs: metrics.generation.completed,
    completedIllustrationJobs: metrics.illustration.completed,
    completedChronicleJobs: metrics.chronicle.completed,
    completedAssetJobs: metrics.asset.completed
  };
}

async function runBatch(options, batchIndex) {
  for (let index = 0; index < options.warmups; index += 1) {
    await runSample({ ...options, seed: `${options.seed}:batch:${batchIndex}:warmup:${index}` });
  }
  const samples = [];
  for (let index = 0; index < options.samples; index += 1) {
    samples.push(await runSample({
      ...options,
      seed: `${options.seed}:batch:${batchIndex}:sample:${index}`
    }));
  }
  return {
    batchIndex,
    summary: summarizeConcurrencySamples(samples),
    samples
  };
}

async function runConcurrencyPoint(databaseUrl, concurrency, settings, runWorker, createDatabasePool) {
  const applicationName = `iq_worker_benchmark_${process.pid}_${concurrency}`;
  const configuredUrl = new URL(databaseUrl);
  configuredUrl.searchParams.set("application_name", applicationName);
  const databaseMaxConnections = concurrency + 4;
  const pool = createDatabasePool(configuredUrl.toString(), databaseMaxConnections);
  const schema = safeSchemaName();
  try {
    await createBenchmarkTables(pool, schema);
    const options = {
      pool,
      schema,
      applicationName,
      concurrency,
      generationJobCount: settings.generationJobCount,
      optionalJobsPerLane: settings.optionalJobsPerLane,
      providerDelayMs: settings.providerDelayMs,
      optionalDelayMs: settings.optionalDelayMs,
      warmups: settings.warmups,
      samples: settings.samples,
      seed: `${settings.seed}:concurrency:${concurrency}`,
      runWorker
    };
    const batches = [await runBatch(options, 0)];
    if (batches[0].summary.throughputVarianceRatio > VARIANCE_RERUN_THRESHOLD) {
      batches.push(await runBatch(options, 1), await runBatch(options, 2));
    }
    const selected = [...batches]
      .sort((left, right) => left.summary.throughputMedian - right.summary.throughputMedian)
      [Math.floor(batches.length / 2)];
    return {
      concurrency,
      replicaCount: 1,
      databaseMaxConnections,
      providerLimit: concurrency,
      providerDelayMs: settings.providerDelayMs,
      optionalLaneCapacity: { illustration: 1, chronicle: 1, asset: 1 },
      optionalDelayMs: settings.optionalDelayMs,
      variancePolicy: {
        thresholdRatio: VARIANCE_RERUN_THRESHOLD,
        batchCount: batches.length,
        selection: batches.length === 1 ? "single_batch" : "median_of_three_batches",
        selectedBatchIndex: selected.batchIndex
      },
      selected: selected.summary,
      batches
    };
  } finally {
    const namespace = quotedSchema(schema);
    await pool.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
    await pool.end();
  }
}

async function runBenchmark() {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for the worker concurrency benchmark.");
  }
  process.env.LOG_LEVEL = "silent";
  const [{ createDatabasePool }, { runWorker }] = await Promise.all([
    import("../packages/database/src/pool.ts"),
    import("../services/worker/src/worker.ts")
  ]);
  const settings = {
    seed: process.env.WORKER_BENCHMARK_SEED?.trim() || "task-12-c0-worker-v1",
    warmups: positiveIntegerEnvironment("WORKER_BENCHMARK_WARMUPS", DEFAULT_WARMUPS, 20),
    samples: positiveIntegerEnvironment("WORKER_BENCHMARK_SAMPLES", DEFAULT_SAMPLES, 100),
    generationJobCount: positiveIntegerEnvironment(
      "WORKER_BENCHMARK_GENERATION_JOBS",
      DEFAULT_GENERATION_JOBS,
      100
    ),
    optionalJobsPerLane: positiveIntegerEnvironment(
      "WORKER_BENCHMARK_OPTIONAL_JOBS_PER_LANE",
      DEFAULT_OPTIONAL_JOBS_PER_LANE,
      50
    ),
    providerDelayMs: positiveIntegerEnvironment(
      "WORKER_BENCHMARK_PROVIDER_DELAY_MS",
      DEFAULT_PROVIDER_DELAY_MS,
      10_000
    ),
    optionalDelayMs: positiveIntegerEnvironment(
      "WORKER_BENCHMARK_OPTIONAL_DELAY_MS",
      DEFAULT_OPTIONAL_DELAY_MS,
      10_000
    )
  };
  const results = [];
  for (const concurrency of CONCURRENCY_POINTS) {
    results.push(await runConcurrencyPoint(
      databaseUrl,
      concurrency,
      settings,
      runWorker,
      createDatabasePool
    ));
  }
  const availableCpuCount = availableParallelism();
  const cgroupMemoryLimit = cgroupMemoryLimitGiB();
  const addressSpaceLimit = processAddressSpaceLimitGiB();
  const effectiveMemoryLimitGiB = cgroupMemoryLimit ?? addressSpaceLimit;
  return {
    benchmark: "worker-concurrency-v1",
    generatedAt: new Date().toISOString(),
    profile: {
      target: { cpu: "2 vCPU", memory: "4 GiB" },
      targetSatisfied: availableCpuCount === 2 && effectiveMemoryLimitGiB === 4,
      actual: {
        hostname: hostname(),
        availableCpuCount,
        cgroupMemoryLimitGiB: cgroupMemoryLimit,
        processAddressSpaceLimitGiB: addressSpaceLimit,
        effectiveMemoryLimitGiB,
        hostLogicalCpuCount: cpus().length,
        hostTotalMemoryGiB: rounded(totalmem() / (1024 ** 3), 3),
        platform: process.platform,
        architecture: process.arch,
        node: process.version
      },
      fixture: {
        seed: settings.seed,
        generationJobsPerSample: settings.generationJobCount,
        optionalJobsPerLanePerSample: settings.optionalJobsPerLane,
        warmupsPerBatch: settings.warmups,
        measuredSamplesPerBatch: settings.samples
      }
    },
    duplicateTurnGuard: "passed",
    results
  };
}

function compactBenchmarkResult(result) {
  return {
    ...result,
    results: result.results.map((scenario) => ({
      ...scenario,
      batches: scenario.batches.map((batch) => ({
        batchIndex: batch.batchIndex,
        summary: batch.summary
      }))
    }))
  };
}

if (process.argv.includes("--self-test")) {
  process.stdout.write(`${JSON.stringify(selfTest())}\n`);
} else {
  runBenchmark()
    .then((result) => process.stdout.write(`${JSON.stringify(
      process.argv.includes("--summary") ? compactBenchmarkResult(result) : result,
      null,
      2
    )}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
