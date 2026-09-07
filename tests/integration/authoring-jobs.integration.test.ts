import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { authoringSubmitSchema } from "../../packages/contracts/src/index.js";
import { createRuntimeAuthoringApplication } from "../../services/runtime/src/authoring-composition.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createProvider } from "../helpers/provider-application-fixtures.js";
import fixture from "../fixtures/authoring/reliability.json" with { type: "json" };

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const credentialSecret = "authoring-process-test-credential-secret";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function runWorkerProcess(limit: number, crashBeforeCheckpoint = false, crashAfterCheckpoint = false): Promise<{ completed: number; runs: boolean[] }> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "tests/helpers/authoring-worker-process.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEST_DATABASE_URL: databaseUrl!,
        AUTHORING_PROCESS_CREDENTIAL_SECRET: credentialSecret,
        AUTHORING_PROCESS_LIMIT: String(limit),
        AUTHORING_PROCESS_CRASH_BEFORE_CHECKPOINT: String(crashBeforeCheckpoint),
        AUTHORING_PROCESS_CRASH_AFTER_CHECKPOINT: String(crashAfterCheckpoint)
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (crashAfterCheckpoint && code === 87) {
        if (stdout !== "") {
          reject(new Error("Interrupted worker unexpectedly reported completion."));
          return;
        }
        resolveProcess({ completed: 0, runs: [] });
        return;
      }
      if (crashBeforeCheckpoint && code === 86) {
        resolveProcess({ completed: 0, runs: [] });
        return;
      }
      if (code !== 0 || signal) {
        reject(new Error(`Worker process exited unexpectedly (${code ?? signal}): ${stderr}`));
        return;
      }
      try { resolveProcess(JSON.parse(stdout.trim()) as { completed: number; runs: boolean[] }); }
      catch { reject(new Error(`Worker process did not produce a result: ${stdout}`)); }
    });
  });
}

