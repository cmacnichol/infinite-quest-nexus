import { STORY_MEMORY_MANDATORY_CONTRACT } from "../../packages/contracts/src/story-prompt.js";
import { createApiGenerationApplication as composeGeneration } from "../../services/runtime/src/generation-api-composition.js";
import { apiProviderGraph } from "../helpers/provider-application-fixtures.js";
import { saveStoryMemoryEnrollment } from "../../packages/database/src/story-memory-policy-repository.js";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generationRequestSchema } from "../../packages/contracts/src/generation.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { createDatabasePool, initialOwnerId, type DatabaseClient, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { loadPostgresChronicleGenerationAuthorityContext } from "../../packages/database/src/chronicle-generation-context.js";
import { resolveGenerationAuthoritySnapshot } from "../../packages/database/src/generation-authority.js";
import { createProvider } from "../helpers/provider-application-fixtures.js";
import { createApiGenerationApplication } from "../helpers/runtime-application-fixtures.js";
import { importLegacyStory } from "../helpers/memory-aware-services.js";
import { runGenerationJob } from "../helpers/generation-worker-harness.js";
import { installIntegrationProviderTransport } from "./provider-transport-test-helper.js";
import { planChronicleQueries } from "../../packages/domain/src/chronicle-query-plan.js";
import { serializeProviderRequest } from "../../packages/story-engine/src/provider-request.js";
import { planGenerationPromptContext } from "../../services/runtime/src/generation-executor-adapter.js";
import {
  storyContinuityCandidateOutput,
  storyContinuitySourceOracle
} from "../fixtures/story-continuity/scenarios.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const knownFailure = databaseUrl && process.env.RUN_KNOWN_FAILURE_BASELINES === "1" ? describe : describe.skip;
const credentialSecret = "story-context-payload-baseline-secret";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function candidateReply(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    narration: storyContinuityCandidateOutput.narration,
    choices: storyContinuityCandidateOutput.choices,
    custom_action_suggestion: storyContinuityCandidateOutput.customActionSuggestion,
    scratchpad: storyContinuityCandidateOutput.scratchpad,
    tracker_updates: [],
    image_prompt: storyContinuityCandidateOutput.imagePrompt,
    continuity_summary: storyContinuityCandidateOutput.continuitySummary,
    canonical_facts: storyContinuityCandidateOutput.canonicalFacts,
    superseded_facts: [],
    canonical_fact_updates: storyContinuityCandidateOutput.canonicalFactUpdates,
    open_threads: storyContinuityCandidateOutput.openThreads,
    ...overrides
  });
}

type CapturedRequest = Readonly<{ body: string; bodySha256: string; parsed: Record<string, unknown> }>;

function authoritativeContext(captured: CapturedRequest): Record<string, unknown> {
  const messages = captured.parsed.messages;
  if (!Array.isArray(messages)) throw new Error("Provider request did not contain messages.");
  const userMessage = messages.find((message) => (
    typeof message === "object"
    && message !== null
    && (message as { role?: unknown }).role === "user"
  )) as { content?: unknown } | undefined;
  if (typeof userMessage?.content !== "string") throw new Error("Provider request did not contain a serialized user context.");
  const parsed = JSON.parse(userMessage.content) as { authoritative_context?: unknown };
  if (typeof parsed.authoritative_context !== "object" || parsed.authoritative_context === null) {
    throw new Error("Provider request did not contain authoritative context.");
  }
  return parsed.authoritative_context as Record<string, unknown>;
}

