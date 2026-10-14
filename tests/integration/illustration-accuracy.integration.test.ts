import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IllustrationPromptRefinementPort, IllustrationWorkerPorts } from "../../packages/application/src/index.js";
import { createIllustrationApplication } from "../../packages/application/src/index.js";
import { illustrationConfigSchema } from "../../packages/contracts/src/generation.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { createPostgresIllustrationAssetPublicationRepository } from "../../packages/database/src/illustration-asset-publication-repository.js";
import { createPostgresIllustrationRepositories } from "../../packages/database/src/illustration-repository.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { segmentIllustrationText } from "../../packages/domain/src/illustrations.js";
import { sha256 } from "../../packages/domain/src/text.js";
import { createIllustrationRepositoryFactories } from "../../services/runtime/src/illustration-repository-bindings.js";
import { createIllustrationWorkerPorts } from "../../services/runtime/src/illustration-composition.js";
import { runImageJob } from "../../services/runtime/src/illustration-image-job-adapter.js";
import { runIllustrationResolutionJob } from "../../services/runtime/src/illustration-resolution-job-adapter.js";
import {
  generateTurnIllustrationSegments,
  loadConfig,
  promoteProvisionalSet,
  runIllustrationPromptJob
} from "../../services/runtime/src/illustration-segment-job-adapter.js";
import { importLegacyStory } from "../helpers/memory-aware-services.js";
import { apiProviderGraph, createProvider } from "../helpers/provider-application-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const credentialSecret = "illustration-accuracy-secret";

