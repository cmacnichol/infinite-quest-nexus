import { readFileSync } from "node:fs";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import type { RuntimeConfig } from "../../../packages/database/src/config.js";
import { createSettingsOperatorRepository } from "../../../packages/database/src/settings-operator-repository.js";
import { createInstanceSettingsRepository } from "../../../packages/database/src/instance-settings-repository.js";
import { createSettingsUseCases, SettingsConflictError, type SettingsState } from "../../../packages/application/src/settings/index.js";
import { instanceSettingsHistorySchema, instanceSettingsPatchSchema, instanceSettingsViewSchema, settingsFeatureGatesSchema, type SettingsFeatureKey } from "../../../packages/contracts/src/instance-settings.js";
import { resolveInstanceSettings, INSTANCE_SETTING_FIELDS } from "../../../packages/domain/src/instance-settings.js";
import { loadDeploymentSettingsPolicy, projectRuntimeSettings, settingsDigest } from "../../runtime/src/instance-settings.js";
import { createSettingsOperatorSessions, SettingsHttpError } from "./settings-operator-session.js";
export function createInstanceSettingsHttpComposition(pool: DatabasePool, bootstrap: RuntimeConfig) {
  const repository=createInstanceSettingsRepository(pool);
  // Mount failures lock only installation management in environment mode.
  const readKey=()=>{try{return bootstrap.settingsManagementEnabled && bootstrap.settingsManagementKeyFile ? readFileSync(bootstrap.settingsManagementKeyFile,"utf8").trim():undefined;}catch{return undefined;}};
  const policy=()=>{try{return bootstrap.instanceSettingsPolicyFile?loadDeploymentSettingsPolicy(bootstrap.instanceSettingsPolicyFile):undefined;}catch{return undefined;}};
  const enabled=()=>{const mounted=policy();return !!mounted && mounted.minimumSettingsProtocolVersion<=1 && Buffer.byteLength(readKey()??"")>=32;};
  const currentPolicy=()=>{const value=policy();if(!value || value.minimumSettingsProtocolVersion>1)throw new SettingsHttpError(503,"settings_management_disabled");return value;};
  const constrainedPolicy=()=>{const value=currentPolicy();const gates={...value.featureGates};for(const key of Object.keys(settingsFeatureGatesSchema.shape) as SettingsFeatureKey[])gates[key]=gates[key]&&bootstrap[key]===true;return {...value,featureGates:gates};};
  const view=async(state:SettingsState)=>{
    const mounted=currentPolicy();
    const active=state.mode==="environment"?projectRuntimeSettings(bootstrap):state.active;
    if(!active)throw new SettingsHttpError(503,"settings_unavailable");
    const resolution=resolveInstanceSettings(active,constrainedPolicy(),{role:bootstrap.role,databaseMaxConnections:bootstrap.databaseMaxConnections});
    if(!resolution.ok)throw new SettingsHttpError(503,"settings_policy_rejected");
    if(state.installationId!==mounted.installationId && state.requestedRevision)throw new SettingsHttpError(503,"settings_policy_mismatch");
    return instanceSettingsViewSchema.parse({activeRevision:state.activeRevision,requestedRevision:state.requestedRevision,active:state.mode==="environment"?active:resolution.effective,requested:state.requested,fields:resolution.fields.map(field=>({...field,source:state.mode==="environment"?"environment":"database"})),activationStatus:state.mode==="environment"?(state.requestedRevision?"restart_required":"environment"):state.activeRevision===state.requestedRevision?"active":"restart_required"});
  };
  return {enabled,operatorSessions:createSettingsOperatorSessions(createSettingsOperatorRepository(pool),readKey),settings:{
    read:async()=>view(await repository.read()),
    patch:async(input:unknown,actor:{userId:string;operatorSessionId:string})=>{
      const patch=instanceSettingsPatchSchema.parse(input),state=await repository.read(),mounted=currentPolicy(),effectivePolicy=constrainedPolicy();
      if(!state.requested)throw new SettingsHttpError(503,"settings_uninitialized");
      if(state.installationId!==mounted.installationId || state.policyDigest!==settingsDigest(mounted))throw new SettingsHttpError(503,"settings_policy_mismatch");
      if(state.requestedRevision!==patch.expectedRequestedRevision)throw new SettingsConflictError(state.requestedRevision);
      for(const key of Object.keys(settingsFeatureGatesSchema.shape) as SettingsFeatureKey[])if(patch.changes[key]===true && !effectivePolicy.featureGates[key])throw new SettingsHttpError(422,"settings_deployment_disabled");
      try {return await view(await createSettingsUseCases(repository,effectivePolicy,resolveInstanceSettings).propose(patch,actor));}
      catch(error){if(error instanceof SettingsConflictError)throw error;if(error instanceof Error && error.message==="settings_policy_rejected")throw new SettingsHttpError(422,"settings_policy_rejected");throw error;}
    },
    history:async(cursor:string|undefined,limit:number)=>{
      const state=await repository.read();
      if(state.requestedRevision && state.installationId!==currentPolicy().installationId)throw new SettingsHttpError(503,"settings_policy_mismatch");
      const rows=(await pool.query(`SELECT id::text,kind,revision,actor_user_id,operator_session_id,reason_code,changed_keys,created_at FROM instance_settings_events WHERE ($1::bigint IS NULL OR id<$1::bigint) ORDER BY instance_settings_events.id DESC LIMIT $2`,[cursor??null,limit+1])).rows;
      const allowed=new Set<string>(INSTANCE_SETTING_FIELDS.map(field=>field.key));
      const events=rows.slice(0,limit).map(row=>({id:row.id,kind:row.kind,revision:row.revision,actorUserId:row.actor_user_id,operatorSessionId:row.operator_session_id,reasonCode:row.reason_code,changedKeys:Array.isArray(row.changed_keys)?row.changed_keys.filter((key:unknown)=>typeof key==="string"&&allowed.has(key)):[],createdAt:new Date(row.created_at).toISOString()}));
      return instanceSettingsHistorySchema.parse({events,nextCursor:rows.length>limit?events.at(-1)!.id:null});
    }
  }};
}
