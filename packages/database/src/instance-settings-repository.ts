import { INSTANCE_SETTING_FIELDS } from "../../domain/src/instance-settings.js";
import { z } from "zod";
import { instanceSettingsSchema, settingsRevisionSchema } from "../../contracts/src/instance-settings.js";
import { SettingsConflictError, type SettingsActor, type SettingsState, type SettingsRepositoryPort } from "../../application/src/settings/index.js";
import { withTransaction, type DatabaseClient, type DatabasePool } from "./pool.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const actorSchema = z.union([
  z.object({ userId: z.string().uuid(), operatorSessionId: z.string().uuid() }).strict(),
  z.object({ userId: z.string().uuid(), localSingleUser: z.literal(true) }).strict(),
  z.object({ userId: z.string().uuid(), cliReference: z.string().trim().min(1).max(200) }).strict()
]);
async function checkActor(client: DatabaseClient, actor: SettingsActor): Promise<void> {
  actorSchema.parse(actor);
  if (actor.operatorSessionId) {
    const result = await client.query("SELECT id FROM settings_operator_sessions WHERE id=$1 AND actor_user_id=$2 AND expires_at>clock_timestamp()", [actor.operatorSessionId, actor.userId]);
    if (!result.rowCount) throw new Error("settings_operator_session_invalid");
  }
}
export async function readSettingsState(client: DatabaseClient | DatabasePool): Promise<SettingsState> {
  const { rows: [row] } = await client.query(`SELECT s.*,a.snapshot AS active,r.snapshot AS requested,r.policy_digest
    FROM instance_settings_state s LEFT JOIN instance_settings_revisions a ON a.revision=s.active_revision
    LEFT JOIN instance_settings_revisions r ON r.revision=s.requested_revision`);
  if (!row) throw new Error("settings_state_missing");
  return { installationId: row.installation_id, mode: row.mode, schemaVersion: row.schema_version,
    activeRevision: row.active_revision, requestedRevision: row.requested_revision, activationEpoch: row.activation_epoch,
    active: row.active === null ? null : instanceSettingsSchema.parse(row.active),
    requested: row.requested === null ? null : instanceSettingsSchema.parse(row.requested), policyDigest: row.policy_digest ?? null };
}
export async function lockSettingsState(client: DatabaseClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(1936942451)");
  await client.query("SELECT singleton FROM instance_settings_state FOR UPDATE");
}
async function event(client: DatabaseClient, kind: string, revision: string, actor: SettingsActor, reason: string, maintenanceReference: string | null = null, changedKeys: string[] = []): Promise<void> {
  await client.query(`INSERT INTO instance_settings_events(kind,revision,actor_user_id,operator_session_id,cli_reference,local_single_user,reason_code,maintenance_reference,changed_keys) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [kind, revision, actor.userId, actor.operatorSessionId ?? null, actor.cliReference ?? null, actor.localSingleUser ?? false, reason, maintenanceReference, changedKeys]);
}
/** A deployment adapter must verify all drained lanes/protocol/policy inside this transaction. */
export type SettingsActivationGuard = (client: DatabaseClient, state: SettingsState, request: import("../../application/src/settings/types.js").ActivationRequest) => Promise<void>;
export function createInstanceSettingsRepository(pool: DatabasePool, options: { activationGuard?: SettingsActivationGuard } = {}): SettingsRepositoryPort {
  return {
    read: () => readSettingsState(pool),
    async seed(input) {
      const snapshot = instanceSettingsSchema.parse(input.snapshot);
      digest.parse(input.policyDigest); digest.parse(input.seedDigest); z.string().uuid().parse(input.installationId);
      return withTransaction(pool, async (client) => {
        await lockSettingsState(client); await checkActor(client, input.actor);
        const state = await readSettingsState(client);
        if (state.requestedRevision) {
          const { rows: [existing] } = await client.query("SELECT seed_digest FROM instance_settings_state");
          if (existing.seed_digest !== input.seedDigest || state.installationId !== input.installationId) throw new Error("settings_seed_mismatch");
          return state;
        }
        await client.query(`INSERT INTO instance_settings_revisions(revision,snapshot,schema_version,actor_user_id,operator_session_id,cli_reference,local_single_user,kind,policy_digest)
          VALUES(1,$1,1,$2,$3,$4,$5,'seed',$6)`, [snapshot, input.actor.userId, input.actor.operatorSessionId ?? null, input.actor.cliReference ?? null, input.actor.localSingleUser ?? false, input.policyDigest]);
        await client.query("UPDATE instance_settings_state SET requested_revision=1,installation_id=$1,seed_digest=$2,updated_at=clock_timestamp()", [input.installationId, input.seedDigest]);
        await event(client, "seed", "1", input.actor, "seed_import");
        return readSettingsState(client);
      });
    },
    async propose(input) {
      const snapshot = instanceSettingsSchema.parse(input.snapshot);
      settingsRevisionSchema.parse(input.expectedRequestedRevision);
      z.string().trim().min(1).max(1000).parse(input.reason);
      const kind = z.enum(["proposal", "rollback"]).parse(input.kind ?? "proposal");
      return withTransaction(pool, async (client) => {
        await lockSettingsState(client); await checkActor(client, input.actor);
        const state = await readSettingsState(client);
        if (state.requestedRevision !== input.expectedRequestedRevision) throw new SettingsConflictError(state.requestedRevision);
        if (input.policyDigest !== undefined) digest.parse(input.policyDigest);
        const policyDigest = input.policyDigest ?? state.policyDigest;
        if (JSON.stringify(state.requested) === JSON.stringify(snapshot) && policyDigest === state.policyDigest) return state;
        const next = settingsRevisionSchema.parse((BigInt(input.expectedRequestedRevision) + 1n).toString());
        await client.query(`INSERT INTO instance_settings_revisions(revision,previous_revision,snapshot,schema_version,actor_user_id,operator_session_id,cli_reference,local_single_user,kind,policy_digest)
          VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9)`, [next, state.requestedRevision, snapshot, input.actor.userId, input.actor.operatorSessionId ?? null, input.actor.cliReference ?? null, input.actor.localSingleUser ?? false, kind, policyDigest]);
        const updated = await client.query("UPDATE instance_settings_state SET requested_revision=$1,updated_at=clock_timestamp() WHERE requested_revision=$2", [next, input.expectedRequestedRevision]);
        if (updated.rowCount !== 1) throw new SettingsConflictError(state.requestedRevision);
        // Audit a fixed code, never arbitrary operator text or setting values.
        const at = (value: unknown, key: string): unknown => key.split(".").reduce((item: any, part) => item?.[part], value);
        const changedKeys = INSTANCE_SETTING_FIELDS.filter(field => at(state.requested,field.key) !== at(snapshot,field.key)).map(field => field.key);
        await event(client, kind, next, input.actor, kind === "rollback" ? "operator_rollback" : "operator_change", null, changedKeys);
        return readSettingsState(client);
      });
    },
    async activate(input) {
      if (!options.activationGuard) throw new Error("settings_activation_guard_required");
      settingsRevisionSchema.parse(input.expectedRequestedRevision);
      if (input.expectedActiveRevision !== null) settingsRevisionSchema.parse(input.expectedActiveRevision);
      digest.parse(input.policyDigest); z.string().trim().min(1).max(200).parse(input.maintenanceReference);
      return withTransaction(pool, async (client) => {
        await lockSettingsState(client); await checkActor(client, input.actor);
        const state = await readSettingsState(client);
        if (state.activeRevision !== input.expectedActiveRevision || state.requestedRevision !== input.expectedRequestedRevision) throw new SettingsConflictError(state.requestedRevision);
        if ((input.expectedEpoch !== undefined || (state.mode === "environment" && state.activationEpoch !== "0")) &&
            input.expectedEpoch !== state.activationEpoch) throw new Error("settings_activation_epoch_mismatch");
        if (state.policyDigest !== input.policyDigest) throw new Error("settings_policy_mismatch");
        const live = await client.query("SELECT process_id FROM instance_settings_runtime_reports WHERE heartbeat_at > clock_timestamp()-interval '30 seconds' LIMIT 1");
        if (live.rowCount) throw new Error("settings_runtime_not_drained");
        await options.activationGuard!(client, state, input);
        await client.query("UPDATE instance_settings_state SET active_revision=requested_revision,mode='database',activation_epoch=activation_epoch+1,updated_at=clock_timestamp()");
        await event(client, "activation", input.expectedRequestedRevision, input.actor, "maintenance_activation", input.maintenanceReference);
        return readSettingsState(client);
      });
    }
  };
}
