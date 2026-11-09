import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { resolve } from "node:path";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { acquireAdmission, releaseAdmission, renewAdmission, type AdmissionPolicy } from "../../services/api/src/admission-service.js";
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
    expect(duplicate).toMatchObject({allowed:true,remaining:1,leaseId:first.allowed?first.leaseId:null});
    expect((await pool.query("SELECT accepted_count FROM api_admission_buckets")).rows).toEqual([{accepted_count:1}]);
  });
  it("counts prior events exactly once through longer windows and multiple revisions", async () => {
    const t = new Date("2026-07-23T12:00:10Z");
    for (let i=0;i<3;i++) expect(await acquireAdmission(pool,owner,`before-${i}`,policy(30,9),t)).toMatchObject({allowed:true});
    expect(await acquireAdmission(replica,owner,"tight",policy(60,2),t)).toMatchObject({allowed:false});
    expect(await acquireAdmission(replica,owner,"fourth",policy(60,4),t)).toMatchObject({allowed:false});
    expect(await acquireAdmission(pool,owner,"long",policy(120,4),t)).toMatchObject({allowed:false});
    expect((await pool.query("SELECT count(*)::int AS count FROM api_admission_events")).rows).toEqual([{count:3}]);
  });

  it("does not reclaim an expired HTTP lease while its actual work may still be running",async()=>{
    const current={...policy(60,9),key:"provider" as const,maxConcurrent:1,leaseSeconds:1,durableRequest:true};
    const time=new Date("2026-07-23T12:00:10Z");
    const first=await acquireAdmission(pool,owner,"running",current,time);
    expect(first.allowed).toBe(true);
    expect(await acquireAdmission(replica,owner,"extra",current,new Date(time.getTime()+2000))).toMatchObject({allowed:false});
    if(first.allowed&&first.leaseId)await releaseAdmission(pool,first.leaseId);
    expect(await acquireAdmission(replica,owner,"after",current,new Date(time.getTime()+2000))).toMatchObject({allowed:true});
  });

  it("renews only the exact running owner/request lease and fails closed when it is missing",async()=>{
    const current={...policy(60,9),key:"provider" as const,maxConcurrent:1,leaseSeconds:1,durableRequest:true};
    const acquired=await acquireAdmission(pool,owner,"renew-scope",current);
    if(!acquired.allowed||!acquired.leaseId)throw new Error("lease");
    await expect(renewAdmission(replica,acquired.leaseId,owner,"wrong","provider",1)).rejects.toThrow("Admission control is temporarily unavailable.");
    await expect(renewAdmission(replica,acquired.leaseId,"11111111-1111-4111-8111-111111111111","renew-scope","provider",1)).rejects.toThrow();
    await renewAdmission(replica,acquired.leaseId,owner,"renew-scope","provider",9);
    expect((await pool.query("SELECT expires_at>clock_timestamp()+interval '7 seconds' AS renewed FROM api_admission_leases")).rows).toEqual([{renewed:true}]);
    await releaseAdmission(pool,acquired.leaseId);
    await expect(renewAdmission(replica,acquired.leaseId,owner,"renew-scope","provider",9)).rejects.toThrow();
  });

  it("reports only the exhausted older window as Retry-After",async()=>{
    const now=new Date("2026-07-23T12:00:10Z");
    expect(await acquireAdmission(pool,owner,"short",policy(30,1),now)).toMatchObject({allowed:true});
    expect(await acquireAdmission(replica,owner,"long",policy(60,9),new Date(now.getTime()+1000))).toEqual({allowed:false,retryAfterSeconds:19});
  });
  it.each(["generation","provider"] as const)("bounds expired history cleanup on %s denial",async key=>{
    const now=new Date("2026-07-23T12:00:10Z"),old=new Date(now.getTime()-10800000);
    const current={...policy(60,1),key,maxConcurrent:key==="provider"?1:null};
    expect(await acquireAdmission(pool,owner,"held",current,now)).toMatchObject({allowed:true});
    await pool.query(`INSERT INTO api_admission_windows(owner_user_id,operation,window_started_at,window_expires_at,max_requests)
      SELECT $1,$2,$3::timestamptz+i*interval '1 second',$3::timestamptz+(i+1)*interval '1 second',9 FROM generate_series(1,150) i`,[owner,key,old]);
    await pool.query(`INSERT INTO api_admission_buckets(owner_user_id,operation,window_started_at,window_expires_at,accepted_count)
      SELECT $1,$2,$3::timestamptz+i*interval '1 second',$3::timestamptz+(i+1)*interval '1 second',0 FROM generate_series(1,150) i`,[owner,key,old]);
    await pool.query(`INSERT INTO api_admission_events(owner_user_id,operation,accepted_at) SELECT $1,$2,$3 FROM generate_series(1,150)`,[owner,key,old]);
    expect(await acquireAdmission(replica,owner,"denied",current,now)).toMatchObject({allowed:false});
    for(const table of ["api_admission_windows","api_admission_buckets","api_admission_events"]){
      const column=table==="api_admission_events"?"accepted_at":"window_expires_at";
      expect((await pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE ${column}<$1`,[new Date(now.getTime()-3600000)])).rows).toEqual([{count:50}]);
    }
    expect((await pool.query("SELECT count(*)::int AS count FROM api_admission_events WHERE accepted_at=$1",[now])).rows).toEqual([{count:1}]);
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
    config.workerLeaseSeconds=1;
    let finish!:()=>void, entered!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});
    const waiting=new Promise<void>(resolve=>{finish=resolve;});
    const options=pools.map(pool=>inertStorageServerOptions({config,pool}));
    const apps=await Promise.all(options.map(option=>buildServer({...option,requestAdmission:{acquire:acquireAdmission,release:releaseAdmission},providers:{...option.providers,models:async()=>{entered();await waiting;return [];}}})));
    const url="/api/v1/providers/11111111-1111-4111-8111-111111111111/models";
    try {
      const first=apps[0]!.inject({url}).then(response=>response);
      await started;
      await new Promise(resolve=>setTimeout(resolve,1400));
      expect((await pools[0]!.query("SELECT expires_at>clock_timestamp() AS renewed,request_running FROM api_admission_leases")).rows).toEqual([{renewed:true,request_running:true}]);
      expect((await apps[1]!.inject({url,method:"HEAD"})).statusCode).toBe(429);
      expect((await apps[1]!.inject({url})).statusCode).toBe(429);
      finish();expect((await first).statusCode).toBe(200);
      // The response can reach the client before its onResponse lease release commits.
      await expect.poll(async()=>(await pools[0]!.query("SELECT count(*)::int AS count FROM api_admission_leases")).rows).toEqual([{count:0}]);
      expect((await apps[1]!.inject({url,method:"HEAD"})).statusCode).toBe(200);
      await expect.poll(async()=>(await pools[0]!.query("SELECT count(*)::int AS count FROM api_admission_leases")).rows).toEqual([{count:0}]);
    } finally {finish();await Promise.all(apps.map(app=>app.close()));await Promise.all(pools.map(pool=>pool.end()));}
  });

  it("retains the database slot after client disconnect until nonabortable provider work ends",async()=>{
    const pools=[createDatabasePool(process.env.TEST_DATABASE_URL!,3),createDatabasePool(process.env.TEST_DATABASE_URL!,3)];
    await migrateDatabase(pools[0]!,resolve("database/migrations"));
    await pools[0]!.query("TRUNCATE api_admission_events,api_admission_windows,api_admission_buckets,api_admission_leases");
    const config=bootstrap();config.logLevel="silent";config.systemArchiveEnabled=false;config.security.apiConcurrencyProviderRequests=1;
    let finish!:()=>void,entered!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;}),waiting=new Promise<void>(resolve=>{finish=resolve;});
    const apps=await Promise.all(pools.map(pool=>{const options=inertStorageServerOptions({config,pool});return buildServer({...options,requestAdmission:{acquire:acquireAdmission,release:releaseAdmission},providers:{...options.providers,models:async()=>{entered();await waiting;return [];}}});}));
    const url="/api/v1/providers/11111111-1111-4111-8111-111111111111/models";
    try{
      await apps[0]!.listen({host:"127.0.0.1",port:0});const address=apps[0]!.server.address();if(!address||typeof address==="string")throw new Error("port");
      const req=httpRequest({hostname:"127.0.0.1",port:address.port,path:url});req.on("error",()=>{});req.end();await started;req.destroy();
      await new Promise(resolve=>setTimeout(resolve,30));expect((await apps[1]!.inject({url})).statusCode).toBe(429);
      finish();await expect.poll(async()=>(await pools[0]!.query("SELECT count(*)::int AS count FROM api_admission_leases")).rows).toEqual([{count:0}]);
      expect((await apps[1]!.inject({url})).statusCode).toBe(200);
    }finally{finish();await Promise.all(apps.map(app=>app.close()));await Promise.all(pools.map(pool=>pool.end()));}
  });

  it("keeps an expired pinned slot on another replica after actual renewal storage failure",async()=>{
    const pools=[createDatabasePool(process.env.TEST_DATABASE_URL!,3),createDatabasePool(process.env.TEST_DATABASE_URL!,3)];
    const unavailablePool=createDatabasePool(process.env.TEST_DATABASE_URL!,1);await unavailablePool.end();
    await migrateDatabase(pools[0]!,resolve("database/migrations"));
    await pools[0]!.query("TRUNCATE api_admission_events,api_admission_windows,api_admission_buckets,api_admission_leases");
    const config=bootstrap();config.logLevel="silent";config.systemArchiveEnabled=false;config.workerLeaseSeconds=1;config.security.apiConcurrencyProviderRequests=1;
    let finish!:()=>void,entered!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;}),waiting=new Promise<void>(resolve=>{finish=resolve;});
    const apps=await Promise.all(pools.map((pool,index)=>{const options=inertStorageServerOptions({config,pool});return buildServer({...options,requestAdmission:{acquire:acquireAdmission,release:releaseAdmission,...(index===0?{renew:(_pool,lease,owner,request,key,ttl)=>renewAdmission(unavailablePool,lease,owner,request,key,ttl)}:{})},providers:{...options.providers,models:async()=>{entered();await waiting;return [];}}});}));
    const url="/api/v1/providers/11111111-1111-4111-8111-111111111111/models";
    try{
      const first=apps[0]!.inject({url}).then(response=>response);await started;expect((await first).statusCode).toBe(503);
      expect((await apps[0]!.inject({url:"/health/ready"})).statusCode).toBe(503);
      expect((await apps[0]!.inject({url:"/health/live"})).statusCode).toBe(200);
      await new Promise(resolve=>setTimeout(resolve,900));
      expect((await pools[0]!.query("SELECT expires_at<clock_timestamp() AS expired,request_running FROM api_admission_leases")).rows).toEqual([{expired:true,request_running:true}]);
      expect((await apps[1]!.inject({url})).statusCode).toBe(429);
      finish();await expect.poll(async()=>(await pools[0]!.query("SELECT count(*)::int AS count FROM api_admission_leases")).rows).toEqual([{count:0}]);
      expect((await apps[1]!.inject({url})).statusCode).toBe(200);
    }finally{finish();await Promise.all(apps.map(app=>app.close()));await Promise.all(pools.map(pool=>pool.end()));}
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

import { recoverRequestAdmission } from "../../services/runtime/src/admission-recovery.js";
integration("offline admission recovery contract",()=>{
  it("requires explicit shutdown attestation and exact owner/request scope; releases one orphan only",async()=>{
    const pool=createDatabasePool(process.env.TEST_DATABASE_URL!,3);
    await migrateDatabase(pool,resolve("database/migrations"));
    await pool.query("TRUNCATE api_admission_events,api_admission_windows,api_admission_buckets,api_admission_leases");
    const owner=await initialOwnerId(pool),time=new Date("2026-07-23T12:00:10Z");
    const policy={key:"provider" as const,windowSeconds:60,maxRequests:9,maxConcurrent:2,leaseSeconds:1,durableRequest:true};
    const first=await acquireAdmission(pool,owner,"orphan-1",policy,time),second=await acquireAdmission(pool,owner,"orphan-2",policy,time);
    if(!first.allowed||!first.leaseId||!second.allowed)throw new Error("lease");
    const input={leaseId:first.leaseId,ownerUserId:owner,requestId:"orphan-1",operation:"provider",maintenanceReference:"shutdown/test-123",verifiedShutdown:"all-api-processes-stopped-and-work-terminated"};
    try{
      await expect(recoverRequestAdmission(pool,{...input,verifiedShutdown:undefined})).rejects.toThrow("settings_admission_recovery_attestation_required");
      expect(await recoverRequestAdmission(pool,{...input,requestId:"wrong"})).toMatchObject({recovered:false});
      expect(await recoverRequestAdmission(pool,{...input,ownerUserId:"11111111-1111-4111-8111-111111111111"})).toMatchObject({recovered:false});
      expect((await pool.query("SELECT count(*)::int AS count FROM api_admission_leases")).rows).toEqual([{count:2}]);
      await pool.query(`INSERT INTO instance_settings_runtime_reports(process_id,role,build_version,protocol_version,activation_epoch,policy_digest,effective_configuration_digest,readiness_state)
        VALUES('22222222-2222-4222-8222-222222222222','api','test',1,0,$1,$1,'stopping')`,['0'.repeat(64)]);
      await expect(recoverRequestAdmission(pool,input)).rejects.toThrow("settings_runtime_not_drained");
      await pool.query("DELETE FROM instance_settings_runtime_reports WHERE process_id='22222222-2222-4222-8222-222222222222'");
      await pool.query(`INSERT INTO instance_settings_runtime_reports(process_id,role,build_version,protocol_version,activation_epoch,policy_digest,effective_configuration_digest,readiness_state)
        VALUES('33333333-3333-4333-8333-333333333333','worker','test',1,0,$1,$1,'ready')`,['0'.repeat(64)]);
      expect(await recoverRequestAdmission(pool,input)).toMatchObject({recovered:true});
      await pool.query("DELETE FROM instance_settings_runtime_reports WHERE process_id='33333333-3333-4333-8333-333333333333'");
      expect((await pool.query("SELECT lease_id,maintenance_reference,actor_user_id FROM api_admission_recoveries")).rows).toEqual([{lease_id:first.leaseId,maintenance_reference:input.maintenanceReference,actor_user_id:owner}]);
      await expect(pool.query("DELETE FROM api_admission_recoveries")).rejects.toThrow("immutable_instance_settings_evidence");

      expect((await pool.query("SELECT request_id FROM api_admission_leases")).rows).toEqual([{request_id:"orphan-2"}]);
      expect(await acquireAdmission(pool,owner,"replacement",policy,new Date(time.getTime()+2000))).toMatchObject({allowed:true});
    }finally{await pool.query("TRUNCATE api_admission_leases");await pool.end();}
  });
});

import { spawn } from "node:child_process";
// @ts-expect-error Launcher intentionally has no TypeScript declarations.
import { tsxCommand } from "../../scripts/node-tool-command.mjs";
integration("crashed HTTP reservation process",()=>{
  it.each([true,false])("recovers an exited reservation process with mounted policy=%s",async withPolicy=>{
    const pool=createDatabasePool(process.env.TEST_DATABASE_URL!,3);
    await migrateDatabase(pool,resolve("database/migrations"));
    await pool.query("TRUNCATE api_admission_events,api_admission_windows,api_admission_buckets,api_admission_leases");
    const command=tsxCommand(["tests/helpers/admission-crash.ts"]);
    const child=spawn(command.executable,command.arguments,{env:{...process.env},stdio:["ignore","pipe","ignore"]});
    let output="";child.stdout!.on("data",chunk=>{output+=chunk;});
    try{
      expect(await new Promise<number|null>((resolve,reject)=>{child.on("error",reject);child.on("exit",resolve);})).toBe(0);
      const lease=JSON.parse(output) as {leaseId:string;ownerUserId:string};
      await new Promise(resolve=>setTimeout(resolve,1200));
      const policy={key:"provider" as const,windowSeconds:60,maxRequests:9,maxConcurrent:1,leaseSeconds:1,durableRequest:true};
      expect(await acquireAdmission(pool,lease.ownerUserId,"after-crash",policy)).toMatchObject({allowed:false});
      const directory=await mkdtemp(join(tmpdir(),"iq-admission-recovery-"));
      try{
        const policyPath=join(directory,"policy.json"),inputPath=join(directory,"attestation.json");
        await writeFile(policyPath,JSON.stringify(runtimePolicy()));
        await writeFile(inputPath,JSON.stringify({...lease,operation:"provider",requestId:"crashed-process-request",maintenanceReference:"crash/test-123",verifiedShutdown:"all-api-processes-stopped-and-work-terminated"}));
        const command=tsxCommand(["scripts/instance-settings.ts","recover-admission","--input",inputPath]);
        const operator=spawn(command.executable,command.arguments,{env:{...process.env,DATABASE_URL:process.env.TEST_DATABASE_URL,APP_ROLE:"api",INSTANCE_SETTINGS_POLICY_FILE:withPolicy?policyPath:""},stdio:["ignore","pipe","ignore"]});
        let result="";operator.stdout!.on("data",chunk=>{result+=chunk;});
        expect(await new Promise<number|null>((resolve,reject)=>{operator.on("error",reject);operator.on("exit",resolve);})).toBe(0);
        expect(JSON.parse(result)).toMatchObject({status:"ok",command:"recover-admission",result:{recovered:true,maintenanceReference:"crash/test-123"}});
      }finally{await rm(directory,{recursive:true,force:true});}
      expect(await acquireAdmission(pool,lease.ownerUserId,"after-recovery",policy)).toMatchObject({allowed:true});
    }finally{await pool.query("TRUNCATE api_admission_leases");await pool.end();}
  });
});