/** This suite reaches the executor's real transport; it never calls buildContextPreview. */
integration("story context payload baseline shape", () => {
  let pool: DatabasePool;
  let server: Server;
  let providerId = "";
  let ownerUserId = "";
  let previousDatabaseUrl: string | undefined;
  const replies: string[] = [];
  const requests: CapturedRequest[] = [];

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL ??= databaseUrl;
    pool = createDatabasePool(databaseUrl!, 6);
    await migrateDatabase(pool, resolve(repositoryRoot, "database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    const transport = installIntegrationProviderTransport();
    server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        if (!request.url?.endsWith("/chat/completions")) {
          response.end(JSON.stringify({ data: [] }));
          return;
        }
        requests.push({
          body,
          bodySha256: createHash("sha256").update(body).digest("hex"),
          parsed: JSON.parse(body || "{}") as Record<string, unknown>
        });
        response.end(JSON.stringify({
          id: randomUUID(),
          model: "story-context-payload-baseline",
          choices: [{ message: { content: replies.shift() ?? candidateReply() }, finish_reason: "stop" }],
          usage: { prompt_tokens: 700, completion_tokens: 220, total_tokens: 920 }
        }));
      });
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Baseline provider did not expose a TCP address.");
    providerId = (await createProvider(pool, {
      name: `Story context baseline ${randomUUID()}`,
      providerType: "openai_compatible",
      providerRole: "text",
      baseUrl: `http://127.0.0.1:${address.port}`,
      defaultModel: "story-context-payload-baseline",
      contextWindowTokens: 1_048_576,
      maxOutputTokens: 4_096,
      temperature: 0,
      enabled: true,
      configuration: {}
    }, credentialSecret)).id;
    (server as Server & { __transport?: { close(): Promise<void> } }).__transport = transport;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    await (server as Server & { __transport?: { close(): Promise<void> } }).__transport?.close();
    await pool?.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  async function importedCampaign(label: string): Promise<{ campaignId: string; worldVersionId: string }> {
    const story = JSON.parse(await readFile(resolve(repositoryRoot, "tests/fixtures/legacy-story.json"), "utf8"));
    story.world.title = `Story context ${label} ${randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({
      sourceName: "story-context-payload-baseline.story",
      story
    }));
    const campaign = await pool.query<{ world_version_id: string }>(
      "SELECT world_version_id FROM campaigns WHERE id=$1 AND owner_user_id=$2",
      [imported.campaignId, ownerUserId]
    );
    return { campaignId: imported.campaignId, worldVersionId: campaign.rows[0]!.world_version_id };
  }

  async function dispatch(campaignId: string, action: string, enrolled = false, inputMode: "action" | "scene" = "action"): Promise<CapturedRequest> {
    const before = requests.length;
    const application = enrolled
      ? composeGeneration(pool, apiProviderGraph(pool, credentialSecret).generation, undefined, { installedCapability: "r1", enforceEnabled: false })
      : createApiGenerationApplication(pool, credentialSecret);
    const job = await application.enqueueAppend({ ownerUserId, campaignId }, generationRequestSchema.parse({
      action, requestedInputMode: inputMode, resolvedInputMode: inputMode, inputModeSource: "explicit",
      providerProfileId: providerId,
      idempotencyKey: randomUUID(),
      context: { budgetTokens: 1_000_000, compression: "full", recentTurns: 8 }
    }));
    expect(await runGenerationJob(pool, `payload-baseline-${randomUUID()}`, 30, credentialSecret)).toBe(true);
    expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "completed" });
    const captured = requests.at(before);
    if (!captured) throw new Error("The real executor did not reach the fake provider boundary.");
    return captured;
  }

  async function withAuthorityRead<T>(
    read: (client: DatabaseClient) => Promise<T>
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      return await read(client);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }

  async function seedFutureCanonicalFact(fixture: { campaignId: string; worldVersionId: string }): Promise<void> {
    const sourceTurn = await pool.query<{ id: string; turn_number: number }>(
      `SELECT id,turn_number FROM turns
        WHERE owner_user_id=$1 AND campaign_id=$2
        ORDER BY turn_number,id LIMIT 1`,
      [ownerUserId, fixture.campaignId]
    );
    const turn = sourceTurn.rows[0];
    if (!turn) throw new Error("Future-fact fixture needs an accepted source turn.");
    await pool.query(
      `INSERT INTO campaign_canonical_facts (
         id,owner_user_id,campaign_id,world_version_id,source_turn_id,source_turn_number,source_fact_index,
         content,normalized_content,entities,entity_ids,valid_from_turn,metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,0,$7,lower($7),ARRAY[]::text[],ARRAY[]::text[],$8,'{}'::jsonb)`,
      [randomUUID(), ownerUserId, fixture.campaignId,
        fixture.worldVersionId, turn.id, turn.turn_number,
        "FUTURE_TURN_NEGATIVE: must not enter the provider request before its effective turn.",
        storyContinuitySourceOracle.negative.futureTurnNumber]
    );
  }

  it("captures an exact serialized executor body and reports only its hash", async () => {
    const fixture = await importedCampaign("hash");
    const captured = await dispatch(fixture.campaignId, "Inspect the relay lantern.");

    expect(captured.parsed).toHaveProperty("messages");
    expect(captured.bodySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(captured.body).not.toContain("buildContextPreview");
  });

  it("keeps a deliberately empty correction oracle independent from transported candidate output", () => {
    expect(storyContinuitySourceOracle.intentionalEmptyCorrection).toEqual({
      id: storyContinuitySourceOracle.intentionalEmptyCorrection.id,
      continuitySummary: "",
      openThreads: [],
      canonicalFacts: [],
      scratchpad: ""
    });
    expect(JSON.stringify(storyContinuityCandidateOutput)).not.toContain(storyContinuitySourceOracle.correctedNarration.snippet);
  });

  it("rejects a wrong-owner scope at the private authority-read boundary", async () => {
    const fixture = await importedCampaign("negative-owner");

    await expect(withAuthorityRead((client) => loadPostgresChronicleGenerationAuthorityContext(client, {
      ownerUserId: storyContinuitySourceOracle.negative.wrongOwnerId,
      campaignId: fixture.campaignId,
      worldVersionId: fixture.worldVersionId,
      operationKind: "append",
      expectedTurnNumber: 3,
      query: "negative owner scope"
    }))).rejects.toThrow("Generation authority campaign was not found.");
  });

  it("rejects a wrong-world-version scope at the private authority-read boundary", async () => {
    const fixture = await importedCampaign("negative-world");

    await expect(withAuthorityRead((client) => loadPostgresChronicleGenerationAuthorityContext(client, {
      ownerUserId,
      campaignId: fixture.campaignId,
      worldVersionId: storyContinuitySourceOracle.negative.wrongWorldVersionId,
      operationKind: "append",
      expectedTurnNumber: 3,
      query: "negative world scope"
    }))).rejects.toThrow("Generation authority world version no longer matches the requested scope.");
  });

  it("excludes a future-turn fact from the captured final provider request", async () => {
    const fixture = await importedCampaign("negative-future");
    await seedFutureCanonicalFact(fixture);
    const captured = await dispatch(fixture.campaignId, "Inspect the future-only relay fact.");

    expect(captured.body).not.toContain(storyContinuitySourceOracle.negative.omittedFactId);
    expect(captured.body).not.toContain("FUTURE_TURN_NEGATIVE: must not enter the provider request before its effective turn.");
  });

  it("loads the complete classified effective character authority before optional Chronicle retrieval", async () => {
    const fixture = await importedCampaign("character-authority");
    const relationship = "Maintains the full long relationship description. ".repeat(90).trim();
    await pool.query(
      `UPDATE campaigns SET selected_character_id='mira', character_profile=$2::jsonb, character_profile_revision=1
        WHERE id=$1 AND owner_user_id=$3`,
      [fixture.campaignId, JSON.stringify({
        name: "Campaign Mira",
        profile: {
          identity: { aliases: ["Fox"], unknownIdentity: "PRIVATE_UNKNOWN" },
          story: { keyRelationships: relationship, unknownStory: "PRIVATE_UNKNOWN" },
          appearance: { clothing: "blue cloak", unknownAppearance: "PRIVATE_UNKNOWN" },
          unclassifiedNotes: "Complete fiction note.",
          extension: "PRIVATE_UNKNOWN"
        }
      }), ownerUserId]
    );

    const loaded = await withAuthorityRead(async (client) => {
      const scope = {
        ownerUserId, campaignId: fixture.campaignId, worldVersionId: fixture.worldVersionId,
        operationKind: "append" as const, expectedTurnNumber: 1, query: "Mira's relationship"
      };
      const frozen = await resolveGenerationAuthoritySnapshot(client, { ...scope, baseIdentityVersion: "generation-base-v3" });
      return loadPostgresChronicleGenerationAuthorityContext(client, { ...scope, expectedBaseIdentity: frozen.baseIdentity });
    });
    const serialized = JSON.stringify(loaded.authority.characterAuthority);
    expect(loaded.authority.characterAuthority).toMatchObject({
      source: "campaign_profile", name: "Campaign Mira", omittedExtensionFieldCount: 4,
      profile: { story: { keyRelationships: relationship }, appearance: { clothing: "blue cloak" } }
    });
    expect(serialized).not.toContain("PRIVATE_UNKNOWN");
    expect(serialized).not.toContain("scratchpad");
  });

  it("serializes v3 selected sibling world lore through the PostgreSQL authority reader without running the guarded executor", async () => {
    const fixture = await importedCampaign("v3-world-planner");
    const siblingLore = "The Sable Relay remembers every oath sworn beneath its blue lens.";
    const siblingRelationship = "The relay keeper still answers the Sable Relay after dusk.";
    await pool.query(
      `UPDATE world_versions SET content = jsonb_set(
         jsonb_set(content, '{entities}', $2::jsonb, true),
         '{relationships}', $3::jsonb, true
       ) WHERE id=$1 AND owner_user_id=$4`,
      [fixture.worldVersionId,
        JSON.stringify([
          { id: "sable-relay", name: "Sable Relay", description: siblingLore },
          { id: "relay-keeper", name: "Relay Keeper", description: "Keeps the lantern burning." }
        ]),
        JSON.stringify([{ id: "sable-keeper", from: "sable-relay", to: "relay-keeper", description: siblingRelationship }]),
        ownerUserId]
    );

    const context = await withAuthorityRead(async (client) => {
      const scope = { ownerUserId, campaignId: fixture.campaignId, worldVersionId: fixture.worldVersionId,
        operationKind: "append" as const, expectedTurnNumber: 1, query: "Ask the Sable Relay about its keeper." };
      const frozen = await resolveGenerationAuthoritySnapshot(client, { ...scope, baseIdentityVersion: "generation-base-v3" });
      return loadPostgresChronicleGenerationAuthorityContext(client, { ...scope, expectedBaseIdentity: frozen.baseIdentity });
    });
    const provider = { id: providerId, providerType: "openai_compatible", model: "story-context-payload-baseline",
      contextWindowTokens: 1_048_576, maxOutputTokens: 4_096, temperature: 0, requestTimeoutMs: 1_000, configuration: {} } as never;
    const planned = planGenerationPromptContext(context, provider, "Write a scene.", "Ask the Sable Relay about its keeper.", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "action", 1_000_000, 1_000_000, randomUUID());
    const serialized = serializeProviderRequest(provider, { systemPrompt: "Write a scene.", input: planned.storyInput }).body;
    const sent = authoritativeContext({ body: serialized, bodySha256: createHash("sha256").update(serialized).digest("hex"), parsed: JSON.parse(serialized) });

    expect(JSON.stringify(sent.worldReferences)).toContain(siblingLore);
    expect(JSON.stringify(sent.worldReferences)).toContain(siblingRelationship);
    expect(planned.contextPlan.selected.some((block) => block.scope === "world")).toBe(true);
  });

  // These probes are intentionally red on the pinned baseline. They are
  // opt-in so a known product defect cannot turn ordinary CI permanently red.
  knownFailure("story context payload known-failure probes", () => {
    it("F1 sends selected sibling world entity authority", async () => {
      const fixture = await importedCampaign("f1");
      await pool.query(
        `UPDATE world_versions SET content = jsonb_set(
           jsonb_set(content, '{entities}', $2::jsonb, true),
           '{relationships}', $3::jsonb, true
         ) WHERE id=$1 AND owner_user_id=$4`,
        [fixture.worldVersionId,
          JSON.stringify([{ id: storyContinuitySourceOracle.f1WorldSiblingLore.id, detail: storyContinuitySourceOracle.f1WorldSiblingLore.entitySnippet }]),
          JSON.stringify([{ id: "sable-relay-relationship", detail: storyContinuitySourceOracle.f1WorldSiblingLore.relationshipSnippet }]),
          ownerUserId]
      );
      const captured = await dispatch(fixture.campaignId, "Ask about the Sable Relay.");

      expect(captured.body).toContain(storyContinuitySourceOracle.f1WorldSiblingLore.entitySnippet);
    });

    it("F1 sends selected sibling world relationship authority", async () => {
      const fixture = await importedCampaign("f1-relationship");
      await pool.query(
        `UPDATE world_versions SET content = jsonb_set(
           jsonb_set(content, '{entities}', $2::jsonb, true),
           '{relationships}', $3::jsonb, true
         ) WHERE id=$1 AND owner_user_id=$4`,
        [fixture.worldVersionId,
          JSON.stringify([{ id: storyContinuitySourceOracle.f1WorldSiblingLore.id, detail: storyContinuitySourceOracle.f1WorldSiblingLore.entitySnippet }]),
          JSON.stringify([{ id: "sable-relay-relationship", detail: storyContinuitySourceOracle.f1WorldSiblingLore.relationshipSnippet }]),
          ownerUserId]
      );
      const captured = await dispatch(fixture.campaignId, "Ask about the Sable Relay.");

      expect(captured.body).toContain(storyContinuitySourceOracle.f1WorldSiblingLore.relationshipSnippet);
    });

    it("F2 sends the edited campaign character profile rather than only its selected ID", async () => {
      const fixture = await importedCampaign("f2");
      await pool.query(
        `UPDATE campaigns SET selected_character_id='mira', character_profile=$2::jsonb, character_profile_revision=1
          WHERE id=$1 AND owner_user_id=$3`,
        [fixture.campaignId, JSON.stringify({ name: "Mira", profile: { story: { motivations: storyContinuitySourceOracle.f2EditedCharacter.snippet } } }), ownerUserId]
      );
      const captured = await dispatch(fixture.campaignId, "Ask Mira to guide the company.");

      expect(captured.body).toContain(storyContinuitySourceOracle.f2EditedCharacter.snippet);
    });

    it("F3 carries a structured-only accepted base fact into the next provider request", async () => {
      const fixture = await importedCampaign("f3");
      replies.push(candidateReply({
        canonical_fact_updates: [{
          content: storyContinuitySourceOracle.f3StructuredOnlyFact.snippet,
          supersedes_fact_ids: []
        }]
      }));
      await dispatch(fixture.campaignId, "Recover the silver seal.");
      const captured = await dispatch(fixture.campaignId, "Use the silver seal at the relay.");
      const currentContinuity = authoritativeContext(captured).currentContinuity as { canonicalFacts?: unknown };

      expect(currentContinuity.canonicalFacts).toEqual(expect.arrayContaining([
        expect.objectContaining({ content: storyContinuitySourceOracle.f3StructuredOnlyFact.snippet })
      ]));
    });

    it("F4 retains a late Story Direction beat in the bounded retrieval-query coverage", () => {
      const action = `${"Earlier direction filler. ".repeat(70)}${storyContinuitySourceOracle.f4LateDirectionBeat.actionSnippet}`;
      const queries = planChronicleQueries({ action });

      expect(queries.some((query) => query.query.includes(storyContinuitySourceOracle.f4LateDirectionBeat.actionSnippet))).toBe(true);
    });

    it("F5 admits an old exact fact after 300 newer distractor facts", async () => {
      const fixture = await importedCampaign("f5");
      await seedOldFactAfterNewerDistractors(fixture);
      const captured = await dispatch(fixture.campaignId, "Find the original relay key beneath the north stair.");

      expect(captured.body).toContain(storyContinuitySourceOracle.f5OldExactFact.snippet);
    });
  });

  async function enrolledCampaign(label: string) {
    const fixture = await importedCampaign(label);
    await saveStoryMemoryEnrollment(pool, { ownerUserId, campaignId: fixture.campaignId },
      { capability: "r1", reviewMode: "off" }, { installedCapability: "r1", enforceEnabled: false });
    return fixture;
  }
  const dispatchR1 = (campaignId: string, action: string) => dispatch(campaignId, action, true);

  describe("enrolled R1 actual provider-payload regressions", () => {
    it("runs enrolled Story Direction choice repair with the mandatory contract on both actual requests", async () => {
      const fixture = await enrolledCampaign("r1-scene-repair");
      await pool.query("UPDATE campaigns SET turn_control_style='flexible_scene' WHERE id=$1", [fixture.campaignId]);
      const before = requests.length;
      replies.push(candidateReply({ choices: [] }), JSON.stringify({ choices: storyContinuityCandidateOutput.choices,
        custom_action_suggestion: storyContinuityCandidateOutput.customActionSuggestion }));
      await dispatch(fixture.campaignId, "Set the relay scene.", true, "scene");
      const actual = requests.slice(before);
      expect(actual).toHaveLength(2);
      for (const request of actual) {
        const messages = request.parsed.messages as { role: string; content: string }[];
        expect(messages.find((message) => message.role === "system")?.content).toContain(STORY_MEMORY_MANDATORY_CONTRACT);
        expect(request.body).not.toContain("are facts that happen in this turn");
      }
      expect((await pool.query("SELECT narration FROM turns WHERE campaign_id=$1 ORDER BY turn_number DESC LIMIT 1", [fixture.campaignId])).rows[0]!.narration)
        .toBe(storyContinuityCandidateOutput.narration);
    });
    it("refuses a changed frozen provider configuration before any provider dispatch", async () => {
      const fixture = await enrolledCampaign("r1-provider-stale");
      const application = composeGeneration(pool, apiProviderGraph(pool, credentialSecret).generation, undefined, { installedCapability: "r1", enforceEnabled: false });
      const job = await application.enqueueAppend({ ownerUserId, campaignId: fixture.campaignId }, generationRequestSchema.parse({
        action: "Wait beside the relay.", providerProfileId: providerId, idempotencyKey: randomUUID() }));
      const before = requests.length;
      await pool.query("UPDATE provider_profiles SET temperature=0.1 WHERE id=$1", [providerId]);
      try {
        expect(await runGenerationJob(pool, `provider-stale-${randomUUID()}`, 30, credentialSecret)).toBe(false);
        expect(requests).toHaveLength(before);
        expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "recoverable" });
      } finally { await pool.query("UPDATE provider_profiles SET temperature=0 WHERE id=$1", [providerId]); }
    });
    it("keeps future scoped fact evidence out of enrolled provider requests", async () => {
      const fixture = await enrolledCampaign("r1-future");
      await seedFutureCanonicalFact(fixture);
      expect((await dispatchR1(fixture.campaignId, "Inspect the relay lantern.")).body).not.toContain("FUTURE_TURN_NEGATIVE");
    });

    it("F1 sends selected sibling world entity authority", async () => {
      const fixture = await enrolledCampaign("f1");
      await pool.query(
        `UPDATE world_versions SET content = jsonb_set(
           jsonb_set(content, '{entities}', $2::jsonb, true),
           '{relationships}', $3::jsonb, true
         ) WHERE id=$1 AND owner_user_id=$4`,
        [fixture.worldVersionId,
          JSON.stringify([{ id: storyContinuitySourceOracle.f1WorldSiblingLore.id, name: "Sable Relay", description: storyContinuitySourceOracle.f1WorldSiblingLore.entitySnippet }, { id: "keeper", name: "Keeper", description: "Tends the relay." }]),
          JSON.stringify([{ id: "sable-relay-relationship", from: storyContinuitySourceOracle.f1WorldSiblingLore.id, to: "keeper", description: storyContinuitySourceOracle.f1WorldSiblingLore.relationshipSnippet }]),
          ownerUserId]
      );
      const captured = await dispatchR1(fixture.campaignId, "Ask about the Sable Relay.");

      expect(captured.body).toContain(storyContinuitySourceOracle.f1WorldSiblingLore.entitySnippet);
    });

    it("F1 sends selected sibling world relationship authority", async () => {
      const fixture = await enrolledCampaign("f1-relationship");
      await pool.query(
        `UPDATE world_versions SET content = jsonb_set(
           jsonb_set(content, '{entities}', $2::jsonb, true),
           '{relationships}', $3::jsonb, true
         ) WHERE id=$1 AND owner_user_id=$4`,
        [fixture.worldVersionId,
          JSON.stringify([{ id: storyContinuitySourceOracle.f1WorldSiblingLore.id, name: "Sable Relay", description: storyContinuitySourceOracle.f1WorldSiblingLore.entitySnippet }, { id: "keeper", name: "Keeper", description: "Tends the relay." }]),
          JSON.stringify([{ id: "sable-relay-relationship", from: storyContinuitySourceOracle.f1WorldSiblingLore.id, to: "keeper", description: storyContinuitySourceOracle.f1WorldSiblingLore.relationshipSnippet }]),
          ownerUserId]
      );
      const captured = await dispatchR1(fixture.campaignId, "Ask about the Sable Relay.");

      expect(captured.body).toContain(storyContinuitySourceOracle.f1WorldSiblingLore.relationshipSnippet);
    });

    it("F2 sends the edited campaign character profile rather than only its selected ID", async () => {
      const fixture = await enrolledCampaign("f2");
      await pool.query(
        `UPDATE campaigns SET selected_character_id='mira', character_profile=$2::jsonb, character_profile_revision=1
          WHERE id=$1 AND owner_user_id=$3`,
        [fixture.campaignId, JSON.stringify({ name: "Mira", profile: { story: { motivations: storyContinuitySourceOracle.f2EditedCharacter.snippet } } }), ownerUserId]
      );
      const captured = await dispatchR1(fixture.campaignId, "Ask Mira to guide the company.");

      expect(captured.body).toContain(storyContinuitySourceOracle.f2EditedCharacter.snippet);
    });

    it("F3 carries a structured-only accepted base fact into the next provider request", async () => {
      const fixture = await enrolledCampaign("f3");
      replies.push(candidateReply({
        canonical_fact_updates: [{
          content: storyContinuitySourceOracle.f3StructuredOnlyFact.snippet,
          supersedes_fact_ids: []
        }]
      }));
      await dispatchR1(fixture.campaignId, "Recover the silver seal.");
      const captured = await dispatchR1(fixture.campaignId, "Use the silver seal at the relay.");
      const currentContinuity = authoritativeContext(captured).currentContinuity as { canonicalFacts?: unknown };

      expect(currentContinuity.canonicalFacts).toEqual(expect.arrayContaining([
        expect.objectContaining({ content: storyContinuitySourceOracle.f3StructuredOnlyFact.snippet })
      ]));
    });

    it("F4 retrieves old evidence for a late beat through the real bounded query path", async () => {
      const fixture = await enrolledCampaign("f4-wire");
      await seedOldFactAfterNewerDistractors(fixture);
      const action = `${"Earlier direction filler. ".repeat(180)}Find the original relay key beneath the north stair.`;
      const captured = await dispatchR1(fixture.campaignId, action);
      expect(captured.body).toContain(storyContinuitySourceOracle.f5OldExactFact.snippet);
      expect(captured.body).toContain("Find the original relay key beneath the north stair.");
    });

    it("F5 admits an old exact fact after 300 newer distractor facts", async () => {
      const fixture = await enrolledCampaign("f5");
      await seedOldFactAfterNewerDistractors(fixture);
      const captured = await dispatchR1(fixture.campaignId, "Find the original relay key beneath the north stair.");

      expect(captured.body).toContain(storyContinuitySourceOracle.f5OldExactFact.snippet);
    });
  });

  async function seedOldFactAfterNewerDistractors(fixture: { campaignId: string; worldVersionId: string }): Promise<void> {
    const rows = await pool.query<{ id: string; turn_number: number }>(
      `INSERT INTO turns (owner_user_id,campaign_id,turn_number,action,narration,state_snapshot_private)
       SELECT $1,$2,turn_number,'Record distractor ' || turn_number,'Distractor narration ' || turn_number,
              jsonb_build_object('continuitySummary','Current fixture continuity.','scratchpad','',
                'openThreads','[]'::jsonb,'canonicalFacts','[]'::jsonb,'trackers','[]'::jsonb,
                'rpgStats','[]'::jsonb,'eventTriggers','[]'::jsonb,'pendingEventTriggers','[]'::jsonb)
         FROM generate_series(3,303) turn_number
       RETURNING id,turn_number`,
      [ownerUserId, fixture.campaignId]
    );
    const old = rows.rows.find((row) => row.turn_number === 3);
    if (!old) throw new Error("Old fact source turn was not created.");
    await pool.query(
      `INSERT INTO campaign_canonical_facts (
         id,owner_user_id,campaign_id,world_version_id,source_turn_id,source_turn_number,source_fact_index,
         content,normalized_content,entities,entity_ids,valid_from_turn,metadata
       ) VALUES ($1,$2,$3,$4,$5,3,0,$6,lower($6),ARRAY[]::text[],ARRAY[]::text[],3,'{}'::jsonb)`,
      [randomUUID(), ownerUserId, fixture.campaignId, fixture.worldVersionId,
        old.id, storyContinuitySourceOracle.f5OldExactFact.snippet]
    );
    await pool.query(
      `INSERT INTO campaign_canonical_facts (
         id,owner_user_id,campaign_id,world_version_id,source_turn_id,source_turn_number,source_fact_index,
         content,normalized_content,entities,entity_ids,valid_from_turn,metadata
       ) SELECT gen_random_uuid(),$1,$2,$3,turn_row.id,turn_row.turn_number,0,
                'NEWER_DISTRACTOR_FACT ' || turn_row.turn_number,
                lower('NEWER_DISTRACTOR_FACT ' || turn_row.turn_number),
                ARRAY[]::text[],ARRAY[]::text[],turn_row.turn_number,'{}'::jsonb
           FROM turns turn_row
          WHERE turn_row.owner_user_id=$1 AND turn_row.campaign_id=$2 AND turn_row.turn_number BETWEEN 4 AND 303`,
      [ownerUserId, fixture.campaignId, fixture.worldVersionId]
    );
    await pool.query("UPDATE campaigns SET active_turn_number=303 WHERE id=$1 AND owner_user_id=$2", [fixture.campaignId, ownerUserId]);
  }
});
