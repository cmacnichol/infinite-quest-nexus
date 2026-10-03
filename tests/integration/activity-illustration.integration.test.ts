import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, withTransaction, type DatabasePool } from "../../packages/database/src/pool.js";
import { importLegacyStory } from "../helpers/memory-aware-services.js";
import { apiProviderGraph, createProvider } from "../helpers/provider-application-fixtures.js";
import { getIllustrationConfig, insertImageJob, retryImageJob, runImageJob } from "../../services/runtime/src/illustration-image-job-adapter.js";
import { createPostgresActivityMaintenanceRepository } from "../../packages/database/src/activity-maintenance-repository.js";
import { createPostgresIllustrationAssetPublicationRepository, type PrivateIllustrationAttachedPublication } from "../../packages/database/src/illustration-asset-publication-repository.js";
import { createProvisionalSet, createProvisionalSegment, loadConfig, runIllustrationPromptJob } from "../../services/runtime/src/illustration-segment-job-adapter.js";
import { runIllustrationResolutionJob } from "../../services/runtime/src/illustration-resolution-job-adapter.js";
import { illustrationConfigSchema } from "../../packages/contracts/src/generation.js";
import { setIllustrationConfig } from "../../services/runtime/src/illustration-image-job-adapter.js";
import { createIllustrationWorkerStateMachine } from "../../services/runtime/src/illustration-worker-state-adapter.js";
import type { IllustrationWorkerPorts } from "../../packages/application/src/index.js";
import type { PrivateIllustrationAssetPublicationCoordinator } from "../../packages/application/src/illustration/private-illustration-asset-publication.js";

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration("Persistent illustration activity producers", () => {
  let pool: DatabasePool;
  let ownerUserId: string;
  let providerProfileId: string;
  beforeAll(async () => {
    pool = createDatabasePool(process.env.TEST_DATABASE_URL!, 6);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    providerProfileId = (await createProvider(pool, { name: "Activity image fixture", providerType: "openai_compatible", providerRole: "image", baseUrl: "http://127.0.0.1:9911", defaultModel: "activity-image", contextWindowTokens: 8192, maxOutputTokens: 1024, temperature: 0, enabled: true, configuration: {} }, "activity-fixture-secret")).id;
  });
  afterEach(async () => { await pool.query("DELETE FROM campaigns WHERE owner_user_id=$1", [ownerUserId]); });
  afterAll(async () => { await pool.end(); });
  async function setup() {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Activity image ${crypto.randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "activity-image.story", story: fixture }));
    const turn = (await pool.query<{ id: string }>("SELECT id FROM turns WHERE campaign_id=$1 ORDER BY turn_number LIMIT 1", [imported.campaignId])).rows[0]!;
    const config = await getIllustrationConfig(pool, imported.campaignId);
    const job = await withTransaction(pool, client => insertImageJob(client, { ownerUserId, campaignId: imported.campaignId, turnId: turn.id, prompt: "A quiet silver forest.", config: { ...config, enabled: true, providerProfileId, model: "activity-image", size: "1024x1024", aspectRatio: "1:1", quality: "auto", outputFormat: "png", maxAttempts: 1, imagesPerSegment: 1 } }));
    return { ...imported, turnId: turn.id, job: job! };
  }
  async function events(id: string) {
    return (await pool.query<{ snapshot: { kind: string; occurredAt: string; turnId: string | null; diagnostic: { code: string } | null }; activity_revision: string }>("SELECT snapshot, activity_revision::text FROM activity_event_outbox WHERE source_id=$1 ORDER BY activity_revision", [id])).rows;
  }
  function providers() { return apiProviderGraph(pool, "activity-fixture-secret").illustration; }
  async function segment(campaignId: string, turnId: string) {
    const set = (await pool.query<{ id: string }>(`INSERT INTO turn_illustration_sets(owner_user_id,campaign_id,turn_id,source_text_hash,segment_word_count,images_per_segment,prompt_mode) VALUES ($1,$2,$3,'synthetic-segment',100,1,'direct') RETURNING id`, [ownerUserId,campaignId,turnId])).rows[0]!;
    return (await pool.query<{ id: string }>(`INSERT INTO turn_illustration_segments(owner_user_id,illustration_set_id,campaign_id,turn_id,ordinal,start_offset,end_offset,start_word,end_word,source_text,source_text_hash,direct_prompt,resolved_prompt,status) VALUES ($1,$2,$3,$4,0,0,25,0,5,'A quiet silver forest.','synthetic-segment','A quiet silver forest.','A quiet silver forest.','generating') RETURNING id`, [ownerUserId,set.id,campaignId,turnId])).rows[0]!.id;
  }
  async function asset() {
    return (await pool.query<{ id: string }>(`INSERT INTO assets(owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length) VALUES ($1,$2,'filesystem','synthetic/activity.png','image/png',20) RETURNING id`, [ownerUserId,crypto.randomUUID().replaceAll("-","").padEnd(64,"0")])).rows[0]!.id;
  }
  const lanes = { prompt: async () => false, resolution: async () => false, image: async () => false };
  it("captures actual insertion, fenced generic phases, retry reset and no heartbeat/reclaim noise", async () => {
    const { job } = await setup();
    const state = createIllustrationWorkerStateMachine(pool, lanes);
    const claim = await state.claimNextImageJob({ workerId: "activity-image", leaseSeconds: 60 });
    expect(claim?.jobId).toBe(job.id);
    await state.heartbeatClaim(claim!);
    expect(await state.transitionClaim({ ...claim!, workerId: "stale" }, { status: "downloading" })).toBe(false);
    await state.transitionClaim(claim!, { status: "downloading" });
    await pool.query("UPDATE image_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [job.id]);
    const reclaimed = await state.claimNextImageJob({ workerId: "activity-image", leaseSeconds: 60 });
    await state.transitionClaim(reclaimed!, { status: "failed", metadata: { code: "PRIVATE_CODE", message: "PRIVATE_MESSAGE" } });
    await retryImageJob(pool, job.id);
    const rows = await events(job.id);
    expect(rows.map(row => row.snapshot.kind)).toEqual(["image.queued", "image.generating", "image.downloading", "image.failed", "image.retry_queued"]);
    expect(rows.map(row => row.activity_revision)).toEqual(["1", "2", "3", "4", "5"]);
    expect(JSON.stringify(rows)).not.toContain("PRIVATE");
    expect((await pool.query("SELECT attempts FROM image_jobs WHERE id=$1", [job.id])).rows[0].attempts).toBe(0);
  });
  it("imageFailurePreservesAcceptedStory and sourceCleanupPreservesEvent", async () => {
    const { job, turnId } = await setup();
    const before = (await pool.query("SELECT narration FROM turns WHERE id=$1", [turnId])).rows[0];
    const ports = { imageProvider: { executeImage: async () => { throw Object.assign(new Error("PRIVATE_PROVIDER_BODY"), { code: "PRIVATE_CODE", permanent: true }); } } } as unknown as IllustrationWorkerPorts;
    const publication = {} as PrivateIllustrationAssetPublicationCoordinator;
    await runImageJob(pool, "activity-image", 60, ports, publication);
    expect((await events(job.id)).map(row => row.snapshot.kind)).toEqual(["image.queued", "image.generating", "image.failed"]);
    expect((await pool.query("SELECT narration FROM turns WHERE id=$1", [turnId])).rows[0]).toEqual(before);
    await pool.query("DELETE FROM image_jobs WHERE id=$1", [job.id]);
    expect(await events(job.id)).toHaveLength(3);
    expect(JSON.stringify(await events(job.id))).not.toContain("PRIVATE");
  });
  it("provider progress and poll claims do not flood events or prematurely capture completion", async () => {
    const { job } = await setup();
    let progress = 1;
    const ports = { imageProvider: { executeImage: async () => ({ status: "pending", remoteJobId: "remote-private", progress: progress++, queuePosition: 2, etaSeconds: 10, pollAfterMs: 1000, generationTimeoutMs: 60000, metadata: { status: "pending", private: "PRIVATE_RESULT" } }) } } as unknown as IllustrationWorkerPorts;
    for (let index = 0; index < 3; index++) {
      await runImageJob(pool, "activity-image", 60, ports, {} as PrivateIllustrationAssetPublicationCoordinator);
      await pool.query("UPDATE image_jobs SET next_poll_at=now() WHERE id=$1", [job.id]);
    }
    expect((await events(job.id)).map(row => row.snapshot.kind)).toEqual(["image.queued", "image.generating", "image.provider_pending"]);
  });
  it("rolls authoritative mutations and revisions back when outbox capture fails", async () => {
    const { job } = await setup();
    await pool.query("CREATE FUNCTION reject_activity_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'capture fixture failure'; END $$");
    await pool.query("CREATE TRIGGER reject_activity_fixture BEFORE INSERT ON activity_event_outbox FOR EACH ROW EXECUTE FUNCTION reject_activity_fixture()");
    try {
      const state = createIllustrationWorkerStateMachine(pool, lanes);
      await expect(state.claimNextImageJob({ workerId: "activity-image", leaseSeconds: 60 })).rejects.toThrow("capture fixture failure");
      expect((await pool.query("SELECT status,activity_revision::text FROM image_jobs WHERE id=$1", [job.id])).rows[0]).toEqual({ status: "queued", activity_revision: "1" });
      expect(await events(job.id)).toHaveLength(1);
    } finally { await pool.query("DROP TRIGGER reject_activity_fixture ON activity_event_outbox"); await pool.query("DROP FUNCTION reject_activity_fixture()"); }
  });
  it.each(["recoverable", "expired", "queued"])("captures live %s outcomes safely", async expected => {
    const { job } = await setup();
    if (expected === "queued") await pool.query("UPDATE image_jobs SET max_attempts=3 WHERE id=$1", [job.id]);
    const ports = { imageProvider: { executeImage: async () => { throw Object.assign(new Error("PRIVATE_BODY"), { code: expected === "expired" ? "image_generation_expired" : "PRIVATE_CODE", expired: expected === "expired" }); } } } as unknown as IllustrationWorkerPorts;
    await runImageJob(pool,"activity-image",60,ports,{} as PrivateIllustrationAssetPublicationCoordinator);
    const rows = await events(job.id);
    expect(rows.at(-1)?.snapshot.kind).toBe(expected === "queued" ? "image.retry_queued" : `image.${expected}`);
    expect(JSON.stringify(rows)).not.toContain("PRIVATE");
  });
  it("captures publication completion inside asset authority and remains publishable after source removal", async () => {
    const { job, campaignId, turnId } = await setup();
    const segmentId = await segment(campaignId,turnId);
    await pool.query("UPDATE image_jobs SET segment_id=$2 WHERE id=$1", [job.id,segmentId]);
    await createIllustrationWorkerStateMachine(pool,lanes).claimNextImageJob({ workerId:"activity-image",leaseSeconds:60 });
    const repository = createPostgresIllustrationAssetPublicationRepository(pool);
    const claimed = (await repository.loadClaimedPublication({imageJobId:job.id,workerId:"activity-image"}))!;
    const assetId = await asset();
    // This exercises the authoritative DB publication boundary; filesystem finalization is a separate platform-gated suite.
    const publications = [{ variantIndex:0,result:{assetId,mimeType:"image/png",byteLength:20,contentHash:"a".repeat(64),pixelWidth:1,pixelHeight:1,derivatives:[]},finalization:{} }] as unknown as readonly PrivateIllustrationAttachedPublication[];
    const metadata = {usage:{},reportedCost:null,providerMetadata:{private:"PRIVATE_RESULT"},providerResponseId:"PRIVATE_RESPONSE",primaryMimeType:"image/png",primaryByteLength:20};
    await expect(withTransaction(pool,client=>repository.completeInTransaction(client,claimed,"stale-worker",publications,metadata))).rejects.toThrow("illustration_publication_lease_lost");
    expect(await events(job.id)).toHaveLength(2);
    await withTransaction(pool,async client=>{
      const locked = await repository.lockCompletionInTransaction(client,{job:claimed,workerId:"activity-image"});
      await repository.completeInTransaction(client,locked!,"activity-image",publications,metadata);
    });
    expect((await events(job.id)).at(-1)?.snapshot.kind).toBe("image.completed");
    expect((await events(segmentId)).at(-1)?.snapshot.kind).toBe("illustration_segment.completed");
    expect((await pool.query("SELECT image_job_id FROM turn_illustration_segment_assets WHERE segment_id=$1",[segmentId])).rows[0].image_job_id).toBe(job.id);
    await pool.query("DELETE FROM turns WHERE id=$1",[turnId]);
    const result = await createPostgresActivityMaintenanceRepository(pool).publishBatch(100);
    expect(result).toEqual({published:4,quarantined:0});
    const published = await pool.query("SELECT snapshot FROM story_activity_events WHERE campaign_id=$1",[campaignId]);
    expect(published.rows).toHaveLength(4);
    expect(JSON.stringify(published.rows)).not.toContain("PRIVATE");
  });
  it.each([false,true])("captures library segment outcome with a match=%s", async matched=>{
    const {campaignId,turnId} = await setup();
    const segmentId = await segment(campaignId,turnId);
    if (matched) {
      const assetId = await asset();
      await pool.query(`UPDATE asset_library_entries SET title='A quiet silver forest.',caption='A quiet silver forest.',tags=ARRAY['quiet','silver','forest'],review_status='eligible',reuse_scope='owner_library',automatic_reuse_enabled=true WHERE asset_id=$1 AND owner_user_id=$2`,[assetId,ownerUserId]);
      await pool.query(`INSERT INTO asset_generation_contexts(owner_user_id,asset_id,created_by_user_id,campaign_id,turn_id,target_type,fiction_prompt) VALUES ($1,$2,$1,$3,$4,'turn_illustration','A quiet silver forest.')`,[ownerUserId,assetId,campaignId,turnId]);
    }
    await pool.query(`INSERT INTO illustration_resolution_jobs(owner_user_id,campaign_id,turn_id,segment_id,source_policy,matching_scope,confidence_profile) VALUES ($1,$2,$3,$4,'library_only','owner_library','broad')`,[ownerUserId,campaignId,turnId,segmentId]);
    await runIllustrationResolutionJob(pool,"activity-library",60,providers());
    expect((await events(segmentId)).map(row=>row.snapshot.kind)).toEqual([matched ? "illustration_segment.completed" : "illustration_segment.failed"]);
  });
  it("streamingSegmentHasNullableTurnUntilBound and direct mode has no fallback", async()=>{
    const {campaignId,turnId} = await setup();
    await setIllustrationConfig(pool,campaignId,illustrationConfigSchema.parse({sourcePolicy:"generate_only",providerProfileId,model:"activity-image",segmentPromptMode:"ai_refined",segmentWordCount:100}));
    const parent = (await pool.query<{id:string}>(`INSERT INTO generation_jobs(owner_user_id,campaign_id,provider_profile_id,idempotency_key,expected_turn_number,action,status) VALUES ($1,$2,$3,$4,99,'Synthetic fixture action','generating') RETURNING id`,[ownerUserId,campaignId,providerProfileId,crypto.randomUUID()])).rows[0]!.id;
    const setId = (await createProvisionalSet(pool,ownerUserId,campaignId,parent))!;
    const config = await loadConfig(pool,ownerUserId,campaignId);
    const text = "A quiet silver forest surrounds an old stone bridge.";
    const data = {ordinal:0,startOffset:0,endOffset:text.length,startWord:0,endWord:10,wordCount:10,text};
    const snapshot = {version:2 as const,state:"unavailable" as const,errorCode:"illustration_text_route_unavailable" as const};
    await createProvisionalSegment(pool,ownerUserId,campaignId,parent,setId,data,config,providers(),undefined,snapshot);
    const segmentId = (await pool.query<{id:string}>("SELECT id FROM turn_illustration_segments WHERE illustration_set_id=$1",[setId])).rows[0]!.id;
    expect((await events(segmentId)).map(row=>row.snapshot.kind)).toEqual(["illustration_segment.refining","illustration_segment.direct_fallback"]);
    await createProvisionalSegment(pool,ownerUserId,campaignId,parent,setId,data,config,providers(),undefined,snapshot);
    expect(await events(segmentId)).toHaveLength(2);
    await pool.query("UPDATE turn_illustration_segments SET turn_id=$2 WHERE id=$1",[segmentId,turnId]);
    expect((await events(segmentId)).every(row=>row.snapshot.turnId===null)).toBe(true);
    const direct = {...config,segment_prompt_mode:"direct" as const};
    await createProvisionalSegment(pool,ownerUserId,campaignId,parent,setId,{...data,ordinal:1},direct,providers());
    const directId = (await pool.query<{id:string}>("SELECT id FROM turn_illustration_segments WHERE illustration_set_id=$1 AND ordinal=1",[setId])).rows[0]!.id;
    expect(await events(directId)).toHaveLength(0);
  });
  it.each(["success","fallback","recoverable","lost_success","lost_failure"])("captures actual refinement %s and fences child delivery", async outcome=>{
    const {campaignId,turnId} = await setup();
    await setIllustrationConfig(pool,campaignId,illustrationConfigSchema.parse({sourcePolicy:"generate_only",providerProfileId,model:"activity-image",segmentPromptMode:"ai_refined"}));
    const segmentId = await segment(campaignId,turnId);
    await pool.query("UPDATE turn_illustration_segments SET status='refining' WHERE id=$1",[segmentId]);
    if (outcome === "recoverable") await pool.query("UPDATE turn_illustration_segments SET updated_at='2000-01-01' WHERE id=$1", [segmentId]);
    const promptId=(await pool.query<{id:string}>(`INSERT INTO illustration_prompt_jobs(owner_user_id,campaign_id,turn_id,segment_id,provider_profile_id,requested_model,max_attempts,prompt_snapshot) VALUES ($1,$2,$3,$4,$5,'activity-image',$6,'{}') RETURNING id`,[ownerUserId,campaignId,turnId,segmentId,providerProfileId,outcome==="recoverable"?3:1])).rows[0]!.id;
    const refinement={refinePrompt:async()=>{
      if (outcome.startsWith("lost_")) await pool.query("UPDATE illustration_prompt_jobs SET lease_owner='replacement-worker' WHERE id=$1",[promptId]);
      if (["fallback","recoverable","lost_failure"].includes(outcome)) throw Object.assign(new Error("PRIVATE_REFINEMENT"),{code:"PRIVATE_REFINEMENT_CODE"});
      return {providerRole:"text" as const,providerProfileId,model:"activity-image",prompt:"A quiet silver forest.",metadata:{}};
    }};
    await runIllustrationPromptJob(pool,"activity-prompt",60,refinement,{recordIllustrationCost:async()=>null},providers());
    const rows = await events(segmentId);
    expect(rows.map(row=>row.snapshot.kind)).toEqual(outcome==="fallback"?["illustration_segment.direct_fallback"]:outcome==="recoverable"?["illustration_segment.failed"]:[]);
    if (outcome === "recoverable") expect(rows[0]!.snapshot.occurredAt).not.toContain("2000-01-01");
    const images=(await pool.query("SELECT id FROM image_jobs WHERE segment_id=$1",[segmentId])).rows;
    expect(images).toHaveLength(["success","fallback"].includes(outcome)?1:0);
    expect(JSON.stringify(rows)).not.toContain("PRIVATE");
  });
  it("expired library claim creates no segment event, match or child",async()=>{
    const {campaignId,turnId}=await setup();
    const segmentId=await segment(campaignId,turnId);
    await pool.query(`INSERT INTO illustration_resolution_jobs(owner_user_id,campaign_id,turn_id,segment_id,source_policy,matching_scope,confidence_profile) VALUES ($1,$2,$3,$4,'library_then_generate','owner_library','broad')`,[ownerUserId,campaignId,turnId,segmentId]);
    await runIllustrationResolutionJob(pool,"expired-library",-1,providers());
    expect(await events(segmentId)).toHaveLength(0);
    expect((await pool.query("SELECT id FROM image_jobs WHERE segment_id=$1",[segmentId])).rows).toHaveLength(0);
  });
  it("remote retry advances revision while polling and attempts do not",async()=>{
    const {job}=await setup();
    await pool.query("UPDATE image_jobs SET max_attempts=3 WHERE id=$1",[job.id]);
    let calls=0;
    const ports={imageProvider:{executeImage:async()=>{
      if(calls++) throw Object.assign(new Error("PRIVATE_REMOTE_ERROR"),{code:"PRIVATE_REMOTE_CODE",remoteTerminal:true});
      return {status:"pending",remoteJobId:"remote-private",progress:1,queuePosition:1,etaSeconds:5,pollAfterMs:1000,generationTimeoutMs:60000,metadata:{}};
    }}} as unknown as IllustrationWorkerPorts;
    await runImageJob(pool,"activity-image",60,ports,{} as PrivateIllustrationAssetPublicationCoordinator);
    await pool.query("UPDATE image_jobs SET next_poll_at=now() WHERE id=$1",[job.id]);
    await runImageJob(pool,"activity-image",60,ports,{} as PrivateIllustrationAssetPublicationCoordinator);
    expect((await events(job.id)).map(row=>row.snapshot.kind)).toEqual(["image.queued","image.generating","image.provider_pending","image.retry_queued"]);
    expect((await pool.query("SELECT attempts,activity_revision::text FROM image_jobs WHERE id=$1",[job.id])).rows[0]).toEqual({attempts:1,activity_revision:"4"});
  });
  it("lost image lease creates no failure events or child mutation",async()=>{
    const {job,campaignId,turnId}=await setup();
    const segmentId=await segment(campaignId,turnId);
    await pool.query("UPDATE image_jobs SET segment_id=$2 WHERE id=$1",[job.id,segmentId]);
    const ports={imageProvider:{executeImage:async()=>{
      await pool.query("UPDATE image_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[job.id]);
      throw Object.assign(new Error("PRIVATE_IMAGE_FAILURE"),{permanent:true});
    }}} as unknown as IllustrationWorkerPorts;
    await runImageJob(pool,"activity-image",60,ports,{} as PrivateIllustrationAssetPublicationCoordinator);
    expect(await events(job.id)).toHaveLength(2);
    expect(await events(segmentId)).toHaveLength(0);
    expect((await pool.query("SELECT status FROM turn_illustration_segments WHERE id=$1",[segmentId])).rows[0].status).toBe("generating");
  });

  it("excludes world covers and retains the current public cause without private text",async()=>{
    const {job,campaignId}=await setup();
    const worldId=(await pool.query("SELECT versions.world_id FROM campaigns JOIN world_versions versions ON versions.id=campaigns.world_version_id WHERE campaigns.id=$1",[campaignId])).rows[0].world_id;
    const config=await getIllustrationConfig(pool,campaignId);
    const cover=await insertImageJob(pool,{ownerUserId,worldId,targetType:"world_cover",prompt:"A quiet forest.",config:{...config,providerProfileId,model:"activity-image"}});
    expect(await events(cover!.id)).toHaveLength(0);
    expect((await pool.query("SELECT activity_revision::text FROM image_jobs WHERE id=$1",[cover!.id])).rows[0].activity_revision).toBe("0");
    const ports={imageProvider:{executeImage:async()=>{throw Object.assign(new Error("PRIVATE_TIMEOUT"),{code:"provider_request_timeout",permanent:true});}}} as unknown as IllustrationWorkerPorts;
    await runImageJob(pool,"activity-image",60,ports,{} as PrivateIllustrationAssetPublicationCoordinator);
    expect((await events(job.id)).at(-1)?.snapshot.diagnostic?.code).toBe("provider_request_timeout");
    expect(JSON.stringify(await events(job.id))).not.toContain("PRIVATE");
  });

  it("generic worker pending polls and same-status phases stay quiet",async()=>{
    const {job}=await setup();
    const state=createIllustrationWorkerStateMachine(pool,lanes);
    for(let index=0;index<3;index++){
      const claim=(await state.claimNextImageJob({workerId:"generic-poll",leaseSeconds:60}))!;
      await state.transitionClaim(claim,{status:"generating"});
      await state.transitionClaim(claim,{status:"provider_pending",metadata:{progress:index,queuePosition:index}});
      await pool.query("UPDATE image_jobs SET next_poll_at=now() WHERE id=$1",[job.id]);
    }
    expect((await events(job.id)).map(row=>row.snapshot.kind)).toEqual(["image.queued","image.generating","image.provider_pending"]);
  });

  it("expired final refinement write rolls child insertion and capture back",async()=>{
    const {campaignId,turnId}=await setup();
    await setIllustrationConfig(pool,campaignId,illustrationConfigSchema.parse({sourcePolicy:"generate_only",providerProfileId,model:"activity-image",segmentPromptMode:"ai_refined"}));
    const segmentId=await segment(campaignId,turnId);
    await pool.query("UPDATE turn_illustration_segments SET status='refining' WHERE id=$1",[segmentId]);
    await pool.query(`INSERT INTO illustration_prompt_jobs(owner_user_id,campaign_id,turn_id,segment_id,provider_profile_id,requested_model,max_attempts,prompt_snapshot) VALUES ($1,$2,$3,$4,$5,'activity-image',1,'{}')`,[ownerUserId,campaignId,turnId,segmentId,providerProfileId]);
    const graph=providers();
    const delayed={...graph,resolution:{...graph.resolution,resolveDirect:(async(input:Parameters<typeof graph.resolution.resolveDirect>[0])=>{
      await new Promise(resolve=>setTimeout(resolve,1100));
      return graph.resolution.resolveDirect(input);
    }) as typeof graph.resolution.resolveDirect}};
    await runIllustrationPromptJob(pool,"expiry-prompt",1,{refinePrompt:async()=>({providerRole:"text",providerProfileId,model:"activity-image",prompt:"A quiet silver forest.",metadata:{}})},{recordIllustrationCost:async()=>null},delayed);
    expect((await pool.query("SELECT id FROM image_jobs WHERE segment_id=$1",[segmentId])).rows).toHaveLength(0);
    expect(await events(segmentId)).toHaveLength(0);
    expect((await pool.query("SELECT status FROM turn_illustration_segments WHERE id=$1",[segmentId])).rows[0].status).toBe("refining");
  });
  it("generic provider completion does not invent asset publication success",async()=>{
    const {job}=await setup();
    const state=createIllustrationWorkerStateMachine(pool,lanes);
    const claim=(await state.claimNextImageJob({workerId:"provider-only",leaseSeconds:60}))!;
    await state.transitionClaim(claim,{status:"completed"});
    expect((await events(job.id)).map(row=>row.snapshot.kind)).toEqual(["image.queued","image.generating"]);
  });

});
