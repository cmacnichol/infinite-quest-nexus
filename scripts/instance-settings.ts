import { recoverRequestAdmission } from "../services/runtime/src/admission-recovery.js";
import { readFile } from "node:fs/promises";
import { createDatabasePool, initialOwnerId, loadRuntimeConfig } from "../packages/database/src/index.js";
import { createInstanceSettingsRepository } from "../packages/database/src/instance-settings-repository.js";
import { instanceSettingsSchema } from "../packages/contracts/src/instance-settings.js";
import { loadDeploymentSettingsPolicy, settingsDigest, loadActiveRuntimeSettings, readSettingsRuntimeReports, settingsReportsCompatible } from "../services/runtime/src/instance-settings.js";
import { createSettingsActivationGuard } from "../services/runtime/src/settings-activation.js";
import { exportSettingsSeed, runInstanceSettingsCommand, runAdmissionRecoveryCommand } from "../services/runtime/src/settings-operator.js";
const output=(value:unknown)=>process.stdout.write(JSON.stringify(value)+'\n');
try {
  const config=loadRuntimeConfig();
  const args=process.argv.slice(2);
  if(args[0]==='export-seed') {output(exportSettingsSeed(config));}
  else if(args[0]==='recover-admission') {
    const pool=createDatabasePool(config.databaseUrl,config.databaseMaxConnections);
    try {
      process.exitCode=await runAdmissionRecoveryCommand(args,{output,
        readJson:async path=>JSON.parse(await readFile(path,'utf8')),
        recoverAdmission:input=>recoverRequestAdmission(pool,input)});
    } finally {await pool.end();}
  } else {
    const policy=loadDeploymentSettingsPolicy(config.instanceSettingsPolicyFile??'');
    const pool=createDatabasePool(config.databaseUrl,config.databaseMaxConnections);
    try {
      const repository=createInstanceSettingsRepository(pool,{activationGuard:createSettingsActivationGuard(policy)});
      process.exitCode=await runInstanceSettingsCommand(args,{
        config,policy,repository,actor:{userId:await initialOwnerId(pool),cliReference:'settings-operator-cli'},output,
        recoverAdmission:input=>recoverRequestAdmission(pool,input),
        readJson:async path=>JSON.parse(await readFile(path,'utf8')),
        readRevision:async revision=>{if(!/^[1-9]\d*$/.test(revision))throw new Error('settings_revision_invalid');const {rows:[row]}=await pool.query('SELECT snapshot FROM instance_settings_revisions WHERE revision=$1',[revision]);return instanceSettingsSchema.parse(row?.snapshot);},
        status:async()=>{
          const state=await repository.read();
          const reports=await readSettingsRuntimeReports(pool);
          const resolved=await loadActiveRuntimeSettings(pool,config,policy);
          const ready=state.mode==='database'&&settingsReportsCompatible(reports,resolved,policy,true);
          return {mode:state.mode,activeRevision:state.activeRevision,requestedRevision:state.requestedRevision,activationEpoch:state.activationEpoch,policyDigest:settingsDigest(policy),ready,reports};
        }
      });
    } finally {await pool.end();}
  }
} catch {output({status:'error',code:'settings_operator_initialization_failed'});process.exitCode=1;}
