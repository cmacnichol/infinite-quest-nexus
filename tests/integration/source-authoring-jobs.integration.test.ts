import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createPostgresAuthoringRepository } from "../../packages/database/src/authoring-job-repository.js";
import { normalizeSourceDocument } from "../../packages/domain/src/source-authoring.js";
import { planSourceChunks } from "../../packages/domain/src/source-authoring-budget.js";
import { SOURCE_EXTRACTION_PROMPT_PROTOCOL_VERSION } from "../../packages/domain/src/authoring-prompts.js";
import type { SourceFact } from "../../packages/contracts/src/source-authoring.js";
import { createProvider } from "../helpers/provider-application-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe.sequential : describe.skip;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const credentialSecret = "p3-source-process-secret";

type WorkerOutcome = "no_claim" | "claimed_then_null" | "failed" | "checkpoint_lost" | "checkpointed";
type WorkerProcessResult = { completed: number; runs: boolean[]; outcomes?: Array<{ outcome: WorkerOutcome; jobId?: string; stageId?: string; generation?: number; claimCandidates?: Array<{ jobId: string; stageKey: string; generation: number; due: boolean; stageStatus: string; leaseLive: boolean | null }> }> };
let workerDiagnosticPool: DatabasePool | undefined;
let providerCallCount = () => 0;

function runSourceWorker(limit: number, diagnostics = true): Promise<WorkerProcessResult> {
  return new Promise((resolveProcess, reject) => {
    const providerCallsBefore = providerCallCount();
    const child = spawn(process.execPath, ["--import", "tsx", "tests/helpers/authoring-worker-process.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEST_DATABASE_URL: process.env.TEST_DATABASE_URL!,
        AUTHORING_PROCESS_CREDENTIAL_SECRET: credentialSecret,
        AUTHORING_PROCESS_LIMIT: String(limit),
        ...(diagnostics ? { AUTHORING_PROCESS_DIAGNOSTICS: "true" } : {})
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", async (code, signal) => {
      if (code !== 0 || signal) { reject(new Error(`source worker exited ${code ?? signal}: ${stderr}`)); return; }
      try {
        const result = JSON.parse(stdout.trim()) as WorkerProcessResult;
        const outcomes = result.outcomes;
        const jobId = outcomes?.find((outcome) => outcome.jobId)?.jobId;
        const eligibility = workerDiagnosticPool && jobId ? await sourceEligibility(workerDiagnosticPool, jobId) : undefined;
        process.stdout.write(`${JSON.stringify({
          p3WorkerDiagnostic: outcomes,
          providerCalls: { before: providerCallsBefore, after: providerCallCount(), delta: providerCallCount() - providerCallsBefore },
          eligibility
        })}\n`);
        if (outcomes) Object.defineProperty(result, "outcomes", { value: outcomes, enumerable: false });
        resolveProcess(result);
      }
      catch { reject(new Error(`source worker result was invalid: ${stdout}`)); }
    });
  });
}

function startSourceApi(ownerUserId: string): Promise<{ url: string; close(): Promise<void> }> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "tests/helpers/source-authoring-api-process.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, TEST_DATABASE_URL: process.env.TEST_DATABASE_URL!, AUTHORING_PROCESS_OWNER_USER_ID: ownerUserId },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = ""; let stderr = ""; let ready = false;
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (ready || !stdout.includes("\n")) return;
      try {
        const { address } = JSON.parse(stdout.trim()) as { address: string };
        ready = true;
        resolveProcess({
          url: address,
          close: () => new Promise<void>((resolveClose, rejectClose) => {
            child.once("error", rejectClose);
            child.once("exit", (code, signal) => code === 0 || signal === "SIGTERM" ? resolveClose() : rejectClose(new Error(`source API exited ${code ?? signal}: ${stderr}`)));
            child.kill("SIGTERM");
          })
        });
      } catch (error) { reject(error); }
    });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (!ready) reject(new Error(`source API failed to start ${code ?? signal}: ${stderr}`));
    });
  });
}

/** Safe claim-eligibility observation for restart/failure diagnosis; never returns source or provider payloads. */
async function sourceEligibility(pool: DatabasePool, jobId: string) {
  const [job, stages] = await Promise.all([
    pool.query<{ status: string; execution_generation: number; expired: boolean }>(
      "SELECT status,execution_generation,expires_at <= clock_timestamp() AS expired FROM authoring_jobs WHERE id=$1",
      [jobId]
    ),
    pool.query<{
      stage_key: string;
      generation: number;
      status: string;
      attempt_count: number;
      due: boolean;
      lease_live: boolean | null;
      parent_generations: Record<string, number>;
    }>(
      `SELECT stage_key,generation,status,attempt_count,
              next_attempt_at <= clock_timestamp() AS due,
              CASE WHEN lease_expires_at IS NULL THEN NULL ELSE lease_expires_at > clock_timestamp() END AS lease_live,
              parent_generations
         FROM authoring_job_stages current
        WHERE job_id=$1
          AND generation=(SELECT max(candidate.generation) FROM authoring_job_stages candidate WHERE candidate.job_id=current.job_id AND candidate.stage_key=current.stage_key)
          AND stage_key LIKE 'source:%'
        ORDER BY stage_key,generation`,
      [jobId]
    )
  ]);
  return { job: job.rows[0], stages: stages.rows };
}

/** Observes the durable retry schedule; it never changes a stage timestamp. */
async function waitForStageDue(pool: DatabasePool, jobId: string, stageId: string, timeoutMs = 5_000): Promise<void> {
  const observations: Array<Record<string, unknown>> = [];
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const result = await pool.query<{ status: string; generation: number; due: boolean; observedAt: string; nextAttemptAt: string; secondsUntilDue: string }>(
      `SELECT status,generation,next_attempt_at <= clock_timestamp() AS due,clock_timestamp() AS "observedAt",next_attempt_at AS "nextAttemptAt",
              EXTRACT(epoch FROM (next_attempt_at-clock_timestamp())) AS "secondsUntilDue"
         FROM authoring_job_stages WHERE job_id=$1 AND id=$2`,
      [jobId, stageId]
    );
    const row = result.rows[0];
    if (!row) throw new Error(`Retried source stage ${stageId} disappeared before it became due.`);
    observations.push(row);
    if (row.due) return;
    if (Date.now() >= deadline) throw new Error(`Retried source stage ${stageId} did not become due within ${timeoutMs}ms: ${JSON.stringify(observations)}`);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
  }
}

/** Retry only after the worker itself observed a due-gated no-claim with no provider work. */
async function runDueSourceRetry(input: Readonly<{
  pool: DatabasePool; jobId: string; stageId: string; stageKey: string; generation: number;
  providerCalls(): number;
}>): Promise<WorkerProcessResult> {
  await waitForStageDue(input.pool, input.jobId, input.stageId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = input.providerCalls();
    const result = await runSourceWorker(16);
    if (result.completed > 0) return result;
    expect(result).toEqual(expect.objectContaining({ completed: 0, runs: [false], outcomes: [expect.objectContaining({
      outcome: "no_claim", claimCandidates: expect.arrayContaining([
        expect.objectContaining({ jobId: input.jobId, stageKey: input.stageKey, generation: input.generation, stageStatus: "queued", due: false, leaseLive: null })
      ])
    })] }));
    expect(input.providerCalls()).toBe(before);
    await waitForStageDue(input.pool, input.jobId, input.stageId);
  }
  throw new Error(`Retried source stage ${input.stageId} remained due-gated after three worker attempts.`);
}

