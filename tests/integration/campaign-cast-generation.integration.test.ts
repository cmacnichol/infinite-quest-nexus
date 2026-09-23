import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { generationRequestSchema } from "../../packages/contracts/src/generation.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { CAST_DISCOVERY_SYSTEM_PROMPT, PROMPT_TEMPLATE_CATALOG, type PromptTemplateKey } from "../../packages/contracts/src/prompt-library.js";
import { deriveTextExecutionPlan, textExecutionRouteBasisHash } from "../../packages/contracts/src/text-execution-plan.js";
import { runCastDiscoveryOnce } from "../../packages/application/src/campaign-cast/discovery.js";
import { createDatabasePool, initialOwnerId, withTransaction, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createPostgresCampaignCastRepository } from "../../packages/database/src/campaign-cast-repository.js";
import { createCastDiscoveryJobRepository, enqueueCastDiscoveryWithClient } from "../../packages/database/src/campaign-cast-job-repository.js";
import { createPostgresGenerationCommandRepository } from "../../packages/database/src/generation-repository.js";
import { createPostgresGenerationExecutionRepository } from "../../packages/database/src/generation-execution-repository.js";
import { resolveGenerationAuthoritySnapshot } from "../../packages/database/src/generation-authority.js";
import { resolveStoryMemoryPromptSnapshot } from "../../packages/database/src/prompt-repository.js";
import { resolveStoryMemoryPolicySnapshot, saveStoryMemoryEnrollment } from "../../packages/database/src/story-memory-policy-repository.js";
import { createGenerationExecutor, type GenerationExecutionCollaborators } from "../../services/runtime/src/generation-executor-adapter.js";
import { createProvider, loadPromptSnapshotForTest, providerPromptProtocolVersion, readTurnReportedCostsForTest } from "../helpers/provider-application-fixtures.js";
import { importLegacyStory } from "../helpers/memory-aware-services.js";
import { memoryGeneration } from "../helpers/memory-applications.js";
import { sha256 } from "../../packages/domain/src/text.js";
import type { StreamingIllustrationConfig } from "../../packages/application/src/illustration/types.js";

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const secret = "cast-generation-test-secret";
const source = "Mara, known as Silver Watcher, greets the traveler. Mara has blue eyes. Mara was a cartographer. Mara stands at the harbor.";
const disabledIllustration: StreamingIllustrationConfig = {
  enabled: false, sourcePolicy: "off", matchingScope: "world", confidenceProfile: "balanced", repetitionWindow: 5,
  providerProfileId: null, model: "", size: "1024x1024", aspectRatio: "1:1", quality: "auto", outputFormat: "png",
  maxAttempts: 3, segmentWordCount: 500, imagesPerSegment: 1, segmentPromptMode: "direct", refinementPrompt: "disabled",
  defaultRefinementPrompt: "disabled", updatedAt: null, campaignImageProviderProfileId: null, campaignTextProviderProfileId: null
};
integration("campaign cast composed generation", () => {
  let pool: DatabasePool, ownerUserId: string, providerProfileId: string;
  const campaignIds: string[] = [];
  beforeAll(async () => {
    pool = createDatabasePool(process.env.TEST_DATABASE_URL!, 8);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    providerProfileId = (await createProvider(pool, { name: `Cast ${randomUUID()}`, providerType: "openai_compatible",
      providerRole: "text", baseUrl: "http://127.0.0.1:9911", defaultModel: "cast-test", contextWindowTokens: 32768,
      maxOutputTokens: 4096, temperature: 0, requestTimeoutMs: 5000, enabled: true, configuration: { textResponseFormatPolicy: "auto" } }, secret)).id;
  }, 60000);
  afterAll(async () => { await pool?.end(); });
  afterEach(async () => { await pool.query("DELETE FROM campaigns WHERE id=ANY($1::uuid[])", [campaignIds.splice(0)]); });

  function commands(enabled = true) {
    return createPostgresGenerationCommandRepository(pool, {
      resolvePromptSnapshot: (client, owner, campaignId, policy) => policy
        ? resolveStoryMemoryPromptSnapshot(client, { ownerUserId: owner, campaignId, scope: "campaign" }, "off", policy.castContext === true)
        : loadPromptSnapshotForTest(client, owner, campaignId),
      promptProtocolVersion: providerPromptProtocolVersion,
      resolveStoryMemoryPolicySnapshot: (client, scope) => resolveStoryMemoryPolicySnapshot(client, scope,
        { installedCapability: "r3", enforceEnabled: false, castContextEnabled: enabled }),
      readTurnReportedCosts: (owner, _campaign, ids) => readTurnReportedCostsForTest(pool, owner, [...ids])
    });
  }

  async function campaign(foreign = false) {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Cast composed ${randomUUID()}`;
    fixture.turns = Array.from({ length: 8 }, (_, index) => ({ ...fixture.turns[0], id: `cast-${index + 1}`, turnNumber: index + 1,
      action: "Wait quietly.", narration: index === 0 ? (foreign ? "FOREIGN_CAST_SECRET waits alone." : source) : "Rain falls over the empty road." }));
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "cast-composed.story", story: fixture }));
    campaignIds.push(imported.campaignId);
    await pool.query("UPDATE campaign_memory_configs SET embedding_enabled=false WHERE campaign_id=$1", [imported.campaignId]);
    return { ownerUserId, campaignId: imported.campaignId };
  }

  it.each([["action", true], ["scene", true], ["action", false], ["scene", false]] as const)("preserves %s generation through request, commit and next snapshot with cast=%s", async (mode, enabled) => {
    const scope = await campaign(), foreign = await campaign(true);
    const cast = createPostgresCampaignCastRepository(pool, { editingEnabled: true, discoveryEnabled: true });
    await cast.initialize(scope);
    const foreignCast = await cast.initialize(foreign);
    const foreignPerson = await cast.create(foreign, { expectedCastRevision: foreignCast.revision, expectedBoundary: foreignCast.boundary,
      idempotencyKey: randomUUID(), name: "Foreign witness", aliases: ["Silver Watcher"], profile: { "story.role": "FOREIGN_CAST_PROFILE" } });
    const turn = (await pool.query("SELECT id FROM turns WHERE campaign_id=$1 AND turn_number=1", [scope.campaignId])).rows[0];
    const basis = { version: 2 as const, selection: { kind: "model" as const, modelId: "cast-test" }, preset: null,
      candidates: [{ modelId: "cast-test", providerPolicy: {}, contextWindowTokens: 8000, maxOutputTokens: 2000 }], presetSystemPrompt: "",
      parameters: {}, endpointReference: "fixture-endpoint", credentialReference: providerProfileId, profileRevision: "fixture",
      authorityRevision: "fixture", requestTimeoutMs: 30000, protocolVersion: "cast-discovery-v1", routeBasisHash: "0".repeat(64) };
    await withTransaction(pool, (client) => enqueueCastDiscoveryWithClient(client, { scope, turnId: turn.id, enabled: true,
      execution: { providerProfileId, plan: deriveTextExecutionPlan({ ...basis, routeBasisHash: textExecutionRouteBasisHash(basis) }, CAST_DISCOVERY_SYSTEM_PROMPT) } }));
    expect(await runCastDiscoveryOnce({ workerId: "cast-composed", repository: createCastDiscoveryJobRepository(pool, () => true), extractor: {
      async extract(claim) {
        expect(claim.source.turnNumber).toBe(1);
        return { version: 1, characters: [{ localKey: "mara", existingCharacterId: null, name: "Mara", aliases: ["Silver Watcher"],
          identityEvidence: [{ paragraphId: "p1", quote: source }], observations: [
            { field: "appearance.description", value: "blue eyes", quote: "Mara has blue eyes." },
            { field: "story.role", value: "cartographer", quote: "Mara was a cartographer." },
            { field: "state.location", value: "harbor", quote: "Mara stands at the harbor." }
          ].map((item) => ({ ...item, mode: "fact", speakerCharacterId: null, paragraphId: "p1" })) }] };
      }
    } })).toBe("complete");
    const pending = (await pool.query("SELECT reason FROM campaign_cast_discovery_candidates WHERE campaign_id=$1", [scope.campaignId])).rows;
    expect(pending).toEqual([]);
    expect((await pool.query("SELECT validation_summary FROM campaign_cast_discovery_receipts WHERE campaign_id=$1", [scope.campaignId])).rows)
      .toEqual([expect.objectContaining({ validation_summary: { accepted: 1, unresolved: 0, rejected: [] } })]);
    const current = await cast.current(scope), person = current.characters.find((item) => item.name === "Mara")!;
    expect(person).toMatchObject({ origin: { kind: "discovered" }, aliases: ["Silver Watcher"] });
    const edited = await cast.edit(scope, person.id, { expectedCastRevision: current.revision, expectedCharacterRevision: person.revision,
      expectedBoundary: current.boundary, idempotencyKey: randomUUID(), setOverrides: { "appearance.description": "gray eyes" } });
    await saveStoryMemoryEnrollment(pool, scope, { capability: "r3", reviewMode: "off" }, { installedCapability: "r3", enforceEnabled: false });
    const enqueue = () => commands(enabled).enqueueAppend(scope, generationRequestSchema.parse({ action: "The Silver Watcher returns to the road.",
      providerProfileId, idempotencyKey: randomUUID(), requestedInputMode: mode, resolvedInputMode: mode, inputModeSource: "explicit",
      context: { budgetTokens: 16000, compression: "full", recentTurns: 2 } }));
    const queued = await enqueue();
    const requests: { operation: string; input: string }[] = [];
    let operation = "";
    const collaborators: GenerationExecutionCollaborators = {
      memory: memoryGeneration(pool, secret),
      illustration: { loadStreamingIllustrationConfig: async () => disabledIllustration,
        createProvisionalSet: async () => null, createProvisionalSegment: async () => false,
        promoteProvisionalSet: async () => undefined, orphanProvisionalSet: async () => undefined,
        enqueueAcceptedTurnIllustrationSegments: async () => null } as GenerationExecutionCollaborators["illustration"],
      loadTextExecution: async () => ({ id: providerProfileId, name: "Cast synthetic", providerRole: "text", providerType: "openai_compatible",
        model: "cast-test", endpointIdentity: sha256("http://127.0.0.1:9911"), contextWindowTokens: 32768, maxOutputTokens: 4096, temperature: 0, requestTimeoutMs: 5000, configuration: { textResponseFormatPolicy: "auto" },
        execute: async (request: { input?: string }) => {
          requests.push({ operation, input: String(request.input) });
          const content = operation === "scene_coverage_validation"
            ? JSON.stringify({ covered: true, missing_required_beats: [], contradictions: [] })
            : JSON.stringify({ narration: "Mara returns to the road, her gray eyes following the rain.",
              choices: ["Greet Mara.", "Ask about the map.", "Walk down the road.", "Wait by the gate."], custom_action_suggestion: "Ask Mara about her travels.",
              scratchpad: "Mara returned.", tracker_updates: [], image_prompt: "A traveler beside a wet road.", continuity_summary: "Mara returned to the road.",
              canonical_facts: ["Mara returned to the road."], superseded_facts: [], canonical_fact_updates: [], open_threads: [] });
          return { content, responseId: randomUUID(), finishReason: "stop", outputLimited: false, modelInstanceId: "cast-synthetic",
            usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, reportedCost: null, rawMetadata: {} };
        } }),
      onProviderDispatch: (value) => { operation = value; },
      promptFromSnapshot: (snapshot, key) => (snapshot as Record<string, { content?: string }> | undefined)?.[key as PromptTemplateKey]?.content ?? PROMPT_TEMPLATE_CATALOG[key].defaultContent,
      recordProfileCost: async () => null, attributeGenerationCostsToTurn: async () => undefined
    };
    const repository = createPostgresGenerationExecutionRepository(pool);
    const claim = await repository.claimNext({ workerId: "cast-generation", leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);
    const executed = await createGenerationExecutor({ pool, repository, collaborators }).execute({ claim: claim!, workerId: "cast-generation", leaseSeconds: 30 });
    expect(executed, JSON.stringify((await pool.query("SELECT status,error_code,error_message FROM generation_jobs WHERE id=$1", [queued.id])).rows)).toBe(true);
    expect((await pool.query("SELECT status,error_code,error_message FROM generation_jobs WHERE id=$1", [queued.id])).rows)
      .toEqual([{ status: "completed", error_code: null, error_message: null }]);
    const outgoing = requests.find((request) => request.operation === "story_generation")!;
    expect(outgoing).toBeDefined();
    const payload = JSON.parse(outgoing.input).authoritative_context;
    expect(JSON.parse(outgoing.input).current_turn_input.mode).toBe(mode);
    if (enabled) {
      expect(payload.cast.characters).toEqual(expect.arrayContaining([expect.objectContaining({ characterId: person.id, name: "Mara",
        fields: expect.arrayContaining([expect.objectContaining({ field: "appearance.description", value: "gray eyes", authority: "user" }),
          expect.objectContaining({ field: "story.role", source: expect.objectContaining({ turnNumber: 1 }) })]) })]));
      expect(payload.cast.notice).toContain("incomplete");
      expect(JSON.stringify(payload.cast)).not.toContain('"state.location"');
    } else expect(payload).not.toHaveProperty("cast");
    expect(outgoing.input).not.toContain("FOREIGN_CAST_SECRET");
    expect(outgoing.input).not.toContain("FOREIGN_CAST_PROFILE");
    expect(outgoing.input).not.toContain(foreignPerson.character.id);
    const job = (await pool.query("SELECT status,result_turn_id FROM generation_jobs WHERE id=$1", [queued.id])).rows[0];
    expect(job).toMatchObject({ status: "completed", result_turn_id: expect.any(String) });
    const next = await enqueue();
    const authority = await withTransaction(pool, (client) => resolveGenerationAuthoritySnapshot(client,
      { ...scope, operationKind: "append", expectedTurnNumber: 10, baseIdentityVersion: enabled ? "generation-base-v4" : "generation-base-v3" }));
    if (enabled) {
      expect(authority.castSnapshot).toMatchObject({ revision: edited.revision, boundary: { turnNumber: 9 },
        characters: expect.arrayContaining([expect.objectContaining({ id: person.id, profile: expect.objectContaining({ "appearance.description": "gray eyes" }) })]) });
      if (!("castFingerprint" in authority.baseIdentity)) throw new Error("Next generation did not capture cast authority.");
      expect((await pool.query("SELECT generation_base_identity FROM generation_jobs WHERE id=$1", [next.id])).rows[0].generation_base_identity.castFingerprint)
        .toBe(authority.baseIdentity.castFingerprint);
    } else {
      expect(authority.castSnapshot).toBeUndefined();
      expect((await pool.query("SELECT generation_base_identity FROM generation_jobs WHERE id=$1", [next.id])).rows[0].generation_base_identity.version)
        .toBe("generation-base-v3");
    }
    expect((await pool.query("SELECT active_turn_number FROM campaigns WHERE id=$1", [foreign.campaignId])).rows[0].active_turn_number).toBe(8);
    await commands().cancel({ ownerUserId, jobId: next.id });
  }, 60000);
});
