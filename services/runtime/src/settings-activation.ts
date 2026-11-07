import { resolveInstanceSettings } from "../../../packages/domain/src/instance-settings.js";
import { validateSettingsPolicy } from "../../../packages/application/src/settings/index.js";
import type { DeploymentSettingsPolicy } from "../../../packages/contracts/src/instance-settings.js";
import type { SettingsActivationGuard } from "../../../packages/database/src/instance-settings-repository.js";
import { SETTINGS_PROTOCOL_VERSION, settingsDigest } from "./instance-settings.js";
/** Runs under the repository's advisory and singleton locks. Deployment shutdown evidence
 * remains an explicit operator attestation; stale reports never supply that evidence. */
export function createSettingsActivationGuard(policy:DeploymentSettingsPolicy):SettingsActivationGuard {
  return async (client,state,request)=>{
    await client.query("SET LOCAL lock_timeout='5s'");
    if(!/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,199}$/.test(request.maintenanceReference)) throw new Error('settings_maintenance_reference_required');
    if(state.schemaVersion!==1) throw new Error('settings_schema_unsupported');
    if(policy.minimumSettingsProtocolVersion>SETTINGS_PROTOCOL_VERSION) throw new Error('settings_protocol_unsupported');
    if(state.installationId!==policy.installationId || request.policyDigest!==settingsDigest(policy)) throw new Error('settings_policy_mismatch');
    if(!state.requested) throw new Error('settings_uninitialized');
    validateSettingsPolicy(state.requested,policy,resolveInstanceSettings);
    // Discover every durable lease table, including future lanes. Table identifiers come
    // only from PostgreSQL's catalog and are quoted, never from operator input.
    const leases=await client.query<{table_name:string;column_name:string}>(`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND (column_name='lease_expires_at' OR (table_name='text_provider_capacity_leases' AND column_name='expires_at')) ORDER BY table_name`);
    const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
    const tables=[...new Set([...leases.rows.map(r=>r.table_name),'prepared_text_physical_attempts','instance_settings_runtime_reports'])].sort();
    // Block claims/invocations/report insertion across the final guard and activation commit.
    await client.query('LOCK TABLE '+tables.map(quote).join(',')+' IN SHARE MODE');
    for(const row of leases.rows) {
      const active=await client.query('SELECT 1 FROM '+quote(row.table_name)+' WHERE '+quote(row.column_name)+' > clock_timestamp() LIMIT 1');
      if(active.rowCount) throw new Error('settings_active_leases');
    }
    const attempts=await client.query("SELECT 1 FROM prepared_text_physical_attempts WHERE status IN ('reserved','dispatched') LIMIT 1");
    if(attempts.rowCount) throw new Error('settings_active_invocations');
    const reports=await client.query("SELECT 1 FROM instance_settings_runtime_reports WHERE heartbeat_at>clock_timestamp()-interval '30 seconds' LIMIT 1");
    if(reports.rowCount) throw new Error('settings_runtime_not_drained');
  };
}
