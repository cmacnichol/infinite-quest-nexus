import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createPostgresAuthoringRepository } from "../../packages/database/src/authoring-job-repository.js";
import { createPostgresWorldRepositoryAdapters } from "../../packages/database/src/world-repository.js";
import { authoringJobViewSchema } from "../../packages/contracts/src/authoring.js";
import { worldContentSchema, worldImportRequestSchema } from "../../packages/contracts/src/world-library.js";
import { normalizeSourceDocument } from "../../packages/domain/src/source-authoring.js";
import { createAuthoringJobSession } from "../../apps/web-next/src/authoring-job-session.js";
import { createProvider } from "../helpers/provider-application-fixtures.js";
import scenarios from "../fixtures/authoring/source-scenarios.json" with { type: "json" };

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe.sequential : describe.skip;
const credentialSecret = "p3-9-source-acceptance-secret";

type SourceScenario = typeof scenarios.scenarios[number];
let chainDiagnosticPool: DatabasePool | undefined;
let chainProviderCalls = 0;
let activeScenario: SourceScenario | undefined;
let extractionServiceFailuresRemaining = 0;
let characterInvalidResponsesRemaining = 0;

async function chainEligibility(jobId: string | undefined) {
  if (!chainDiagnosticPool || !jobId) return undefined;
  const [job, stages] = await Promise.all([
    chainDiagnosticPool.query("SELECT status,execution_generation,expires_at <= clock_timestamp() AS expired,clock_timestamp() AS observed_at,expires_at FROM authoring_jobs WHERE id=$1", [jobId]),
    chainDiagnosticPool.query("SELECT stage_key,generation,status,attempt_count,source_review_generation,clock_timestamp() AS observed_at,next_attempt_at,started_at,completed_at,EXTRACT(epoch FROM (next_attempt_at-clock_timestamp())) AS seconds_until_due,next_attempt_at <= clock_timestamp() AS due,CASE WHEN lease_expires_at IS NULL THEN NULL ELSE lease_expires_at > clock_timestamp() END AS lease_live,lease_expires_at,parent_generations FROM authoring_job_stages current WHERE job_id=$1 AND generation=(SELECT max(candidate.generation) FROM authoring_job_stages candidate WHERE candidate.job_id=current.job_id AND candidate.stage_key=current.stage_key) ORDER BY stage_key,generation", [jobId])
  ]);
  return { job: job.rows[0], stages: stages.rows };
}

async function waitForStageDue(pool: DatabasePool, jobId: string, stageId: string, timeoutMs = 5_000): Promise<void> {
  const observations: Array<Record<string, unknown>> = [];
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const result = await pool.query<{ status: string; generation: number; due: boolean; observed_at: string; next_attempt_at: string; seconds_until_due: string }>(
      "SELECT status,generation,next_attempt_at <= clock_timestamp() AS due,clock_timestamp() AS observed_at,next_attempt_at,EXTRACT(epoch FROM (next_attempt_at-clock_timestamp())) AS seconds_until_due FROM authoring_job_stages WHERE job_id=$1 AND id=$2",
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

function runSourceWorker(limit: number, expectedJobId?: string): Promise<{ completed: number; runs: boolean[] }> {
  return new Promise((resolveProcess, reject) => {
    const callsBefore = chainProviderCalls;
    const child = spawn(process.execPath, ["--import", "tsx", "tests/helpers/authoring-worker-process.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEST_DATABASE_URL: databaseUrl!,
        AUTHORING_PROCESS_CREDENTIAL_SECRET: credentialSecret,
        AUTHORING_PROCESS_LIMIT: String(limit),
        AUTHORING_PROCESS_DIAGNOSTICS: "true"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", async (code, signal) => {
      if (code !== 0 || signal) { reject(new Error(`source worker exited ${code ?? signal}: ${stderr}`)); return; }
      try {
        const result = JSON.parse(stdout.trim()) as { completed: number; runs: boolean[]; outcomes?: unknown };
        const outcomes = result.outcomes as Array<{ jobId?: string }> | undefined;
        process.stdout.write(`${JSON.stringify({
          scenario: activeScenario?.id,
          p3_9_chain_worker: result,
          providerCalls: { before: callsBefore, after: chainProviderCalls, delta: chainProviderCalls - callsBefore },
          eligibility: await chainEligibility(outcomes?.find((outcome) => outcome.jobId)?.jobId ?? expectedJobId)
        })}\n`);
        resolveProcess(result);
      }
      catch (error) { reject(new Error(`source worker result was invalid: ${stdout}; ${error instanceof Error ? error.message : String(error)}`)); }
    });
  });
}

function startAuthoringApi(ownerUserId: string): Promise<{ url: string; close(): Promise<void> }> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "tests/helpers/source-authoring-api-process.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, TEST_DATABASE_URL: databaseUrl!, AUTHORING_PROCESS_OWNER_USER_ID: ownerUserId },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let ready = false;
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (ready || !stdout.includes("\n")) return;
      try {
        const value = JSON.parse(stdout.trim()) as { address: string };
        ready = true;
        resolveProcess({
          url: value.address,
          close: () => new Promise<void>((resolveClose, rejectClose) => {
            child.once("error", rejectClose);
            child.once("exit", (code, signal) => code === 0 || signal === "SIGTERM"
              ? resolveClose()
              : rejectClose(new Error(`authoring API exited ${code ?? signal}: ${stderr}`)));
            child.kill("SIGTERM");
          })
        });
      } catch (error) { reject(error); }
    });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (!ready) reject(new Error(`authoring API failed to start ${code ?? signal}: ${stderr}`));
    });
  });
}