integration("illustration accuracy", () => {
  let pool: DatabasePool;
  let ownerUserId = "";
  let imageProviderId = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    imageProviderId = (await createProvider(pool, {
      name: `Illustration accuracy ${crypto.randomUUID()}`,
      providerType: "openai_compatible",
      providerRole: "image",
      baseUrl: "http://127.0.0.1:9912",
      defaultModel: "accuracy-image-model",
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

  function providers() {
    return apiProviderGraph(pool, credentialSecret).illustration;
  }

  function application() {
    return createIllustrationApplication(
      createPostgresIllustrationRepositories(pool, createIllustrationRepositoryFactories(providers()))
    );
  }

  async function campaign(config: Record<string, unknown> = {}) {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Lantern Coast ${crypto.randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({
      sourceName: "illustration-accuracy.story",
      story: fixture
    }));
    await application().setIllustrationConfig({ ownerUserId, campaignId: imported.campaignId }, illustrationConfigSchema.parse({
      enabled: true,
      sourcePolicy: "generate_only",
      providerProfileId: imageProviderId,
      model: "accuracy-image-model",
      segmentWordCount: 100,
      ...config
    }));
    return imported;
  }

  /** A generation that is still streaming turn 3: its children have no accepted turn yet. */
  async function streamingGeneration(campaignId: string) {
    return (await pool.query<{ id: string }>(
      `INSERT INTO generation_jobs(owner_user_id,campaign_id,provider_profile_id,idempotency_key,expected_turn_number,action,status,requested_model)
       VALUES ($1,$2,$3,$4,3,'Cross the bridge','generating','fixture') RETURNING id`,
      [ownerUserId, campaignId, imageProviderId, crypto.randomUUID()]
    )).rows[0]!;
  }

  async function provisionalSegments(campaignId: string, generationJobId: string, texts: string[]) {
    const set = (await pool.query<{ id: string }>(
      `INSERT INTO turn_illustration_sets(owner_user_id,campaign_id,generation_job_id,source_text_hash,segment_word_count,images_per_segment,prompt_mode,status)
       VALUES ($1,$2,$3,$4,100,1,'ai_refined','provisional') RETURNING id`,
      [ownerUserId, campaignId, generationJobId, sha256("provisional")]
    )).rows[0]!;
    const ids: string[] = [];
    let offset = 0;
    for (const [ordinal, text] of texts.entries()) {
      const segment = (await pool.query<{ id: string }>(
        `INSERT INTO turn_illustration_segments(owner_user_id,campaign_id,generation_job_id,illustration_set_id,ordinal,start_offset,end_offset,start_word,end_word,source_text,source_text_hash,direct_prompt,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,0,1,$8,$9,$8,'refining') RETURNING id`,
        [ownerUserId, campaignId, generationJobId, set.id, ordinal, offset, offset + text.length, text, sha256(text)]
      )).rows[0]!;
      offset += text.length;
      ids.push(segment.id);
    }
    return { setId: set.id, segmentIds: ids };
  }

  async function queuePromptJob(campaignId: string, generationJobId: string, segmentId: string) {
    await pool.query(
      `INSERT INTO illustration_prompt_jobs(owner_user_id,campaign_id,generation_job_id,segment_id,provider_profile_id,requested_model,prompt_snapshot)
       VALUES ($1,$2,$3,$4,$5,'fixture-text',$6)`,
      [ownerUserId, campaignId, generationJobId, segmentId, imageProviderId,
        JSON.stringify({ illustration_refinement: { content: "Refine the excerpt.", hash: "fixture", source: "shipped" } })]
    );
  }

  function capturingRefinement() {
    const requests: Parameters<IllustrationPromptRefinementPort["refinePrompt"]>[0][] = [];
    const port: IllustrationPromptRefinementPort = {
      async refinePrompt(request) {
        requests.push(request);
        return { providerRole: "text", providerProfileId: request.providerProfileId, model: request.model, prompt: "A lantern bridge at dusk", metadata: {} };
      }
    };
    return { port, requests };
  }

  const noCosts = { recordIllustrationCost: async () => null };

  it("gives a streamed segment's refinement the world, previous turn, and earlier segment context", async () => {
    const imported = await campaign({ segmentPromptMode: "ai_refined", artStyle: "Ink wash on rice paper" });
    const generation = await streamingGeneration(imported.campaignId);
    const { segmentIds } = await provisionalSegments(imported.campaignId, generation.id, [
      "Mira steps onto the rope bridge above the black river. ",
      "She raises the brass lantern and the fog parts around her."
    ]);
    await queuePromptJob(imported.campaignId, generation.id, segmentIds[1]!);
    const refinement = capturingRefinement();

    await expect(runIllustrationPromptJob(pool, "accuracy-worker", 30, refinement.port, noCosts, providers())).resolves.toBe(true);

    expect(refinement.requests).toHaveLength(1);
    const context = refinement.requests[0]!.storyContext;
    expect(context).toContain("World: Lantern Coast");
    expect(context).toContain("Object Gamma remains at Location Beta.");
    expect(context).toContain("Earlier in this turn: Mira steps onto the rope bridge above the black river.");
    expect(context).toContain("Art style (fixed for every illustration): Ink wash on rice paper");
    expect(context).not.toContain("d100");
  });

  const acceptedNarration = [
    "The ferry groaned against the pilings while Mira counted the lanterns along the quay. Fog rolled in from the estuary and swallowed the far bank, leaving only the bells to mark the channel.",
    "A gull screamed overhead as the harbor master unrolled a soaked chart across a barrel lid. He traced the drowned road with a crooked finger and warned her that the tide would turn before midnight.",
    "Mira folded the chart into her coat, paid the ferryman in tarnished silver, and stepped onto the swaying deck as the ropes slipped free. Behind her the quay lights shrank into the mist one by one."
  ].join("\n\n");

  /** Turn 2 stands in for the turn this generation is committing. */
  async function committingGeneration(campaignId: string) {
    const turn = (await pool.query<{ id: string }>(
      "UPDATE turns SET narration=$2 WHERE campaign_id=$1 AND turn_number=2 RETURNING id",
      [campaignId, acceptedNarration]
    )).rows[0]!;
    const generation = (await pool.query<{ id: string }>(
      `INSERT INTO generation_jobs(owner_user_id,campaign_id,provider_profile_id,idempotency_key,expected_turn_number,action,status,requested_model)
       VALUES ($1,$2,$3,$4,2,'Board the ferry','committing','fixture') RETURNING id`,
      [ownerUserId, campaignId, imageProviderId, crypto.randomUUID()]
    )).rows[0]!;
    return { turnId: turn.id, generationJobId: generation.id };
  }

  async function streamedImageJob(campaignId: string, generationJobId: string, segmentId: string) {
    return (await pool.query<{ id: string }>(
      `INSERT INTO image_jobs(owner_user_id,campaign_id,generation_job_id,segment_id,target_type,provider_profile_id,requested_model,prompt,prompt_hash,status,provider_type)
       VALUES($1,$2,$3,$4,'streaming_illustration',$5,'accuracy-image-model','A rejected scene','fixture','queued','openai_compatible') RETURNING id`,
      [ownerUserId, campaignId, generationJobId, segmentId, imageProviderId]
    )).rows[0]!;
  }

  it("replaces streamed segments whose text was rewritten before the turn was accepted", async () => {
    const imported = await campaign();
    const { turnId, generationJobId } = await committingGeneration(imported.campaignId);
    const rejected = "The ferry burned at the quay while Mira fled through the market, scattering crates of oranges as the watch gave chase through the rain.";
    const { setId, segmentIds } = await provisionalSegments(imported.campaignId, generationJobId, [rejected]);
    const rejectedImage = await streamedImageJob(imported.campaignId, generationJobId, segmentIds[0]!);
    const config = await loadConfig(pool, ownerUserId, imported.campaignId);

    await promoteProvisionalSet(pool, ownerUserId, generationJobId, turnId, imported.campaignId, acceptedNarration, config, providers());

    expect((await pool.query("SELECT is_active,status FROM turn_illustration_sets WHERE id=$1", [setId])).rows)
      .toEqual([{ is_active: false, status: "superseded" }]);
    expect((await pool.query("SELECT status FROM image_jobs WHERE id=$1", [rejectedImage.id])).rows)
      .toEqual([{ status: "cancelled" }]);
    const active = await pool.query<{ source_text: string; start_offset: number; end_offset: number }>(
      `SELECT segments.source_text, segments.start_offset, segments.end_offset
         FROM turn_illustration_sets sets
         JOIN turn_illustration_segments segments ON segments.illustration_set_id = sets.id
        WHERE sets.turn_id=$1 AND sets.is_active ORDER BY segments.ordinal`,
      [turnId]
    );
    expect(active.rows.length).toBeGreaterThan(0);
    for (const segment of active.rows) {
      expect(acceptedNarration.slice(segment.start_offset, segment.end_offset)).toBe(segment.source_text);
    }
    expect(active.rows.some((segment) => segment.source_text.includes("oranges"))).toBe(false);
    await expect(application().retryImageJob({ ownerUserId, jobId: rejectedImage.id }))
      .rejects.toMatchObject({ statusCode: 409 });
    expect((await pool.query("SELECT status FROM image_jobs WHERE id=$1", [rejectedImage.id])).rows)
      .toEqual([{ status: "cancelled" }]);
  });

  it("keeps streamed segments whose text matches the accepted narration", async () => {
    const imported = await campaign();
    const { turnId, generationJobId } = await committingGeneration(imported.campaignId);
    const config = await loadConfig(pool, ownerUserId, imported.campaignId);
    const first = segmentIllustrationText(acceptedNarration, config.segment_word_count)[0]!;
    const { setId, segmentIds } = await provisionalSegments(imported.campaignId, generationJobId, [first.text]);
    const streamedImage = await streamedImageJob(imported.campaignId, generationJobId, segmentIds[0]!);

    await promoteProvisionalSet(pool, ownerUserId, generationJobId, turnId, imported.campaignId, acceptedNarration, config, providers());

    expect((await pool.query("SELECT is_active,turn_id FROM turn_illustration_sets WHERE id=$1", [setId])).rows)
      .toEqual([{ is_active: true, turn_id: turnId }]);
    expect((await pool.query("SELECT status,turn_id FROM image_jobs WHERE id=$1", [streamedImage.id])).rows)
      .toEqual([{ status: "queued", turn_id: turnId }]);
  });

  async function libraryAsset(campaignId: string, turnId: string | null, text: string) {
    const asset = (await pool.query<{ id: string }>(
      `INSERT INTO assets(owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length)
       VALUES ($1,$2,'filesystem','synthetic/accuracy.png','image/png',20) RETURNING id`,
      [ownerUserId, crypto.randomUUID().replaceAll("-", "").padEnd(64, "0")]
    )).rows[0]!;
    await pool.query(
      `UPDATE asset_library_entries SET title='Ferry quay', caption=$3, review_status='eligible', reuse_scope='owner_library',
              automatic_reuse_enabled=true WHERE asset_id=$1 AND owner_user_id=$2`,
      [asset.id, ownerUserId, text]
    );
    await pool.query(
      `INSERT INTO asset_generation_contexts(owner_user_id,asset_id,created_by_user_id,campaign_id,turn_id,target_type,fiction_prompt)
       VALUES ($1,$2,$1,$3,$4,'turn_illustration',$5)`,
      [ownerUserId, asset.id, campaignId, turnId, text]
    );
    return asset.id;
  }

  async function queueResolution(campaignId: string, segmentId: string, imagePrompt: string) {
    return (await pool.query<{ id: string }>(
      `INSERT INTO illustration_resolution_jobs(owner_user_id,campaign_id,segment_id,source_policy,matching_scope,confidence_profile,repetition_window,query_context_snapshot)
       VALUES ($1,$2,$3,'library_only','owner_library','broad',5,$4) RETURNING id`,
      [ownerUserId, campaignId, segmentId, JSON.stringify({ imagePrompt, segmentId })]
    )).rows[0]!;
  }

  it("counts streamed library matches toward the repetition window", async () => {
    const imported = await campaign({ sourcePolicy: "library_only", matchingScope: "owner_library", confidenceProfile: "broad" });
    const { turnId, generationJobId } = await committingGeneration(imported.campaignId);
    const config = await loadConfig(pool, ownerUserId, imported.campaignId);
    const first = segmentIllustrationText(acceptedNarration, config.segment_word_count)[0]!;
    const assetId = await libraryAsset(imported.campaignId, null, first.text);
    const { segmentIds } = await provisionalSegments(imported.campaignId, generationJobId, [first.text]);
    const resolution = await queueResolution(imported.campaignId, segmentIds[0]!, first.text);

    await expect(runIllustrationResolutionJob(pool, "accuracy-library", 60, providers())).resolves.toBe(true);
    expect((await pool.query("SELECT selected_asset_id FROM illustration_resolution_jobs WHERE id=$1", [resolution.id])).rows)
      .toEqual([{ selected_asset_id: assetId }]);
    await promoteProvisionalSet(pool, ownerUserId, generationJobId, turnId, imported.campaignId, acceptedNarration, config, providers());

    expect((await pool.query("SELECT turn_id FROM illustration_resolution_jobs WHERE id=$1", [resolution.id])).rows)
      .toEqual([{ turn_id: turnId }]);
    expect((await pool.query(
      "SELECT turn_id FROM asset_references WHERE asset_id=$1 AND campaign_id=$2 AND asset_role='turn_illustration'",
      [assetId, imported.campaignId]
    )).rows).toEqual([{ turn_id: turnId }]);

    // The next streamed turn has no turn row yet; its repetition window must still see that reuse.
    await pool.query("UPDATE generation_jobs SET status='completed', result_turn_id=$2, completed_at=now() WHERE id=$1", [generationJobId, turnId]);
    const next = await streamingGeneration(imported.campaignId);
    const nextSegments = await provisionalSegments(imported.campaignId, next.id, [first.text]);
    const nextResolution = await queueResolution(imported.campaignId, nextSegments.segmentIds[0]!, first.text);
    await runIllustrationResolutionJob(pool, "accuracy-library", 60, providers());

    const candidate = await pool.query<{ score_components: Record<string, number> }>(
      "SELECT score_components FROM illustration_match_candidates WHERE resolution_job_id=$1 AND asset_id=$2",
      [nextResolution.id, assetId]
    );
    expect(candidate.rows[0]!.score_components.repetitionPenalty).toBeGreaterThan(0);
  });

  async function turnResolution(campaignId: string, turnId: string, imagePrompt: string) {
    return (await pool.query<{ id: string }>(
      `INSERT INTO illustration_resolution_jobs(owner_user_id,campaign_id,turn_id,source_policy,matching_scope,confidence_profile,repetition_window,query_context_snapshot)
       VALUES ($1,$2,$3,'library_only','owner_library','broad',5,$4) RETURNING id`,
      [ownerUserId, campaignId, turnId, JSON.stringify({ imagePrompt })]
    )).rows[0]!;
  }

  async function turnIds(campaignId: string) {
    return (await pool.query<{ id: string }>(
      "SELECT id FROM turns WHERE campaign_id=$1 ORDER BY turn_number", [campaignId]
    )).rows.map((row) => row.id);
  }

  it("considers an older strong match beyond the newest hundred library assets", async () => {
    const imported = await campaign({ sourcePolicy: "library_only", matchingScope: "owner_library", confidenceProfile: "broad" });
    const [, turnId] = await turnIds(imported.campaignId);
    const scene = "A ferry leaves the fog-bound quay while lanterns shrink into the estuary mist";
    const matchId = await libraryAsset(imported.campaignId, null, scene);
    await pool.query("UPDATE assets SET created_at = now() - interval '1 day' WHERE id=$1", [matchId]);
    for (let index = 0; index < 100; index += 1) {
      await libraryAsset(imported.campaignId, null, `A desert caravan crossing dune ${index} under a white sun`);
    }
    // Real prompts carry words the stored asset text lacks.
    const resolution = await turnResolution(imported.campaignId, turnId!, `${scene}, moody blue dusk, painterly`);

    await runIllustrationResolutionJob(pool, "accuracy-library", 60, providers());

    expect((await pool.query("SELECT selected_asset_id FROM illustration_resolution_jobs WHERE id=$1", [resolution.id])).rows)
      .toEqual([{ selected_asset_id: matchId }]);
  });

  it("rejects a generated asset whose turn named different characters", async () => {
    const imported = await campaign({ sourcePolicy: "library_only", matchingScope: "owner_library", confidenceProfile: "broad" });
    const [firstTurnId, secondTurnId] = await turnIds(imported.campaignId);
    const scene = "A cloaked figure raises a brass lantern on the rope bridge above the black river";
    const assetId = await libraryAsset(imported.campaignId, firstTurnId!, scene);
    const worldVersion = (await pool.query<{ world_version_id: string }>(
      "SELECT world_version_id FROM campaigns WHERE id=$1", [imported.campaignId]
    )).rows[0]!.world_version_id;
    await pool.query("DELETE FROM chronicle_memories WHERE campaign_id=$1", [imported.campaignId]);
    for (const [turnId, entity] of [[firstTurnId, "character:oswin"], [secondTurnId, "character:mira"]] as const) {
      await pool.query(
        `INSERT INTO chronicle_memories(owner_user_id,campaign_id,world_version_id,turn_id,memory_kind,content,token_estimate,entities)
         VALUES ($1,$2,$3,$4,'canonical_fact','fixture',1,$5)`,
        [ownerUserId, imported.campaignId, worldVersion, turnId, [entity]]
      );
    }
    const resolution = await turnResolution(imported.campaignId, secondTurnId!, scene);

    await runIllustrationResolutionJob(pool, "accuracy-library", 60, providers());

    const candidate = await pool.query<{ rejection_reasons: string[] }>(
      "SELECT rejection_reasons FROM illustration_match_candidates WHERE resolution_job_id=$1 AND asset_id=$2",
      [resolution.id, assetId]
    );
    expect(candidate.rows[0]!.rejection_reasons).toContain("canonical_entity_mismatch");
  });

  it("sends the campaign art style in the prompt and its exclusions as a negative prompt", async () => {
    const artStyle = "Ink and watercolor storybook, muted palette";
    const negativePrompt = "text, watermark, frame";
    const imported = await campaign({ artStyle, negativePrompt });
    await expect(application().getIllustrationConfig({ ownerUserId, campaignId: imported.campaignId }))
      .resolves.toMatchObject({ artStyle, negativePrompt });
    const { turnId } = await committingGeneration(imported.campaignId);
    await generateTurnIllustrationSegments(pool, turnId, { mode: "rebuild" }, providers());
    const job = (await pool.query<{ id: string; prompt: string; negative_prompt: string }>(
      "SELECT id, prompt, negative_prompt FROM image_jobs WHERE turn_id=$1 ORDER BY created_at LIMIT 1", [turnId]
    )).rows[0]!;
    expect(job.prompt).toContain(`ART STYLE:\n${artStyle}`);
    expect(job.negative_prompt).toBe(negativePrompt);

    const requests: Parameters<IllustrationWorkerPorts["imageProvider"]["executeImage"]>[0][] = [];
    const ports = createIllustrationWorkerPorts(pool, providers());
    const capturing: IllustrationWorkerPorts = {
      ...ports,
      imageProvider: {
        async executeImage(request) {
          requests.push(request);
          throw Object.assign(new Error("Captured request."), { code: "captured", permanent: true });
        }
      }
    };
    await pool.query("UPDATE image_jobs SET next_attempt_at = now() - interval '1 minute' WHERE id=$1", [job.id]);
    // Earlier tests leave queued jobs; the capturing port fails each one permanently.
    while (!requests.some((request) => request.jobId === job.id)
      && await runImageJob(pool, "accuracy-image", 30, capturing, {} as never)) { /* drain */ }
    expect(requests.find((request) => request.jobId === job.id)?.negativePrompt).toBe(negativePrompt);
  });

  it("still publishes a streamed image that finishes after its turn was accepted", async () => {
    const imported = await campaign();
    const { turnId, generationJobId } = await committingGeneration(imported.campaignId);
    const config = await loadConfig(pool, ownerUserId, imported.campaignId);
    const first = segmentIllustrationText(acceptedNarration, config.segment_word_count)[0]!;
    const { segmentIds } = await provisionalSegments(imported.campaignId, generationJobId, [first.text]);
    const image = await streamedImageJob(imported.campaignId, generationJobId, segmentIds[0]!);
    await promoteProvisionalSet(pool, ownerUserId, generationJobId, turnId, imported.campaignId, acceptedNarration, config, providers());
    await pool.query("UPDATE generation_jobs SET status='completed', result_turn_id=$2, completed_at=now() WHERE id=$1", [generationJobId, turnId]);
    await pool.query(
      `UPDATE image_jobs SET status='generating', lease_owner='accuracy-publisher', lease_expires_at=now() + interval '1 minute'
        WHERE id=$1`, [image.id]
    );

    const claimed = await createPostgresIllustrationAssetPublicationRepository(pool)
      .loadClaimedPublication({ imageJobId: image.id, workerId: "accuracy-publisher" });

    expect(claimed?.id).toBe(image.id);
  });
});
