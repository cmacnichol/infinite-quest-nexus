import { illustrationSegmentsResponseSchema } from "../../packages/contracts/src/illustration-client.js";
import { loadConfig, promoteProvisionalSet } from "../../services/runtime/src/illustration-segment-job-adapter.js";
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

  async function completedSegment(provisional = false) {
    const imported = await campaign();
    const turn = (await pool.query<{ id: string; narration: string }>(
      "SELECT id,narration FROM turns WHERE campaign_id=$1 ORDER BY turn_number DESC LIMIT 1", [imported.campaignId]
    )).rows[0]!;
    await application().setIllustrationConfig({ ownerUserId, campaignId: imported.campaignId }, illustrationConfigSchema.parse({
      enabled: true, sourcePolicy: "generate_only", providerProfileId: imageProviderId, model: "repository-image-model", segmentWordCount: 5000
    }));
    const generation = (await pool.query<{ id: string }> (
      `INSERT INTO generation_jobs(owner_user_id,campaign_id,provider_profile_id,idempotency_key,expected_turn_number,action,status,requested_model,result_turn_id)
       SELECT $1,$2,$3,$4,turn_number,'Illustrate the scene','completed','fixture',$5 FROM turns WHERE id=$5 RETURNING id`,
      [ownerUserId, imported.campaignId, imageProviderId, crypto.randomUUID(), turn.id]
    )).rows[0]!;
    const set = (await pool.query<{ id: string }>(
      `INSERT INTO turn_illustration_sets(owner_user_id,campaign_id,turn_id,generation_job_id,source_text_hash,segment_word_count,images_per_segment,prompt_mode,status)
       VALUES ($1,$2,$3,$4,'fixture',5000,1,'direct','completed') RETURNING id`,
      [ownerUserId, imported.campaignId, provisional ? null : turn.id, generation.id]
    )).rows[0]!;
    const segment = (await pool.query<{ id: string }>(
      `INSERT INTO turn_illustration_segments(owner_user_id,campaign_id,turn_id,generation_job_id,illustration_set_id,ordinal,start_offset,end_offset,start_word,end_word,source_text,source_text_hash,direct_prompt,status)
       VALUES ($1,$2,$3,$4,$5,0,0,$6,0,1,$7,'fixture','A quiet road','completed') RETURNING id`,
      [ownerUserId, imported.campaignId, provisional ? null : turn.id, generation.id, set.id, turn.narration.length, turn.narration]
    )).rows[0]!;
    const asset = (await pool.query<{ id: string }>(
      `INSERT INTO assets(owner_user_id,campaign_id,content_hash,storage_driver,storage_path,mime_type,byte_length)
       VALUES($1,$2,$3,'filesystem',$4,'image/png',68) RETURNING id`,
      [ownerUserId, imported.campaignId, crypto.randomUUID().replaceAll('-', '').padEnd(64,'0'), `test/${crypto.randomUUID()}.png`]
    )).rows[0]!;
    const job = (await pool.query<{id:string}>(
      `INSERT INTO image_jobs(owner_user_id,campaign_id,turn_id,generation_job_id,segment_id,target_type,provider_profile_id,requested_model,prompt,prompt_hash,status,asset_id,provider_type)
       VALUES($1,$2,$3,$4,$5,$6,$7,'fixture','A quiet road','fixture','completed',$8,'openai_compatible') RETURNING id`,
      [ownerUserId,imported.campaignId,provisional?null:turn.id,generation.id,segment.id,provisional?'streaming_illustration':'turn_illustration',imageProviderId,asset.id]
    )).rows[0]!;
    const promptJob = (await pool.query<{id:string}>(
      `INSERT INTO illustration_prompt_jobs(owner_user_id,campaign_id,turn_id,generation_job_id,segment_id,status)
       VALUES($1,$2,$3,$4,$5,'completed') RETURNING id`,
      [ownerUserId,imported.campaignId,provisional?null:turn.id,generation.id,segment.id]
    )).rows[0]!;
    await pool.query(
      `INSERT INTO turn_illustration_segment_assets(owner_user_id,segment_id,asset_id,variant_index)
       VALUES($1,$2,$3,0)`, [ownerUserId, segment.id, asset.id]
    );
    return { ...imported, turn, generation, set, segment, asset, job, promptJob };
  }

  it("returns database-created illustration variants that the real client contract accepts", async () => {
    const data = await completedSegment();
    const response = await application().listCampaignIllustrationSegments({ownerUserId, campaignId: data.campaignId});
    expect(illustrationSegmentsResponseSchema.safeParse(JSON.parse(JSON.stringify(response))).success).toBe(true);
    expect(response.segments[0]!.variants[0]!.assetId).toBe(data.asset.id);
  });

  it("excludes unattached completed sets from the accepted-turn segment response", async () => {
    const data = await completedSegment(true);
    const response = await application().listCampaignIllustrationSegments({ownerUserId, campaignId: data.campaignId});
    expect(response.segments).toEqual([]);
  });

  it.each(['completed', 'partial'])("attaches a %s streaming set after image completion without replacing its asset", async (status) => {
    const data = await completedSegment(true);
    await pool.query('UPDATE turn_illustration_sets SET status=$2 WHERE id=$1', [data.set.id,status]);
    const config = await loadConfig(pool,ownerUserId,data.campaignId);
    config.segment_word_count = 5000;
    for(let attempt=0; attempt<2; attempt++) {
      await promoteProvisionalSet(pool,ownerUserId,data.generation.id,data.turn.id,data.campaignId,data.turn.narration,config,apiProviderGraph(pool,credentialSecret).illustration);
    }
    expect((await pool.query('SELECT turn_id FROM turn_illustration_sets WHERE id=$1',[data.set.id])).rows).toEqual([{turn_id:data.turn.id}]);
    expect((await pool.query('SELECT turn_id FROM turn_illustration_segments WHERE id=$1',[data.segment.id])).rows).toEqual([{turn_id:data.turn.id}]);
    expect((await pool.query('SELECT asset_id FROM turn_illustration_segment_assets WHERE segment_id=$1',[data.segment.id])).rows).toEqual([{asset_id:data.asset.id}]);
  });
  it("previews and recovers historical assets without creating image jobs and is idempotent", async () => {
    const { recoverUnattachedIllustrations } = await import('../../packages/database/src/illustration-recovery.js');
    const data = await completedSegment(true);
    const scope = { ownerUserId, campaignId: data.campaignId };
    expect(await recoverUnattachedIllustrations(pool,scope)).toEqual([{setId:data.set.id,turnId:data.turn.id,outcome:'eligible'}]);
    expect((await pool.query('SELECT turn_id FROM turn_illustration_sets WHERE id=$1',[data.set.id])).rows[0].turn_id).toBeNull();
    expect(await recoverUnattachedIllustrations(pool,{...scope,apply:true})).toEqual([{setId:data.set.id,turnId:data.turn.id,outcome:'recovered'}]);
    expect(await recoverUnattachedIllustrations(pool,{...scope,apply:true})).toEqual([]);
    expect((await pool.query('SELECT id,turn_id,status FROM illustration_prompt_jobs WHERE id=$1',[data.promptJob.id])).rows).toEqual([{id:data.promptJob.id,turn_id:data.turn.id,status:'completed'}]);
    expect((await pool.query('SELECT id,turn_id,target_type,status,asset_id FROM image_jobs WHERE id=$1',[data.job.id])).rows).toEqual([{id:data.job.id,turn_id:data.turn.id,target_type:'turn_illustration',status:'completed',asset_id:data.asset.id}]);
    expect((await pool.query('SELECT count(*)::int AS count FROM image_jobs WHERE campaign_id=$1',[data.campaignId])).rows[0].count).toBe(1);
    expect((await application().listCampaignIllustrationSegments(scope)).segments[0]!.variants[0]!.assetId).toBe(data.asset.id);
  });

  it.each(['source_mismatch','rejected_parent','inactive_set','existing_set','active_children','active_prompt'])("skips unsafe historical recovery: %s", async (reason) => {
    const { recoverUnattachedIllustrations } = await import('../../packages/database/src/illustration-recovery.js');
    const data = await completedSegment(true);
    if(reason==='active_prompt') await pool.query("UPDATE illustration_prompt_jobs SET status='queued' WHERE id=$1",[data.promptJob.id]);
    if(reason==='active_children') await pool.query("UPDATE image_jobs SET status='queued' WHERE id=$1",[data.job.id]);
    if(reason==='source_mismatch') await pool.query("UPDATE turn_illustration_segments SET source_text='Unaccepted prose' WHERE id=$1",[data.segment.id]);
    if(reason==='rejected_parent') await pool.query("UPDATE generation_jobs SET status='failed' WHERE id=$1",[data.generation.id]);
    if(reason==='inactive_set') await pool.query("UPDATE turn_illustration_sets SET is_active=false WHERE id=$1",[data.set.id]);
    if(reason==='existing_set') await pool.query(`INSERT INTO turn_illustration_sets(owner_user_id,campaign_id,turn_id,source_text_hash,segment_word_count,images_per_segment,prompt_mode,status) VALUES($1,$2,$3,'fixture',5000,1,'direct','completed')`,[ownerUserId,data.campaignId,data.turn.id]);
    const results = await recoverUnattachedIllustrations(pool,{ownerUserId,campaignId:data.campaignId,apply:true});
    expect(results.every(row=>row.outcome!=='recovered')).toBe(true);
    expect((await pool.query('SELECT turn_id FROM turn_illustration_sets WHERE id=$1',[data.set.id])).rows[0].turn_id).toBeNull();
    expect(await recoverUnattachedIllustrations(pool,{ownerUserId:crypto.randomUUID(),campaignId:data.campaignId,apply:true})).toEqual([]);
  });

});
