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
import type { SourceFact } from "../../packages/contracts/src/source-authoring.js";
import { createProvider } from "../helpers/provider-application-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe.sequential : describe.skip;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const credentialSecret = "p3-source-process-secret";

function runSourceWorker(limit: number): Promise<{ completed: number; runs: boolean[] }> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "tests/helpers/authoring-worker-process.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, TEST_DATABASE_URL: process.env.TEST_DATABASE_URL!, AUTHORING_PROCESS_CREDENTIAL_SECRET: credentialSecret, AUTHORING_PROCESS_LIMIT: String(limit) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0 || signal) { reject(new Error(`source worker exited ${code ?? signal}: ${stderr}`)); return; }
      try { resolveProcess(JSON.parse(stdout.trim()) as { completed: number; runs: boolean[] }); }
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

integration("durable story-source authoring", () => {
  let pool: DatabasePool;
  let ownerUserId: string;
  let provider: Server;
  let providerPort: number;
  let providerCalls = 0;
  let outputLimitedResponses = 0;
  let rejectProviderRequests = false;
  const jobs: string[] = [];

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    provider = createServer((request, response) => {
      providerCalls += 1;
      request.resume();
      request.on("end", () => {
        if (rejectProviderRequests) {
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: { message: "Synthetic source extraction rejection." } }));
          return;
        }
        const outputLimited = outputLimitedResponses > 0;
        if (outputLimited) outputLimitedResponses -= 1;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ id: randomUUID(), choices: [{ message: { role: "assistant", content: JSON.stringify({ facts: [] }) }, finish_reason: outputLimited ? "length" : "stop" }] }));
      });
    });
    await new Promise<void>((ready) => provider.listen(0, "127.0.0.1", ready));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("Source provider did not bind.");
    providerPort = address.port;
  });
  afterEach(async () => { if (jobs.length) await pool.query("DELETE FROM authoring_jobs WHERE id = ANY($1::uuid[])", [jobs.splice(0)]); });
  afterAll(async () => { await pool?.end(); if (provider) await new Promise<void>((done) => provider.close(() => done())); });

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
    await expect(repository.initializeExecutionSnapshot(plan!, { providerProfileId: randomUUID(), model: "synthetic", configurationHash: "a".repeat(64), contextWindowTokens: 100_000, maxOutputTokens: 100, requestTimeoutMs: 10_000, prompts: {}, protocols: { source: "source-extraction-v1" } })).resolves.toBeTruthy();
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
    await repository.initializeExecutionSnapshot(otherPlanClaim!, { providerProfileId: randomUUID(), model: "synthetic", configurationHash: "b".repeat(64), contextWindowTokens: 100_000, maxOutputTokens: 100, requestTimeoutMs: 10_000, prompts: {}, protocols: { source: "source-extraction-v1" } });
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
    const conflictingDateIds = regenerated.source!.facts.filter((item) => item.predicate === "arrives").map((item) => item.id);
    const visitsIds = regenerated.source!.facts.filter((item) => item.predicate === "visits").map((item) => item.id);
    expect(conflictingDateIds).toHaveLength(2);
    expect(visitsIds).toHaveLength(1);
    await expect(repository.reviewSourceFacts!({ ownerUserId }, submitted.id, {
      expectedRevision: regenerated.revision, acceptedFactIds: accepted, rejectedFactIds: [], uncertainFactIds: [], selectedCharacterFactIds: [visitsIds[0]!, conflictingDateIds[0]!],
      characterIdentityGroups: [
        { representativeFactId: visitsIds[0]!, factIds: visitsIds },
        { representativeFactId: conflictingDateIds[0]!, factIds: conflictingDateIds }
      ],
      manualFacts: [{ id: "unrelated-manual-fact", kind: "rule", subject: "Lantern", predicate: "means", value: "hope", provenance: "manual", citations: [] }]
    })).rejects.toMatchObject({ code: "invalid_state" });
    const resolvedAccepted = accepted.filter((id) => id !== conflictingDateIds[1]);
    const resolvedCharacterGroup = { representativeFactId: visitsIds[0]!, factIds: resolvedAccepted };
    const reviewed = await repository.reviewSourceFacts!({ ownerUserId }, submitted.id, {
      expectedRevision: regenerated.revision, acceptedFactIds: resolvedAccepted, rejectedFactIds: [], uncertainFactIds: [conflictingDateIds[1]!], selectedCharacterFactIds: [visitsIds[0]!], characterIdentityGroups: [resolvedCharacterGroup],
      manualFacts: [{ id: "author-entered-manual-fact", kind: "rule", subject: "Lantern", predicate: "means", value: "hope", provenance: "manual", citations: [] }]
    });
    if (reviewed.kind !== "story_source") throw new Error("Expected source review detail.");
    const manualId = reviewed.source?.facts.find((item) => item.provenance === "manual")?.id;
    expect(manualId).toMatch(/^source-fact:manual:/u);
    expect(reviewed.source?.acceptedFactIds).toEqual([...resolvedAccepted, manualId]);
    expect(reviewed.source?.uncertainFactIds).toEqual([conflictingDateIds[1]]);
    expect(reviewed.source?.characterIdentityGroups).toEqual([resolvedCharacterGroup]);
    const rereviewed = await repository.reviewSourceFacts!({ ownerUserId }, submitted.id, {
      expectedRevision: reviewed.revision, acceptedFactIds: [...resolvedAccepted, manualId!], rejectedFactIds: [], uncertainFactIds: [conflictingDateIds[1]!], selectedCharacterFactIds: [visitsIds[0]!], characterIdentityGroups: [resolvedCharacterGroup], manualFacts: []
    });
    const synthesis = await repository.startSourceSynthesis!({ ownerUserId }, submitted.id, rereviewed.revision);
    expect(synthesis.status).toBe("queued");
    expect(synthesis.result).toBeUndefined();
    expect(synthesis.stages.some((stage) => stage.key === "source:synthesis" && stage.status === "queued")).toBe(true);
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
    await repository.initializeExecutionSnapshot(planClaim!, { providerProfileId: randomUUID(), model: "synthetic", configurationHash: "c".repeat(64), contextWindowTokens: 100_000, maxOutputTokens: 100, requestTimeoutMs: 10_000, prompts: {}, protocols: { source: "source-extraction-v1" } });
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
    await repository.initializeExecutionSnapshot(planClaim!, { providerProfileId: randomUUID(), model: "synthetic", configurationHash: "d".repeat(64), contextWindowTokens: 100_000, maxOutputTokens: 100, requestTimeoutMs: 10_000, prompts: {}, protocols: { source: "source-extraction-v1" } });
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
      expect(await runSourceWorker(1)).toEqual({ completed: 1, runs: [true] });
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
      expect(await runSourceWorker(1)).toEqual({ completed: 1, runs: [true] });
      outputLimitedResponses = 2;
      expect(await runSourceWorker(1)).toEqual({ completed: 0, runs: [false] });
      const splitLeaves = await pool.query<{ stage_key: string; status: string }>("SELECT stage_key, status FROM authoring_job_stages WHERE job_id = $1 AND stage_key LIKE 'source:chunk:%' ORDER BY stage_key", [submitted.id]);
      expect(splitLeaves.rows.filter((stage) => stage.status === "cancelled")).toHaveLength(1);
      expect(splitLeaves.rows.filter((stage) => stage.status === "queued")).toHaveLength(2);
      expect(await runSourceWorker(1)).toEqual({ completed: 1, runs: [true] });
      const first = await pool.query<{ id: string; output: string }>("SELECT id, output::text AS output FROM authoring_job_stages WHERE job_id = $1 AND stage_key LIKE 'source:chunk:%' AND status = 'validated'", [submitted.id]);
      expect(first.rows).toHaveLength(1);
      const firstHash = sha256(first.rows[0]!.output);
      rejectProviderRequests = true;
      expect(await runSourceWorker(1)).toEqual({ completed: 0, runs: [false] });
      rejectProviderRequests = false;
      const incomplete = (await repository.read({ ownerUserId }, submitted.id))!;
      if (incomplete.kind !== "story_source") throw new Error("Expected source authoring detail.");
      expect(incomplete.source?.extractionComplete).toBe(false);
      expect(incomplete.stages.some((stage) => stage.key === "source:synthesis")).toBe(false);
      const missing = incomplete.stages.find((stage) => stage.key.startsWith("source:chunk:") && stage.status === "failed");
      expect(missing).toBeDefined();
      await repository.retry({ ownerUserId }, submitted.id, missing!.id, incomplete.revision);
      const callsBeforeRetry = providerCalls;
      expect(await runSourceWorker(16)).toEqual({ completed: 1, runs: [true, false] });
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
