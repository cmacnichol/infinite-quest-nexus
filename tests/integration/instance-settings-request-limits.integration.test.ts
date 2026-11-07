import { resolve } from "node:path";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { acquireAdmission, releaseAdmission, type AdmissionPolicy } from "../../services/api/src/admission-service.js";
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration("request settings preserve distributed admission authority", () => {
  let pool: DatabasePool, replica: DatabasePool, owner: string;
  beforeAll(async () => {
    pool = createDatabasePool(process.env.TEST_DATABASE_URL!, 3);
    replica = createDatabasePool(process.env.TEST_DATABASE_URL!, 2);
    await migrateDatabase(pool, resolve("database/migrations"));
    owner = await initialOwnerId(pool);
  });
  afterEach(async () => { await pool.query("TRUNCATE api_admission_events, api_admission_windows, api_admission_leases, api_admission_buckets"); });
  afterAll(async () => { await pool?.end(); await replica?.end(); });
  const policy = (windowSeconds: number, maxRequests: number): AdmissionPolicy => ({key:"generation",windowSeconds,maxRequests,maxConcurrent:null,leaseSeconds:30});
  it.each(["12:00:10", "12:00:40"])("preserves old capacity across same/different starts at %s", async (time) => {
    const now = new Date(`2026-07-23T${time}Z`);
    expect(await acquireAdmission(pool, owner, "old", policy(60,2), now)).toMatchObject({allowed:true});
    expect(await acquireAdmission(replica, owner, "new", policy(30,4), now)).toMatchObject({allowed:true});
    expect(await acquireAdmission(pool, owner, "excess", policy(30,4), now)).toMatchObject({allowed:false});
    expect(await acquireAdmission(replica, owner, "expired", policy(30,4), new Date("2026-07-23T12:01:00Z"))).toMatchObject({allowed:true});
  });
  it("preserves unknown historical maximum conservatively until expiry", async () => {
    await pool.query("INSERT INTO api_admission_buckets(owner_user_id,operation,window_started_at,window_expires_at,accepted_count) VALUES($1,'generation','2026-07-23T12:00:00Z','2026-07-23T12:01:00Z',1)",[owner]);
    expect(await acquireAdmission(replica,owner,"legacy",policy(30,9),new Date("2026-07-23T12:00:40Z"))).toMatchObject({allowed:false});
    expect(await acquireAdmission(replica,owner,"after",policy(30,9),new Date("2026-07-23T12:01:00Z"))).toMatchObject({allowed:true});
  });
  it("retains duplicate lease and count across policy changes", async () => {
    const old = {...policy(60,2),key:"provider" as const,maxConcurrent:1};
    const now = new Date("2026-07-23T12:00:40Z");
    const first = await acquireAdmission(pool,owner,"same",old,now);
    const duplicate = await acquireAdmission(replica,owner,"same",{...old,windowSeconds:30},now);
    expect(duplicate).toMatchObject({allowed:true,leaseId:first.allowed?first.leaseId:null});
    expect((await pool.query("SELECT accepted_count FROM api_admission_buckets")).rows).toEqual([{accepted_count:1}]);
  });
  it("counts prior events exactly once through longer windows and multiple revisions", async () => {
    const t = new Date("2026-07-23T12:00:10Z");
    for (let i=0;i<3;i++) expect(await acquireAdmission(pool,owner,`before-${i}`,policy(30,9),t)).toMatchObject({allowed:true});
    expect(await acquireAdmission(replica,owner,"tight",policy(60,2),t)).toMatchObject({allowed:false});
    expect(await acquireAdmission(replica,owner,"fourth",policy(60,4),t)).toMatchObject({allowed:true,remaining:0});
    expect(await acquireAdmission(pool,owner,"long",policy(120,4),t)).toMatchObject({allowed:false});
    expect((await pool.query("SELECT count(*)::int AS count FROM api_admission_events")).rows).toEqual([{count:4}]);
  });
  it("retains old SQL conflict target and treats old binary accepts as unknown authority", async () => {
    const sql = `INSERT INTO api_admission_buckets(owner_user_id,operation,window_started_at,window_expires_at,accepted_count)
      VALUES($1,'generation','2026-07-23T12:00:00Z','2026-07-23T12:01:00Z',1)
      ON CONFLICT(owner_user_id,operation,window_started_at) DO UPDATE SET accepted_count=api_admission_buckets.accepted_count+1
      WHERE api_admission_buckets.accepted_count<9 RETURNING accepted_count`;
    await pool.query(sql,[owner]);
    expect((await pool.query(sql,[owner])).rows).toEqual([{accepted_count:2}]);
    expect(await acquireAdmission(replica,owner,"after-old",policy(60,9),new Date("2026-07-23T12:00:40Z"))).toMatchObject({allowed:false});
  });

});

