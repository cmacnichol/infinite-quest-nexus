import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIllustrationApplication } from "../../packages/application/src/index.js";
import {
  DEFAULT_ILLUSTRATION_REFINEMENT_PROMPT,
  illustrationConfigSchema
} from "../../packages/contracts/src/generation.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { createPostgresIllustrationRepositories } from "../../packages/database/src/illustration-repository.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import {
  createIllustrationRepositoryFactories
} from "../../services/runtime/src/illustration-repository-bindings.js";
import { importLegacyStory } from "../helpers/memory-aware-services.js";
import { insertImageJob } from "../../services/runtime/src/illustration-image-job-adapter.js";
import { apiProviderGraph, createProvider } from "../helpers/provider-application-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const credentialSecret = "illustration-repository-secret";

integration("PostgreSQL illustration repository", () => {
  let pool: DatabasePool;
  let ownerUserId = "";
  let imageProviderId = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    imageProviderId = (await createProvider(pool, {
      name: `Illustration repository ${crypto.randomUUID()}`,
      providerType: "openai_compatible",
      providerRole: "image",
      baseUrl: "http://127.0.0.1:9911",
      defaultModel: "repository-image-model",
      contextWindowTokens: 32768,
      maxOutputTokens: 4096,
      temperature: 0,
      enabled: true,
      configuration: {}
    }, credentialSecret)).id;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function campaign() {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Illustration repository ${crypto.randomUUID()}`;
    return importLegacyStory(pool, storyImportRequestSchema.parse({
      sourceName: "illustration-repository.story",
      story: fixture
    }));
  }

  function application() {
    return createIllustrationApplication(
      createPostgresIllustrationRepositories(
        pool,
        createIllustrationRepositoryFactories(apiProviderGraph(pool, credentialSecret).illustration),
      )
    );
  }

  it("keeps config reads and writes owner-scoped through the concrete repository", async () => {
    const imported = await campaign();
    const illustrations = application();
    const scope = { ownerUserId, campaignId: imported.campaignId };

    await expect(illustrations.getIllustrationConfig(scope)).resolves.toMatchObject({
      enabled: false,
      sourcePolicy: "off",
      providerProfileId: null
    });
    const refinementPrompt = "Return one concise fiction-only observatory prompt.";
    await expect(illustrations.setIllustrationConfig(scope, illustrationConfigSchema.parse({
      enabled: true,
      sourcePolicy: "generate_only",
      providerProfileId: imageProviderId,
      model: "repository-image-model",
      refinementPrompt
    }))).resolves.toMatchObject({ enabled: true, sourcePolicy: "generate_only", refinementPrompt });
    await expect(illustrations.loadStreamingIllustrationConfig(scope)).resolves.toMatchObject({
      refinementPrompt,
      defaultRefinementPrompt: DEFAULT_ILLUSTRATION_REFINEMENT_PROMPT,
      campaignImageProviderProfileId: null,
      campaignTextProviderProfileId: null
    });

    await expect(illustrations.getIllustrationConfig({
      ownerUserId: crypto.randomUUID(),
      campaignId: imported.campaignId
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("retries a durable image job without permitting another owner to read or mutate it", async () => {
    const imported = await campaign();
    const turn = await pool.query<{ id: string }>(
      "SELECT id FROM turns WHERE campaign_id = $1 AND owner_user_id = $2 ORDER BY turn_number DESC LIMIT 1",
      [imported.campaignId, ownerUserId]
    );
    const job = await insertImageJob(pool, {
      ownerUserId,
      campaignId: imported.campaignId,
      turnId: turn.rows[0]!.id,
      prompt: "A moonlit observatory beneath a violet sky.",
      config: {
        enabled: true,
        sourcePolicy: "generate_only",
        matchingScope: "world",
        confidenceProfile: "balanced",
        repetitionWindow: 5,
        providerProfileId: imageProviderId,
        model: "repository-image-model",
        size: "1024x1024",
        aspectRatio: "1:1",
        quality: "auto",
        outputFormat: "png",
        maxAttempts: 3,
        segmentWordCount: 500,
        imagesPerSegment: 1,
        segmentPromptMode: "direct",
        refinementPrompt: "Fiction only.",
        defaultRefinementPrompt: "Fiction only.",
        updatedAt: null
      }
    });
    expect(job).not.toBeNull();
    await pool.query("UPDATE image_jobs SET status = 'failed' WHERE id = $1", [job!.id]);
    const illustrations = application();
    const wrongOwner = crypto.randomUUID();

    await expect(illustrations.getImageJob({ ownerUserId: wrongOwner, jobId: job!.id }))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(illustrations.retryImageJob({ ownerUserId, jobId: job!.id })).resolves.toMatchObject({
      id: job!.id,
      status: "queued",
      attempts: 0,
      generationRevision: 1
    });
    await expect(illustrations.retryImageJob({ ownerUserId: wrongOwner, jobId: job!.id }))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(pool.query(
      "SELECT status, generation_revision FROM image_jobs WHERE id = $1 AND owner_user_id = $2",
      [job!.id, ownerUserId]
    )).resolves.toMatchObject({ rows: [{ status: "queued", generation_revision: 1 }] });
  });
});
