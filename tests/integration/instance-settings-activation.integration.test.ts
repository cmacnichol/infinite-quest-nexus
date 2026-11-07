import { beforeAll,afterAll,describe,it,expect } from "vitest";
import { resolve } from "node:path";
import { createDatabasePool,initialOwnerId,type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createInstanceSettingsRepository } from "../../packages/database/src/instance-settings-repository.js";
import { createSettingsActivationGuard } from "../../services/runtime/src/settings-activation.js";
import { loadActiveRuntimeSettings,settingsDigest,startSettingsRuntimeReport, registerSettingsRuntime } from "../../services/runtime/src/instance-settings.js";
import { runtimePolicy,bootstrap } from "../helpers/instance-settings-runtime.js";
import { exportSettingsSeed,runInstanceSettingsCommand,type SettingsOperatorPorts } from "../../services/runtime/src/settings-operator.js";
import { settingsFixture } from "../fixtures/instance-settings.js";
describe('controlled settings activation',()=>{
 let pool:DatabasePool;
 beforeAll(async()=>{pool=createDatabasePool(process.env.TEST_DATABASE_URL!);await migrateDatabase(pool,resolve('database/migrations'));});
 afterAll(async()=>{await pool?.end();});
 it('activates only drained state, revalidates new policies through audited revisions and restarts current epoch',async()=>{
  const policy=runtimePolicy(); const digest=settingsDigest(policy);
  const repository=createInstanceSettingsRepository(pool,{activationGuard:createSettingsActivationGuard(policy)});
  const actor={userId:await initialOwnerId(pool),cliReference:'activation-test'};
  const snapshot=settingsFixture();
  await repository.seed({installationId:policy.installationId,snapshot,policyDigest:digest,seedDigest:settingsDigest(snapshot),actor});
  const request={expectedActiveRevision:null,expectedRequestedRevision:'1',policyDigest:digest,maintenanceReference:'maintenance/change-123',actor};
  const unsupported=createInstanceSettingsRepository(pool,{activationGuard:createSettingsActivationGuard({...policy,minimumSettingsProtocolVersion:2})});
  await expect(unsupported.activate(request)).rejects.toThrow('settings_protocol_unsupported');
  await pool.query(`INSERT INTO prepared_text_physical_attempts(owner_user_id,logical_kind,reservation_key,logical_reservation,plan_hash,candidate_ordinal,requested_model,provider_policy,request_payload_hash,request_body)
    VALUES($1,'direct','settings-test','{}',$2,0,'test-model','{}',$2,'{}')`,[actor.userId,'a'.repeat(64)]);
  await expect(repository.activate(request)).rejects.toThrow('settings_active_invocations');
  await pool.query("UPDATE prepared_text_physical_attempts SET status='completed',dispatched_at=clock_timestamp(),completed_at=clock_timestamp(),outcome='failed',failure_reason='cancelled' WHERE reservation_key='settings-test'");
  await pool.query('CREATE TABLE settings_test_future_lane (lease_expires_at timestamptz)');
  await pool.query("INSERT INTO settings_test_future_lane VALUES(clock_timestamp()+interval '1 minute')");
  await expect(repository.activate(request)).rejects.toThrow('settings_active_leases');
  await pool.query('DELETE FROM settings_test_future_lane');
  const config=bootstrap();
  const resolved=await loadActiveRuntimeSettings(pool,config,policy);
  const controller=new AbortController();const stop=await startSettingsRuntimeReport(pool,resolved,controller.signal,()=>controller.abort());
  await expect(repository.activate(request)).rejects.toThrow('settings_runtime_not_drained');
  await stop();
  await expect(repository.activate({...request,maintenanceReference:'bad reference with spaces'})).rejects.toThrow('settings_maintenance_reference_required');
  expect((await repository.read()).mode).toBe('environment');
  await repository.activate(request);
  expect((await loadActiveRuntimeSettings(pool,config,policy)).activeRevision).toBe('1');
  await expect(repository.activate(request)).rejects.toThrow('settings_conflict');
  const tightened={...policy,numericBounds:{...policy.numericBounds,textProviderConcurrency:{min:1,max:1}}};
  const next=createInstanceSettingsRepository(pool,{activationGuard:createSettingsActivationGuard(tightened)});
  const changed={...snapshot,textProviderConcurrency:1};
  await next.propose({expectedRequestedRevision:'1',snapshot:changed,policyDigest:settingsDigest(tightened),actor,reason:'policy-review'});
  // Proposed policy does not replace the active revision's policy at startup.
  expect((await loadActiveRuntimeSettings(pool,config,policy)).activeRevision).toBe('1');
  await expect(loadActiveRuntimeSettings(pool,config,tightened)).rejects.toThrow('settings_policy_mismatch');
  await next.activate({...request,expectedActiveRevision:'1',expectedRequestedRevision:'2',policyDigest:settingsDigest(tightened)});
  expect((await loadActiveRuntimeSettings(pool,config,tightened)).config.textProviderConcurrency).toBe(1);
  // Same values under a new policy are a meaningful immutable revision.
  const changedPolicy={...tightened,featureGates:{...tightened.featureGates,worldSharingEnabled:false}};
  const third=await next.propose({expectedRequestedRevision:'2',snapshot:changed,policyDigest:settingsDigest(changedPolicy),actor,reason:'policy-review'});
  expect(third.requestedRevision).toBe('3');
  const operatorPolicy=changedPolicy;
  const operatorRepository=createInstanceSettingsRepository(pool,{activationGuard:createSettingsActivationGuard(operatorPolicy)});
  const outputs:unknown[]=[];
  let input:unknown=[exportSettingsSeed(config)];
  const ports:SettingsOperatorPorts={config,policy:operatorPolicy,repository:operatorRepository,actor,
    output:value=>outputs.push(value),readJson:async()=>input,
    readRevision:async revision=>(await pool.query('SELECT snapshot FROM instance_settings_revisions WHERE revision=$1',[revision])).rows[0].snapshot,
    status:async()=>{const state=await operatorRepository.read();return {mode:state.mode,activeRevision:state.activeRevision,requestedRevision:state.requestedRevision};}
  };
  expect(await runInstanceSettingsCommand(['export-seed'],ports)).toBe(0);
  // Repeated seed preserves the already active/requested revisions and source configuration.
  expect(await runInstanceSettingsCommand(['seed','--input','role-seeds.json'],{...ports,policy})).toBe(0);
  expect((await operatorRepository.read()).requestedRevision).toBe('3');
  input={...changed,logLevel:'debug'};
  expect(await runInstanceSettingsCommand(['propose','--input','reviewed.json','--expected-requested','3'],ports)).toBe(0);
  expect(await runInstanceSettingsCommand(['validate'],ports)).toBe(0);
  expect(await runInstanceSettingsCommand(['activate','--expected-active','2','--expected-requested','4','--maintenance','maintenance/change-456'],ports)).toBe(0);
  const restarted=await loadActiveRuntimeSettings(pool,config,operatorPolicy);
  expect(restarted.config.logLevel).toBe('debug');
  const registration=await registerSettingsRuntime(pool,restarted,controller.signal,()=>controller.abort(),operatorPolicy);
  await registration.waitUntilCompatible();
  expect(await registration.isReady()).toBe(false); // registered, before serving
  await registration.markReady();
  expect(await registration.isReady()).toBe(true);
  await pool.query("UPDATE instance_settings_runtime_reports SET heartbeat_at=clock_timestamp()-interval '31 seconds'");
  expect(await registration.isReady()).toBe(false);
  await registration.markReady();
  expect(await registration.isReady()).toBe(true);
  expect(await runInstanceSettingsCommand(['status'],ports)).toBe(0);
  expect(outputs.at(-1)).toMatchObject({mode:'database',activeRevision:'4'});
  await registration.dispose();
  expect((await pool.query('SELECT count(*)::int AS n FROM instance_settings_runtime_reports')).rows[0].n).toBe(0);
  // Tightened policy refuses the former higher-capacity revision.
  expect(await runInstanceSettingsCommand(['propose-rollback','--revision','1','--expected-requested','4'],ports)).toBe(1);
  expect(await runInstanceSettingsCommand(['propose-rollback','--revision','2','--expected-requested','4'],ports)).toBe(0);
  expect((await operatorRepository.read()).activeRevision).toBe('4');
  expect((await operatorRepository.read()).requestedRevision).toBe('5');
  expect(JSON.stringify(outputs)).not.toContain('postgresql');
  const audit=await pool.query("SELECT maintenance_reference FROM instance_settings_events WHERE kind='activation'");
  expect(audit.rows).toHaveLength(3);
 });
});