integration("durable story-source authoring", () => {
  let pool: DatabasePool;
  let ownerUserId: string;
  let provider: Server;
  let providerPort: number;
  let providerCalls = 0;
  let outputLimitedResponses = 0;
  let rejectProviderRequests = false;
  let sourceWorldFixture = false;
  let quoteOnlyExtractionFixture = false;
  let sourceWorldExpansionFixture = false;
  let sourceWorldAgeExpansionFixture = false;
  let sourceWorldUnknownExpansionFixture = false;
  let sourceWorldAcceptedFactIds: string[][] = [];
  let sourceWorldResponseCount = 0;
  let failSourceWorldOnResponse: number | undefined;
  const jobs: string[] = [];

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    workerDiagnosticPool = pool;
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    provider = createServer((request, response) => {
      providerCalls += 1;
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        if (rejectProviderRequests) {
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: { message: "Synthetic source extraction rejection." } }));
          return;
        }
        const outputLimited = outputLimitedResponses > 0;
        if (outputLimited) outputLimitedResponses -= 1;
        let content = JSON.stringify({ facts: [] });
        if (sourceWorldFixture && !outputLimited && body.trim()) {
          const payload = JSON.parse(body) as { messages?: Array<{ role?: string; content?: string }> };
          const sourceRequest = [...(payload.messages ?? [])].reverse().find((message) => message.role === "user")?.content;
          const frame = sourceRequest ? JSON.parse(sourceRequest) as {
            acceptedFacts?: Array<{ id: string; kind: string; subject: string; predicate: string; value: string; provenance?: string }>;
            selectedCharacterFactIds?: string[];
            chunk?: { sourceRange: { start: number; end: number }; paragraphSpans: Array<{ paragraphId: string; start: number; end: number; evidenceId: string; text: string }> };
          } : {};
          if (Array.isArray(frame.acceptedFacts)) {
            sourceWorldResponseCount += 1;
            sourceWorldAcceptedFactIds.push(frame.acceptedFacts.map((fact) => fact.id));
            const selected = frame.selectedCharacterFactIds?.[0];
            const fact = frame.acceptedFacts.find((candidate) => candidate.id === selected);
            const reviewedExpansion = frame.acceptedFacts.find((candidate) => candidate.provenance === "invented" && candidate.predicate === "rule");
            const reviewedAgeExpansion = frame.acceptedFacts.find((candidate) => candidate.provenance === "invented" && candidate.predicate === "age");
            const support = frame.acceptedFacts[0];
            content = JSON.stringify(failSourceWorldOnResponse === sourceWorldResponseCount
              ? { fields: [{ path: "world.rules", value: 7, supportingFactIds: [] }], characterFields: [] }
              : sourceWorldUnknownExpansionFixture && support
              ? { fields: [], characterFields: [], expansionCandidates: [{ target: "world", path: "world.backgroundStory", value: "An unsupported candidate", supportingFactIds: [support.id] }] }
              : sourceWorldExpansionFixture && support && !reviewedExpansion
              ? {
                  fields: [], characterFields: [], expansionCandidates: [
                    { target: "world", path: "world.rules", value: "The gates cannot be crossed after dusk.", supportingFactIds: [support.id] },
                    { target: "world", path: "world.tone", value: "Somber", supportingFactIds: [support.id] },
                    ...(selected ? [{ target: selected, path: "profile.appearance.hair", value: "black hair", supportingFactIds: [support.id] }] : [])
                  ]
                }
              : sourceWorldAgeExpansionFixture && selected && support && !reviewedAgeExpansion
                ? { fields: [], characterFields: [], expansionCandidates: [{ target: selected, path: "profile.appearance.apparentAge", value: "thirty", supportingFactIds: [support.id] }] }
              : reviewedAgeExpansion && selected
                ? { fields: [], characterFields: [{ selectedCharacterFactId: selected, fields: [{ path: "profile.appearance.apparentAge", value: reviewedAgeExpansion.value, supportingFactIds: [reviewedAgeExpansion.id] }] }] }
              : reviewedExpansion
                ? { fields: [{ path: "world.rules", value: reviewedExpansion.value, supportingFactIds: [reviewedExpansion.id] }], characterFields: [] }
                : selected && fact
              ? { fields: [], characterFields: [{ selectedCharacterFactId: selected, fields: [{ path: "profile.appearance.clothing", value: fact.value, supportingFactIds: [fact.id] }] }] }
              : { fields: [], characterFields: [] });
          } else if (frame.chunk?.paragraphSpans.length) {
            const span = frame.chunk.paragraphSpans[0]!;
            content = JSON.stringify({ facts: [{
              category: "character", subject: "Iris", predicate: "clothing", value: "blue coat", provenance: "stated",
              citations: [quoteOnlyExtractionFixture
                ? { paragraphId: span.paragraphId, quote: span.text }
                : { evidenceId: span.evidenceId }]
            }] });
          }
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ id: randomUUID(), choices: [{ message: { role: "assistant", content }, finish_reason: outputLimited ? "length" : "stop" }] }));
      });
    });
    await new Promise<void>((ready) => provider.listen(0, "127.0.0.1", ready));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("Source provider did not bind.");
    providerPort = address.port;
    providerCallCount = () => providerCalls;
  });

  it("claims a never-attempted source stage when an initial due timestamp appears ahead after a clock rollback", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const submitted = await repository.submit({ ownerUserId }, {
      kind: "story_source", idempotencyKey: randomUUID(), target: { kind: "new_world" }, name: "clock-rollback.txt",
      text: "Mara tends the beacon.", mode: "faithful", boundaryParagraphId: "paragraph:0", instructions: "P3.9 initial claim clock rollback fixture."
    }, sha256("Mara tends the beacon."));
    jobs.push(submitted.id);
    await pool.query("UPDATE authoring_job_stages SET next_attempt_at=clock_timestamp()+interval '60 seconds' WHERE job_id=$1 AND stage_key='source:plan' AND attempt_count=0", [submitted.id]);
    await expect(repository.claim("p3-9-clock-rollback", 30, ["story_source"])).resolves.toMatchObject({ jobId: submitted.id });
  });

  it("keeps an explicit retry generation blocked until its scheduled due time", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const submitted = await repository.submit({ ownerUserId }, {
      kind: "story_source", idempotencyKey: randomUUID(), target: { kind: "new_world" }, name: "retry-schedule.txt",
      text: "Mara tends the beacon.", mode: "faithful", boundaryParagraphId: "paragraph:0", instructions: "P3.9 retry schedule fixture."
    }, sha256("Mara tends the beacon."));
    jobs.push(submitted.id);
    await pool.query("UPDATE authoring_job_stages SET retry_count=1,next_attempt_at=clock_timestamp()+interval '60 seconds' WHERE job_id=$1 AND stage_key='source:plan' AND attempt_count=0", [submitted.id]);
    await expect(repository.claim("p3-9-retry-schedule", 30, ["story_source"])).resolves.toBeNull();
  });

  it("keeps an already-attempted queued stage blocked until its scheduled due time", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const submitted = await repository.submit({ ownerUserId }, {
      kind: "story_source", idempotencyKey: randomUUID(), target: { kind: "new_world" }, name: "attempted-schedule.txt",
      text: "Mara tends the beacon.", mode: "faithful", boundaryParagraphId: "paragraph:0", instructions: "P3.9 attempted schedule fixture."
    }, sha256("Mara tends the beacon."));
    jobs.push(submitted.id);
    await pool.query("UPDATE authoring_job_stages SET attempt_count=1,retry_count=0,next_attempt_at=clock_timestamp()+interval '60 seconds' WHERE job_id=$1 AND stage_key='source:plan'", [submitted.id]);
    await expect(repository.claim("p3-9-attempted-schedule", 30, ["story_source"])).resolves.toBeNull();
  });

  it("claims an explicit retry generation once its scheduled due time has passed", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const submitted = await repository.submit({ ownerUserId }, {
      kind: "story_source", idempotencyKey: randomUUID(), target: { kind: "new_world" }, name: "retry-due.txt",
      text: "Mara tends the beacon.", mode: "faithful", boundaryParagraphId: "paragraph:0", instructions: "P3.9 retry due fixture."
    }, sha256("Mara tends the beacon."));
    jobs.push(submitted.id);
    await pool.query("UPDATE authoring_job_stages SET retry_count=1,next_attempt_at=clock_timestamp()-interval '1 second' WHERE job_id=$1 AND stage_key='source:plan' AND attempt_count=0", [submitted.id]);
    await expect(repository.claim("p3-9-retry-due", 30, ["story_source"])).resolves.toMatchObject({ jobId: submitted.id });
  });
  afterEach(async () => {
    sourceWorldResponseCount = 0;
    failSourceWorldOnResponse = undefined;
    sourceWorldAgeExpansionFixture = false;
    quoteOnlyExtractionFixture = false;
    if (jobs.length) await pool.query("DELETE FROM authoring_jobs WHERE id = ANY($1::uuid[])", [jobs.splice(0)]);
  });
  afterAll(async () => {
    workerDiagnosticPool = undefined;
    providerCallCount = () => 0;
    await pool?.end();
    if (provider) await new Promise<void>((done) => provider.close(() => done()));
  });

  it.each(["character", "location"] as const)("saves multiple values for a free-form %s predicate and permits synthesis", async (kind) => {
    const repository = createPostgresAuthoringRepository(pool);
    const text = "The beacon has a brass bell and a stone stair.";
    const submitted = await repository.submit({ ownerUserId }, {
      kind: "story_source", idempotencyKey: randomUUID(), target: { kind: "new_world" }, name: "multi-value.txt", text,
      mode: "faithful", boundaryParagraphId: "paragraph:0", instructions: ""
    }, sha256(text));
    jobs.push(submitted.id);
    const source = normalizeSourceDocument("multi-value.txt", text, submitted.id);
    const chunks = planSourceChunks({ source, boundaryParagraphId: "paragraph:0", systemPrompt: "", instructions: "", budget: { contextWindowTokens: 100_000, maxOutputTokens: 100, countTokens: value => Buffer.byteLength(value) } });
    const plan = await repository.claim("multi-value-plan", 60);
    await repository.initializeExecutionSnapshot(plan!, { providerProfileId: randomUUID(), model: "synthetic", configurationHash: "a".repeat(64), contextWindowTokens: 100_000, maxOutputTokens: 100, requestTimeoutMs: 10_000, prompts: {}, protocols: { source: SOURCE_EXTRACTION_PROMPT_PROTOCOL_VERSION } });
    await repository.checkpoint(plan!, { kind: "source_plan", chunks });
    const chunkClaim = await repository.claim("multi-value-extraction", 60);
    await repository.checkpoint(chunkClaim!, { kind: "source_extraction", facts: ["a brass bell", "a stone stair"].map((value, index) => ({
      id: `fixture:${index}`, kind, subject: "Beacon", predicate: "has", value, provenance: "stated" as const,
      citations: [{ sourceId: source.id, paragraphId: "paragraph:0", start: 0, end: text.length, quote: text }]
    })) });
    const extracted = (await repository.read({ ownerUserId }, submitted.id))!;
    if (extracted.kind !== "story_source") throw new Error("Expected source job.");
    const ids = extracted.source!.facts.map(fact => fact.id);
    expect(ids).toHaveLength(2);
    const reviewed = await repository.reviewSourceFacts!({ ownerUserId }, submitted.id, {
      expectedRevision: extracted.revision, acceptedFactIds: ids, rejectedFactIds: [], uncertainFactIds: [], manualFacts: [],
      selectedCharacterFactIds: [], characterIdentityGroups: kind === "character" ? [{ representativeFactId: ids[0]!, factIds: ids }] : []
    });
    if (reviewed.kind !== "story_source") throw new Error("Expected source review.");
    expect(reviewed.source!.acceptedFactIds).toEqual(ids);
    const reloaded = (await repository.read({ ownerUserId }, submitted.id))!;
    if (reloaded.kind !== "story_source") throw new Error("Expected source review reload.");
    expect(reloaded.source!.acceptedFactIds).toEqual(ids);
    expect(reloaded.source!.facts.map(fact => fact.value).sort()).toEqual(["a brass bell", "a stone stair"]);
    const synthesis = await repository.startSourceSynthesis!({ ownerUserId }, submitted.id, reloaded.revision);
    expect(synthesis.stages.some(stage => stage.key === "source:synthesis" && stage.status === "queued")).toBe(true);
  });

  it("persists normalized source once, checkpoints independent chunks, and requires explicit review before synthesis", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const text = "\uFEFF\uFEFFIris crossed the bridge.\n\nIris reached South Harbor.";
    const submitted = await repository.submit({ ownerUserId }, {
      kind: "story_source", idempotencyKey: randomUUID(), target: { kind: "new_world" }, name: "iris.txt", text,
      mode: "faithful", boundaryParagraphId: "paragraph:1", instructions: "Preserve uncertainty."
    }, sha256(text));
    jobs.push(submitted.id);
    if (submitted.kind !== "story_source") throw new Error("Expected source authoring job.");
    const source = normalizeSourceDocument("iris.txt", text, submitted.id);
    expect(submitted.source?.source).toEqual(source);
    const chunks = planSourceChunks({ source, boundaryParagraphId: "paragraph:1", systemPrompt: "source", instructions: "Preserve uncertainty.", budget: { contextWindowTokens: 100_000, maxOutputTokens: 100, countTokens: value => Buffer.byteLength(value, "utf8") } });
    const plan = await repository.claim("source-plan", 60);
    expect(plan?.stageId).toBe(submitted.stages[0]?.id);
    await expect(repository.initializeExecutionSnapshot(plan!, { providerProfileId: randomUUID(), model: "synthetic", configurationHash: "a".repeat(64), contextWindowTokens: 100_000, maxOutputTokens: 100, requestTimeoutMs: 10_000, prompts: {}, protocols: { source: SOURCE_EXTRACTION_PROMPT_PROTOCOL_VERSION } })).resolves.toBeTruthy();
    await expect(repository.checkpoint(plan!, { kind: "source_plan", chunks })).resolves.toBe(true);

    const fact = (chunk: typeof chunks[number]): SourceFact => ({ id: `fact:${chunk.id}`, kind: "character", subject: "Iris", predicate: "visits", value: chunk.id, provenance: "stated", citations: [{ sourceId: source.id, paragraphId: chunk.spans[0]!.paragraphId, start: chunk.spans[0]!.start, end: chunk.spans[0]!.end, quote: Array.from(source.text).slice(chunk.spans[0]!.start, chunk.spans[0]!.end).join("") }] });
    const sourceFacts = (chunk: typeof chunks[number]) => [
      fact(chunk),
      { ...fact(chunk), id: `date:early:${chunk.id}`, predicate: "arrives", value: "on 5 June", citations: [fact(chunk).citations[0]!] },
      { ...fact(chunk), id: `date:late:${chunk.id}`, predicate: "arrives", value: "on 6 June", citations: [fact(chunk).citations[0]!] }
    ];
    for (const chunk of chunks) {
      const claim = await repository.claim(`chunk-${chunk.id}`, 60);
      expect(claim).not.toBeNull();
      await expect(repository.checkpoint(claim!, { kind: "source_extraction", facts: sourceFacts(chunk) })).resolves.toBe(true);
    }
    const extracted = (await repository.read({ ownerUserId }, submitted.id))!;
    if (extracted.kind !== "story_source") throw new Error("Expected source authoring detail.");
    expect(extracted.source).toMatchObject({ extractionComplete: true, facts: expect.arrayContaining([expect.objectContaining({ id: expect.stringMatching(/^source-fact:/u), subject: "Iris" })]) });
    expect(extracted.source?.source).toEqual(source);
    expect(extracted.source?.facts.find((item) => item.subject === "Iris")?.citations).toEqual([fact(chunks[0]!).citations[0]]);
    await expect(repository.startSourceSynthesis!({ ownerUserId }, submitted.id, extracted.revision)).rejects.toMatchObject({ code: "choose_source_facts" });

    const oldFactId = extracted.source!.facts[0]!.id;
    const completedStage = extracted.stages.find((stage) => stage.key === `source:chunk:${chunks[0]!.id}`)!;
    await repository.retry({ ownerUserId }, submitted.id, completedStage.id, extracted.revision);
    const regeneratedClaim = await repository.claim("source-regeneration", 60);
    expect(regeneratedClaim).not.toBeNull();
    await expect(repository.checkpoint(regeneratedClaim!, { kind: "source_extraction", facts: sourceFacts(chunks[0]!) })).resolves.toBe(true);
    const regenerated = (await repository.read({ ownerUserId }, submitted.id))!;
    if (regenerated.kind !== "story_source") throw new Error("Expected regenerated source detail.");
    expect(regenerated.source?.facts[0]!.id).not.toBe(oldFactId);
    await expect(repository.reviewSourceFacts!({ ownerUserId }, submitted.id, {
      expectedRevision: regenerated.revision, acceptedFactIds: [oldFactId], rejectedFactIds: [], uncertainFactIds: [], selectedCharacterFactIds: [], characterIdentityGroups: [{ representativeFactId: oldFactId, factIds: [oldFactId] }], manualFacts: []
    })).rejects.toMatchObject({ code: "invalid_state" });
    await expect(repository.reviewSourceFacts!({ ownerUserId: randomUUID() }, submitted.id, {
      expectedRevision: regenerated.revision, acceptedFactIds: [], rejectedFactIds: [], uncertainFactIds: [], selectedCharacterFactIds: [], characterIdentityGroups: [], manualFacts: []
    })).rejects.toMatchObject({ code: "not_found" });
    const other = await repository.submit({ ownerUserId }, {
      kind: "story_source", idempotencyKey: randomUUID(), target: { kind: "new_world" }, name: "other.txt", text: "Mara watched the tide.",
      mode: "faithful", boundaryParagraphId: "paragraph:0", instructions: "Preserve evidence."
    }, sha256("Mara watched the tide."));
    jobs.push(other.id);
    const otherSource = normalizeSourceDocument("other.txt", "Mara watched the tide.", other.id);
    const otherChunks = planSourceChunks({ source: otherSource, boundaryParagraphId: "paragraph:0", systemPrompt: "source", instructions: "Preserve evidence.", budget: { contextWindowTokens: 100_000, maxOutputTokens: 100, countTokens: value => Buffer.byteLength(value, "utf8") } });
    const otherPlanClaim = await repository.claim("foreign-plan", 60);
    await repository.initializeExecutionSnapshot(otherPlanClaim!, { providerProfileId: randomUUID(), model: "synthetic", configurationHash: "b".repeat(64), contextWindowTokens: 100_000, maxOutputTokens: 100, requestTimeoutMs: 10_000, prompts: {}, protocols: { source: SOURCE_EXTRACTION_PROMPT_PROTOCOL_VERSION } });
    await repository.checkpoint(otherPlanClaim!, { kind: "source_plan", chunks: otherChunks });
    const otherChunkClaim = await repository.claim("foreign-chunk", 60);
    const otherChunk = otherChunks[0]!;
    await repository.checkpoint(otherChunkClaim!, { kind: "source_extraction", facts: [{ id: "other-fact", kind: "character", subject: "Mara", predicate: "watches", value: "the tide", provenance: "stated", citations: [{ sourceId: otherSource.id, paragraphId: otherChunk.spans[0]!.paragraphId, start: otherChunk.spans[0]!.start, end: otherChunk.spans[0]!.end, quote: otherSource.text }] }] });
    const otherView = (await repository.read({ ownerUserId }, other.id))!;
    if (otherView.kind !== "story_source") throw new Error("Expected other source detail.");
    const beforeForeignReview = (await repository.read({ ownerUserId }, submitted.id))!;
    await expect(repository.reviewSourceFacts!({ ownerUserId }, submitted.id, {
      expectedRevision: regenerated.revision, acceptedFactIds: [otherView.source!.facts[0]!.id], rejectedFactIds: [], uncertainFactIds: [], selectedCharacterFactIds: [], characterIdentityGroups: [{ representativeFactId: otherView.source!.facts[0]!.id, factIds: [otherView.source!.facts[0]!.id] }], manualFacts: []
    })).rejects.toMatchObject({ code: "invalid_state" });
    expect((await repository.read({ ownerUserId }, submitted.id))!.revision).toBe(beforeForeignReview.revision);

    const accepted = regenerated.source!.facts.map((item) => item.id);
    const arrivalFactIds = regenerated.source!.facts.filter((item) => item.predicate === "arrives").map((item) => item.id);
    const visitsIds = regenerated.source!.facts.filter((item) => item.predicate === "visits").map((item) => item.id);
    expect(arrivalFactIds).toHaveLength(2);
    expect(visitsIds).toHaveLength(1);
    await expect(repository.reviewSourceFacts!({ ownerUserId }, submitted.id, {
      expectedRevision: regenerated.revision, acceptedFactIds: accepted, rejectedFactIds: [], uncertainFactIds: [], selectedCharacterFactIds: [visitsIds[0]!, arrivalFactIds[0]!],
      characterIdentityGroups: [
        { representativeFactId: visitsIds[0]!, factIds: visitsIds },
        { representativeFactId: arrivalFactIds[0]!, factIds: [...arrivalFactIds, visitsIds[0]!] }
      ],
      manualFacts: [{ id: "unrelated-manual-fact", kind: "rule", subject: "Lantern", predicate: "means", value: "hope", provenance: "manual", citations: [] }]
    })).rejects.toMatchObject({ name: "ZodError", issues: expect.arrayContaining([expect.objectContaining({ message: "A fact can belong to only one identity." })]) });
    expect((await repository.read({ ownerUserId }, submitted.id))!.revision).toBe(regenerated.revision);
    const resolvedAccepted = accepted.filter((id) => id !== arrivalFactIds[1]);
    const resolvedCharacterGroup = { representativeFactId: visitsIds[0]!, factIds: resolvedAccepted };
    const reviewed = await repository.reviewSourceFacts!({ ownerUserId }, submitted.id, {
      expectedRevision: regenerated.revision, acceptedFactIds: resolvedAccepted, rejectedFactIds: [], uncertainFactIds: [arrivalFactIds[1]!], selectedCharacterFactIds: [visitsIds[0]!], characterIdentityGroups: [resolvedCharacterGroup],
      manualFacts: [{ id: "author-entered-manual-fact", kind: "rule", subject: "Lantern", predicate: "means", value: "hope", provenance: "manual", citations: [] }]
    });
    if (reviewed.kind !== "story_source") throw new Error("Expected source review detail.");
    const manualId = reviewed.source?.facts.find((item) => item.provenance === "manual")?.id;
    expect(manualId).toMatch(/^source-fact:manual:/u);
    expect(reviewed.source?.acceptedFactIds).toEqual([...resolvedAccepted, manualId]);
    expect(reviewed.source?.uncertainFactIds).toEqual([arrivalFactIds[1]]);
    expect(reviewed.source?.characterIdentityGroups).toEqual([resolvedCharacterGroup]);
    const rereviewed = await repository.reviewSourceFacts!({ ownerUserId }, submitted.id, {
      expectedRevision: reviewed.revision, acceptedFactIds: [...resolvedAccepted, manualId!], rejectedFactIds: [], uncertainFactIds: [arrivalFactIds[1]!], selectedCharacterFactIds: [visitsIds[0]!], characterIdentityGroups: [resolvedCharacterGroup], manualFacts: []
    });
    const synthesis = await repository.startSourceSynthesis!({ ownerUserId }, submitted.id, rereviewed.revision);
    expect(synthesis.status).toBe("queued");
    expect(synthesis.result).toBeUndefined();
    expect(synthesis.stages.some((stage) => stage.key === "source:synthesis" && stage.status === "queued")).toBe(true);
    const synthesisClaim = await repository.claim("source-selection-fence", 60);
    expect(synthesisClaim).not.toBeNull();
    const loadedSelection = await repository.loadClaim(synthesisClaim!);
    expect(loadedSelection?.sourceSelection).toMatchObject({
      reviewGeneration: expect.any(Number),
      acceptedFacts: expect.arrayContaining([expect.objectContaining({ id: visitsIds[0] })]),
      selectedCharacterFactIds: [visitsIds[0]],
      characterIdentityGroups: [{ representativeFactId: visitsIds[0], factIds: resolvedAccepted }]
    });
    await pool.query("UPDATE authoring_jobs SET review_generation = review_generation + 1, revision = revision + 1 WHERE id = $1", [submitted.id]);
    await expect(repository.loadClaim(synthesisClaim!)).resolves.toBeNull();
    await expect(repository.checkpoint(synthesisClaim!, { kind: "source_world", proposal: { schemaVersion: 5, world: { title: "ignored", genre: "", tone: "", premise: "", backgroundStory: "", firstAction: "", rules: "" }, playableCharacters: [], entities: [], relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [], defaults: {} } })).resolves.toBe(false);
  });

  it("retires a completed source synthesis when a later fact review changes its selection", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const text = "Iris wears a blue coat.";
    const submitted = await repository.submit({ ownerUserId }, {
      kind: "story_source", idempotencyKey: randomUUID(), target: { kind: "new_world" }, name: "fence.txt", text,
      mode: "faithful", boundaryParagraphId: "paragraph:0", instructions: "Preserve exact evidence."
    }, sha256(text));
    jobs.push(submitted.id);
    const source = normalizeSourceDocument("fence.txt", text, submitted.id);
    const chunks = planSourceChunks({ source, boundaryParagraphId: "paragraph:0", systemPrompt: "source", instructions: "Preserve exact evidence.", budget: { contextWindowTokens: 100_000, maxOutputTokens: 100, countTokens: value => Buffer.byteLength(value, "utf8") } });
    const planClaim = await repository.claim("source-synthesis-fence-plan", 60);
    await repository.initializeExecutionSnapshot(planClaim!, { providerProfileId: randomUUID(), model: "synthetic", configurationHash: "d".repeat(64), contextWindowTokens: 100_000, maxOutputTokens: 100, requestTimeoutMs: 10_000, prompts: {}, protocols: { source: SOURCE_EXTRACTION_PROMPT_PROTOCOL_VERSION } });
    await repository.checkpoint(planClaim!, { kind: "source_plan", chunks });
    const chunk = chunks[0]!;
    const chunkClaim = await repository.claim("source-synthesis-fence-chunk", 60);
    await repository.checkpoint(chunkClaim!, { kind: "source_extraction", facts: [{
      id: "iris-coat", kind: "character", subject: "Iris", predicate: "clothing", value: "blue coat", provenance: "stated",
      citations: [{ sourceId: source.id, paragraphId: chunk.spans[0]!.paragraphId, start: chunk.spans[0]!.start, end: chunk.spans[0]!.end, quote: source.text }]
    }] });
    const extracted = await repository.read({ ownerUserId }, submitted.id);
    if (extracted?.kind !== "story_source") throw new Error("Expected source authoring detail.");
    const factId = extracted.source!.facts[0]!.id;
    const review = await repository.reviewSourceFacts!({ ownerUserId }, submitted.id, {
      expectedRevision: extracted.revision, acceptedFactIds: [factId], rejectedFactIds: [], uncertainFactIds: [], selectedCharacterFactIds: [factId],
      characterIdentityGroups: [{ representativeFactId: factId, factIds: [factId] }], manualFacts: []
    });
    const queued = await repository.startSourceSynthesis!({ ownerUserId }, submitted.id, review.revision);
    const synthesisClaim = await repository.claim("source-synthesis-fence-overview", 60);
    await repository.checkpoint(synthesisClaim!, { kind: "source_world", proposal: { schemaVersion: 5, world: { title: "fence.txt", genre: "", tone: "", premise: "", backgroundStory: "", firstAction: "", rules: "" }, playableCharacters: [], entities: [], relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [], defaults: {} } });
    const afterOverview = await repository.read({ ownerUserId }, submitted.id);
    expect(afterOverview?.stages).toEqual(expect.arrayContaining([expect.objectContaining({ key: `source:character:${factId}`, status: "queued" })]));
    const characterClaim = await repository.claim("source-synthesis-fence-character", 60);
    await repository.checkpoint(characterClaim!, { kind: "source_world", proposal: { schemaVersion: 5, world: { title: "fence.txt", genre: "", tone: "", premise: "", backgroundStory: "", firstAction: "", rules: "" }, playableCharacters: [], entities: [], relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [], defaults: {} } });
    const changedReview = await repository.reviewSourceFacts!({ ownerUserId }, submitted.id, {
      expectedRevision: queued.revision, acceptedFactIds: [factId], rejectedFactIds: [], uncertainFactIds: [], selectedCharacterFactIds: [],
      characterIdentityGroups: [{ representativeFactId: factId, factIds: [factId] }], manualFacts: []
    });
    expect(changedReview.stages.filter((stage) => stage.key === "source:synthesis" && stage.status === "cancelled")).toHaveLength(1);
    const replacement = await repository.startSourceSynthesis!({ ownerUserId }, submitted.id, changedReview.revision);
    expect(replacement.stages).toEqual(expect.arrayContaining([expect.objectContaining({ key: "source:synthesis", generation: 2, status: "queued" })]));
  });

  it("keeps queued and running source-character work claimable through public draft saves while fact review still replaces it", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const text = "Iris wears a blue coat.";
    const submitted = await repository.submit({ ownerUserId }, {
      kind: "story_source", idempotencyKey: randomUUID(), target: { kind: "new_world" }, name: "draft-save-fence.txt", text,
      mode: "faithful", boundaryParagraphId: "paragraph:0", instructions: "Keep reviewed source facts stable across draft saves."
    }, sha256(text));
    jobs.push(submitted.id);
    const source = normalizeSourceDocument("draft-save-fence.txt", text, submitted.id);
    const chunks = planSourceChunks({ source, boundaryParagraphId: "paragraph:0", systemPrompt: "source", instructions: "Keep reviewed source facts stable across draft saves.", budget: { contextWindowTokens: 100_000, maxOutputTokens: 100, countTokens: value => Buffer.byteLength(value, "utf8") } });
    const planClaim = await repository.claim("source-draft-save-plan", 60);
    await repository.initializeExecutionSnapshot(planClaim!, { providerProfileId: randomUUID(), model: "synthetic", configurationHash: "e".repeat(64), contextWindowTokens: 100_000, maxOutputTokens: 100, requestTimeoutMs: 10_000, prompts: {}, protocols: { source: SOURCE_EXTRACTION_PROMPT_PROTOCOL_VERSION } });
    await repository.checkpoint(planClaim!, { kind: "source_plan", chunks });
    const extractionClaim = await repository.claim("source-draft-save-extraction", 60);
    await repository.checkpoint(extractionClaim!, { kind: "source_extraction", facts: [{
      id: "iris-coat", kind: "character", subject: "Iris", predicate: "clothing", value: "blue coat", provenance: "stated",
      citations: [{ sourceId: source.id, paragraphId: chunks[0]!.spans[0]!.paragraphId, start: chunks[0]!.spans[0]!.start, end: chunks[0]!.spans[0]!.end, quote: text }]
    }] });
    const extracted = await repository.read({ ownerUserId }, submitted.id);
    if (extracted?.kind !== "story_source") throw new Error("Expected source draft-save extraction.");
    const factId = extracted.source!.facts[0]!.id;
    const factReview = await repository.reviewSourceFacts!({ ownerUserId }, submitted.id, {
      expectedRevision: extracted.revision, acceptedFactIds: [factId], rejectedFactIds: [], uncertainFactIds: [], selectedCharacterFactIds: [factId],
      characterIdentityGroups: [{ representativeFactId: factId, factIds: [factId] }], manualFacts: []
    });
    await repository.startSourceSynthesis!({ ownerUserId }, submitted.id, factReview.revision);
    const synthesisClaim = await repository.claim("source-draft-save-synthesis", 60);
    await repository.checkpoint(synthesisClaim!, { kind: "source_world", proposal: { schemaVersion: 5, world: { title: "draft-save-fence.txt", genre: "", tone: "", premise: "", backgroundStory: "", firstAction: "", rules: "" }, playableCharacters: [], entities: [], relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [], defaults: {} } });
    const queued = await repository.read({ ownerUserId }, submitted.id);
    if (queued?.kind !== "story_source" || !queued.result) throw new Error("Expected queued source-character draft result.");
    const synthesisStageId = queued.stages.find((stage) => stage.key === "source:synthesis")?.id;
    if (!synthesisStageId) throw new Error("Expected source synthesis stage.");
    const beforeDraftSaves = await pool.query<{ review_generation: number }>("SELECT review_generation FROM authoring_jobs WHERE id=$1", [submitted.id]);
    const api = await startSourceApi(ownerUserId);
    try {
      const saveQueued = await fetch(`${api.url}/api/v1/authoring/jobs/${submitted.id}/review`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: queued.revision, content: queued.result, selectedStageIds: [synthesisStageId] })
      });
      expect(saveQueued.status).toBe(200);
      const queuedSaved = await saveQueued.json() as { revision: number; stages: Array<{ key: string; status: string }> };
      expect(queuedSaved.stages).toEqual(expect.arrayContaining([expect.objectContaining({ key: `source:character:${factId}`, status: "queued" })]));
      await expect(pool.query<{ review_generation: number }>("SELECT review_generation FROM authoring_jobs WHERE id=$1", [submitted.id]))
        .resolves.toEqual(beforeDraftSaves);

      const characterClaim = await repository.claim("source-draft-save-character", 60);
      expect(characterClaim).toMatchObject({ jobId: submitted.id });
      const saveRunning = await fetch(`${api.url}/api/v1/authoring/jobs/${submitted.id}/review`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: queuedSaved.revision, content: queued.result, selectedStageIds: [synthesisStageId] })
      });
      expect(saveRunning.status).toBe(200);
      await expect(repository.checkpoint(characterClaim!, { kind: "source_world", proposal: {
        schemaVersion: 5, world: { title: "draft-save-fence.txt", genre: "", tone: "", premise: "", backgroundStory: "", firstAction: "", rules: "" },
        playableCharacters: [{ id: `source-character:${factId}`, name: "Iris", characterText: "", profile: { appearance: { clothing: "blue coat" } }, rpgStats: [], defaultTriggers: [], source: { type: "story-source", representativeFactId: factId } }],
        entities: [], relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [], defaults: {}
      } })).resolves.toBe(true);
    } finally {
      await api.close();
    }
    const completed = await repository.read({ ownerUserId }, submitted.id);
    expect(completed).toMatchObject({ status: "awaiting_review", stages: expect.arrayContaining([expect.objectContaining({ key: `source:character:${factId}`, status: "validated" })]) });

    const changedFacts = await repository.reviewSourceFacts!({ ownerUserId }, submitted.id, {
      expectedRevision: completed!.revision, acceptedFactIds: [factId], rejectedFactIds: [], uncertainFactIds: [], selectedCharacterFactIds: [],
      characterIdentityGroups: [{ representativeFactId: factId, factIds: [factId] }], manualFacts: []
    });
    expect(changedFacts.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "source:synthesis", status: "cancelled" }),
      expect.objectContaining({ key: `source:character:${factId}`, status: "cancelled" })
    ]));
  });

  it("requires explicit rereview after a public extraction retry replaces fact IDs", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const text = "Iris wears a blue coat.";
    const submitted = await repository.submit({ ownerUserId }, {
      kind: "story_source", idempotencyKey: randomUUID(), target: { kind: "new_world" }, name: "retry-rereview.txt", text,
      mode: "faithful", boundaryParagraphId: "paragraph:0", instructions: "Do not remap reviewed fact identities."
    }, sha256(text));
    jobs.push(submitted.id);
    const source = normalizeSourceDocument("retry-rereview.txt", text, submitted.id);
    const chunks = planSourceChunks({ source, boundaryParagraphId: "paragraph:0", systemPrompt: "source", instructions: "Do not remap reviewed fact identities.", budget: { contextWindowTokens: 100_000, maxOutputTokens: 100, countTokens: value => Buffer.byteLength(value, "utf8") } });
    const plan = await repository.claim("retry-rereview-plan", 60);
    await repository.initializeExecutionSnapshot(plan!, { providerProfileId: randomUUID(), model: "synthetic", configurationHash: "f".repeat(64), contextWindowTokens: 100_000, maxOutputTokens: 100, requestTimeoutMs: 10_000, prompts: {}, protocols: { source: SOURCE_EXTRACTION_PROMPT_PROTOCOL_VERSION } });
    await repository.checkpoint(plan!, { kind: "source_plan", chunks });
    const extraction = await repository.claim("retry-rereview-extraction", 60);
    await repository.checkpoint(extraction!, { kind: "source_extraction", facts: [{
      id: "iris-coat", kind: "character", subject: "Iris", predicate: "clothing", value: "blue coat", provenance: "stated",
      citations: [{ sourceId: source.id, paragraphId: chunks[0]!.spans[0]!.paragraphId, start: chunks[0]!.spans[0]!.start, end: chunks[0]!.spans[0]!.end, quote: text }]
    }] });
    const extracted = await repository.read({ ownerUserId }, submitted.id);
    if (extracted?.kind !== "story_source") throw new Error("Expected retry-rereview extraction.");
    const factId = extracted.source!.facts[0]!.id;
    const reviewed = await repository.reviewSourceFacts!({ ownerUserId }, submitted.id, {
      expectedRevision: extracted.revision, acceptedFactIds: [factId, "manual:harbor"], rejectedFactIds: [], uncertainFactIds: [], selectedCharacterFactIds: [factId],
      characterIdentityGroups: [{ representativeFactId: factId, factIds: [factId] }],
      manualFacts: [{ id: "manual:harbor", kind: "rule", subject: "Harbor", predicate: "rule", value: "keeps the beacon lit", provenance: "manual", citations: [] }]
    });
    if (reviewed.kind !== "story_source" || !reviewed.source) throw new Error("Expected reviewed retry-rereview source job.");
    const manualId = reviewed.source!.facts.find((fact) => fact.provenance === "manual")!.id;
    await repository.startSourceSynthesis!({ ownerUserId }, submitted.id, reviewed.revision);
    const synthesis = await repository.claim("retry-rereview-synthesis", 60);
    await repository.checkpoint(synthesis!, { kind: "source_world", proposal: { schemaVersion: 5, world: { title: "retry-rereview.txt", genre: "", tone: "", premise: "", backgroundStory: "", firstAction: "", rules: "" }, playableCharacters: [], entities: [], relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [], defaults: {} } });
    const character = await repository.claim("retry-rereview-character", 60);
    await repository.checkpoint(character!, { kind: "source_world", proposal: { schemaVersion: 5, world: { title: "retry-rereview.txt", genre: "", tone: "", premise: "", backgroundStory: "", firstAction: "", rules: "" }, playableCharacters: [], entities: [], relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [], defaults: {} } });
    const complete = await repository.read({ ownerUserId }, submitted.id);
    if (complete?.kind !== "story_source") throw new Error("Expected completed retry-rereview source job.");
    const leaf = complete.stages.find((stage) => stage.key === `source:chunk:${chunks[0]!.id}`);
    if (!leaf) throw new Error("Expected validated extraction leaf.");
    const api = await startSourceApi(ownerUserId);
    try {
      const retry = await fetch(`${api.url}/api/v1/authoring/jobs/${submitted.id}/retry`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: complete.revision, stageId: leaf.id })
      });
      expect(retry.status).toBe(200);
      const retryQueued = await retry.json() as { revision: number };
      const replacement = await repository.claim("retry-rereview-replacement", 60);
      await repository.checkpoint(replacement!, { kind: "source_extraction", facts: [{
        id: "iris-coat", kind: "character", subject: "Iris", predicate: "clothing", value: "blue coat", provenance: "stated",
        citations: [{ sourceId: source.id, paragraphId: chunks[0]!.spans[0]!.paragraphId, start: chunks[0]!.spans[0]!.start, end: chunks[0]!.spans[0]!.end, quote: text }]
      }] });
      const refreshed = await repository.read({ ownerUserId }, submitted.id);
      if (refreshed?.kind !== "story_source") throw new Error("Expected refreshed retry-rereview source job.");
      const replacementFactId = refreshed.source!.facts.find((fact) => fact.provenance === "stated")!.id;
      expect(replacementFactId).not.toBe(factId);
      expect(refreshed.source).toMatchObject({ acceptedFactIds: [manualId], selectedCharacterFactIds: [], characterIdentityGroups: [] });
      expect(refreshed.source?.facts).toEqual(expect.arrayContaining([expect.objectContaining({ id: manualId, provenance: "manual" })]));
      expect(refreshed.stages).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: "source:synthesis", status: "cancelled" }),
        expect.objectContaining({ key: `source:character:${factId}`, status: "cancelled" })
      ]));
      const synthesisRetry = await fetch(`${api.url}/api/v1/authoring/source-jobs/${submitted.id}/synthesis`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: refreshed.revision })
      });
      expect(synthesisRetry.status).toBe(409);
      expect(retryQueued.revision).toBeLessThanOrEqual(refreshed.revision);
      const rereview = await fetch(`${api.url}/api/v1/authoring/source-jobs/${submitted.id}/facts`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: refreshed.revision, acceptedFactIds: [replacementFactId, manualId], rejectedFactIds: [], uncertainFactIds: [], selectedCharacterFactIds: [replacementFactId],
          characterIdentityGroups: [{ representativeFactId: replacementFactId, factIds: [replacementFactId] }], manualFacts: []
        })
      });
      expect(rereview.status).toBe(200);
      const rereviewed = await rereview.json() as { revision: number; source: { acceptedFactIds: string[]; selectedCharacterFactIds: string[] } };
      expect(rereviewed.source).toMatchObject({ acceptedFactIds: [replacementFactId, manualId], selectedCharacterFactIds: [replacementFactId] });
      const resumed = await fetch(`${api.url}/api/v1/authoring/source-jobs/${submitted.id}/synthesis`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: rereviewed.revision })
      });
      expect(resumed.status).toBe(200);
      const resumedClaim = await repository.claim("retry-rereview-resumed-synthesis", 60);
      await repository.checkpoint(resumedClaim!, { kind: "source_world", proposal: { schemaVersion: 5, world: { title: "retry-rereview.txt", genre: "", tone: "", premise: "", backgroundStory: "", firstAction: "", rules: "" }, playableCharacters: [], entities: [], relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [], defaults: {} } });
      const resumedCharacter = await repository.claim("retry-rereview-resumed-character", 60);
      await repository.checkpoint(resumedCharacter!, { kind: "source_world", proposal: { schemaVersion: 5, world: { title: "retry-rereview.txt", genre: "", tone: "", premise: "", backgroundStory: "", firstAction: "", rules: "" }, playableCharacters: [], entities: [], relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [], defaults: {} } });
      await expect(repository.read({ ownerUserId }, submitted.id)).resolves.toMatchObject({ status: "awaiting_review", source: { acceptedFactIds: [replacementFactId, manualId] } });
    } finally {
      await api.close();
    }
  });

  it("does not queue synthesis when a retried leaf leaves a mixed identity group incomplete", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const paragraphs = [0, 1, 2].map((index) => `Iris ${index} keeps the harbor watch. `.repeat(48));
    const text = paragraphs.join("\n\n");
    const submitted = await repository.submit({ ownerUserId }, {
      kind: "story_source", idempotencyKey: randomUUID(), target: { kind: "new_world" }, name: "mixed-identity-retry.txt", text,
      mode: "faithful", boundaryParagraphId: "paragraph:2", instructions: "Keep explicit character identities separate."
    }, sha256(text));
    jobs.push(submitted.id);
    const source = normalizeSourceDocument("mixed-identity-retry.txt", text, submitted.id);
    const chunks = planSourceChunks({
      source, boundaryParagraphId: "paragraph:2", systemPrompt: "source", instructions: "Keep explicit character identities separate.",
      budget: { contextWindowTokens: 2_000, maxOutputTokens: 100, countTokens: value => Buffer.byteLength(value, "utf8") }
    });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    const plan = await repository.claim("mixed-identity-retry-plan", 60);
    await repository.initializeExecutionSnapshot(plan!, { providerProfileId: randomUUID(), model: "synthetic", configurationHash: "f".repeat(64), contextWindowTokens: 2_000, maxOutputTokens: 100, requestTimeoutMs: 10_000, prompts: {}, protocols: { source: SOURCE_EXTRACTION_PROMPT_PROTOCOL_VERSION } });
    await repository.checkpoint(plan!, { kind: "source_plan", chunks });
    for (const [index, chunk] of chunks.entries()) {
      const claim = await repository.claim(`mixed-identity-retry-extraction-${index}`, 60);
      const span = chunk.spans.at(-1)!;
      const [predicate, value] = [["role", "harbor keeper"], ["clothing", "blue coat"], ["hair", "black hair"]][index % 3]!;
      await repository.checkpoint(claim!, { kind: "source_extraction", facts: [{
        id: `iris-watch-${index}`, kind: "character", subject: "Iris", predicate, value, provenance: "stated",
        citations: [{ sourceId: source.id, paragraphId: span.paragraphId, start: span.start, end: span.end, quote: Array.from(text).slice(span.start, span.end).join("") }]
      }] });
    }
    const extracted = await repository.read({ ownerUserId }, submitted.id);
    if (extracted?.kind !== "story_source") throw new Error("Expected mixed-identity extraction.");
    const facts = extracted.source!.facts.filter((fact) => fact.provenance === "stated");
    expect(facts).toHaveLength(chunks.length);
    const [retained, retried, selected] = facts;
    if (!retained || !retried || !selected) throw new Error("Expected three source facts for mixed identity coverage.");
    const reviewed = await repository.reviewSourceFacts!({ ownerUserId }, submitted.id, {
      expectedRevision: extracted.revision, acceptedFactIds: [retained.id, retried.id, selected.id], rejectedFactIds: [], uncertainFactIds: [], selectedCharacterFactIds: [selected.id],
      characterIdentityGroups: [
        { representativeFactId: retained.id, factIds: [retained.id, retried.id] },
        { representativeFactId: selected.id, factIds: [selected.id] }
      ], manualFacts: []
    });
    const retriedStage = reviewed.stages.find((stage) => stage.key === `source:chunk:${chunks[1]!.id}`);
    if (!retriedStage) throw new Error("Expected selected retried extraction stage.");
    const api = await startSourceApi(ownerUserId);
    try {
      const retry = await fetch(`${api.url}/api/v1/authoring/jobs/${submitted.id}/retry`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: reviewed.revision, stageId: retriedStage.id })
      });
      expect(retry.status).toBe(200);
      const replacementClaim = await repository.claim("mixed-identity-retry-replacement", 60);
      const span = chunks[1]!.spans.at(-1)!;
      await repository.checkpoint(replacementClaim!, { kind: "source_extraction", facts: [{
        id: "iris-watch-replacement", kind: "character", subject: "Iris", predicate: "clothing", value: "replacement blue coat", provenance: "stated",
        citations: [{ sourceId: source.id, paragraphId: span.paragraphId, start: span.start, end: span.end, quote: Array.from(text).slice(span.start, span.end).join("") }]
      }] });
      const refreshed = await repository.read({ ownerUserId }, submitted.id);
      if (refreshed?.kind !== "story_source") throw new Error("Expected mixed-identity retry detail.");
      expect(refreshed.source).toMatchObject({
        acceptedFactIds: [retained.id, selected.id], selectedCharacterFactIds: [selected.id],
        characterIdentityGroups: [{ representativeFactId: selected.id, factIds: [selected.id] }]
      });
      const synthesis = await fetch(`${api.url}/api/v1/authoring/source-jobs/${submitted.id}/synthesis`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: refreshed.revision })
      });
      expect(synthesis.status).toBe(409);
      expect((await repository.read({ ownerUserId }, submitted.id))?.stages.some((stage) => stage.key === "source:synthesis" && stage.status !== "cancelled")).toBe(false);
    } finally {
      await api.close();
    }
  });

  it("runs bounded source-world overview and selected-character stages through the real worker", async () => {
    const profile = await createProvider(pool, {
      name: `P3 source world ${randomUUID()}`, providerType: "openai_compatible", providerRole: "text",
      baseUrl: `http://127.0.0.1:${providerPort}/v1`, defaultModel: "source-test", contextWindowTokens: 8_192,
      maxOutputTokens: 256, temperature: 0, enabled: true, isDefault: true, configuration: {}
    }, credentialSecret);
    const repository = createPostgresAuthoringRepository(pool);
    const text = "Iris wears a blue coat.";
    const submitted = await repository.submit({ ownerUserId }, {
      kind: "story_source", idempotencyKey: randomUUID(), target: { kind: "new_world" }, name: "worker-world.txt", text,
      mode: "faithful", boundaryParagraphId: "paragraph:0", instructions: "P3.5 source-world worker fixture."
    }, sha256(text));
    jobs.push(submitted.id);
    sourceWorldFixture = true;
    quoteOnlyExtractionFixture = true;
    try {
      expect(await runSourceWorker(16)).toEqual({ completed: 2, runs: [true, true, false] });
      const extracted = await repository.read({ ownerUserId }, submitted.id);
      if (extracted?.kind !== "story_source") throw new Error("Expected extracted source detail.");
      expect(extracted.source).toMatchObject({ extractionComplete: true, facts: [expect.objectContaining({ subject: "Iris", predicate: "clothing", value: "blue coat", citations: [expect.objectContaining({ paragraphId: "paragraph:0", start: 0, end: Array.from(text).length, quote: text })] })] });
      const factId = extracted.source?.facts[0]?.id;
      if (!factId) throw new Error("Source-world worker fixture did not produce a reviewed fact.");
      const reviewed = await repository.reviewSourceFacts!({ ownerUserId }, submitted.id, {
        expectedRevision: extracted.revision, acceptedFactIds: [factId], rejectedFactIds: [], uncertainFactIds: [], selectedCharacterFactIds: [factId],
        characterIdentityGroups: [{ representativeFactId: factId, factIds: [factId] }], manualFacts: []
      });
      await repository.startSourceSynthesis!({ ownerUserId }, submitted.id, reviewed.revision);
      expect(await runSourceWorker(16)).toEqual({ completed: 2, runs: [true, true, false] });
      const completed = await repository.read({ ownerUserId }, submitted.id);
      expect(completed).toMatchObject({
        status: "awaiting_review",
        result: { world: { title: "worker-world.txt" }, playableCharacters: [expect.objectContaining({ name: "Iris", profile: expect.objectContaining({ appearance: expect.objectContaining({ clothing: "blue coat" }) }) })] },
        stages: expect.arrayContaining([expect.objectContaining({ key: "source:synthesis", status: "validated" }), expect.objectContaining({ key: `source:character:${factId}`, status: "validated" })])
      });
      const evidence = await pool.query<{ mappings: unknown; candidates: unknown }>(
        "SELECT output->'mappings' AS mappings, output->'expansionCandidates' AS candidates FROM authoring_job_stages WHERE job_id = $1 AND stage_key = $2 AND status = 'validated'",
        [submitted.id, `source:character:${factId}`]
      );
      expect(evidence.rows).toEqual([expect.objectContaining({
        mappings: [expect.objectContaining({ target: { characterRepresentativeFactId: factId }, path: "profile.appearance.clothing", supportingFactIds: [factId] })],
        candidates: []
      })]);
    } finally {
      sourceWorldFixture = false;
      await pool.query("DELETE FROM provider_profiles WHERE id = $1", [profile.id]);
    }
  });

  it("retains completed extraction and synthesis while a character stage fails, then retries only that character in a restarted worker", async () => {
    const profile = await createProvider(pool, {
      name: `P3 character restart ${randomUUID()}`, providerType: "openai_compatible", providerRole: "text",
      baseUrl: `http://127.0.0.1:${providerPort}/v1`, defaultModel: "source-test", contextWindowTokens: 8_192,
      maxOutputTokens: 256, temperature: 0, enabled: true, isDefault: true, configuration: {}
    }, credentialSecret);
    const repository = createPostgresAuthoringRepository(pool);
    const text = "Iris wears a blue coat.";
    const submitted = await repository.submit({ ownerUserId }, {
      kind: "story_source", idempotencyKey: randomUUID(), target: { kind: "new_world" }, name: "character-restart.txt", text,
      mode: "faithful", boundaryParagraphId: "paragraph:0", instructions: "P3.9 character restart fixture."
    }, sha256(text));
    jobs.push(submitted.id);
    sourceWorldFixture = true;
    sourceWorldResponseCount = 0;
    failSourceWorldOnResponse = 2;
    try {
      expect(await runSourceWorker(16)).toEqual({ completed: 2, runs: [true, true, false] });
      const extracted = await repository.read({ ownerUserId }, submitted.id);
      if (extracted?.kind !== "story_source") throw new Error("Expected extracted character restart source detail.");
      const factId = extracted.source?.facts[0]?.id;
      if (!factId) throw new Error("Character restart extraction omitted its selected fact.");
      const reviewed = await repository.reviewSourceFacts!({ ownerUserId }, submitted.id, {
        expectedRevision: extracted.revision, acceptedFactIds: [factId], rejectedFactIds: [], uncertainFactIds: [], selectedCharacterFactIds: [factId],
        characterIdentityGroups: [{ representativeFactId: factId, factIds: [factId] }], manualFacts: []
      });
      await repository.startSourceSynthesis!({ ownerUserId }, submitted.id, reviewed.revision);
      expect(await runSourceWorker(16)).toEqual({ completed: 1, runs: [true, false] });
      const failed = await repository.read({ ownerUserId }, submitted.id);
      if (failed?.kind !== "story_source") throw new Error("Expected failed character restart source detail.");
      const synthesis = failed.stages.find((stage) => stage.key === "source:synthesis");
      const character = failed.stages.find((stage) => stage.key === `source:character:${factId}`);
      expect(synthesis).toMatchObject({ generation: 1, status: "validated", attemptCount: 1 });
      expect(character).toMatchObject({ generation: 1, status: "recoverable", attemptCount: 1 });
      if (!character) throw new Error("Expected one recoverable selected character stage.");
      const retainedSynthesis = await pool.query<{ output: string }>("SELECT output::text AS output FROM authoring_job_stages WHERE job_id=$1 AND stage_key='source:synthesis' AND generation=1", [submitted.id]);
      const retainedSynthesisHash = sha256(retainedSynthesis.rows[0]!.output);
      const retried = await repository.retry({ ownerUserId }, submitted.id, character.id, failed.revision);
      const replacement = retried.stages.filter((stage) => stage.key === character.key).sort((left, right) => left.generation - right.generation).at(-1);
      expect(replacement).toMatchObject({ generation: 2, status: "queued", attemptCount: 0 });
      expect(retried.stages.find((stage) => stage.key === "source:synthesis")).toMatchObject({ generation: 1, status: "validated" });
      expect(await sourceEligibility(pool, submitted.id)).toMatchObject({
        job: { status: "queued", expired: false },
        stages: expect.arrayContaining([expect.objectContaining({ stage_key: character.key, generation: 2, status: "queued", lease_live: null })])
      });
      expect(await runDueSourceRetry({ pool, jobId: submitted.id, stageId: replacement!.id, stageKey: character.key, generation: 2, providerCalls: () => providerCalls })).toEqual({ completed: 1, runs: [true, false] });
      const completed = await repository.read({ ownerUserId }, submitted.id);
      expect(completed).toMatchObject({
        status: "awaiting_review",
        stages: expect.arrayContaining([expect.objectContaining({ key: "source:synthesis", generation: 1, status: "validated", attemptCount: 1 }), expect.objectContaining({ key: character.key, generation: 2, status: "validated", attemptCount: 1 })])
      });
      const afterRetrySynthesis = await pool.query<{ output: string }>("SELECT output::text AS output FROM authoring_job_stages WHERE job_id=$1 AND stage_key='source:synthesis' AND generation=1", [submitted.id]);
      expect(sha256(afterRetrySynthesis.rows[0]!.output)).toBe(retainedSynthesisHash);
    } finally {
      sourceWorldFixture = false;
      await pool.query("DELETE FROM provider_profiles WHERE id=$1", [profile.id]);
    }
  });

  it("retains explicitly reviewed expansion candidates across synthesis replacement without promoting rejected or uncertain candidates", async () => {
    const profile = await createProvider(pool, {
      name: `P3 expansion review ${randomUUID()}`, providerType: "openai_compatible", providerRole: "text",
      baseUrl: `http://127.0.0.1:${providerPort}/v1`, defaultModel: "source-test", contextWindowTokens: 8_192,
      maxOutputTokens: 256, temperature: 0, enabled: true, isDefault: true, configuration: {}
    }, credentialSecret);
    const repository = createPostgresAuthoringRepository(pool);
    const text = "Iris wears a blue coat.";
    const submitted = await repository.submit({ ownerUserId }, {
      kind: "story_source", idempotencyKey: randomUUID(), target: { kind: "new_world" }, name: "expand.txt", text,
      mode: "expand", boundaryParagraphId: "paragraph:0", instructions: "Offer separately reviewed expansion candidates."
    }, sha256(text));
    jobs.push(submitted.id);
    sourceWorldFixture = true;
    sourceWorldExpansionFixture = true;
    sourceWorldAcceptedFactIds = [];
    try {
      expect(await runSourceWorker(16)).toEqual({ completed: 2, runs: [true, true, false] });
      const extracted = await repository.read({ ownerUserId }, submitted.id);
      if (extracted?.kind !== "story_source") throw new Error("Expected extracted expansion source detail.");
      const statedFactId = extracted.source?.facts[0]?.id;
      if (!statedFactId) throw new Error("Expansion fixture did not produce its stated fact.");
      const firstReview = await repository.reviewSourceFacts!({ ownerUserId }, submitted.id, {
        expectedRevision: extracted.revision, acceptedFactIds: [statedFactId], rejectedFactIds: [], uncertainFactIds: [], selectedCharacterFactIds: [statedFactId],
        characterIdentityGroups: [{ representativeFactId: statedFactId, factIds: [statedFactId] }], manualFacts: []
      });
      await repository.startSourceSynthesis!({ ownerUserId }, submitted.id, firstReview.revision);
      expect(await runSourceWorker(16)).toEqual({ completed: 2, runs: [true, true, false] });
      const candidatesView = await repository.read({ ownerUserId }, submitted.id);
      if (candidatesView?.kind !== "story_source") throw new Error("Expected current expansion candidate detail.");
      const candidates = candidatesView.source?.expansionCandidates ?? [];
      const acceptedCandidate = candidates.find((fact) => fact.value === "The gates cannot be crossed after dusk.");
      const rejectedCandidate = candidates.find((fact) => fact.value === "Somber");
      const uncertainCandidate = candidates.find((fact) => fact.value === "black hair");
      expect(acceptedCandidate).toMatchObject({ provenance: "invented", kind: "rule", predicate: "rule", citations: [] });
      expect(rejectedCandidate).toMatchObject({ provenance: "invented", kind: "tone", predicate: "tone", citations: [] });
      expect(uncertainCandidate).toMatchObject({ provenance: "invented", citations: [] });
      if (!acceptedCandidate || !rejectedCandidate || !uncertainCandidate) throw new Error("Expected all generated expansion candidates.");
      await expect(repository.reviewSourceFacts!({ ownerUserId }, submitted.id, {
        expectedRevision: candidatesView.revision, acceptedFactIds: [statedFactId, "source-fact:expansion:foreign"], rejectedFactIds: [], uncertainFactIds: [], selectedCharacterFactIds: [],
        characterIdentityGroups: [{ representativeFactId: statedFactId, factIds: [statedFactId] }], manualFacts: []
      })).rejects.toMatchObject({ code: "invalid_state" });
      const reviewed = await repository.reviewSourceFacts!({ ownerUserId }, submitted.id, {
        expectedRevision: candidatesView.revision, acceptedFactIds: [statedFactId, acceptedCandidate.id], rejectedFactIds: [rejectedCandidate.id], uncertainFactIds: [uncertainCandidate.id], selectedCharacterFactIds: [],
        characterIdentityGroups: [{ representativeFactId: statedFactId, factIds: [statedFactId] }], manualFacts: []
      });
      if (reviewed.kind !== "story_source") throw new Error("Expected reviewed expansion detail.");
      expect(reviewed.source).toMatchObject({
        acceptedFactIds: [statedFactId, acceptedCandidate.id],
        rejectedFactIds: [rejectedCandidate.id],
        uncertainFactIds: [uncertainCandidate.id],
        expansionCandidates: expect.arrayContaining([
          expect.objectContaining({ id: acceptedCandidate.id, provenance: "invented", value: acceptedCandidate.value, citations: [] }),
          expect.objectContaining({ id: rejectedCandidate.id, provenance: "invented", value: rejectedCandidate.value, citations: [] }),
          expect.objectContaining({ id: uncertainCandidate.id, provenance: "invented", value: uncertainCandidate.value, citations: [] })
        ])
      });
      expect(reviewed.stages).toEqual(expect.arrayContaining([expect.objectContaining({ key: "source:synthesis", status: "cancelled" })]));
      await repository.startSourceSynthesis!({ ownerUserId }, submitted.id, reviewed.revision);
      expect(await runSourceWorker(16)).toEqual({ completed: 1, runs: [true, false] });
      expect(sourceWorldAcceptedFactIds.at(-1)).toEqual([statedFactId, acceptedCandidate.id]);
      const completed = await repository.read({ ownerUserId }, submitted.id);
      expect(completed).toMatchObject({
        result: { world: { rules: acceptedCandidate.value } },
        source: {
          acceptedFactIds: [statedFactId, acceptedCandidate.id],
          rejectedFactIds: [rejectedCandidate.id],
          uncertainFactIds: [uncertainCandidate.id]
        }
      });
    } finally {
      sourceWorldExpansionFixture = false;
      sourceWorldFixture = false;
      sourceWorldAcceptedFactIds = [];
      await pool.query("DELETE FROM provider_profiles WHERE id = $1", [profile.id]);
    }
  });

  it("re-synthesizes an explicitly accepted apparent-age expansion as an age fact", async () => {
    const profile = await createProvider(pool, {
      name: `P3 age expansion ${randomUUID()}`, providerType: "openai_compatible", providerRole: "text",
      baseUrl: `http://127.0.0.1:${providerPort}/v1`, defaultModel: "source-test", contextWindowTokens: 8_192,
      maxOutputTokens: 256, temperature: 0, enabled: true, isDefault: true, configuration: {}
    }, credentialSecret);
    const repository = createPostgresAuthoringRepository(pool);
    const text = "Iris wears a blue coat.";
    const submitted = await repository.submit({ ownerUserId }, {
      kind: "story_source", idempotencyKey: randomUUID(), target: { kind: "new_world" }, name: "age-expansion.txt", text,
      mode: "expand", boundaryParagraphId: "paragraph:0", instructions: "Offer a separately reviewed apparent age."
    }, sha256(text));
    jobs.push(submitted.id);
    sourceWorldFixture = true;
    sourceWorldAgeExpansionFixture = true;
    sourceWorldAcceptedFactIds = [];
    try {
      expect(await runSourceWorker(16)).toEqual({ completed: 2, runs: [true, true, false] });
      const extracted = await repository.read({ ownerUserId }, submitted.id);
      if (extracted?.kind !== "story_source") throw new Error("Expected age-expansion source detail.");
      const stated = extracted.source?.facts[0];
      if (!stated) throw new Error("Age expansion fixture omitted stated support.");
      const firstReview = await repository.reviewSourceFacts!({ ownerUserId }, submitted.id, {
        expectedRevision: extracted.revision, acceptedFactIds: [stated.id], rejectedFactIds: [], uncertainFactIds: [], selectedCharacterFactIds: [stated.id],
        characterIdentityGroups: [{ representativeFactId: stated.id, factIds: [stated.id] }], manualFacts: []
      });
      await repository.startSourceSynthesis!({ ownerUserId }, submitted.id, firstReview.revision);
      expect(await runSourceWorker(16)).toEqual({ completed: 2, runs: [true, true, false] });
      const candidates = await repository.read({ ownerUserId }, submitted.id);
      if (candidates?.kind !== "story_source") throw new Error("Expected age expansion candidate detail.");
      const age = candidates.source?.expansionCandidates.find((fact) => fact.predicate === "age" && fact.value === "thirty");
      expect(age).toMatchObject({ kind: "character", provenance: "invented", citations: [] });
      if (!age) throw new Error("Expected projected apparent-age expansion.");
      const reviewed = await repository.reviewSourceFacts!({ ownerUserId }, submitted.id, {
        expectedRevision: candidates.revision, acceptedFactIds: [stated.id, age.id], rejectedFactIds: [], uncertainFactIds: [], selectedCharacterFactIds: [stated.id],
        characterIdentityGroups: [{ representativeFactId: stated.id, factIds: [stated.id, age.id] }], manualFacts: []
      });
      await repository.startSourceSynthesis!({ ownerUserId }, submitted.id, reviewed.revision);
      expect(await runSourceWorker(16)).toEqual({ completed: 2, runs: [true, true, false] });
      const completed = await repository.read({ ownerUserId }, submitted.id);
      expect(sourceWorldAcceptedFactIds.at(-1)).toEqual([stated.id, age.id]);
      expect(completed).toMatchObject({
        result: { playableCharacters: [expect.objectContaining({ profile: expect.objectContaining({ appearance: expect.objectContaining({ apparentAge: "thirty" }) }) })] },
        source: { acceptedFactIds: [stated.id, age.id] }
      });
    } finally {
      sourceWorldFixture = false;
      sourceWorldAcceptedFactIds = [];
      await pool.query("DELETE FROM provider_profiles WHERE id = $1", [profile.id]);
    }
  });

  it("rejects an unknown expansion path before it reaches review inventory or canon", async () => {
    const profile = await createProvider(pool, {
      name: `P3 unknown expansion ${randomUUID()}`, providerType: "openai_compatible", providerRole: "text",
      baseUrl: `http://127.0.0.1:${providerPort}/v1`, defaultModel: "source-test", contextWindowTokens: 8_192,
      maxOutputTokens: 256, temperature: 0, enabled: true, isDefault: true, configuration: {}
    }, credentialSecret);
    const repository = createPostgresAuthoringRepository(pool);
    const text = "Iris wears a blue coat.";
    const submitted = await repository.submit({ ownerUserId }, {
      kind: "story_source", idempotencyKey: randomUUID(), target: { kind: "new_world" }, name: "unknown-expand.txt", text,
      mode: "expand", boundaryParagraphId: "paragraph:0", instructions: "Reject unknown expansion targets."
    }, sha256(text));
    jobs.push(submitted.id);
    sourceWorldFixture = true;
    sourceWorldUnknownExpansionFixture = true;
    try {
      expect(await runSourceWorker(16)).toEqual({ completed: 2, runs: [true, true, false] });
      const extracted = await repository.read({ ownerUserId }, submitted.id);
      if (extracted?.kind !== "story_source") throw new Error("Expected extracted unknown-expansion detail.");
      const statedFactId = extracted.source?.facts[0]?.id;
      if (!statedFactId) throw new Error("Unknown-expansion fixture did not produce its stated fact.");
      const reviewed = await repository.reviewSourceFacts!({ ownerUserId }, submitted.id, {
        expectedRevision: extracted.revision, acceptedFactIds: [statedFactId], rejectedFactIds: [], uncertainFactIds: [], selectedCharacterFactIds: [],
        characterIdentityGroups: [{ representativeFactId: statedFactId, factIds: [statedFactId] }], manualFacts: []
      });
      await repository.startSourceSynthesis!({ ownerUserId }, submitted.id, reviewed.revision);
      expect(await runSourceWorker(16)).toEqual({ completed: 0, runs: [false] });
      const failed = await repository.read({ ownerUserId }, submitted.id);
      expect(failed).toMatchObject({
        status: "recoverable",
        source: { acceptedFactIds: [statedFactId], expansionCandidates: [] }
      });
      expect(failed?.stages).toEqual(expect.arrayContaining([expect.objectContaining({ key: "source:synthesis", status: "recoverable" })]));
      expect(failed?.result).toBeUndefined();
    } finally {
      sourceWorldUnknownExpansionFixture = false;
      sourceWorldFixture = false;
      await pool.query("DELETE FROM provider_profiles WHERE id = $1", [profile.id]);
    }
  });

  it("requires explicit source-character identities while preserving separate same-name people", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const text = "Iris recorded the North Harbor chart.\n\nIris recorded the South Harbor chart.";
    const submitted = await repository.submit({ ownerUserId }, {
      kind: "story_source", idempotencyKey: randomUUID(), target: { kind: "new_world" }, name: "identities.txt", text,
      mode: "faithful", boundaryParagraphId: "paragraph:1", instructions: "Preserve exact source identities."
    }, sha256(text));
    jobs.push(submitted.id);
    if (submitted.kind !== "story_source") throw new Error("Expected source authoring job.");
    const source = normalizeSourceDocument("identities.txt", text, submitted.id);
    const chunks = planSourceChunks({ source, boundaryParagraphId: "paragraph:1", systemPrompt: "source", instructions: "Preserve exact source identities.", budget: { contextWindowTokens: 100_000, maxOutputTokens: 100, countTokens: value => Buffer.byteLength(value, "utf8") } });
    expect(chunks).toHaveLength(1);
    const planClaim = await repository.claim("identity-plan", 60);
    await repository.initializeExecutionSnapshot(planClaim!, { providerProfileId: randomUUID(), model: "synthetic", configurationHash: "c".repeat(64), contextWindowTokens: 100_000, maxOutputTokens: 100, requestTimeoutMs: 10_000, prompts: {}, protocols: { source: SOURCE_EXTRACTION_PROMPT_PROTOCOL_VERSION } });
    await repository.checkpoint(planClaim!, { kind: "source_plan", chunks });
    const chunk = chunks[0]!;
    const claim = await repository.claim("identity-chunk", 60);
    const paragraph = (index: number) => source.paragraphs[index]!;
    const citation = (index: number) => ({ sourceId: source.id, paragraphId: paragraph(index).id, start: paragraph(index).start, end: paragraph(index).end, quote: Array.from(source.text).slice(paragraph(index).start, paragraph(index).end).join("") });
    const northFacts: SourceFact[] = Array.from({ length: 21 }, (_, index) => ({
      id: `north:${index}`, kind: "character", subject: "Iris", predicate: `north-detail-${index}`, value: "North Harbor", provenance: "stated", citations: [citation(0)]
    }));
    const southFact: SourceFact = { id: "south", kind: "character", subject: "Iris", predicate: "resides", value: "South Harbor", provenance: "stated", citations: [citation(1)] };
    await repository.checkpoint(claim!, { kind: "source_extraction", facts: [...northFacts, southFact] });
    const detail = (await repository.read({ ownerUserId }, submitted.id))!;
    if (detail.kind !== "story_source") throw new Error("Expected source authoring detail.");
    const northIds = detail.source!.facts.filter((fact) => fact.predicate.startsWith("north-detail-")).map((fact) => fact.id);
    const southId = detail.source!.facts.find((fact) => fact.value === "South Harbor")!.id;
    const groups = [
      { representativeFactId: northIds[0]!, factIds: northIds },
      { representativeFactId: southId, factIds: [southId] }
    ];
    const accepted = [...northIds, southId];

    await expect(repository.reviewSourceFacts!({ ownerUserId }, submitted.id, {
      expectedRevision: detail.revision, acceptedFactIds: accepted, rejectedFactIds: [], uncertainFactIds: [], selectedCharacterFactIds: [], characterIdentityGroups: [], manualFacts: []
    })).rejects.toMatchObject({ code: "invalid_state" });
    await expect(repository.reviewSourceFacts!({ ownerUserId }, submitted.id, {
      expectedRevision: detail.revision, acceptedFactIds: accepted, rejectedFactIds: [], uncertainFactIds: [], selectedCharacterFactIds: [northIds[0]!, northIds[1]!], characterIdentityGroups: groups, manualFacts: []
    })).rejects.toThrow(/identity representatives/u);

    const reviewed = await repository.reviewSourceFacts!({ ownerUserId }, submitted.id, {
      expectedRevision: detail.revision, acceptedFactIds: accepted, rejectedFactIds: [], uncertainFactIds: [], selectedCharacterFactIds: [northIds[0]!], characterIdentityGroups: groups, manualFacts: []
    });
    if (reviewed.kind !== "story_source") throw new Error("Expected reviewed source detail.");
    expect(reviewed.source?.selectedCharacterFactIds).toEqual([northIds[0]]);
    expect(reviewed.source?.characterIdentityGroups).toEqual(groups);
    expect(reviewed.source?.acceptedFactIds).toHaveLength(22);
  });

  it("remaps new manual character identities before they become accepted source facts", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const text = "The harbor bell marks the evening tide.";
    const submitted = await repository.submit({ ownerUserId }, {
      kind: "story_source", idempotencyKey: randomUUID(), target: { kind: "new_world" }, name: "manual-identities.txt", text,
      mode: "faithful", boundaryParagraphId: "paragraph:0", instructions: "Preserve exact source identities."
    }, sha256(text));
    jobs.push(submitted.id);
    if (submitted.kind !== "story_source") throw new Error("Expected source authoring job.");
    const source = normalizeSourceDocument("manual-identities.txt", text, submitted.id);
    const chunks = planSourceChunks({ source, boundaryParagraphId: "paragraph:0", systemPrompt: "source", instructions: "Preserve exact source identities.", budget: { contextWindowTokens: 100_000, maxOutputTokens: 100, countTokens: value => Buffer.byteLength(value, "utf8") } });
    expect(chunks).toHaveLength(1);
    const planClaim = await repository.claim("manual-identity-plan", 60);
    await repository.initializeExecutionSnapshot(planClaim!, { providerProfileId: randomUUID(), model: "synthetic", configurationHash: "d".repeat(64), contextWindowTokens: 100_000, maxOutputTokens: 100, requestTimeoutMs: 10_000, prompts: {}, protocols: { source: SOURCE_EXTRACTION_PROMPT_PROTOCOL_VERSION } });
    await repository.checkpoint(planClaim!, { kind: "source_plan", chunks });
    const chunk = chunks[0]!;
    const paragraph = source.paragraphs[0]!;
    const claim = await repository.claim("manual-identity-chunk", 60);
    await repository.checkpoint(claim!, { kind: "source_extraction", facts: [{
      id: "harbor-rule", kind: "rule", subject: "harbor bell", predicate: "marks", value: "the evening tide", provenance: "stated",
      citations: [{ sourceId: source.id, paragraphId: paragraph.id, start: paragraph.start, end: paragraph.end, quote: source.text }]
    }] });
    const detail = (await repository.read({ ownerUserId }, submitted.id))!;
    if (detail.kind !== "story_source") throw new Error("Expected source authoring detail.");
    const existingId = detail.source!.facts[0]!.id;
    const manualReferenceId = "manual-request:iris";
    const manualCharacter = {
      id: manualReferenceId, kind: "character" as const, subject: "Iris", predicate: "role", value: "harbor keeper", provenance: "manual" as const, citations: []
    } satisfies SourceFact;

    await expect(repository.reviewSourceFacts!({ ownerUserId }, submitted.id, {
      expectedRevision: detail.revision, acceptedFactIds: [existingId], rejectedFactIds: [], uncertainFactIds: [], selectedCharacterFactIds: [], characterIdentityGroups: [], manualFacts: [manualCharacter]
    })).rejects.toMatchObject({ code: "invalid_state" });
    await expect(repository.reviewSourceFacts!({ ownerUserId }, submitted.id, {
      expectedRevision: detail.revision, acceptedFactIds: [existingId], rejectedFactIds: [], uncertainFactIds: [], selectedCharacterFactIds: [], characterIdentityGroups: [],
      manualFacts: [{ ...manualCharacter, id: existingId, kind: "rule", subject: "harbor bell", predicate: "marks", value: "a false tide" }]
    })).rejects.toMatchObject({ code: "invalid_state" });

    const reviewed = await repository.reviewSourceFacts!({ ownerUserId }, submitted.id, {
      expectedRevision: detail.revision, acceptedFactIds: [existingId, manualReferenceId], rejectedFactIds: [], uncertainFactIds: [], selectedCharacterFactIds: [manualReferenceId],
      characterIdentityGroups: [{ representativeFactId: manualReferenceId, factIds: [manualReferenceId] }], manualFacts: [manualCharacter]
    });
    if (reviewed.kind !== "story_source") throw new Error("Expected reviewed source detail.");
    const persistedManual = reviewed.source!.facts.find((fact) => fact.provenance === "manual")!;
    expect(persistedManual).toMatchObject({ id: expect.stringMatching(/^source-fact:manual:/u), kind: "character", citations: [] });
    expect(persistedManual.id).not.toBe(manualReferenceId);
    expect(reviewed.source?.acceptedFactIds).toEqual([existingId, persistedManual.id]);
    expect(reviewed.source?.selectedCharacterFactIds).toEqual([persistedManual.id]);
    expect(reviewed.source?.characterIdentityGroups).toEqual([{ representativeFactId: persistedManual.id, factIds: [persistedManual.id] }]);

    const rereviewed = await repository.reviewSourceFacts!({ ownerUserId }, submitted.id, {
      expectedRevision: reviewed.revision, acceptedFactIds: [existingId, persistedManual.id], rejectedFactIds: [], uncertainFactIds: [], selectedCharacterFactIds: [persistedManual.id],
      characterIdentityGroups: [{ representativeFactId: persistedManual.id, factIds: [persistedManual.id] }], manualFacts: []
    });
    if (rereviewed.kind !== "story_source") throw new Error("Expected rereviewed source detail.");
    expect(rereviewed.revision).toBe(reviewed.revision + 1);
    expect(rereviewed.source?.facts).toContainEqual(persistedManual);
    expect(rereviewed.source?.acceptedFactIds).toEqual([existingId, persistedManual.id]);
    expect(rereviewed.source?.selectedCharacterFactIds).toEqual([persistedManual.id]);
    expect(rereviewed.source?.characterIdentityGroups).toEqual([{ representativeFactId: persistedManual.id, factIds: [persistedManual.id] }]);

    const rejectedManual = await repository.reviewSourceFacts!({ ownerUserId }, submitted.id, {
      expectedRevision: rereviewed.revision, acceptedFactIds: [existingId], rejectedFactIds: [persistedManual.id], uncertainFactIds: [], selectedCharacterFactIds: [], characterIdentityGroups: [], manualFacts: []
    });
    if (rejectedManual.kind !== "story_source") throw new Error("Expected rejected-manual source detail.");
    expect(rejectedManual.source?.facts).toContainEqual(persistedManual);
    expect(rejectedManual.source?.acceptedFactIds).toEqual([existingId]);
    expect(rejectedManual.source?.rejectedFactIds).toEqual([persistedManual.id]);
    expect(rejectedManual.source?.selectedCharacterFactIds).toEqual([]);
    expect(rejectedManual.source?.characterIdentityGroups).toEqual([]);

    const retainedRejectedManual = await repository.reviewSourceFacts!({ ownerUserId }, submitted.id, {
      expectedRevision: rejectedManual.revision, acceptedFactIds: [existingId], rejectedFactIds: [persistedManual.id], uncertainFactIds: [], selectedCharacterFactIds: [], characterIdentityGroups: [], manualFacts: []
    });
    if (retainedRejectedManual.kind !== "story_source") throw new Error("Expected retained rejected-manual detail.");
    expect(retainedRejectedManual.source?.facts).toContainEqual(persistedManual);
    expect(retainedRejectedManual.source?.rejectedFactIds).toEqual([persistedManual.id]);
  });

  it("restarts a real worker process and resumes only missing source chunks", async () => {
    const profile = await createProvider(pool, {
      name: `P3 source process ${randomUUID()}`, providerType: "openai_compatible", providerRole: "text",
      baseUrl: `http://127.0.0.1:${providerPort}/v1`, defaultModel: "source-test", contextWindowTokens: 8_192,
      maxOutputTokens: 256, temperature: 0, enabled: true, isDefault: true, configuration: {}
    }, credentialSecret);
    const repository = createPostgresAuthoringRepository(pool);
    const sourceText = `${"Iris crossed the northern bridge. ".repeat(220)}\n\n${"Iris crossed the southern bridge. ".repeat(220)}`;
    const submitted = await repository.submit({ ownerUserId }, {
      kind: "story_source", idempotencyKey: randomUUID(), target: { kind: "new_world" }, name: "restart.txt", text: sourceText,
      mode: "faithful", boundaryParagraphId: "paragraph:1", instructions: "Extract exact facts only."
    }, sha256(sourceText));
    jobs.push(submitted.id);
    try {
      const firstRun = await runSourceWorker(1);
      expect(firstRun).toEqual({ completed: 1, runs: [true] });
      const planned = await pool.query<{ stage_key: string }>("SELECT stage_key FROM authoring_job_stages WHERE job_id = $1 AND stage_key LIKE 'source:chunk:%' ORDER BY stage_key", [submitted.id]);
      expect(planned.rows.length).toBeGreaterThan(1);
      expect(await runSourceWorker(1, true)).toEqual(expect.objectContaining({
        completed: 1,
        runs: [true],
        outcomes: [expect.objectContaining({ outcome: "checkpointed", jobId: submitted.id, stageId: expect.any(String), generation: 1 })]
      }));
      const completed = await pool.query<{ stage_key: string; output: string }>("SELECT stage_key, output::text AS output FROM authoring_job_stages WHERE job_id = $1 AND stage_key LIKE 'source:chunk:%' AND status = 'validated'", [submitted.id]);
      expect(completed.rows).toHaveLength(1);
      const first = completed.rows[0]!;
      const firstHash = sha256(first.output);
      const normalized = normalizeSourceDocument("restart.txt", sourceText, submitted.id);
      const callsBeforeApiRestart = providerCalls;
      const apiBeforeRestart = await startSourceApi(ownerUserId);
      try {
        const response = await fetch(`${apiBeforeRestart.url}/api/v1/authoring/jobs/${submitted.id}`);
        expect(response.status).toBe(200);
        const checkpoint = await response.json() as { source?: { source: { sha256: string } }; stages: Array<{ key: string; status: string }> };
        expect(checkpoint.source?.source.sha256).toMatch(/^[0-9a-f]{64}$/u);
        expect(checkpoint.source?.source.sha256).toBe(normalized.sha256);
        expect(checkpoint.stages.filter((stage) => stage.key.startsWith("source:chunk:") && stage.status === "validated")).toHaveLength(1);
        expect(checkpoint.stages.filter((stage) => stage.key.startsWith("source:chunk:") && stage.status === "queued")).toHaveLength(planned.rows.length - 1);
      } finally {
        await apiBeforeRestart.close();
      }
      const apiAfterRestart = await startSourceApi(ownerUserId);
      try {
        const response = await fetch(`${apiAfterRestart.url}/api/v1/authoring/jobs/${submitted.id}`);
        expect(response.status).toBe(200);
        const checkpoint = await response.json() as { source?: { source: { sha256: string } }; stages: Array<{ key: string; status: string }> };
        expect(checkpoint.source?.source.sha256).toMatch(/^[0-9a-f]{64}$/u);
        expect(checkpoint.source?.source.sha256).toBe(normalized.sha256);
        expect(checkpoint.stages.filter((stage) => stage.key.startsWith("source:chunk:") && stage.status === "validated")).toHaveLength(1);
      } finally {
        await apiAfterRestart.close();
      }
      expect(providerCalls).toBe(callsBeforeApiRestart);
      const callsBeforeRestart = providerCalls;
      const resumed = await runSourceWorker(16);
      expect(resumed.completed).toBe(planned.rows.length - 1);
      const after = await pool.query<{ output: string }>("SELECT output::text AS output FROM authoring_job_stages WHERE job_id = $1 AND stage_key = $2 AND status = 'validated'", [submitted.id, first.stage_key]);
      expect(sha256(after.rows[0]!.output)).toBe(firstHash);
      expect(providerCalls - callsBeforeRestart).toBe(planned.rows.length - 1);
    } finally {
      await pool.query("DELETE FROM provider_profiles WHERE id = $1", [profile.id]);
    }
  });

  it("restarts a real API process and retains the normalized source without provider work", async () => {
    const callsBeforeApi = providerCalls;
    const first = await startSourceApi(ownerUserId);
    let submittedId: string | undefined;
    try {
      const text = "\uFEFF\uFEFFIris carried the lantern.\n\nThe harbor watched.";
      const response = await fetch(`${first.url}/api/v1/authoring/source-jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "story_source", idempotencyKey: randomUUID(), target: { kind: "new_world" }, name: "api-restart.txt", text,
          mode: "faithful", boundaryParagraphId: "paragraph:1", instructions: "Do not call a provider."
        })
      });
      expect(response.status).toBe(202);
      const submitted = await response.json() as { id: string; source?: { source: { text: string } } };
      submittedId = submitted.id;
      jobs.push(submittedId);
      expect(submitted.source?.source.text).toBe("\uFEFFIris carried the lantern.\n\nThe harbor watched.");
    } finally {
      await first.close();
    }
    const restarted = await startSourceApi(ownerUserId);
    try {
      const response = await fetch(`${restarted.url}/api/v1/authoring/jobs/${submittedId!}`);
      expect(response.status).toBe(200);
      const persisted = await response.json() as { kind: string; source?: { source: { text: string } } };
      expect(persisted.kind).toBe("story_source");
      expect(persisted.source?.source.text).toBe("\uFEFFIris carried the lantern.\n\nThe harbor watched.");
      expect(providerCalls).toBe(callsBeforeApi);
    } finally {
      await restarted.close();
    }
  });

  it("splits an actual output-limited provider leaf and retries only the missing child", async () => {
    const profile = await createProvider(pool, {
      name: `P3 source overflow ${randomUUID()}`, providerType: "openai_compatible", providerRole: "text",
      baseUrl: `http://127.0.0.1:${providerPort}/v1`, defaultModel: "source-test", contextWindowTokens: 8_192,
      maxOutputTokens: 256, temperature: 0, enabled: true, isDefault: true, configuration: {}
    }, credentialSecret);
    const repository = createPostgresAuthoringRepository(pool);
    const text = "Iris crossed the northern bridge. ".repeat(10);
    const submitted = await repository.submit({ ownerUserId }, {
      kind: "story_source", idempotencyKey: randomUUID(), target: { kind: "new_world" }, name: "overflow.txt", text,
      mode: "faithful", boundaryParagraphId: "paragraph:0", instructions: "Extract exact facts only."
    }, sha256(text));
    jobs.push(submitted.id);
    try {
      const beforePlan = await sourceEligibility(pool, submitted.id);
      expect(beforePlan).toMatchObject({
        job: { status: "queued", expired: false },
        stages: [expect.objectContaining({ stage_key: "source:plan", generation: 1, status: "queued", due: true, lease_live: null, parent_generations: {} })]
      });
      expect(await runSourceWorker(1, true)).toEqual(expect.objectContaining({
        completed: 1,
        runs: [true],
        outcomes: [expect.objectContaining({ outcome: "checkpointed", jobId: submitted.id, stageId: expect.any(String), generation: 1 })]
      }));
      outputLimitedResponses = 2;
      expect(await runSourceWorker(1, true)).toEqual(expect.objectContaining({
        completed: 0,
        runs: [false],
        outcomes: [expect.objectContaining({ outcome: "claimed_then_null", jobId: submitted.id, stageId: expect.any(String), generation: 1 })]
      }));
      const splitLeaves = await pool.query<{ stage_key: string; status: string }>("SELECT stage_key, status FROM authoring_job_stages WHERE job_id = $1 AND stage_key LIKE 'source:chunk:%' ORDER BY stage_key", [submitted.id]);
      expect(splitLeaves.rows.filter((stage) => stage.status === "cancelled")).toHaveLength(1);
      expect(splitLeaves.rows.filter((stage) => stage.status === "queued")).toHaveLength(2);
      const beforeResumedChild = await sourceEligibility(pool, submitted.id);
      expect(beforeResumedChild).toMatchObject({
        job: { status: "queued", expired: false },
        stages: expect.arrayContaining([
          expect.objectContaining({ stage_key: "source:plan", status: "validated", due: true }),
          expect.objectContaining({ stage_key: expect.stringMatching(/^source:chunk:/u), status: "queued", due: true, lease_live: null, parent_generations: { "source:plan": 1 } })
        ])
      });
      expect(await runSourceWorker(1, true)).toEqual(expect.objectContaining({
        completed: 1,
        runs: [true],
        outcomes: [expect.objectContaining({ outcome: "checkpointed", jobId: submitted.id, stageId: expect.any(String), generation: 1 })]
      }));
      const first = await pool.query<{ id: string; output: string }>("SELECT id, output::text AS output FROM authoring_job_stages WHERE job_id = $1 AND stage_key LIKE 'source:chunk:%' AND status = 'validated'", [submitted.id]);
      expect(first.rows).toHaveLength(1);
      const firstHash = sha256(first.rows[0]!.output);
      rejectProviderRequests = true;
      expect(await runSourceWorker(1, true)).toEqual(expect.objectContaining({
        completed: 0,
        runs: [false],
        outcomes: [expect.objectContaining({ outcome: "failed", jobId: submitted.id, stageId: expect.any(String), generation: 1 })]
      }));
      rejectProviderRequests = false;
      const incomplete = (await repository.read({ ownerUserId }, submitted.id))!;
      if (incomplete.kind !== "story_source") throw new Error("Expected source authoring detail.");
      expect(incomplete.source?.extractionComplete).toBe(false);
      expect(incomplete.stages.some((stage) => stage.key === "source:synthesis")).toBe(false);
      const missing = incomplete.stages.find((stage) => stage.key.startsWith("source:chunk:") && stage.status === "failed");
      expect(missing).toBeDefined();
      const retried = await repository.retry({ ownerUserId }, submitted.id, missing!.id, incomplete.revision);
      const replacement = retried.stages.filter((stage) => stage.key === missing!.key).sort((left, right) => left.generation - right.generation).at(-1);
      if (!replacement) throw new Error("Missing source retry replacement stage.");
      const callsBeforeRetry = providerCalls;
      expect(await runDueSourceRetry({ pool, jobId: submitted.id, stageId: replacement.id, stageKey: missing!.key, generation: replacement.generation, providerCalls: () => providerCalls })).toEqual({ completed: 1, runs: [true, false] });
      const preserved = await pool.query<{ output: string }>("SELECT output::text AS output FROM authoring_job_stages WHERE id = $1", [first.rows[0]!.id]);
      expect(sha256(preserved.rows[0]!.output)).toBe(firstHash);
      expect(providerCalls - callsBeforeRetry).toBe(1);
    } finally {
      outputLimitedResponses = 0;
      rejectProviderRequests = false;
      await pool.query("DELETE FROM provider_profiles WHERE id = $1", [profile.id]);
    }
  });

  it("persists a bounded split lineage without changing successful source leaves", async () => {
    const profile = await createProvider(pool, {
      name: `P3 source split ${randomUUID()}`, providerType: "openai_compatible", providerRole: "text",
      baseUrl: `http://127.0.0.1:${providerPort}/v1`, defaultModel: "source-test", contextWindowTokens: 8_192,
      maxOutputTokens: 256, temperature: 0, enabled: true, isDefault: true, configuration: {}
    }, credentialSecret);
    const repository = createPostgresAuthoringRepository(pool);
    const text = "Iris crossed the northern bridge. ".repeat(10);
    const submitted = await repository.submit({ ownerUserId }, {
      kind: "story_source", idempotencyKey: randomUUID(), target: { kind: "new_world" }, name: "split.txt", text,
      mode: "faithful", boundaryParagraphId: "paragraph:0", instructions: "Extract exact facts only."
    }, sha256(text));
    jobs.push(submitted.id);
    try {
      expect(await runSourceWorker(1)).toEqual({ completed: 1, runs: [true] });
      const before = await pool.query<{ chunks: unknown }>("SELECT source_plan->'chunks' AS chunks FROM authoring_jobs WHERE id = $1", [submitted.id]);
      const beforeCount = (before.rows[0]!.chunks as unknown[]).length;
      const claimed = await repository.claim("source-split-test", 60);
      expect(claimed).not.toBeNull();
      const stage = await pool.query<{ stage_key: string }>("SELECT stage_key FROM authoring_job_stages WHERE id = $1", [claimed!.stageId]);
      const chunkId = stage.rows[0]!.stage_key.slice("source:chunk:".length);
      expect(await repository.splitSourceChunk!(claimed!, chunkId)).toBe(true);
      const leaves = await pool.query<{ stage_key: string; status: string }>("SELECT stage_key, status FROM authoring_job_stages WHERE job_id = $1 AND stage_key LIKE 'source:chunk:%' ORDER BY stage_key", [submitted.id]);
      expect(leaves.rows.filter((stage) => stage.status === "cancelled")).toHaveLength(1);
      expect(leaves.rows.filter((stage) => stage.status === "queued")).toHaveLength(beforeCount + 1);
      const after = await pool.query<{ chunks: unknown }>("SELECT source_plan->'chunks' AS chunks FROM authoring_jobs WHERE id = $1", [submitted.id]);
      expect((after.rows[0]!.chunks as unknown[]).length).toBe(beforeCount + 1);
      expect((after.rows[0]!.chunks as unknown[]).length).toBeLessThanOrEqual(200);
      const splitChunks = after.rows[0]!.chunks as Array<{ id: string; spans: Array<{ paragraphId: string; start: number; end: number }> }>;
      const splitSource = normalizeSourceDocument("split.txt", text, submitted.id);
      for (const splitChunk of splitChunks) {
        const child = await repository.claim("source-split-complete", 60);
        const span = splitChunk.spans[0]!;
        await repository.checkpoint(child!, { kind: "source_extraction", facts: [{ id: `split-fact:${splitChunk.id}`, kind: "character", subject: "Iris", predicate: "crosses", value: splitChunk.id, provenance: "stated", citations: [{ sourceId: splitSource.id, paragraphId: span.paragraphId, start: span.start, end: span.end, quote: Array.from(splitSource.text).slice(span.start, span.end).join("") }] }] });
      }
      const completeBeforePlanRetry = (await repository.read({ ownerUserId }, submitted.id))!;
      if (completeBeforePlanRetry.kind !== "story_source") throw new Error("Expected split source detail.");
      const oldSplitFactIds = completeBeforePlanRetry.source!.facts.map((fact) => fact.id);
      const sourcePlanStage = completeBeforePlanRetry.stages.find((stage) => stage.key === "source:plan")!;
      await repository.retry({ ownerUserId }, submitted.id, sourcePlanStage.id, completeBeforePlanRetry.revision);
      const regeneratedPlanClaim = await repository.claim("source-plan-regeneration", 60);
      const originalPlanOutput = await pool.query<{ output: { chunks: unknown } }>("SELECT output FROM authoring_job_stages WHERE id = $1", [sourcePlanStage.id]);
      await repository.checkpoint(regeneratedPlanClaim!, { kind: "source_plan", chunks: originalPlanOutput.rows[0]!.output.chunks });
      const afterPlanRetry = (await repository.read({ ownerUserId }, submitted.id))!;
      if (afterPlanRetry.kind !== "story_source") throw new Error("Expected regenerated plan detail.");
      expect(afterPlanRetry.source?.extractionComplete).toBe(false);
      expect(afterPlanRetry.source?.facts).toEqual([]);
      expect(afterPlanRetry.source?.facts.map((fact) => fact.id)).not.toEqual(oldSplitFactIds);
      const latestChildren = afterPlanRetry.stages.filter((stage) => stage.key.startsWith("source:chunk:") && stage.status === "queued");
      expect(latestChildren).toHaveLength(1);
      expect(latestChildren[0]!.generation).toBeGreaterThan(1);
      const planAfterRetry = await pool.query<{ chunks: unknown }>("SELECT source_plan->'chunks' AS chunks FROM authoring_jobs WHERE id = $1", [submitted.id]);
      const capClaim = await repository.claim("source-split-cap-test", 60);
      expect(capClaim).not.toBeNull();
      const capStage = await pool.query<{ stage_key: string }>("SELECT stage_key FROM authoring_job_stages WHERE id = $1", [capClaim!.stageId]);
      await pool.query(
        `INSERT INTO authoring_job_stages (job_id, owner_user_id, stage_key, parent_generations, status, next_attempt_at)
         SELECT $1, $2, 'source:chunk:retired:' || value::text, '{"source:plan":1}'::jsonb, 'cancelled', clock_timestamp()
           FROM generate_series(1, 197) AS value`,
        [submitted.id, ownerUserId]
      );
      expect(await repository.splitSourceChunk!(capClaim!, capStage.rows[0]!.stage_key.slice("source:chunk:".length))).toBe(false);
      const unchanged = await pool.query<{ chunks: unknown; status: string }>(
        "SELECT jobs.source_plan->'chunks' AS chunks, stages.status FROM authoring_jobs jobs JOIN authoring_job_stages stages ON stages.id = $2 WHERE jobs.id = $1",
        [submitted.id, capClaim!.stageId]
      );
      expect(unchanged.rows[0]!.chunks).toEqual(planAfterRetry.rows[0]!.chunks);
      expect(unchanged.rows[0]!.status).toBe("running");
      const stageCountBeforeExpired = (await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM authoring_job_stages WHERE job_id = $1", [submitted.id])).rows[0]!.count;
      await pool.query("UPDATE authoring_job_stages SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [capClaim!.stageId]);
      expect(await repository.splitSourceChunk!(capClaim!, capStage.rows[0]!.stage_key.slice("source:chunk:".length))).toBe(false);
      const expired = await pool.query<{ chunks: unknown; count: string }>(
        "SELECT jobs.source_plan->'chunks' AS chunks, (SELECT count(*)::text FROM authoring_job_stages WHERE job_id = jobs.id) AS count FROM authoring_jobs jobs WHERE jobs.id = $1",
        [submitted.id]
      );
      expect(expired.rows[0]!.chunks).toEqual(planAfterRetry.rows[0]!.chunks);
      expect(expired.rows[0]!.count).toBe(stageCountBeforeExpired);
    } finally {
      await pool.query("DELETE FROM provider_profiles WHERE id = $1", [profile.id]);
    }
  });
});
