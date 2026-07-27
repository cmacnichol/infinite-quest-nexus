import { createServer, type Server } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDatabasePool,
  initialOwnerId,
  type DatabasePool
} from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createProviderNetworkPolicy } from "../../packages/security/src/provider-network-policy.js";
import { MAX_PROVIDER_JSON_RESPONSE_BYTES } from "../../packages/story-engine/src/provider-response.js";
import {
  configureDefaultProviderTransport,
  createProviderTransport,
  type ProviderTransport
} from "../../packages/story-engine/src/provider-transport.js";
import { createProvider } from "../../services/api/src/provider-service.js";
import { logger } from "../../packages/logger/src/index.js";
import {
  activeProgressMap,
  getImportProgress,
  importInfiniteWorlds
} from "../../services/api/src/infinite-worlds-import-service.js";
import { generateWorldPreview } from "../../services/api/src/world-generator-service.js";
import { PROMPT_TEMPLATE_CATALOG } from "../../packages/contracts/src/prompt-library.js";
import {
  getWorldGenerationProgress,
  type WorldGenerationProgress
} from "../../services/api/src/world-generation-progress-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const credentialSecret = "world-generation-integration-secret";

type MockProviderReply = {
  status?: number;
  content?: string;
  error?: string;
  declaredLength?: number;
};

type CompatibleProviderRequest = {
  messages?: Array<{
    role?: string;
    content?: string;
  }>;
};

type GeneratedCharacterRequestInput = {
  world: {
    title: string;
    genre: string;
    tone: string;
    backgroundStory: string;
    premise: string;
    firstAction: string;
    storyRules: string;
  };
  seed: ReturnType<typeof characterSeed>;
  otherSeeds: Array<Pick<ReturnType<typeof characterSeed>, "id" | "name" | "role">>;
  acceptedCharacterNames: string[];
};

function profile(role: string) {
  return {
    story: {
      role,
      background: `${role} background.`,
      personality: "Curious and steady.",
      motivations: "Protect the expedition.",
      goals: "Reveal the citadel's secret.",
      fearsAndConflicts: "Fears the crushing dark.",
      keyRelationships: "Trusts the other explorers.",
      narrativeHooks: "Carries a fragment of the old map.",
      voiceAndMannerisms: "Speaks in short, careful sentences.",
      otherGuidance: ""
    }
  };
}

function character(name: string, includeProfile: boolean, privateMarker = "", id?: string) {
  return {
    id: id ?? `provider-${name.toLocaleLowerCase().replaceAll(" ", "-")}`,
    name,
    character_text: `${name} is prepared to explore the submerged citadel.${privateMarker}`,
    ...(includeProfile ? { profile: profile(name) } : {}),
    rpg_statistics: [],
    default_triggers: []
  };
}

function characterSeed(index: number) {
  return {
    id: `seed-${index}`,
    name: `Explorer ${index}`,
    role: `Explorer role ${index}`,
    concept: `Explorer concept ${index}`,
    narrative_hook: `Explorer hook ${index}`
  };
}

function worldResponse(seedCount = 3): string {
  return JSON.stringify({
    title: "The Sunken Citadel",
    genre: "Fantasy exploration",
    tone: "Mysterious and adventurous",
    backgroundStory: "An ancient citadel sank beneath the waves.",
    premise: "Three explorers descend to recover its lost archive.",
    firstAction: "Examine the glowing runes on the bronze archway.",
    story_rules: "Ancient enchantments distort sound and light underwater.",
    character_seeds: Array.from(
      { length: seedCount },
      (_, index) => characterSeed(index + 1)
    ),
    rpg_statistics: [],
    default_triggers: [],
    event_triggers: []
  });
}

function characterResponse(index: number, includeProfile = true, privateMarker = ""): string {
  return JSON.stringify(character(
    `Explorer ${index}`,
    includeProfile,
    privateMarker,
    includeProfile ? `seed-${index}` : undefined
  ));
}

function providerEnvelope(content: string, responseId: string) {
  return JSON.stringify({
    id: responseId,
    choices: [{
      message: { content },
      finish_reason: "stop"
    }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 200,
      total_tokens: 300
    }
  });
}

