import { describe, it, expect } from "vitest";
import { settingsFixture } from "../fixtures/instance-settings.js";
import { projectRuntimeSettings, mergeRuntimeSettings, settingsDigest, resolveRuntimeSettingsState, settingsReportsCompatible } from "../../services/runtime/src/instance-settings.js";
import { bootstrap, runtimePolicy } from "../helpers/instance-settings-runtime.js";
const environment = {installationId:null,mode:'environment' as const,schemaVersion:1,activeRevision:null,requestedRevision:null,activationEpoch:'0',active:null,requested:null,policyDigest:null};
describe('runtime installation settings',()=>{
  it('applies the archive capacity dependency at startup with the same disabled-gate semantics',()=>{
    const policy=runtimePolicy(), snapshot=settingsFixture();
    snapshot.systemArchiveLimits.maxCompressedBytes=1;
    const state={...environment,installationId:policy.installationId,mode:'database' as const,activeRevision:'1',requestedRevision:'1',active:snapshot,requested:snapshot,policyDigest:settingsDigest(policy)};
    expect(()=>resolveRuntimeSettingsState(state,bootstrap(),policy)).toThrow('settings_policy_rejected');
    const disabled={...snapshot,systemArchiveEnabled:false};
    expect(resolveRuntimeSettingsState({...state,active:disabled,requested:disabled},bootstrap(),policy).config.systemArchiveEnabled).toBe(false);
    policy.featureGates.systemArchiveEnabled=false;
    expect(resolveRuntimeSettingsState({...state,policyDigest:settingsDigest(policy)},bootstrap(),policy).config.systemArchiveEnabled).toBe(false);
  });
  it('counts compatible registration separately from serving readiness and rejects stale or divergent reports',()=>{
    const resolved=resolveRuntimeSettingsState(environment,bootstrap(),runtimePolicy());
    const report={role:'worker',protocol_version:1,active_revision:null,policy_digest:resolved.policyDigest,activation_epoch:'0',effective_configuration_digest:resolved.effectiveDigest,fresh:true,readiness_state:'blocked'};
    expect(settingsReportsCompatible([report],resolved,runtimePolicy(),false)).toBe(true);
    expect(settingsReportsCompatible([report],resolved,runtimePolicy(),true)).toBe(false);
    expect(settingsReportsCompatible([{...report,fresh:false}],resolved,runtimePolicy(),false)).toBe(false);
    expect(settingsReportsCompatible([{...report,effective_configuration_digest:'wrong'}],resolved,runtimePolicy(),false)).toBe(false);
    expect(settingsReportsCompatible([],resolved,runtimePolicy(),false)).toBe(false);
  });
  it('projects only effective runtime controls and preserves false gates',()=>{
    const config={...bootstrap(),castEditingEnabled:false};
    const projected=projectRuntimeSettings(config);
    expect(projected.castEditingEnabled).toBe(false);
    expect(projected).not.toHaveProperty('databaseUrl');
    expect(projected).not.toHaveProperty('credentialEncryptionKey');
    expect(mergeRuntimeSettings(config,{...projected,apiDefaultBodyLimitBytes:123456}).security.apiDefaultBodyLimitBytes).toBe(123456);
  });
  it('preserves environment startup without requiring a policy',()=>{
    const config=bootstrap();
    expect(resolveRuntimeSettingsState(environment,config).config).toBe(config);
  });
  it('rejects missing policy, unsupported schema and incompatible protocol in database mode',()=>{
    const policy=runtimePolicy(), snapshot=settingsFixture();
    const state={...environment,installationId:policy.installationId,mode:'database' as const,activeRevision:'1',requestedRevision:'1',active:snapshot,requested:snapshot,policyDigest:settingsDigest(policy)};
    expect(()=>resolveRuntimeSettingsState(state,bootstrap())).toThrow('settings_policy_required');
    expect(()=>resolveRuntimeSettingsState({...state,schemaVersion:2},bootstrap(),policy)).toThrow('settings_schema_unsupported');
    expect(()=>resolveRuntimeSettingsState(state,bootstrap(),{...policy,minimumSettingsProtocolVersion:2})).toThrow('settings_protocol_unsupported');
    expect(resolveRuntimeSettingsState(state,bootstrap(),policy).activeRevision).toBe('1');
  });
});
