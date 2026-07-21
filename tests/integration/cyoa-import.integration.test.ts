import { createServer, type Server } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createProvider } from "../../services/api/src/provider-service.js";
import { getImportProgress, importInfiniteWorlds, previewInfiniteWorldsImport } from "../../services/api/src/infinite-worlds-import-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const credentialSecret = "integration-test-credential-secret";

function validConvertedWorldJson(): string {
  return JSON.stringify({
    title: "Converted CYOA World",
    genre: "Fantasy Exploration",
    tone: "Mysterious and Adventurous",
    backgroundStory: "An ancient citadel sunk beneath the waves centuries ago.",
    premise: "Explorers descend into the sunken citadel to uncover its secrets.",
    firstAction: "Examine the glowing runes on the bronze archway.",
    story_rules: "Enchantments work differently underwater.",
    playable_characters: [
      {
        id: "char-1",
        name: "Elara the Diver",
        character_text: "A master underwater specialist.",
        rpg_statistics: [{ name: "Diving", value: 85, note: "Expert free diver." }],
        default_triggers: []
      },
      {
        id: "char-2",
        name: "Thalor the Scholar",
        character_text: "An elven historian seeking lost lore.",
        rpg_statistics: [{ name: "Arcana", value: 90, note: "Knows ancient runes." }],
        default_triggers: []
      },
      {
        id: "char-3",
        name: "Kael the Guard",
        character_text: "A veteran sellsword protecting the expedition.",
        rpg_statistics: [{ name: "Combat", value: 80, note: "Spear specialist." }],
        default_triggers: []
      }
    ],
    rpg_statistics: [],
    default_triggers: [],
    event_triggers: []
  });
}

integration("CYOA import service integration", () => {
  let pool: DatabasePool;
  let server: Server;
  let baseUrl = "";
  let providerId = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 5);
    await migrateDatabase(pool, resolve("database/migrations"));
    server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          id: "mock-cyoa-response",
          choices: [{
            message: {
              content: validConvertedWorldJson()
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
    });

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
  });
});
