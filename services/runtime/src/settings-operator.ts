import { INSTANCE_SETTING_FIELDS, valueAt, resolveInstanceSettings } from "../../../packages/domain/src/instance-settings.js";
import { z } from "zod";
import { deploymentSettingsPolicySchema, instanceSettingsSchema, runtimeRoleCapacitySchema, type DeploymentSettingsPolicy, type InstanceSettings } from "../../../packages/contracts/src/instance-settings.js";
import { validateSettingsPolicy, type SettingsActor, type SettingsRepositoryPort } from "../../../packages/application/src/settings/index.js";
import type { RuntimeConfig } from "../../../packages/database/src/index.js";
import { projectRuntimeSettings, settingsDigest, SETTINGS_PROTOCOL_VERSION } from "./instance-settings.js";
const seedSchema=z.object({version:z.literal(1),role:runtimeRoleCapacitySchema,snapshot:instanceSettingsSchema.partial({castPresetsEnabled:true,castContextWithoutDiscoveryEnabled:true}),digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type SettingsSeedExport=Omit<z.infer<typeof seedSchema>, "snapshot"> & { snapshot: InstanceSettings };
export function exportSettingsSeed(config:RuntimeConfig):SettingsSeedExport {
  const snapshot=projectRuntimeSettings(config);
  return {version:1,role:{role:config.role,databaseMaxConnections:config.databaseMaxConnections},snapshot,digest:settingsDigest(snapshot)};
}
export function reconcileSettingsSeeds(input:unknown,policy:DeploymentSettingsPolicy):InstanceSettings {
  const seeds=z.array(seedSchema).parse(input);
  if(!seeds.length) throw new Error('settings_seed_roles_missing');
  const original=seeds[0]!.snapshot;
  for(const seed of seeds) if(seed.digest!==settingsDigest(seed.snapshot) || settingsDigest(seed.snapshot)!==settingsDigest(original)) throw new Error('settings_seed_inconsistent');
  const snapshot=instanceSettingsSchema.parse({castPresetsEnabled:false,castContextWithoutDiscoveryEnabled:false,...original});
  for(const intended of policy.expectedRoles) if(seeds.filter(seed=>seed.role.role===intended.role && seed.role.databaseMaxConnections===intended.databaseMaxConnections).length!==intended.replicas) throw new Error('settings_seed_roles_missing');
  if(seeds.length!==policy.expectedRoles.reduce((n,r)=>n+r.replicas,0)) throw new Error('settings_seed_roles_unexpected');
  validateSettingsPolicy(snapshot,policy,resolveInstanceSettings);
  return snapshot;
}
export function createSeedPolicy(input: unknown, installationId: string): DeploymentSettingsPolicy {
  const seeds = z.array(seedSchema).min(1).parse(input);
  const snapshot = instanceSettingsSchema.parse({ castPresetsEnabled: false, castContextWithoutDiscoveryEnabled: false, ...seeds[0]!.snapshot });
  const roles = new Map<string, { role: string; replicas: number; databaseMaxConnections: number }>();
  for (const { role } of seeds) {
    const existing = roles.get(role.role);
    if (existing && existing.databaseMaxConnections !== role.databaseMaxConnections) throw new Error("settings_seed_inconsistent");
    roles.set(role.role, { ...role, replicas: (existing?.replicas ?? 0) + 1 });
  }
  const numericBounds = Object.fromEntries(INSTANCE_SETTING_FIELDS.filter(f => f.kind === "integer").map(f => {
    const value = valueAt(snapshot, f.key);
    return [f.key, { min: value, max: value }];
  }));
  const policy = deploymentSettingsPolicySchema.parse({
    version: 2, installationId, minimumSettingsProtocolVersion: 1, systemArchiveAllowLimitIncrease: false,
    expectedRoles: [...roles.values()], numericBounds,
    featureGates: Object.fromEntries(INSTANCE_SETTING_FIELDS.filter(f => f.kind === "boolean").map(f => [f.key, valueAt(snapshot, f.key)])),
    approvedRateTuples: [{ windowSeconds: snapshot.apiRateLimitWindowSeconds, providerRequests: snapshot.apiRateLimitProviderRequests,
      generationRequests: snapshot.apiRateLimitGenerationRequests, importRequests: snapshot.apiRateLimitImportRequests }]
  });
  reconcileSettingsSeeds(seeds, policy);
  return policy;
}

/** A fixed policy derived from the original seed, never the current requested revision. */
export function createLocalSingleUserPolicy(snapshot: InstanceSettings, installationId: string, databaseMaxConnections: number): DeploymentSettingsPolicy {
  const seed = { version: 1 as const, role: { role: "all" as const, databaseMaxConnections }, snapshot, digest: settingsDigest(snapshot) };
  const policy = createSeedPolicy([seed], installationId);
  policy.featureGates.castPresetsEnabled = true;
  policy.featureGates.castContextWithoutDiscoveryEnabled = true;
  policy.featureGates.castContextEnabled = true;
  policy.featureGates.castEditingEnabled = true;
  policy.numericBounds.workerPollIntervalMs = { min: snapshot.workerPollIntervalMs, max: 60000 };
  policy.numericBounds.workerGenerationConcurrency = { min: 1, max: snapshot.workerGenerationConcurrency };
  return policy;
}

export function exportCompatibilityEnvironment(snapshot: InstanceSettings): Record<string, string> {
  const checked = instanceSettingsSchema.parse(snapshot);
  return Object.fromEntries(INSTANCE_SETTING_FIELDS.map(field => [field.environmentName, String(valueAt(checked, field.key))]));
}

export type SettingsOperatorPorts={
  config:RuntimeConfig;policy:DeploymentSettingsPolicy;repository:SettingsRepositoryPort;actor:SettingsActor;
  readJson(path:string):Promise<unknown>;readRevision(revision:string):Promise<InstanceSettings>;
  recoverAdmission?(input:unknown):Promise<unknown>;
  status():Promise<unknown>; output(value:unknown):void;
};
/** No process-execution port exists: this tool records changes, never controls deployment. */
export async function runInstanceSettingsCommand(args:readonly string[],ports:SettingsOperatorPorts):Promise<number> {
  if(args[0]==='recover-admission') return runAdmissionRecoveryCommand(args,ports);
  try {
    const [command,...rest]=args;
    if(!['export-seed','seed','propose','status','validate','activate','propose-rollback','recover-admission'].includes(command??'')) throw new Error('settings_command_invalid');
    const options=new Map<string,string>();
    for(let i=0;i<rest.length;i+=2) {
      const key=rest[i],value=rest[i+1];
      if(!key?.startsWith('--')||!value||options.has(key)||!['--input','--expected-active','--expected-requested','--maintenance','--revision','--expected-epoch'].includes(key)) throw new Error('settings_arguments_invalid');
      options.set(key,value);
    }
    const required=(key:string)=>{const value=options.get(key);if(!value)throw new Error('settings_argument_required');return value;};
    if(command==='export-seed') {ports.output(exportSettingsSeed(ports.config));return 0;}
    if(command==='status') {ports.output(await ports.status());return 0;}
    if(ports.policy.minimumSettingsProtocolVersion>SETTINGS_PROTOCOL_VERSION) throw new Error('settings_protocol_unsupported');
    const policyDigest=settingsDigest(ports.policy);
    if(command==='seed') {
      const snapshot=reconcileSettingsSeeds(await ports.readJson(required('--input')),ports.policy);
      const state=await ports.repository.seed({installationId:ports.policy.installationId,snapshot,policyDigest,seedDigest:settingsDigest(snapshot),actor:ports.actor});
      ports.output({mode:state.mode,activeRevision:state.activeRevision,requestedRevision:state.requestedRevision,policyDigest});return 0;
    }
    const state=await ports.repository.read();
    if(state.installationId!==ports.policy.installationId) throw new Error('settings_installation_mismatch');
    if(command==='activate') {
      const active=required('--expected-active');
      await ports.repository.activate({...(options.has('--expected-epoch') ? {expectedEpoch:required('--expected-epoch')} : {}),expectedActiveRevision:active==='null'?null:active,expectedRequestedRevision:required('--expected-requested'),policyDigest,maintenanceReference:required('--maintenance'),actor:ports.actor});
    } else if(command==='propose'||command==='propose-rollback') {
      const snapshot=command==='propose'?instanceSettingsSchema.parse(await ports.readJson(required('--input'))):await ports.readRevision(required('--revision'));
      validateSettingsPolicy(snapshot,ports.policy,resolveInstanceSettings);
      await ports.repository.propose({expectedRequestedRevision:required('--expected-requested'),snapshot,policyDigest,actor:ports.actor,reason:'operator_policy_review',kind:command==='propose-rollback'?'rollback':'proposal'});
    } else {
      if(!state.requested)throw new Error('settings_uninitialized');
      validateSettingsPolicy(state.requested,ports.policy,resolveInstanceSettings);
      if(state.policyDigest!==policyDigest) throw new Error('settings_policy_revalidation_required');
    }
    ports.output({status:'ok',command});return 0;
  } catch(error) {
    // Fixed codes only. Never print database errors, file contents, paths or credentials.
    const code=error instanceof Error && /^settings_[a-z_]+$/.test(error.message)?error.message:'settings_command_failed';
    ports.output({status:'error',code});return 1;
  }
}

/** Recovery needs database authority and explicit shutdown evidence, never a settings policy. */
export async function runAdmissionRecoveryCommand(args:readonly string[],ports:Pick<SettingsOperatorPorts,"readJson"|"recoverAdmission"|"output">):Promise<number> {
  try {
    if(args.length!==3||args[0]!=="recover-admission"||args[1]!=="--input"||!args[2])throw new Error("settings_arguments_invalid");
    if(!ports.recoverAdmission)throw new Error("settings_admission_recovery_unavailable");
    const result=await ports.recoverAdmission(await ports.readJson(args[2]));
    ports.output({status:"ok",command:"recover-admission",result});return 0;
  }catch(error){
    const code=error instanceof Error&&/^settings_[a-z_]+$/.test(error.message)?error.message:"settings_command_failed";
    ports.output({status:"error",code});return 1;
  }
}
