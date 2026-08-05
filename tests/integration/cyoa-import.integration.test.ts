import { createServer, type Server } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createProvider } from "../../services/api/src/provider-service.js";
import { getImportProgress, previewInfiniteWorldsImport } from "../../services/api/src/infinite-worlds-import-service.js";
import { importInfiniteWorlds, portableWorldApplicationForTest } from "../helpers/memory-aware-services.js";
import { installIntegrationProviderTransport } from "./provider-transport-test-helper.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const credentialSecret = "integration-test-credential-secret";

function validProfile(role: string) {
  return {
    story: {
      role,
      background: `${role} trained for dangerous underwater expeditions.`,
      personality: "Focused and dependable.",
      motivations: "Protect the expedition and recover the lost archive.",
      goals: "Return from the citadel with its history intact.",
      fearsAndConflicts: "Fears that the ruins will claim another expedition.",
      keyRelationships: "Trusts the other members of the expedition.",
      narrativeHooks: "Carries a clue left by an earlier explorer.",
      voiceAndMannerisms: "Speaks with deliberate precision.",
      otherGuidance: ""
    }
  };
}

function characterSeed(index: number) {
  const characters = [
    ["Elara the Diver", "Diver", "A master underwater specialist."],
    ["Thalor the Scholar", "Scholar", "An elven historian seeking lost lore."],
    ["Kael the Guard", "Guard", "A veteran sellsword protecting the expedition."]
  ] as const;
  const [name, role, concept] = characters[index - 1]!;
  return {
    id: `seed-${index}`,
    name,
    role,
    concept,
    narrative_hook: `${name} carries a clue needed by the expedition.`
  };
}

function validWorldDraftJson(): string {
  return JSON.stringify({
    title: "Converted CYOA World",
    genre: "Fantasy Exploration",
    tone: "Mysterious and Adventurous",
    backgroundStory: "An ancient citadel sunk beneath the waves centuries ago.",
    premise: "Explorers descend into the sunken citadel to uncover its secrets.",
    firstAction: "Examine the glowing runes on the bronze archway.",
    story_rules: "Enchantments work differently underwater.",
    character_seeds: [characterSeed(1), characterSeed(2), characterSeed(3)],
    rpg_statistics: [],
    default_triggers: [],
    event_triggers: []
  });
}

function validCharacterJson(index: number): string {
  const seed = characterSeed(index);
  return JSON.stringify({
    id: seed.id,
    name: seed.name,
    character_text: seed.concept,
    profile: validProfile(seed.role),
    rpg_statistics: [],
    default_triggers: []
  });
}

integration("CYOA import service integration", () => {
  let pool: DatabasePool;
  let server: Server;
  let providerTransport: ReturnType<typeof installIntegrationProviderTransport>;
  let baseUrl = "";
  let providerId = "";
  const providerReplies: string[] = [];
  const providerRequests: unknown[] = [];

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 5);
    await migrateDatabase(pool, resolve("database/migrations"));
    providerTransport = installIntegrationProviderTransport();
    server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        providerRequests.push(JSON.parse(body));
        const content = providerReplies.shift();
        if (!content) {
          response.writeHead(500, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: "Unexpected mock provider request." }));
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          id: "mock-cyoa-response",
          choices: [{
            message: {
              content
            },
            finish_reason: "stop"
          }]
        }));
      });
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}/v1`;

    const created = await createProvider(pool, {
      name: "Mock CYOA Provider",
      providerType: "openai_compatible",
      providerRole: "text",
      baseUrl,
      defaultModel: "mock-model",
      contextWindowTokens: 32768,
      maxOutputTokens: 4096,
      temperature: 0,
      enabled: true,
      configuration: {}
    }, credentialSecret);
    providerId = created.id;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((done) => server.close(() => done()));
    if (providerTransport) await providerTransport.close();
    if (pool) await pool.end();
  });

  it("previews a CYOA export JSON without calling the text provider", async () => {
    const fixturePath = path.resolve(__dirname, "../fixtures/cyoa_writing_com_sample.json");
    const sourceText = fs.readFileSync(fixturePath, "utf8");

    const preview = await previewInfiniteWorldsImport(pool, {
      sourceName: "cyoa_writing_com_sample.json",
      sourceText,
      sourceKind: "auto",
      selectedCharacterIndex: 0,
      enrichFinalTurn: false,
      providerProfileId: providerId
    }, portableWorldApplicationForTest(pool, credentialSecret));

    expect(preview.kind).toBe("cyoa_json");
    if (preview.kind !== "cyoa_json") throw new Error(`Expected CYOA preview, received ${preview.kind}.`);
    expect(preview.valid).toBe(true);
    expect(preview.requiresProvider).toBe(true);
    expect(preview.counts.topLevelTitle).toBe("The Mystery of the Sunken Citadel");
    expect(preview.counts.layer1ChaptersCount).toBe(3);
    expect(preview.counts.characterTarget).toBe("3-4 playable characters");
  });

  it("imports a CYOA export JSON, tracks progress, and creates a Story World with 3 playable characters", async () => {
    const fixturePath = path.resolve(__dirname, "../fixtures/cyoa_writing_com_sample.json");
    const sourceText = fs.readFileSync(fixturePath, "utf8");
    providerRequests.length = 0;
    providerReplies.push(
      validWorldDraftJson(),
      validCharacterJson(1),
      validCharacterJson(2),
      validCharacterJson(3)
    );

    const importPromise = importInfiniteWorlds(pool, {
      sourceName: "cyoa_writing_com_sample.json",
      sourceText,
      sourceKind: "cyoa_json",
      selectedCharacterIndex: 0,
      enrichFinalTurn: false,
      providerProfileId: providerId
    }, credentialSecret);

    const result = await importPromise;
    expect(result.kind).toBe("world");
    expect(result.worldId).toBeTypeOf("string");

    const progressKey = "cyoa_writing_com_sample.json:" + sourceText.length;
    const progress = getImportProgress(progressKey);
    expect(progress).not.toBeNull();
    expect(progress?.status).toBe("completed");
    expect(progress?.progressPercent).toBe(100);
    expect(progress?.worldId).toBe(result.worldId);

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
      (character) => Boolean(character.characterText.trim() && character.profile)
    )).toBe(true);
    expect(providerRequests).toHaveLength(4);
  });
});