import { buildServer } from "../../services/api/src/server.js";
import { inertStorageServerOptions } from "../helpers/build-server-options.js";
import { bootstrap } from "../helpers/instance-settings-runtime.js";
integration("two API replica request admission", () => {
  it("enforces active provider and import rate budgets across actual Fastify servers", async () => {
    const pools=[createDatabasePool(process.env.TEST_DATABASE_URL!,3),createDatabasePool(process.env.TEST_DATABASE_URL!,3)];
    await migrateDatabase(pools[0]!,resolve("database/migrations"));
    const config=bootstrap();config.logLevel="silent";config.systemArchiveEnabled=false;
    config.security.apiRateLimitProviderRequests=1;config.security.apiRateLimitImportRequests=1;
    const apps=await Promise.all(pools.map(pool=>buildServer({...inertStorageServerOptions({config,pool}),requestAdmission:{acquire:acquireAdmission,release:releaseAdmission}})));
    try {
      for(const url of ["/api/v1/providers/discover-models","/api/v1/imports/world/preview"]) {
        expect((await apps[0]!.inject({method:"POST",url,payload:{}})).statusCode).not.toBe(429);
        expect((await apps[1]!.inject({method:"POST",url,payload:{}})).statusCode).toBe(429);
      }
    } finally {await Promise.all(apps.map(app=>app.close()));await Promise.all(pools.map(pool=>pool.end()));}
  });
  it("holds provider concurrency across two Fastify replicas until completion", async () => {
    const pools=[createDatabasePool(process.env.TEST_DATABASE_URL!,3),createDatabasePool(process.env.TEST_DATABASE_URL!,3)];
    await migrateDatabase(pools[0]!,resolve("database/migrations"));
    await pools[0]!.query("TRUNCATE api_admission_events,api_admission_windows,api_admission_buckets,api_admission_leases");
    const config=bootstrap();config.logLevel="silent";config.systemArchiveEnabled=false;
    config.security.apiConcurrencyProviderRequests=1;
    let finish!:()=>void, entered!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});
    const waiting=new Promise<void>(resolve=>{finish=resolve;});
    const options=pools.map(pool=>inertStorageServerOptions({config,pool}));
    const apps=await Promise.all(options.map(option=>buildServer({...option,requestAdmission:{acquire:acquireAdmission,release:releaseAdmission},providers:{...option.providers,models:async()=>{entered();await waiting;return [];}}})));
    const url="/api/v1/providers/11111111-1111-4111-8111-111111111111/models";
    try {
      const first=apps[0]!.inject({url}).then(response=>response);
      await started;
      expect((await apps[1]!.inject({url})).statusCode).toBe(429);
      finish();expect((await first).statusCode).toBe(200);
      expect((await apps[1]!.inject({url})).statusCode).toBe(200);
      await expect.poll(async()=>(await pools[0]!.query("SELECT count(*)::int AS count FROM api_admission_leases")).rows).toEqual([{count:0}]);
    } finally {finish();await Promise.all(apps.map(app=>app.close()));await Promise.all(pools.map(pool=>pool.end()));}
  });

});

import { createInstanceSettingsRepository } from "../../packages/database/src/instance-settings-repository.js";
import { createSettingsActivationGuard } from "../../services/runtime/src/settings-activation.js";
import { loadActiveRuntimeSettings, settingsDigest } from "../../services/runtime/src/instance-settings.js";
import { runtimePolicy } from "../helpers/instance-settings-runtime.js";
import { settingsFixture } from "../fixtures/instance-settings.js";
integration("staged request settings persistence",()=>{
  it("keeps the active body boundary after saving a requested revision in PostgreSQL",async()=>{
    const pool=createDatabasePool(process.env.TEST_DATABASE_URL!,3);
    await migrateDatabase(pool,resolve("database/migrations"));
    const policy=runtimePolicy(),active={...settingsFixture(),apiDefaultBodyLimitBytes:65536};
    const repository=createInstanceSettingsRepository(pool,{activationGuard:createSettingsActivationGuard(policy)});
    const actor={userId:await initialOwnerId(pool),cliReference:"request-test"};
    await repository.seed({installationId:policy.installationId,snapshot:active,policyDigest:settingsDigest(policy),seedDigest:settingsDigest(active),actor});
    await repository.activate({expectedActiveRevision:null,expectedRequestedRevision:"1",policyDigest:settingsDigest(policy),maintenanceReference:"isolated-drain",actor});
    const resolved=await loadActiveRuntimeSettings(pool,bootstrap(),policy);
    resolved.config.systemArchiveEnabled=false;resolved.config.logLevel="silent";
    const app=await buildServer(inertStorageServerOptions({config:resolved.config,pool}));
    app.post("/body-boundary",async request=>({bytes:Buffer.byteLength(request.body as string)}));
    try {
      await repository.propose({expectedRequestedRevision:"1",snapshot:{...active,apiDefaultBodyLimitBytes:131072},actor,reason:"stage-body-limit"});
      expect((await loadActiveRuntimeSettings(pool,bootstrap(),policy)).config.security.apiDefaultBodyLimitBytes).toBe(65536);
      expect((await app.inject({method:"POST",url:"/body-boundary",headers:{"content-type":"text/plain"},payload:"x".repeat(65536)})).statusCode).toBe(200);
      expect((await app.inject({method:"POST",url:"/body-boundary",headers:{"content-type":"text/plain"},payload:"x".repeat(65537)})).statusCode).toBe(413);
    }finally{await app.close();await pool.end();}
  });
});
