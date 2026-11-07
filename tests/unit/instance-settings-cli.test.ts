import { describe,it,expect } from "vitest";
import { reconcileSettingsSeeds, exportSettingsSeed, runInstanceSettingsCommand } from "../../services/runtime/src/settings-operator.js";
import { bootstrap,runtimePolicy } from "../helpers/instance-settings-runtime.js";
describe('settings operator',()=>{
 it('exports effective role configuration without secrets or shell text',()=>{
   const exported=exportSettingsSeed({...bootstrap(),castAutoMatchEnabled:false});
   expect(exported.snapshot.castAutoMatchEnabled).toBe(false);
   expect(JSON.stringify(exported)).not.toContain('postgresql');
   expect(reconcileSettingsSeeds([exported],runtimePolicy())).toEqual(exported.snapshot);
 });
 it('rejects inconsistent role snapshots and missing intended roles',()=>{
   const seed=exportSettingsSeed(bootstrap());
   expect(()=>reconcileSettingsSeeds([seed,{...seed,snapshot:{...seed.snapshot,logLevel:'debug'}}],runtimePolicy())).toThrow('settings_seed_inconsistent');
   expect(()=>reconcileSettingsSeeds([],runtimePolicy())).toThrow('settings_seed_roles_missing');
 });
 it('rejects unknown commands before using any ports',async()=>{
   expect(await runInstanceSettingsCommand(['restart'],{output:()=>{}} as never)).toBe(1);
 });
});