integration("generated CYOA world persistence", () => {
  let pool: DatabasePool;
  let server: Server;
  let transport: ProviderTransport;
  let providerId = "";
  let blockedProviderId = "";
  let ownerUserId = "";
  const replies: MockProviderReply[] = [];
  const providerRequestBodies: CompatibleProviderRequest[] = [];
  const providerProgressSnapshots: WorldGenerationProgress[] = [];
  const progressKeys = new Set<string>();
  let observedProgressKey = "";

  beforeAll(async () => {
    transport = createProviderTransport({
      policy: createProviderNetworkPolicy({
        allowlist: ["127.0.0.0/8"]
      })
    });
    configureDefaultProviderTransport(transport);
    pool = createDatabasePool(databaseUrl!, 5);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);

    server = createServer((request, response) => {
      let requestBody = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        requestBody += chunk;
      });
      request.on("end", async () => {
        providerRequestBodies.push(JSON.parse(requestBody) as CompatibleProviderRequest);
        if (observedProgressKey) {
          const progress = await getWorldGenerationProgress(pool, ownerUserId, observedProgressKey);
          if (progress) providerProgressSnapshots.push(progress);
        }
        const reply = replies.shift();
        if (!reply) {
          response.writeHead(500, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: { message: "Unexpected provider call." } }));
          return;
        }
        const status = reply.status ?? 200;
        response.writeHead(status, {
          "Content-Type": "application/json",
          ...(reply.declaredLength ? { "Content-Length": String(reply.declaredLength) } : {})
        });
        response.end(status >= 400
          ? JSON.stringify({ error: { message: reply.error ?? "Provider failed." } })
          : providerEnvelope(reply.content ?? "", crypto.randomUUID()));
      });
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const provider = await createProvider(pool, {
      name: "Generated CYOA Integration Provider",
      providerType: "openai_compatible",
      providerRole: "text",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      defaultModel: "generated-cyoa-test-model",
      contextWindowTokens: 32768,
      maxOutputTokens: 4096,
      temperature: 0,
      enabled: true,
      isDefault: true,
      configuration: {}
    }, credentialSecret);
    providerId = provider.id;
    const blockedProvider = await createProvider(pool, {
      name: "Blocked Generated CYOA Integration Provider",
      providerType: "openai_compatible",
      providerRole: "text",
      baseUrl: "http://192.0.2.1/v1",
      defaultModel: "blocked-generated-cyoa-test-model",
      contextWindowTokens: 32768,
      maxOutputTokens: 4096,
      temperature: 0,
      enabled: true,
      configuration: {}
    }, credentialSecret);
    blockedProviderId = blockedProvider.id;
  });

  afterEach(() => {
    replies.length = 0;
    providerRequestBodies.length = 0;
    providerProgressSnapshots.length = 0;
    observedProgressKey = "";
    for (const key of progressKeys) activeProgressMap.delete(key);
    progressKeys.clear();
  });

  afterAll(async () => {
    if (server) await new Promise<void>((done) => server.close(() => done()));
    if (transport) await transport.close();
    if (pool) await pool.end();
  });

  function request(
    sourceName: string,
    options: { providerProfileId?: string; privateMarker?: string } = {}
  ) {
    const fixturePath = path.resolve(__dirname, "../fixtures/cyoa_writing_com_sample.json");
    let sourceText = fs.readFileSync(fixturePath, "utf8");
    if (options.privateMarker) {
      const source = JSON.parse(sourceText) as { info: { description: string } };
      source.info.description = `${options.privateMarker}: private lore`;
      sourceText = JSON.stringify(source);
    }
    const progressKey = `${sourceName}:${sourceText.length}`;
    progressKeys.add(progressKey);
    return {
      progressKey,
      value: {
        sourceName,
        sourceText,
        sourceKind: "cyoa_json" as const,
        selectedCharacterIndex: 0,
        enrichFinalTurn: false,
        providerProfileId: options.providerProfileId ?? providerId
      }
    };
  }

  async function persistenceCounts() {
    const result = await pool.query<{
      worlds: number;
      world_versions: number;
      world_drafts: number;
      imports: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM worlds WHERE owner_user_id = $1) AS worlds,
         (SELECT count(*)::int FROM world_versions WHERE owner_user_id = $1) AS world_versions,
         (SELECT count(*)::int FROM world_drafts WHERE owner_user_id = $1) AS world_drafts,
         (SELECT count(*)::int FROM imports WHERE owner_user_id = $1) AS imports`,
      [ownerUserId]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Expected persistence counts.");
    return row;
  }

  function expectCharacterGenerationRequests(expectedNames: string[]) {
    expect(providerRequestBodies).toHaveLength(expectedNames.length + 1);
    expect(replies).toHaveLength(0);
    expect(providerRequestBodies[0]?.messages?.[0]?.content).toContain("character_seeds");
    for (const [index, body] of providerRequestBodies.slice(1).entries()) {
      const userMessage = body.messages?.find((message) => message.role === "user");
      expect(userMessage?.content).toContain(expectedNames[index]);
    }
  }

  function expectSuccessfulCharacterGenerationRequests() {
    const expectedNames = ["Explorer 1", "Explorer 2", "Explorer 3"];
    expectCharacterGenerationRequests(expectedNames);

    for (const [index, body] of providerRequestBodies.slice(1).entries()) {
      expect(body.messages?.find((message) => message.role === "system")?.content)
        .toBe(PROMPT_TEMPLATE_CATALOG.world_character_generation.defaultContent);
      const userMessage = body.messages?.find((message) => message.role === "user");
      const input = JSON.parse(userMessage?.content ?? "") as GeneratedCharacterRequestInput;
      const characterIndex = index + 1;

      expect(input.world).toEqual({
        title: "The Sunken Citadel",
        genre: "Fantasy exploration",
        tone: "Mysterious and adventurous",
        backgroundStory: "An ancient citadel sank beneath the waves.",
        premise: "Three explorers descend to recover its lost archive.",
        firstAction: "Examine the glowing runes on the bronze archway.",
        storyRules: "Ancient enchantments distort sound and light underwater."
      });
      expect(input.seed).toEqual(characterSeed(characterIndex));
      expect(input.otherSeeds).toEqual(
        [1, 2, 3]
          .filter((candidate) => candidate !== characterIndex)
          .map((candidate) => {
            const { id, name, role } = characterSeed(candidate);
            return { id, name, role };
          })
      );
      expect(input.acceptedCharacterNames).toEqual(expectedNames.slice(0, index));
    }
  }

  function expectCharacterGenerationProgress(expectedPhases: Array<{ phase: string; message: string }>) {
    expect(providerProgressSnapshots).toHaveLength(expectedPhases.length + 1);
    expect(providerProgressSnapshots[0]).toMatchObject({
      status: "processing",
      phase: "generating_world"
    });
    for (const [index, expected] of expectedPhases.entries()) {
      expect(providerProgressSnapshots[index + 1]).toMatchObject({
        status: "processing",
        phase: expected.phase,
        message: expected.message
      });
    }
  }

  it("generates a manual preview with separate world and character calls without persisting records", async () => {
    const progressKey = `manual-preview-success-${crypto.randomUUID()}`;
    replies.push(
      { content: worldResponse(3) },
      { content: characterResponse(1) },
      { content: characterResponse(2) },
      { content: characterResponse(3) }
    );
    const before = await persistenceCounts();
    observedProgressKey = progressKey;

    const preview = await generateWorldPreview(pool, {
      title: "The Sunken Citadel",
      prompt: "Build a playable world from the submerged citadel premise.",
      progressKey
    }, credentialSecret);

    expect(preview.content.playableCharacters).toHaveLength(3);
    expect(preview.content.playableCharacters.every(
      (entry) => Boolean(entry.characterText.trim() && entry.profile)
    )).toBe(true);
    await expect(getWorldGenerationProgress(pool, ownerUserId, progressKey)).resolves.toMatchObject({
      status: "completed",
      phase: "completed",
      progressPercent: 100,
      message: "World and character generation completed."
    });
    expectSuccessfulCharacterGenerationRequests();
    expectCharacterGenerationProgress([
      { phase: "generating_character", message: "Generating character 1 of 3: Explorer 1…" },
      { phase: "generating_character", message: "Generating character 2 of 3: Explorer 2…" },
      { phase: "generating_character", message: "Generating character 3 of 3: Explorer 3…" }
    ]);
    expect(await persistenceCounts()).toEqual(before);
  });

  it("fails a character and its recovery safely without persisting records", async () => {
    const progressKey = `manual-preview-failure-${crypto.randomUUID()}`;
    const privateMarker = `PRIVATE_MANUAL_PREVIEW_${crypto.randomUUID()}`;
    replies.push(
      { content: worldResponse(3) },
      { content: characterResponse(1) },
      { content: characterResponse(2, false, privateMarker) },
      { content: characterResponse(2, false, privateMarker) }
    );
    const before = await persistenceCounts();
    observedProgressKey = progressKey;

    await expect(generateWorldPreview(pool, {
      title: "The Sunken Citadel",
      prompt: `Build a playable world without exposing ${privateMarker}.`,
      progressKey
    }, credentialSecret)).rejects.toMatchObject({
      statusCode: 502,
      expose: true,
      details: {
        code: "incomplete_generated_character",
        characterIndex: 1,
        seedName: "Explorer 2"
      }
    });

    const progress = await getWorldGenerationProgress(pool, ownerUserId, progressKey);
    expect(progress).toMatchObject({
      status: "failed",
      phase: "failed",
      progressPercent: 100
    });
    expect(progress?.message).toContain("The text provider did not return a complete character profile. Review the missing fields and try again.");
    expect(progress?.errorMessage).toBe(progress?.message);
    expect(JSON.stringify(progress)).not.toContain(privateMarker);
    expect(progress?.message.length).toBeLessThanOrEqual(500);
    expectCharacterGenerationRequests(["Explorer 1", "Explorer 2", "Explorer 2"]);
    expectCharacterGenerationProgress([
      { phase: "generating_character", message: "Generating character 1 of 3: Explorer 1…" },
      { phase: "generating_character", message: "Generating character 2 of 3: Explorer 2…" },
      { phase: "recovering_character", message: "Character 2 was incomplete. Requesting a complete replacement…" }
    ]);
    expect(await persistenceCounts()).toEqual(before);
  });

  it("does not persist a world or import when a character recovery remains incomplete", async () => {
    const sourceName = `incomplete-generated-cyoa-${crypto.randomUUID()}.json`;
    const generatedRequest = request(sourceName);
    replies.push(
      { content: worldResponse(3) },
      { content: characterResponse(1) },
      { content: characterResponse(2, false) },
      { content: characterResponse(2, false) }
    );
    const worldsBeforeResult = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM worlds WHERE owner_user_id = $1",
      [ownerUserId]
    );
    const worldsBefore = worldsBeforeResult.rows[0]?.count ?? 0;

    await expect(importInfiniteWorlds(
      pool,
      generatedRequest.value,
      credentialSecret
    )).rejects.toMatchObject({
      statusCode: 502,
      details: {
        code: "incomplete_generated_character",
        characterIndex: 1,
        seedName: "Explorer 2"
      }
    });

    const worldsAfter = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM worlds WHERE owner_user_id = $1",
      [ownerUserId]
    );
    const importsAfter = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM imports WHERE owner_user_id = $1 AND source_name = $2",
      [ownerUserId, sourceName]
    );
    expect(worldsAfter.rows[0]?.count).toBe(worldsBefore);
    expect(importsAfter.rows[0]?.count).toBe(0);
    expectCharacterGenerationRequests(["Explorer 1", "Explorer 2", "Explorer 2"]);
    expect(getImportProgress(generatedRequest.progressKey)).toMatchObject({
      status: "failed",
      phase: "failed"
    });
  });

  it("keeps malformed CYOA parser details out of logs and progress", async () => {
    const marker = `PRIVATE_CYOA_PARSE_${crypto.randomUUID()}`;
    const sourceName = `malformed-cyoa-${crypto.randomUUID()}.json`;
    const sourceText = `${marker}{`;
    const progressKey = `${sourceName}:${sourceText.length}`;
    progressKeys.add(progressKey);
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    let errorLogCalls: unknown[][] = [];
    let thrown: unknown;

    try {
      await importInfiniteWorlds(pool, {
        sourceName,
        sourceText,
        sourceKind: "cyoa_json",
        selectedCharacterIndex: 0,
        enrichFinalTurn: false,
        providerProfileId: providerId
      }, credentialSecret);
    } catch (error) {
      thrown = error;
    } finally {
      errorLogCalls = [...errorLog.mock.calls];
      errorLog.mockRestore();
    }

    expect(thrown).toMatchObject({
      statusCode: 400,
      expose: true,
      details: { code: "invalid_cyoa_json" }
    });
    expect(getImportProgress(progressKey)).toMatchObject({
      status: "failed",
      phase: "failed",
      message: "Invalid Choose Your Own Adventure JSON structure.",
      errorMessage: "Invalid Choose Your Own Adventure JSON structure."
    });
    expect(JSON.stringify({ progress: getImportProgress(progressKey), errorLogCalls })).not.toContain(marker);
  });

  it("persists exactly three complete profiles after separate character generation", async () => {
    const sourceName = `repaired-generated-cyoa-${crypto.randomUUID()}.json`;
    const generatedRequest = request(sourceName);
    replies.push(
      { content: worldResponse(3) },
      { content: characterResponse(1) },
      { content: characterResponse(2) },
      { content: characterResponse(3) }
    );

    const result = await importInfiniteWorlds(
      pool,
      generatedRequest.value,
      credentialSecret
    );

    const stored = await pool.query<{
      content: {
        playableCharacters: Array<{
          characterText: string;
          profile?: unknown;
        }>;
      };
    }>(
      "SELECT content FROM world_versions WHERE id = $1",
      [result.worldVersionId]
    );
    expect(stored.rows[0]?.content.playableCharacters).toHaveLength(3);
    expect(stored.rows[0]?.content.playableCharacters.every(
      (entry) => Boolean(entry.characterText.trim() && entry.profile)
    )).toBe(true);
    expect(getImportProgress(generatedRequest.progressKey)).toMatchObject({
      status: "completed",
      phase: "completed",
      worldId: result.worldId,
      worldVersionId: result.worldVersionId
    });
  });

  it("keeps provider response bodies out of failed import progress", async () => {
    const privateMarker = `PRIVATE_PROVIDER_BODY_${crypto.randomUUID()}`;
    const generatedRequest = request(`provider-failure-${crypto.randomUUID()}.json`);
    replies.push({ status: 500, error: privateMarker });

    await expect(importInfiniteWorlds(
      pool,
      generatedRequest.value,
      credentialSecret
    )).rejects.toMatchObject({ statusCode: 500 });

    const progress = getImportProgress(generatedRequest.progressKey);
    expect(progress).toMatchObject({
      status: "failed",
      phase: "failed",
      message: "The text provider request failed with HTTP 500. Check the provider endpoint and server logs.",
      errorMessage: "The text provider request failed with HTTP 500. Check the provider endpoint and server logs."
    });
    expect(JSON.stringify(progress)).not.toContain(privateMarker);
  });

  it.each([
    {
      label: "destination policy",
      prepare: (marker: string) => ({
        providerProfileId: blockedProviderId,
        expectedStatus: 422,
        expectedCode: "PROVIDER_DESTINATION_NOT_ALLOWED",
        expectedMessage: "The provider destination is not allowed by the server network policy."
      })
    },
    {
      label: "response size",
      prepare: (marker: string) => {
        replies.push({
          content: marker,
          declaredLength: MAX_PROVIDER_JSON_RESPONSE_BYTES + 1
        });
        return {
          providerProfileId: providerId,
          expectedStatus: 502,
          expectedCode: "provider_response_too_large",
          expectedMessage: "The provider response exceeded the server's safe size limit."
        };
      }
    }
  ])("keeps CYOA $label failures typed and private in logs and progress", async ({ prepare }) => {
    const marker = `SECRET_AT_START_OF_CYOA_TYPED_FAILURE_${crypto.randomUUID()}`;
    const expected = prepare(marker);
    const generatedRequest = request(`typed-provider-failure-${crypto.randomUUID()}.json`, {
      providerProfileId: expected.providerProfileId,
      privateMarker: marker
    });
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    let errorLogCalls: unknown[][] = [];
    let thrown: unknown;

    try {
      await importInfiniteWorlds(pool, generatedRequest.value, credentialSecret);
    } catch (error) {
      thrown = error;
    } finally {
      errorLogCalls = [...errorLog.mock.calls];
      errorLog.mockRestore();
    }

    expect(thrown).toMatchObject({
      statusCode: expected.expectedStatus,
      code: expected.expectedCode,
      permanent: true,
      retryable: false
    });
    expect(getImportProgress(generatedRequest.progressKey)).toMatchObject({
      status: "failed",
      phase: "failed",
      message: expected.expectedMessage,
      errorMessage: expected.expectedMessage
    });
    expect(errorLogCalls.at(-1)?.[0]).toMatchObject({
      statusCode: expected.expectedStatus,
      code: expected.expectedCode
    });
    expect(JSON.stringify({ thrown, progress: getImportProgress(generatedRequest.progressKey), errorLogCalls }))
      .not.toContain(marker);
    expect(JSON.stringify({ thrown, progress: getImportProgress(generatedRequest.progressKey), errorLogCalls }))
      .not.toContain(credentialSecret);
  });
});