async function requestJson<T>(base: string, path: string, body?: unknown, method = "POST"): Promise<T> {
  const response = await fetch(`${base}${path}`, body === undefined ? undefined : {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const raw = await response.text();
  const value = raw ? JSON.parse(raw) as T & { code?: string; error?: string; message?: string; details?: { code?: string; stage?: string; issues?: Array<{ path?: unknown; message?: string }> } } : undefined;
  if (!response.ok) {
    const safeIssues = value?.details?.issues?.map((issue) => ({ path: issue.path, message: issue.message }));
    throw new Error(`${method} ${path} returned ${response.status}: ${JSON.stringify({ scenario: activeScenario?.id, code: value?.code ?? value?.error ?? value?.message ?? "empty response", details: value?.details ? { code: value.details.code, stage: value.details.stage, issues: safeIssues } : undefined })}`);
  }
  if (value === undefined) {
    throw new Error(`${method} ${path} returned an empty successful response; this request requires JSON`);
  }
  return value;
}

function kindFor(subject: string): "character" | "location" | "faction" | "rule" {
  if (/Mara|Iris/u.test(subject)) return "character";
  if (/Guild/u.test(subject)) return "faction";
  if (/Gate|Harbor|Merehaven|quay/u.test(subject)) return "location";
  return "rule";
}

async function completeScenario(pool: DatabasePool, ownerUserId: string, base: string, scenario: SourceScenario) {
  const normalized = normalizeSourceDocument(`${scenario.id}.txt`, scenario.text, `p3-9:${scenario.id}`);
  expect(normalized.paragraphs.some((paragraph) => paragraph.id === scenario.boundaryParagraphId)).toBe(true);
  const submitted = await requestJson<{ id: string }>(base, "/api/v1/authoring/source-jobs", {
    kind: "story_source",
    idempotencyKey: randomUUID(),
    target: { kind: "new_world" },
    name: `${scenario.id}.txt`,
    text: scenario.text,
    mode: scenario.id === "unsupported-additions" ? "expand" : "faithful",
    boundaryParagraphId: scenario.boundaryParagraphId,
    instructions: "Extract only source-supported facts."
  });
  const repository = createPostgresAuthoringRepository(pool);
  const extractedRun = await runSourceWorker(16, submitted.id);
  expect(extractedRun.completed).toBeGreaterThanOrEqual(2);
  if (scenario.id === "multi-chunk-restart") {
    const leaves = await pool.query<{ stage_key: string; status: string }>("SELECT stage_key,status FROM authoring_job_stages WHERE job_id=$1 AND stage_key LIKE 'source:chunk:%' AND generation=(SELECT max(current.generation) FROM authoring_job_stages current WHERE current.job_id=authoring_job_stages.job_id AND current.stage_key=authoring_job_stages.stage_key) ORDER BY stage_key", [submitted.id]);
    expect(leaves.rows.length).toBeGreaterThan(1);
    expect(leaves.rows).toEqual(expect.arrayContaining([expect.objectContaining({ status: "validated" })]));
    expect(leaves.rows.every((leaf) => leaf.status === "validated")).toBe(true);
  }
  const extracted = await requestJson<{ revision: number; source: { facts: Array<{ id: string; subject: string; predicate: string; value: string; citations: Array<{ quote: string }> }> } }>(base, `/api/v1/authoring/jobs/${submitted.id}`);
  expect(extracted.source.facts).toHaveLength(scenario.accepted.length + (scenario.id === "unsupported-additions" ? 1 : 0));
  expect(extracted.source.facts.map((fact) => `${fact.subject}|${fact.predicate}|${fact.value}`)).toEqual(expect.arrayContaining(
    scenario.accepted.map((fact) => `${fact.subject}|${fact.predicate}|${fact.value}`)
  ));
  expect(extracted.source.facts.map((fact) => fact.citations[0]!.quote)).not.toContain("EXCLUDED_REVELATION_SENTINEL The ferryman is the missing king.");
  const characterFactIds = extracted.source.facts.filter((fact) => /Mara|Iris/u.test(fact.subject)).map((fact) => fact.id);
  const keeperFactIds = scenario.id === "same-name-identities" ? characterFactIds.slice(0, 3) : [];
  const pilotFactId = scenario.id === "same-name-identities" ? characterFactIds.at(-1) : undefined;
  const rejectedFactIds = scenario.id === "unsupported-additions"
    ? extracted.source.facts.filter((fact) => fact.subject === "dragon").map((fact) => fact.id)
    : [];
  const uncertainFactIds = scenario.id === "unsupported-additions"
    ? extracted.source.facts.filter((fact) => fact.predicate === "protects").map((fact) => fact.id)
    : [];
  expect(uncertainFactIds).toHaveLength(scenario.id === "unsupported-additions" ? 1 : 0);
  const review = await requestJson<{ revision: number }>(base, `/api/v1/authoring/source-jobs/${submitted.id}/facts`, {
    expectedRevision: extracted.revision,
    acceptedFactIds: extracted.source.facts.map((fact) => fact.id).filter((id) => !rejectedFactIds.includes(id) && !uncertainFactIds.includes(id)),
    rejectedFactIds,
    uncertainFactIds,
    selectedCharacterFactIds: scenario.id === "same-name-identities"
      ? [keeperFactIds[0]!, pilotFactId!]
      : characterFactIds.slice(0, 1),
    characterIdentityGroups: scenario.id === "same-name-identities"
      ? [{ representativeFactId: keeperFactIds[0]!, factIds: keeperFactIds }, { representativeFactId: pilotFactId!, factIds: [pilotFactId!] }]
      : characterFactIds.length
        ? [{ representativeFactId: characterFactIds[0]!, factIds: characterFactIds }]
        : [],
    manualFacts: []
  }, "PUT");
  const synthesis = await requestJson<{ revision: number }>(base, `/api/v1/authoring/source-jobs/${submitted.id}/synthesis`, { expectedRevision: review.revision });
  expect(synthesis.revision).toBeGreaterThan(review.revision);
  const synthesisRun = await runSourceWorker(16, submitted.id);
  expect(synthesisRun.completed).toBeGreaterThanOrEqual(1);
  let current = await repository.read({ ownerUserId }, submitted.id);
  if (scenario.id === "unsupported-additions") {
    if (current?.kind !== "story_source") throw new Error("Expansion scenario did not retain a source review view.");
    const candidates = current.source?.expansionCandidates ?? [];
    const rejectedCandidateIds = candidates.filter((fact) => fact.value === "A dragon guards East Gate.").map((fact) => fact.id);
    const uncertainCandidateIds = candidates.filter((fact) => fact.value === "East Gate protects the harbor.").map((fact) => fact.id);
    expect(rejectedCandidateIds).toHaveLength(1);
    expect(uncertainCandidateIds).toHaveLength(1);
    const reviewedExpansion = await requestJson<{ revision: number; source: { rejectedFactIds: string[]; uncertainFactIds: string[] } }>(base, `/api/v1/authoring/source-jobs/${submitted.id}/facts`, {
      expectedRevision: current.revision,
      acceptedFactIds: extracted.source.facts.map((fact) => fact.id).filter((id) => !uncertainFactIds.includes(id)),
      rejectedFactIds: rejectedCandidateIds,
      uncertainFactIds: [...uncertainFactIds, ...uncertainCandidateIds],
      selectedCharacterFactIds: [],
      characterIdentityGroups: [],
      manualFacts: []
    }, "PUT");
    expect(reviewedExpansion.source.rejectedFactIds).toEqual(rejectedCandidateIds);
    expect(reviewedExpansion.source.uncertainFactIds).toEqual(expect.arrayContaining([...uncertainFactIds, ...uncertainCandidateIds]));
    await requestJson(base, `/api/v1/authoring/source-jobs/${submitted.id}/synthesis`, { expectedRevision: reviewedExpansion.revision });
    expect((await runSourceWorker(16, submitted.id)).completed).toBeGreaterThanOrEqual(1);
    current = await repository.read({ ownerUserId }, submitted.id);
  }
  if (!current?.result) throw new Error(`Scenario ${scenario.id} did not produce an apply result.`);
  const session = createAuthoringJobSession({
    job: current,
    saveReview: async (id, input) => authoringJobViewSchema.parse(await requestJson(base, `/api/v1/authoring/jobs/${id}/review`, input, "PUT"))
  });
  try {
    session.adoptPendingResult();
    await session.flush();
  } finally {
    session.dispose();
  }
  const reviewed = session.state().job;
  if (!reviewed.reviewedContent || !reviewed.reviewedStageIds?.length) throw new Error(`Scenario ${scenario.id} did not save a reviewed source result.`);
  const applyInput = {
    expectedRevision: reviewed.revision,
    idempotencyKey: `p3-9-${scenario.id}-${randomUUID()}`,
    selectedStageIds: reviewed.reviewedStageIds,
    content: reviewed.reviewedContent
  };
  const applied = await requestJson<{ worldId: string; draftRevision: number }>(base, `/api/v1/authoring/jobs/${submitted.id}/apply`, applyInput);
  await expect(requestJson(base, `/api/v1/authoring/jobs/${submitted.id}/apply`, applyInput)).resolves.toEqual(applied);
  const boundary = normalized.paragraphs.find((paragraph) => paragraph.id === scenario.boundaryParagraphId)!;
  return { applied, scenario, jobId: submitted.id, sourcePrefix: Array.from(normalized.text).slice(0, boundary.end).join("") };
}

integration("P3.9 source authoring end-to-end acceptance", () => {
  let pool: DatabasePool;
  let ownerUserId: string;
  let api: Awaited<ReturnType<typeof startAuthoringApi>>;
  let provider: Server;
  let providerPort: number;

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    chainDiagnosticPool = pool;
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    provider = createServer((request, response) => {
      if (request.method !== "POST") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "p3-9-deterministic" }] }));
        return;
      }
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        chainProviderCalls += 1;
        let payload: { messages?: Array<{ role?: string; content?: string }> } = {};
        try { payload = JSON.parse(body) as typeof payload; } catch { /* Unsupported request shapes receive an empty bounded result. */ }
        const frames = (payload.messages ?? []).flatMap((message) => {
          if (message.role !== "user" || typeof message.content !== "string") return [];
          try { return [JSON.parse(message.content) as {
            chunk?: { sourceRange: { start: number; end: number }; paragraphSpans: Array<{ paragraphId: string; start: number; end: number }> };
            sourceText?: string;
            acceptedFacts?: Array<{ id: string }>;
            selectedCharacterFactIds?: string[];
          }]; } catch { return []; }
        });
        const frame = (frames.find((candidate) => candidate.chunk || candidate.acceptedFacts) ?? {}) as {
          chunk?: { sourceRange: { start: number; end: number }; paragraphSpans: Array<{ paragraphId: string; start: number; end: number }> };
          sourceText?: string;
          acceptedFacts?: Array<{ id: string }>;
          selectedCharacterFactIds?: string[];
        };
        if (frame.chunk && extractionServiceFailuresRemaining > 0) {
          extractionServiceFailuresRemaining -= 1;
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "synthetic extraction service unavailable" } }));
          return;
        }
        if (frame.acceptedFacts && frame.selectedCharacterFactIds?.length && characterInvalidResponsesRemaining > 0) {
          characterInvalidResponsesRemaining -= 1;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ id: randomUUID(), choices: [{ message: { role: "assistant", content: JSON.stringify({ fields: [{ path: "world.rules", value: 7, supportingFactIds: [] }], characterFields: [] }) }, finish_reason: "stop" }] }));
          return;
        }
        let content = JSON.stringify({ facts: [] });
        if (activeScenario && frame.chunk && frame.sourceText) {
          content = JSON.stringify({
            facts: activeScenario.accepted
              .filter((fact) => frame.sourceText!.includes(fact.quote))
              .map((fact) => {
                const localStart = Array.from(frame.sourceText!.slice(0, frame.sourceText!.indexOf(fact.quote))).length;
                const start = frame.chunk!.sourceRange.start + localStart;
                const end = start + Array.from(fact.quote).length;
                const paragraph = frame.chunk!.paragraphSpans.find((candidate) => start >= candidate.start && end <= candidate.end)
                  ?? frame.chunk!.paragraphSpans[0]!;
                return {
                  category: kindFor(fact.subject), subject: fact.subject, predicate: fact.predicate, value: fact.value, provenance: "stated",
                  citations: [{ paragraphId: paragraph.paragraphId, start, end, quote: fact.quote }]
                };
              })
              .concat(activeScenario.id === "unsupported-additions" && frame.sourceText.includes("The brass gate opens")
                ? [{
                    category: "rule", subject: "gate", predicate: "protects", value: "the harbor", provenance: "inferred",
                    citations: [{ paragraphId: frame.chunk.paragraphSpans[0]!.paragraphId, start: frame.chunk.sourceRange.start, end: frame.chunk.sourceRange.start + "The brass gate opens when Mara lifts the lantern.".length, quote: "The brass gate opens when Mara lifts the lantern." }]
                  }]
                : [])
          });
        } else if (frame.acceptedFacts) {
          content = JSON.stringify({
            fields: [],
            characterFields: [],
            expansionCandidates: activeScenario?.id === "unsupported-additions"
              ? [{ target: "world", path: "world.tone", value: "A dragon guards East Gate.", supportingFactIds: [frame.acceptedFacts[0]!.id] },
                { target: "world", path: "world.rules", value: "East Gate protects the harbor.", supportingFactIds: [frame.acceptedFacts[0]!.id] }]
              : []
          });
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: randomUUID(), choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] }));
      });
    });
    await new Promise<void>((ready) => provider.listen(0, "127.0.0.1", ready));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("P3.9 deterministic provider did not bind.");
    providerPort = address.port;
    api = await startAuthoringApi(ownerUserId);
  });
  afterEach(async () => {
    extractionServiceFailuresRemaining = 0;
    characterInvalidResponsesRemaining = 0;
    await pool.query("TRUNCATE TABLE worlds,authoring_jobs,provider_profiles,activity_events RESTART IDENTITY CASCADE");
  });
  afterAll(async () => {
    chainDiagnosticPool = undefined;
    await api?.close();
    await pool?.end();
    if (provider) await new Promise<void>((done) => provider.close(() => done()));
  });

  it("carries each supplied scenario from source HTTP intake through explicit review and source-linked apply without retaining the spoiler tail", async () => {
    const adapters = createPostgresWorldRepositoryAdapters(pool, { memory: { async autoEnableCampaignEmbedding() { return { enabled: false }; } } });
    const baselineTitle = `P3.9 existing ${randomUUID()}`;
    const baseline = await adapters.transaction.command((transaction) => adapters.worlds.createWorld(transaction, { ownerUserId }, {
      title: baselineTitle,
      content: worldContentSchema.parse({ world: { title: baselineTitle, tone: "baseline" } })
    }));
    if (!baseline.ok) throw new Error("Baseline world was not created.");
    const baselineVersion = await adapters.transaction.command((transaction) => adapters.worlds.publishWorld(transaction, { ownerUserId, worldId: baseline.value.id }, { expectedRevision: baseline.value.draftRevision, releaseNotes: "P3.9 baseline" }));
    if (!baselineVersion.ok) throw new Error("Baseline world was not published.");
    const campaign = await pool.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id,world_version_id,title,active_turn_number,turn_control_style) VALUES ($1,$2,$3,0,'flexible_auto') RETURNING id",
      [ownerUserId, baselineVersion.value.worldVersionId, `P3.9 baseline campaign ${randomUUID()}`]
    );
    await pool.query("INSERT INTO campaign_state (campaign_id,owner_user_id) VALUES ($1,$2)", [campaign.rows[0]!.id, ownerUserId]);
    const baselineTurn = await pool.query<{ id: string }>("INSERT INTO turns (owner_user_id,campaign_id,turn_number,action,narration) VALUES ($1,$2,1,$3,$4) RETURNING id", [ownerUserId, campaign.rows[0]!.id, "Inspect the harbor.", "The harbor beacon remains lit."]);
    await pool.query("INSERT INTO chronicle_memories (owner_user_id,campaign_id,world_version_id,turn_id,memory_kind,ordinal,content,token_estimate) VALUES ($1,$2,$3,$4,'turn_fiction',1,$5,6)", [ownerUserId, campaign.rows[0]!.id, baselineVersion.value.worldVersionId, baselineTurn.rows[0]!.id, "The harbor beacon remains lit."]);
    const before = await pool.query<{ content: unknown; campaign_id: string; state: unknown; turns: unknown; memories: unknown }>(
      `SELECT world_versions.content,campaigns.id AS campaign_id,
              row_to_json(campaign_state) AS state,
              COALESCE((SELECT json_agg(row_to_json(turns) ORDER BY turns.turn_number) FROM turns WHERE turns.campaign_id=campaigns.id), '[]'::json) AS turns,
              COALESCE((SELECT json_agg(row_to_json(chronicle_memories) ORDER BY chronicle_memories.created_at,chronicle_memories.id) FROM chronicle_memories WHERE chronicle_memories.campaign_id=campaigns.id), '[]'::json) AS memories
         FROM world_versions
         JOIN campaigns ON campaigns.world_version_id=world_versions.id
         JOIN campaign_state ON campaign_state.campaign_id=campaigns.id
        WHERE world_versions.id=$1`,
      [baselineVersion.value.worldVersionId]
    );
    for (const scenario of scenarios.scenarios) {
      activeScenario = scenario;
      const profile = await createProvider(pool, {
        name: `P3.9 ${scenario.id} ${randomUUID()}`,
        providerType: "openai_compatible",
        providerRole: "text",
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        defaultModel: "p3-9-deterministic",
        contextWindowTokens: 8_192,
        maxOutputTokens: 256,
        temperature: 0,
        enabled: true,
        isDefault: true,
        configuration: {}
      }, credentialSecret);
      try {
        const completed = await completeScenario(pool, ownerUserId, api.url, scenario);
        const draft = await pool.query<{ content: unknown }>("SELECT content FROM world_drafts WHERE world_id=$1 AND owner_user_id=$2", [completed.applied.worldId, ownerUserId]);
        const content = worldContentSchema.parse(draft.rows[0]!.content);
        expect(JSON.stringify(content)).not.toContain("EXCLUDED_REVELATION_SENTINEL");
        expect(JSON.stringify(content)).not.toContain("A dragon guards East Gate.");
        if (scenario.id === "same-name-identities") {
          expect(content.playableCharacters).toHaveLength(2);
          expect(content.playableCharacters.map((character) => character.characterText)).toEqual(expect.arrayContaining([
            expect.stringContaining("lighthouse keeper"), expect.stringContaining("ferry pilot")
          ]));
        }
        const published = await adapters.transaction.command((transaction) => adapters.worlds.publishWorld(transaction, { ownerUserId, worldId: completed.applied.worldId }, { expectedRevision: completed.applied.draftRevision, releaseNotes: "P3.9 source acceptance" }));
        expect(published.ok).toBe(true);
        if (!published.ok) throw new Error("Source acceptance world did not publish.");
        const exported = await adapters.transaction.read((transaction) => adapters.worlds.exportWorld(
          transaction, { ownerUserId, worldId: completed.applied.worldId, worldVersionId: published.value.worldVersionId }
        ));
        const material = exported.content.sourceMaterial;
        expect(material).toBeDefined();
        if (!material) throw new Error("Published source world omitted portable source material.");
        expect(material.documents).toHaveLength(1);
        expect(material.documents[0]!.text).toBe(completed.sourcePrefix);
        expect(material.documents[0]!.sha256).toBe(createHash("sha256").update(material.documents[0]!.text, "utf8").digest("hex"));
        expect(material.documents[0]!.text).not.toContain("EXCLUDED_REVELATION_SENTINEL");
        const importedOwner = (await pool.query<{ id: string }>("INSERT INTO users (display_name,status) VALUES ($1,'active') RETURNING id", [`P3.9 portable ${randomUUID()}`])).rows[0]!.id;
        const imported = await adapters.transaction.command((transaction) => adapters.worlds.importWorld(
          transaction, { ownerUserId: importedOwner }, worldImportRequestSchema.parse({ sourceName: `${scenario.id}.json`, worldExport: exported })
        ));
        expect(imported).toMatchObject({ ok: true, value: { duplicate: false } });
        if (!imported.ok) throw new Error("Published source world did not import.");
        const importedExport = await adapters.transaction.read((transaction) => adapters.worlds.exportWorld(
          transaction, { ownerUserId: importedOwner, worldId: imported.value.worldId, worldVersionId: imported.value.worldVersionId }
        ));
        expect(importedExport.content.sourceMaterial).toEqual(material);
        if (scenario.id === "single-character") {
          const campaignCreated = await adapters.transaction.command((transaction) => adapters.campaigns.createCampaign(
            transaction,
            { ownerUserId },
            {
              worldVersionId: published.value.worldVersionId,
              title: "P3.9 source campaign",
              storyLengthProfile: "standard",
              storyContextBudgetTokens: 32_000,
              turnControlStyle: "flexible_action",
              ...(content.playableCharacters[0]?.id ? { selectedCharacterId: content.playableCharacters[0].id } : {})
            }
          ));
          expect(campaignCreated.ok).toBe(true);
        }
      } finally {
        activeScenario = undefined;
        await pool.query("DELETE FROM provider_profiles WHERE id=$1", [profile.id]);
      }
    }
    const after = await pool.query<{ content: unknown; campaign_id: string; state: unknown; turns: unknown; memories: unknown }>(
      `SELECT world_versions.content,campaigns.id AS campaign_id,
              row_to_json(campaign_state) AS state,
              COALESCE((SELECT json_agg(row_to_json(turns) ORDER BY turns.turn_number) FROM turns WHERE turns.campaign_id=campaigns.id), '[]'::json) AS turns,
              COALESCE((SELECT json_agg(row_to_json(chronicle_memories) ORDER BY chronicle_memories.created_at,chronicle_memories.id) FROM chronicle_memories WHERE chronicle_memories.campaign_id=campaigns.id), '[]'::json) AS memories
         FROM world_versions
         JOIN campaigns ON campaigns.world_version_id=world_versions.id
         JOIN campaign_state ON campaign_state.campaign_id=campaigns.id
        WHERE world_versions.id=$1`,
      [baselineVersion.value.worldVersionId]
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("recovers retained source leaves and source-world synthesis through public retries before one idempotent apply", async () => {
    const scenario = scenarios.scenarios.find((candidate) => candidate.id === "multi-chunk-restart");
    if (!scenario) throw new Error("P3.9 recovery scenario fixture is missing.");
    activeScenario = scenario;
    const profile = await createProvider(pool, {
      name: `P3.9 composed recovery ${randomUUID()}`,
      providerType: "openai_compatible",
      providerRole: "text",
      baseUrl: `http://127.0.0.1:${providerPort}/v1`,
      defaultModel: "p3-9-deterministic",
      contextWindowTokens: 8_192,
      maxOutputTokens: 256,
      temperature: 0,
      enabled: true,
      isDefault: true,
      configuration: {}
    }, credentialSecret);
    try {
      const submitted = await requestJson<{ id: string }>(api.url, "/api/v1/authoring/source-jobs", {
        kind: "story_source",
        idempotencyKey: randomUUID(),
        target: { kind: "new_world" },
        name: "p3-9-composed-recovery.txt",
        text: scenario.text,
        mode: "faithful",
        boundaryParagraphId: scenario.boundaryParagraphId,
        instructions: "Extract only source-supported facts."
      });
      expect(await runSourceWorker(2, submitted.id)).toMatchObject({ completed: 2, runs: [true, true] });
      const plannedLeaves = await pool.query<{ stage_key: string }>(
        "SELECT stage_key FROM authoring_job_stages WHERE job_id=$1 AND stage_key LIKE 'source:chunk:%' ORDER BY stage_key",
        [submitted.id]
      );
      expect(plannedLeaves.rows.length).toBeGreaterThan(1);
      expect(await runSourceWorker(1, submitted.id)).toMatchObject({ completed: 1, runs: [true] });
      const retainedLeaves = await pool.query<{ id: string; stage_key: string; output: string }>(
        "SELECT id,stage_key,output::text AS output FROM authoring_job_stages WHERE job_id=$1 AND stage_key LIKE 'source:chunk:%' AND status='validated' ORDER BY stage_key",
        [submitted.id]
      );
      expect(retainedLeaves.rows).toHaveLength(plannedLeaves.rows.length - 1);
      const retainedLeafSnapshots = new Map(retainedLeaves.rows.map((stage) => [stage.id, {
        stageKey: stage.stage_key,
        outputHash: createHash("sha256").update(stage.output).digest("hex")
      }]));

      extractionServiceFailuresRemaining = 2;
      expect(await runSourceWorker(1, submitted.id)).toMatchObject({ completed: 0, runs: [false] });
      const extractionFailure = await requestJson<{
        revision: number;
        status: string;
        stages: Array<{ id: string; key: string; generation: number; status: string }>;
      }>(api.url, `/api/v1/authoring/jobs/${submitted.id}`, undefined, "GET");
      const failedLeaf = extractionFailure.stages.find((stage) => stage.key.startsWith("source:chunk:") && stage.status === "recoverable");
      expect(extractionFailure.status).toBe("recoverable");
      expect(failedLeaf).toBeDefined();
      if (!failedLeaf) throw new Error("P3.9 recovery fixture did not retain a recoverable extraction leaf.");

      const retriedExtraction = await requestJson<{
        stages: Array<{ id: string; key: string; generation: number; status: string }>;
      }>(api.url, `/api/v1/authoring/jobs/${submitted.id}/retry`, {
        stageId: failedLeaf.id,
        expectedRevision: extractionFailure.revision
      });
      expect(retriedExtraction.stages).toContainEqual(expect.objectContaining({
        key: failedLeaf.key,
        generation: failedLeaf.generation + 1,
        status: "queued"
      }));
      const queuedExtraction = retriedExtraction.stages.find((stage) => stage.key === failedLeaf.key && stage.generation === failedLeaf.generation + 1);
      if (!queuedExtraction) throw new Error("P3.9 recovery fixture did not return the retried extraction leaf.");
      await waitForStageDue(pool, submitted.id, queuedExtraction.id);
      const callsBeforeExtractionRetry = chainProviderCalls;
      expect(await runSourceWorker(1, submitted.id)).toMatchObject({ completed: 1, runs: [true] });
      expect(chainProviderCalls - callsBeforeExtractionRetry).toBe(1);
      const recoveredLeaves = await pool.query<{ id: string; stage_key: string; output: string; status: string }>(
        `SELECT current.id,current.stage_key,current.output::text AS output,current.status
           FROM authoring_job_stages current
          WHERE current.job_id=$1 AND current.stage_key LIKE 'source:chunk:%'
            AND current.generation=(SELECT max(candidate.generation) FROM authoring_job_stages candidate WHERE candidate.job_id=current.job_id AND candidate.stage_key=current.stage_key)
          ORDER BY current.stage_key`,
        [submitted.id]
      );
      expect(recoveredLeaves.rows).toHaveLength(plannedLeaves.rows.length);
      expect(recoveredLeaves.rows.every((stage) => stage.status === "validated")).toBe(true);
      const retainedAfterExtractionRetry = recoveredLeaves.rows.filter((stage) => retainedLeafSnapshots.has(stage.id));
      expect(retainedAfterExtractionRetry.map((stage) => stage.id).sort()).toEqual([...retainedLeafSnapshots.keys()].sort());
      for (const stage of retainedAfterExtractionRetry) {
        const expected = retainedLeafSnapshots.get(stage.id)!;
        expect(stage.stage_key).toBe(expected.stageKey);
        expect(createHash("sha256").update(stage.output).digest("hex")).toBe(expected.outputHash);
      }

      const extracted = await requestJson<{
        revision: number;
        source: { facts: Array<{ id: string; kind: string; subject: string }> };
      }>(api.url, `/api/v1/authoring/jobs/${submitted.id}`, undefined, "GET");
      const selectedCharacter = extracted.source.facts.find((fact) => fact.kind === "character" && fact.subject === "Mara");
      expect(selectedCharacter).toBeDefined();
      if (!selectedCharacter) throw new Error("P3.9 recovery fixture did not extract Mara for explicit roster review.");
      const characterFacts = extracted.source.facts.filter((fact) => fact.kind === "character");
      const review = await requestJson<{ revision: number }>(api.url, `/api/v1/authoring/source-jobs/${submitted.id}/facts`, {
        expectedRevision: extracted.revision,
        acceptedFactIds: extracted.source.facts.map((fact) => fact.id),
        rejectedFactIds: [],
        uncertainFactIds: [],
        selectedCharacterFactIds: [selectedCharacter.id],
        characterIdentityGroups: [{ representativeFactId: selectedCharacter.id, factIds: characterFacts.map((fact) => fact.id) }],
        manualFacts: []
      }, "PUT");
      await requestJson(api.url, `/api/v1/authoring/source-jobs/${submitted.id}/synthesis`, { expectedRevision: review.revision });
      expect(await runSourceWorker(1, submitted.id)).toMatchObject({ completed: 1, runs: [true] });

      characterInvalidResponsesRemaining = 2;
      expect(await runSourceWorker(1, submitted.id)).toMatchObject({ completed: 0, runs: [false] });
      const characterFailure = await requestJson<{
        revision: number;
        status: string;
        stages: Array<{ id: string; key: string; generation: number; status: string }>;
      }>(api.url, `/api/v1/authoring/jobs/${submitted.id}`, undefined, "GET");
      const failedCharacter = characterFailure.stages.find((stage) => stage.key === `source:character:${selectedCharacter.id}` && stage.status === "recoverable");
      expect(characterFailure.status).toBe("recoverable");
      expect(failedCharacter).toBeDefined();
      if (!failedCharacter) throw new Error("P3.9 recovery fixture did not retain a recoverable selected character.");
      const synthesisOutput = await pool.query<{ id: string; output: string }>(
        "SELECT id,output::text AS output FROM authoring_job_stages WHERE job_id=$1 AND stage_key='source:synthesis' AND status='validated' AND generation=1",
        [submitted.id]
      );
      expect(synthesisOutput.rows).toHaveLength(1);
      const retainedSynthesis = synthesisOutput.rows[0]!;
      const retainedSynthesisHash = createHash("sha256").update(retainedSynthesis.output).digest("hex");

      const retriedCharacter = await requestJson<{ stages: Array<{ id: string; key: string; generation: number; status: string }> }>(api.url, `/api/v1/authoring/jobs/${submitted.id}/retry`, {
        stageId: failedCharacter.id,
        expectedRevision: characterFailure.revision
      });
      const queuedCharacter = retriedCharacter.stages.find((stage) => stage.key === failedCharacter.key && stage.generation === failedCharacter.generation + 1);
      if (!queuedCharacter) throw new Error("P3.9 recovery fixture did not return the retried character stage.");
      await waitForStageDue(pool, submitted.id, queuedCharacter.id);
      const callsBeforeCharacterRetry = chainProviderCalls;
      expect(await runSourceWorker(1, submitted.id)).toMatchObject({ completed: 1, runs: [true] });
      expect(chainProviderCalls - callsBeforeCharacterRetry).toBe(1);
      const completed = await requestJson<{
        revision: number;
        result: unknown;
        stages: Array<{ id: string; key: string; status: string }>;
      }>(api.url, `/api/v1/authoring/jobs/${submitted.id}`, undefined, "GET");
      expect(completed.result).toBeDefined();
      const synthesisAfterCharacterRetry = await pool.query<{ id: string; output: string }>(
        "SELECT id,output::text AS output FROM authoring_job_stages WHERE job_id=$1 AND stage_key='source:synthesis' AND status='validated' AND generation=1",
        [submitted.id]
      );
      expect(synthesisAfterCharacterRetry.rows).toEqual([retainedSynthesis]);
      expect(createHash("sha256").update(synthesisAfterCharacterRetry.rows[0]!.output).digest("hex")).toBe(retainedSynthesisHash);
      const leavesAfterCharacterRetry = await pool.query<{ id: string; stage_key: string; output: string; status: string }>(
        `SELECT current.id,current.stage_key,current.output::text AS output,current.status
           FROM authoring_job_stages current
          WHERE current.job_id=$1 AND current.stage_key LIKE 'source:chunk:%'
            AND current.generation=(SELECT max(candidate.generation) FROM authoring_job_stages candidate WHERE candidate.job_id=current.job_id AND candidate.stage_key=current.stage_key)
          ORDER BY current.stage_key`,
        [submitted.id]
      );
      expect(leavesAfterCharacterRetry.rows).toHaveLength(plannedLeaves.rows.length);
      for (const stage of leavesAfterCharacterRetry.rows) {
        const expected = recoveredLeaves.rows.find((candidate) => candidate.id === stage.id);
        expect(expected).toBeDefined();
        expect(stage).toEqual(expected);
      }

      const selectedStageIds = completed.stages
        .filter((stage) => stage.status === "validated" && (stage.key === "source:synthesis" || stage.key.startsWith("source:character:")))
        .map((stage) => stage.id);
      expect(selectedStageIds).toHaveLength(2);
      const beforeApply = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM worlds WHERE owner_user_id=$1", [ownerUserId]);
      const applyInput = {
        expectedRevision: completed.revision,
        idempotencyKey: `p3-9-composed-recovery-${randomUUID()}`,
        selectedStageIds,
        content: completed.result
      };
      const applied = await requestJson<{ worldId: string; draftRevision: number }>(api.url, `/api/v1/authoring/jobs/${submitted.id}/apply`, applyInput);
      await expect(requestJson(api.url, `/api/v1/authoring/jobs/${submitted.id}/apply`, applyInput)).resolves.toEqual(applied);
      const afterApply = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM worlds WHERE owner_user_id=$1", [ownerUserId]);
      expect(Number(afterApply.rows[0]!.count)).toBe(Number(beforeApply.rows[0]!.count) + 1);
    } finally {
      activeScenario = undefined;
      extractionServiceFailuresRemaining = 0;
      characterInvalidResponsesRemaining = 0;
      await pool.query("DELETE FROM provider_profiles WHERE id=$1", [profile.id]);
    }
  });
});