integration("durable authoring process restart", () => {
  let pool: DatabasePool;
  let ownerUserId: string;
  let provider: Server;
  let providerPort: number;
  const requestedStages: string[] = [];

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 6);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    provider = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const parsed = JSON.parse(body) as { messages?: Array<{ content?: string }> };
        const text = parsed.messages?.map((message) => message.content ?? "").join("\n") ?? "";
        const characterId = /char-\d+-synthetic-explorer-\d+/u.exec(text)?.[0];
        requestedStages.push(characterId ? `character:${characterId}` : "world");
        const content = characterId
          ? JSON.stringify({ ...fixture.character, id: characterId, name: characterId.replace(/^char-\d+-/u, "").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) })
          : JSON.stringify(fixture.world);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ id: randomUUID(), choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] }));
      });
    });
    await new Promise<void>((ready) => provider.listen(0, "127.0.0.1", ready));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("Deterministic authoring provider did not listen.");
    providerPort = address.port;
  });

  afterEach(async () => {
    requestedStages.length = 0;
    await pool.query("DELETE FROM authoring_jobs WHERE owner_user_id = $1", [ownerUserId]);
    await pool.query("DELETE FROM provider_profiles WHERE owner_user_id = $1 AND name = 'P2.10 deterministic process provider'", [ownerUserId]);
  });

  afterAll(async () => {
    await pool?.end();
    if (provider) await new Promise<void>((done) => provider.close(() => done()));
  });

  async function submitProcessWorld() {
    const profile = await createProvider(pool, {
      name: "P2.10 deterministic process provider",
      providerType: "openai_compatible",
      providerRole: "text",
      baseUrl: `http://127.0.0.1:${providerPort}/v1`,
      defaultModel: "deterministic-authoring",
      contextWindowTokens: 32_768,
      maxOutputTokens: 4_096,
      temperature: 0,
      enabled: true,
      isDefault: true,
      configuration: {}
    }, credentialSecret);
    const application = createRuntimeAuthoringApplication(pool, sha256);
    const job = await application.submit({ ownerUserId }, authoringSubmitSchema.parse({
      kind: "world_concept",
      idempotencyKey: randomUUID(),
      target: { kind: "new_world" },
      prompt: "Create the synthetic glass road world."
    }));
    return { application, job, profile };
  }

  it("replaces a stopped worker process after a child checkpoint without replaying persisted stages", async () => {
    const { application, job } = await submitProcessWorld();

    expect(await runWorkerProcess(2)).toEqual({ completed: 2, runs: [true, true] });
    const before = await pool.query<{ stage_key: string; bytes: string }>(
      "SELECT stage_key, output::text AS bytes FROM authoring_job_stages WHERE job_id = $1 AND status = 'validated' ORDER BY stage_key",
      [job.id]
    );
    const beforeHashes = before.rows.map((row) => ({
      key: row.stage_key,
      hash: sha256(row.bytes),
      bytes: Buffer.byteLength(row.bytes, "utf8")
    }));
    expect(beforeHashes.map((row) => row.key)).toEqual(["character:char-1-synthetic-explorer-1", "world"]);
    expect(requestedStages).toEqual(["world", "character:char-1-synthetic-explorer-1"]);

    expect(await runWorkerProcess(4)).toEqual({ completed: 2, runs: [true, true, false] });
    const after = await pool.query<{ stage_key: string; bytes: string }>(
      "SELECT stage_key, output::text AS bytes FROM authoring_job_stages WHERE job_id = $1 AND status = 'validated' ORDER BY stage_key",
      [job.id]
    );
    const afterByKey = new Map(after.rows.map((row) => [row.stage_key, {
      hash: sha256(row.bytes), bytes: Buffer.byteLength(row.bytes, "utf8")
    }]));
    for (const stage of beforeHashes) expect(afterByKey.get(stage.key)).toEqual({ hash: stage.hash, bytes: stage.bytes });
    process.stdout.write(`${JSON.stringify({ boundary: "worker-process-replacement", beforeHashes, afterHashes: Object.fromEntries(afterByKey) })}\n`);
    expect(requestedStages).toEqual([
      "world",
      "character:char-1-synthetic-explorer-1",
      "character:char-2-synthetic-explorer-2",
      "character:char-3-synthetic-explorer-3"
    ]);
    expect((await application.get({ ownerUserId }, job.id))?.status).toBe("awaiting_review");
  });

  it("recovers an OS worker exit after successful HTTP provider validation but before checkpoint", async () => {
    const { application, job } = await submitProcessWorld();
    expect(await runWorkerProcess(1, true)).toEqual({ completed: 0, runs: [] });
    expect(requestedStages).toEqual(["world"]);
    const interrupted = await pool.query("SELECT status, output, attempt_count FROM authoring_job_stages WHERE job_id = $1", [job.id]);
    expect(interrupted.rows).toEqual([{ status: "running", output: null, attempt_count: 1 }]);
    await pool.query("UPDATE authoring_job_stages SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE job_id = $1", [job.id]);
    expect(await runWorkerProcess(5)).toEqual({ completed: 4, runs: [true, true, true, true, false] });
    expect(requestedStages).toEqual(["world", "world", "character:char-1-synthetic-explorer-1", "character:char-2-synthetic-explorer-2", "character:char-3-synthetic-explorer-3"]);
    expect((await application.get({ ownerUserId }, job.id))?.status).toBe("awaiting_review");
    const stages = await pool.query("SELECT stage_key, status FROM authoring_job_stages WHERE job_id = $1", [job.id]);
    expect(stages.rows).toHaveLength(4);
    expect(stages.rows.every(row => row.status === "validated")).toBe(true);
  });

  it("retains a committed child checkpoint after OS exit before checkpoint returns to the worker", async () => {
    const { application, job } = await submitProcessWorld();
    expect(await runWorkerProcess(1)).toEqual({ completed: 1, runs: [true] });
    const readOutputs = async () => (await pool.query<{ stage_key: string; bytes: string }>(
      "SELECT stage_key, output::text AS bytes FROM authoring_job_stages WHERE job_id = $1 AND status = 'validated' ORDER BY stage_key", [job.id]
    )).rows;
    const beforeCrash = await readOutputs();
    expect(beforeCrash.map(row => row.stage_key)).toEqual(["world"]);

    // Exit 87 is accepted only after real checkpoint SQL commits, before the
    // wrapper returns to runNext; the interrupted process emits no completion.
    expect(await runWorkerProcess(1, false, true)).toEqual({ completed: 0, runs: [] });
    const afterCommit = await readOutputs();
    expect(afterCommit.map(row => row.stage_key)).toEqual(["character:char-1-synthetic-explorer-1", "world"]);
    expect(afterCommit.find(row => row.stage_key === "world")).toEqual(beforeCrash[0]);
    expect(requestedStages).toEqual(["world", "character:char-1-synthetic-explorer-1"]);

    // No lease-expiry manipulation: the committed child is immediately reusable.
    expect(await runWorkerProcess(4)).toEqual({ completed: 2, runs: [true, true, false] });
    const afterReplacement = await readOutputs();
    for (const row of afterCommit) expect(afterReplacement.find(candidate => candidate.stage_key === row.stage_key)).toEqual(row);
    const hashes = (rows: typeof afterCommit) => rows.map(row => ({ key: row.stage_key, hash: sha256(row.bytes), bytes: Buffer.byteLength(row.bytes, "utf8") }));
    const retainedAfterReplacement = afterReplacement.filter(row => afterCommit.some(committed => committed.stage_key === row.stage_key));
    expect(hashes(retainedAfterReplacement)).toEqual(hashes(afterCommit));
    expect(requestedStages).toEqual(["world", "character:char-1-synthetic-explorer-1", "character:char-2-synthetic-explorer-2", "character:char-3-synthetic-explorer-3"]);
    expect((await application.get({ ownerUserId }, job.id))?.status).toBe("awaiting_review");
    process.stdout.write(`${JSON.stringify({ boundary: "checkpoint-committed-before-worker-return", exitCode: 87, completionReported: false, beforeHashes: hashes(afterCommit), afterHashes: hashes(retainedAfterReplacement), requestedStages })}\n`);
  });

  it("keeps checkpoints and fails safely when the pinned provider is deleted between worker processes", async () => {
    const { application, job, profile } = await submitProcessWorld();
    expect(await runWorkerProcess(1)).toEqual({ completed: 1, runs: [true] });
    const before = (await pool.query("SELECT output::text AS bytes FROM authoring_job_stages WHERE job_id = $1 AND stage_key = 'world'", [job.id])).rows[0]!.bytes;
    await pool.query("DELETE FROM provider_profiles WHERE id = $1", [profile.id]);
    for (let index = 0; index < 3; index += 1) {
      expect(await runWorkerProcess(1)).toEqual({ completed: 0, runs: [false] });
    }
    expect(requestedStages).toEqual(["world"]);
    const current = await application.get({ ownerUserId }, job.id);
    expect(current?.status).toBe("recoverable");
    // A failed stage makes the proposal recoverable; further queued stages wait
    // for explicit recovery rather than repeatedly calling a missing provider.
    expect(current?.stages.filter(stage => stage.key !== "world").map(stage => ({ status: stage.status, failure: stage.failure })))
      .toEqual([
        { status: "recoverable", failure: { code: "authoring_provider_unavailable", stage: "character", retryable: true, issues: [] } },
        { status: "queued", failure: undefined }, { status: "queued", failure: undefined }
      ]);
    expect((await pool.query("SELECT output::text AS bytes FROM authoring_job_stages WHERE job_id = $1 AND stage_key = 'world'", [job.id])).rows[0]!.bytes).toBe(before);
  });
});
