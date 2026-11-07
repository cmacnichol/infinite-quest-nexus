import { z } from "zod";
import { withTransaction, initialOwnerId, type DatabasePool } from "../../../packages/database/src/pool.js";
const recoverySchema=z.object({
  leaseId:z.uuid(),ownerUserId:z.uuid(),requestId:z.string().min(1).max(200),operation:z.enum(["provider","import"]),
  maintenanceReference:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,199}$/),
  verifiedShutdown:z.literal("all-api-processes-stopped-and-work-terminated")
}).strict();
/** Offline operator port only. Absence of heartbeats never proves shutdown. */
export async function recoverRequestAdmission(pool:DatabasePool,input:unknown):Promise<{recovered:boolean;maintenanceReference:string}> {
  const parsed=recoverySchema.safeParse(input);
  if(!parsed.success)throw new Error("settings_admission_recovery_attestation_required");
  const request=parsed.data;
  return withTransaction(pool,async client=>{
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SELECT pg_advisory_xact_lock(1936942451)");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${request.ownerUserId}:${request.operation}`]);
    await client.query("LOCK TABLE api_admission_leases,instance_settings_runtime_reports IN SHARE MODE");
    const live=await client.query("SELECT 1 FROM instance_settings_runtime_reports WHERE role IN ('api','all') AND heartbeat_at>clock_timestamp()-interval '30 seconds' LIMIT 1");
    if(live.rowCount)throw new Error("settings_runtime_not_drained");
    const result=await client.query(`DELETE FROM api_admission_leases WHERE id=$1 AND owner_user_id=$2 AND request_id=$3 AND operation=$4 AND request_running=true`,
      [request.leaseId,request.ownerUserId,request.requestId,request.operation]);
    if(result.rowCount===1) await client.query(`INSERT INTO api_admission_recoveries(lease_id,owner_user_id,operation,request_id,maintenance_reference,actor_user_id)
      VALUES($1,$2,$3,$4,$5,$6)`,[request.leaseId,request.ownerUserId,request.operation,request.requestId,request.maintenanceReference,await initialOwnerId(client)]);
    return {recovered:result.rowCount===1,maintenanceReference:request.maintenanceReference};
  });
}
