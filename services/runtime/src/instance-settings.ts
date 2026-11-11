import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { deploymentSettingsPolicySchema, instanceSettingsSchema, settingsFeatureGatesSchema, type DeploymentSettingsPolicy, type InstanceSettings } from "../../../packages/contracts/src/instance-settings.js";
import { deriveSettingsPolicyForLocalMode, LOCAL_PANEL_GATES, resolveInstanceSettings, resolveRequestPolicy } from "../../../packages/domain/src/instance-settings.js";
import { validateSettingsPolicy, type SettingsState } from "../../../packages/application/src/settings/index.js";
import { createInstanceSettingsRepository } from "../../../packages/database/src/instance-settings-repository.js";
import { withTransaction } from "../../../packages/database/src/pool.js";
import type { DatabasePool, RuntimeConfig } from "../../../packages/database/src/index.js";
export const SETTINGS_PROTOCOL_VERSION = 1;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));
  return value;
}
export function settingsDigest(value: unknown): string { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
export function loadDeploymentSettingsPolicy(path: string): DeploymentSettingsPolicy {
  if (!path) throw new Error("settings_policy_required");
  return deploymentSettingsPolicySchema.parse(JSON.parse(readFileSync(path,"utf8")));
}
export function projectRuntimeSettings(config: RuntimeConfig): InstanceSettings {
  return instanceSettingsSchema.parse(Object.fromEntries(Object.entries({...config,...config.security,logLevel:config.logLevel ?? "info"}).filter(([key])=>key in instanceSettingsSchema.shape)));
}
export function mergeRuntimeSettings(config: RuntimeConfig, snapshot: InstanceSettings): RuntimeConfig {
  const security = {...config.security};
  const application = {...config};
  for (const [key,value] of Object.entries(snapshot)) {
    if (key in security) Object.assign(security,{[key]:value});
    else Object.assign(application,{[key]:value});
  }
  return {...application,security};
}
export type ResolvedRuntimeSettings = {config:RuntimeConfig; mode:"environment"|"database";activeRevision:string|null;policyDigest:string;activationEpoch:string;effectiveDigest:string};
export function resolveRuntimeSettingsState(state:SettingsState, bootstrap:RuntimeConfig, policy?:DeploymentSettingsPolicy):ResolvedRuntimeSettings {
  if(state.schemaVersion!==1) throw new Error("settings_schema_unsupported");
  if(state.mode==='environment') return {config:bootstrap,mode:'environment',activeRevision:null,policyDigest:policy?settingsDigest(policy):settingsDigest(null),activationEpoch:state.activationEpoch,effectiveDigest:settingsDigest(projectRuntimeSettings(bootstrap))};
  if(!policy) throw new Error('settings_policy_required');
  if(policy.minimumSettingsProtocolVersion>SETTINGS_PROTOCOL_VERSION) throw new Error('settings_protocol_unsupported');
  if(state.installationId!==policy.installationId || state.policyDigest!==settingsDigest(policy)) throw new Error('settings_policy_mismatch');
  if (policy.systemArchiveAllowLimitIncrease && bootstrap.systemArchiveAllowLimitIncrease !== true) throw new Error("settings_deployment_divergence");
  if(!state.active || !state.activeRevision) throw new Error('settings_active_missing');
  if(!policy.expectedRoles.some(r=>r.role===bootstrap.role && r.databaseMaxConnections===bootstrap.databaseMaxConnections)) throw new Error('settings_role_mismatch');
  const effectivePolicy = deriveSettingsPolicyForLocalMode(policy, bootstrap.instanceSettingsAccessMode === "local-single-user" && !bootstrap.instanceSettingsPolicyFile, bootstrap.castLifecycleEnabled);
  validateSettingsPolicy(state.active,effectivePolicy,resolveInstanceSettings);
  const gates=Object.fromEntries(Object.keys(settingsFeatureGatesSchema.shape).map(key => [key, effectivePolicy.featureGates[key as keyof typeof effectivePolicy.featureGates]])) as typeof policy.featureGates;
  for(const key of Object.keys(settingsFeatureGatesSchema.shape) as (keyof typeof gates)[]) gates[key] = gates[key] === true && (bootstrap.instanceSettingsAccessMode === "local-single-user" && LOCAL_PANEL_GATES.has(key) || bootstrap[key]===true);
  const resolved=resolveInstanceSettings(state.active,{...effectivePolicy,featureGates:gates},{role:bootstrap.role,databaseMaxConnections:bootstrap.databaseMaxConnections});
  if(!resolved.ok) throw new Error('settings_policy_rejected');
  // Emergency deployment disables are honored but divergence cannot become healthy.
  const permitted=resolveInstanceSettings(state.active,effectivePolicy,{role:bootstrap.role,databaseMaxConnections:bootstrap.databaseMaxConnections});
  if(!permitted.ok || settingsDigest(resolved.effective)!==settingsDigest(permitted.effective)) throw new Error('settings_deployment_divergence');
  const merged=mergeRuntimeSettings(bootstrap,resolved.effective);
  const config={...merged,security:{...merged.security,...resolveRequestPolicy(resolved.effective,effectivePolicy)},instanceSettingsRevision:state.activeRevision};
  return {config,mode:'database',activeRevision:state.activeRevision,policyDigest:settingsDigest(policy),activationEpoch:state.activationEpoch,effectiveDigest:settingsDigest(resolved.effective)};
}
export async function loadActiveRuntimeSettings(pool:DatabasePool,bootstrap:RuntimeConfig,policy?:DeploymentSettingsPolicy):Promise<ResolvedRuntimeSettings> {
  const state=await createInstanceSettingsRepository(pool, { legacyLifecycleEnabled: bootstrap.castLifecycleEnabled }).read();
  // The requested revision can carry a new policy while the old revision remains active.
  if(state.activeRevision) {
    const {rows:[active]}=await pool.query('SELECT policy_digest FROM instance_settings_revisions WHERE revision=$1',[state.activeRevision]);
    state.policyDigest=active.policy_digest;
  }
  return resolveRuntimeSettingsState(state,bootstrap,policy);
}
export type SettingsRuntimeReport={role:string;protocol_version:number;active_revision:string|null;policy_digest:string;activation_epoch:string;effective_configuration_digest:string;fresh:boolean;readiness_state:string};
export function settingsReportsCompatible(reports:SettingsRuntimeReport[],resolved:ResolvedRuntimeSettings,policy:DeploymentSettingsPolicy,requireReady:boolean):boolean {
  const fresh = reports.filter(report => report.fresh);
  if (fresh.some(report => report.protocol_version !== SETTINGS_PROTOCOL_VERSION ||
      report.active_revision !== resolved.activeRevision || report.policy_digest !== resolved.policyDigest ||
      report.activation_epoch !== resolved.activationEpoch || report.effective_configuration_digest !== resolved.effectiveDigest ||
      !["ready", "blocked", "stopping"].includes(report.readiness_state) ||
      !policy.expectedRoles.some(role => role.role === report.role))) return false;
  return policy.expectedRoles.every(role => {
    const members = fresh.filter(report => report.role === role.role);
    const eligible = members.filter(report => report.readiness_state === "ready" || (!requireReady && report.readiness_state === "blocked"));
    return eligible.length >= role.replicas && members.length <= (role.maximumReplicas ?? role.replicas);
  });
}
export async function readSettingsRuntimeReports(pool:DatabasePool):Promise<SettingsRuntimeReport[]> {
  return (await pool.query<SettingsRuntimeReport>("SELECT role,build_version,protocol_version,active_revision,policy_digest,activation_epoch,effective_configuration_digest,readiness_state,heartbeat_at>clock_timestamp()-interval '30 seconds' AS fresh FROM instance_settings_runtime_reports")).rows;
}
export type SettingsRuntimeRegistration={dispose():Promise<void>;markReady():Promise<void>;isReady():Promise<boolean>;waitUntilCompatible():Promise<void>};
export async function registerSettingsRuntime(pool:DatabasePool,resolved:ResolvedRuntimeSettings,signal:AbortSignal,onFailure:()=>void,policy?:DeploymentSettingsPolicy):Promise<SettingsRuntimeRegistration> {
  const id=randomUUID();
  let stopped=false,draining=false,serving=false,failed=false,pending=Promise.resolve();
  const write=async()=>withTransaction(pool,async client=>{
    // Same lock as activation: no startup can publish an old epoch after activation.
    await client.query('SELECT pg_advisory_xact_lock(1936942451)');
    const {rows:[state]}=await client.query('SELECT mode,active_revision,activation_epoch FROM instance_settings_state');
    if(state.mode!==resolved.mode || state.active_revision!==resolved.activeRevision || state.activation_epoch!==resolved.activationEpoch) throw new Error('settings_runtime_epoch_changed');
    await client.query(`INSERT INTO instance_settings_runtime_reports(process_id,role,build_version,protocol_version,active_revision,policy_digest,activation_epoch,effective_configuration_digest,readiness_state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(process_id) DO UPDATE SET heartbeat_at=clock_timestamp(),readiness_state=EXCLUDED.readiness_state`,
      [id,resolved.config.role,process.env.NEXUS_BUILD_COMMIT||'development',SETTINGS_PROTOCOL_VERSION,resolved.activeRevision,resolved.policyDigest,resolved.activationEpoch,resolved.effectiveDigest,draining?'stopping':serving?'ready':'blocked']);
  });
  await write();
  const timer=setInterval(()=>{if(!stopped&&!failed) pending=pending.then(write).catch(()=>{failed=true;onFailure();});},10000);
  timer.unref();
  const abort=()=>{
    draining=true;
    pending=pending.then(write).catch(()=>{failed=true;onFailure();});
  };
  signal.addEventListener('abort',abort,{once:true});
  const compatible=async(requireReady:boolean)=>!failed&&!stopped&&(!policy||resolved.mode==='environment'||settingsReportsCompatible(await readSettingsRuntimeReports(pool),resolved,policy,requireReady));
  return {
    dispose:async()=>{stopped=true;clearInterval(timer);signal.removeEventListener('abort',abort);await pending;await pool.query('DELETE FROM instance_settings_runtime_reports WHERE process_id=$1',[id]);},
    markReady:async()=>{serving=true;await write();},
    isReady:async()=>{
      if(!serving || draining || !await compatible(true)) return false;
      const state=await createInstanceSettingsRepository(pool).read();
      return state.mode===resolved.mode&&state.activeRevision===resolved.activeRevision&&state.activationEpoch===resolved.activationEpoch;
    },
    waitUntilCompatible:async()=>{
      if(signal.aborted) throw new Error('settings_runtime_stopping');
      const deadline=Date.now()+30000;
      while(!await compatible(false)) {
        if(signal.aborted||Date.now()>=deadline) throw new Error('settings_runtime_roles_missing');
        await new Promise(resolve=>setTimeout(resolve,100));
      }
    }
  };
}
/** Compatibility wrapper for callers that only need reporting disposal. */
export async function startSettingsRuntimeReport(pool:DatabasePool,resolved:ResolvedRuntimeSettings,signal:AbortSignal,onFailure:()=>void):Promise<()=>Promise<void>> {
  const report=await registerSettingsRuntime(pool,resolved,signal,onFailure);
  try { await report.markReady(); return report.dispose; }
  catch (error) { await report.dispose(); throw error; }
}
