import { createServer, type Server } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabasePool,
  initialOwnerId,
  type DatabasePool
} from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createProviderNetworkPolicy } from "../../packages/security/src/provider-network-policy.js";
import {
  configureDefaultProviderTransport,
  createProviderTransport,
  type ProviderTransport
} from "../../packages/story-engine/src/provider-transport.js";
import { createProvider } from "../../services/api/src/provider-service.js";
import {
  activeProgressMap,
  getImportProgress,
  importInfiniteWorlds
} from "../../services/api/src/infinite-worlds-import-service.js";
import { generateWorldPreview } from "../../services/api/src/world-generator-service.js";
import { getWorldGenerationProgress } from "../../services/api/src/world-generation-progress-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const credentialSecret = "world-generation-integration-secret";

type MockProviderReply = {
  status?: number;
  content?: string;
  error?: string;
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

function character(name: string, includeProfile: boolean, privateMarker = "") {
  return {
    id: `provider-${name.toLocaleLowerCase().replaceAll(" ", "-")}`,
    name,
    character_text: `${name} is prepared to explore the submerged citadel.${privateMarker}`,
    ...(includeProfile ? { profile: profile(name) } : {}),
    rpg_statistics: [],
    default_triggers: []
  };
}

function worldResponse(includeProfiles: boolean, privateMarker = ""): string {
  return JSON.stringify({
    title: "The Sunken Citadel",
    genre: "Fantasy exploration",
    tone: "Mysterious and adventurous",
    backgroundStory: "An ancient citadel sank beneath the waves.",
    premise: "Three explorers descend to recover its lost archive.",
    firstAction: "Examine the glowing runes on the bronze archway.",
    story_rules: "Ancient enchantments distort sound and light underwater.",
    playable_characters: [
      character("Elara the Diver", includeProfiles, privateMarker),
      character("Thalor the Scholar", includeProfiles, privateMarker),
      character("Kael the Guard", includeProfiles, privateMarker)
    ],
    rpg_statistics: [],
    default_triggers: [],
    event_triggers: []
  });
}

function supplementResponse(includeProfiles: boolean, privateMarker = ""): string {
  return JSON.stringify({
    playable_characters: [
      character("Elara the Diver", includeProfiles, privateMarker),
      character("Thalor the Scholar", includeProfiles, privateMarker),
      character("Kael the Guard", includeProfiles, privateMarker)
    ]
  });
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
  let ownerUserId = "";
  const replies: MockProviderReply[] = [];
  const progressKeys = new Set<string>();

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
      request.resume();
      request.on("end", () => {
        const reply = replies.shift();
        if (!reply) {
          response.writeHead(500, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: { message: "Unexpected provider call." } }));
          return;
        }
        const status = reply.status ?? 200;
        response.writeHead(status, { "Content-Type": "application/json" });
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
      configuration: {}
    }, credentialSecret);
    providerId = provider.id;
  });

  afterEach(() => {
    replies.length = 0;
    for (const key of progressKeys) activeProgressMap.delete(key);
    progressKeys.clear();
  });

  afterAll(async () => {
    if (server) await new Promise<void>((done) => server.close(() => done()));
    if (transport) await transport.close();
    if (pool) await pool.end();
  });

  function request(sourceName: string) {
    const fixturePath = path.resolve(__dirname, "../fixtures/cyoa_writing_com_sample.json");
    const sourceText = fs.readFileSync(fixturePath, "utf8");
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
        providerProfileId: providerId
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

  it("repairs a manual preview without persisting world or import records", async () => {
    const progressKey = `manual-preview-success-${crypto.randomUUID()}`;
    replies.push(
      { content: worldResponse(false) },
      { content: supplementResponse(true) }
    );
    const before = await persistenceCounts();

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
    expect(await persistenceCounts()).toEqual(before);
  });

  it("fails an incomplete manual preview safely without persisting records", async () => {
    const progressKey = `manual-preview-failure-${crypto.randomUUID()}`;
    const privateMarker = `PRIVATE_MANUAL_PREVIEW_${crypto.randomUUID()}`;
    replies.push(
      { content: worldResponse(false, privateMarker) },
      { content: supplementResponse(false, privateMarker) }
    );
    const before = await persistenceCounts();

    await expect(generateWorldPreview(pool, {
      title: "The Sunken Citadel",
      prompt: `Build a playable world without exposing ${privateMarker}.`,
      progressKey
    }, credentialSecret)).rejects.toMatchObject({
      statusCode: 502,
      expose: true,
      details: { code: "incomplete_generated_world" }
    });

    const progress = await getWorldGenerationProgress(pool, ownerUserId, progressKey);
    expect(progress).toMatchObject({
      status: "failed",
      phase: "failed",
      progressPercent: 100
    });
    expect(progress?.message).toContain(
      "The text provider did not return a complete world. Review the missing fields and try again."
    );
    expect(progress?.message).toContain(
      "playable_characters.0.profile: Generated structured character profile is required."
    );
    expect(progress?.errorMessage).toBe(progress?.message);
    expect(JSON.stringify(progress)).not.toContain(privateMarker);
    expect(progress?.message.length).toBeLessThanOrEqual(500);
    expect(await persistenceCounts()).toEqual(before);
  });

  it("does not persist a world or import when supplementation remains incomplete", async () => {
    const sourceName = `incomplete-generated-cyoa-${crypto.randomUUID()}.json`;
    const generatedRequest = request(sourceName);
    replies.push(
      { content: worldResponse(false) },
      { content: supplementResponse(false) }
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
      details: { code: "incomplete_generated_world" }
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
    expect(getImportProgress(generatedRequest.progressKey)).toMatchObject({
      status: "failed",
      phase: "failed"
    });
  });

  it("persists exactly three complete profiles after one successful supplement", async () => {
    const sourceName = `repaired-generated-cyoa-${crypto.randomUUID()}.json`;
    const generatedRequest = request(sourceName);
    replies.push(
      { content: worldResponse(false) },
      { content: supplementResponse(true) }
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
});
