import { z } from "zod";
import { settingsRevisionSchema, type DeploymentSettingsPolicy } from "../../../packages/contracts/src/instance-settings.js";
import { lockSettingsState, readSettingsState } from "../../../packages/database/src/instance-settings-repository.js";
import { withTransaction, type DatabaseClient, type DatabasePool } from "../../../packages/database/src/pool.js";
import type { RuntimeConfig } from "../../../packages/database/src/config.js";
import { projectRuntimeSettings, resolveRuntimeSettingsState, settingsDigest } from "./instance-settings.js";
import { createSettingsActivationGuard } from "./settings-activation.js";
import { exportCompatibilityEnvironment, reconcileSettingsSeeds } from "./settings-operator.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const artifact = z.object({
  version: z.literal(1), installationId: z.uuid(), policyDigest: digest, effectiveDigest: digest,
  activeRevision: settingsRevisionSchema, requestedRevision: settingsRevisionSchema, activationEpoch: settingsRevisionSchema,
  environment: z.record(z.string(), z.string())
}).strict();

export function verifyRollback(input: unknown, policy: DeploymentSettingsPolicy) {
  const { exported, seeds } = z.object({ exported: artifact, seeds: z.array(z.unknown()) }).strict().parse(input);
  const actual = reconcileSettingsSeeds(seeds, policy);
  if (exported.installationId !== policy.installationId || exported.policyDigest !== settingsDigest(policy) ||
      settingsDigest(actual) !== exported.effectiveDigest ||
      settingsDigest(exportCompatibilityEnvironment(actual)) !== settingsDigest(exported.environment)) {
    throw new Error("settings_rollback_parity_mismatch");
  }
  return exported;
}

async function lockedExport(client: DatabaseClient, config: RuntimeConfig, policy: DeploymentSettingsPolicy) {
  await lockSettingsState(client);
  const state = await readSettingsState(client);
  if (state.mode !== "database" || !state.activeRevision || !state.requestedRevision) throw new Error("settings_database_mode_required");
  const { rows: [revision] } = await client.query("SELECT policy_digest FROM instance_settings_revisions WHERE revision=$1", [state.activeRevision]);
  const resolved = resolveRuntimeSettingsState({ ...state, policyDigest: revision.policy_digest }, config, policy);
  const exported = artifact.parse({ version: 1, installationId: policy.installationId, policyDigest: resolved.policyDigest,
    activeRevision: state.activeRevision, requestedRevision: state.requestedRevision, activationEpoch: state.activationEpoch,
    effectiveDigest: resolved.effectiveDigest, environment: exportCompatibilityEnvironment(projectRuntimeSettings(resolved.config)) });
  return { state, exported };
}

export async function exportRollback(pool: DatabasePool, config: RuntimeConfig, policy: DeploymentSettingsPolicy) {
  return withTransaction(pool, async client => (await lockedExport(client, config, policy)).exported);
}

/** Offline CLI only. The maintenance reference attests all old processes and external work were physically stopped. */
export async function transitionToEnvironment(pool: DatabasePool, config: RuntimeConfig, policy: DeploymentSettingsPolicy, input: unknown,
  maintenanceReference: string, actor: { userId: string; cliReference: string }) {
  const reviewed = verifyRollback(input, policy);
  return withTransaction(pool, async client => {
    const { state, exported } = await lockedExport(client, config, policy);
    if (settingsDigest(reviewed) !== settingsDigest(exported)) throw new Error("settings_rollback_stale");
    // Validate the current active policy, even when a separately requested revision has a different policy.
    await createSettingsActivationGuard(policy, { implicitLocal: config.instanceSettingsAccessMode === "local-single-user" && !config.instanceSettingsPolicyFile })(client, { ...state, requested: state.active }, {
      expectedActiveRevision: exported.activeRevision, expectedRequestedRevision: exported.requestedRevision,
      expectedEpoch: exported.activationEpoch, policyDigest: exported.policyDigest, maintenanceReference, actor
    });
    await client.query("LOCK TABLE api_admission_windows IN SHARE MODE");
    const windows = await client.query("SELECT 1 FROM api_admission_windows WHERE window_expires_at > clock_timestamp() LIMIT 1");
    if (windows.rowCount) throw new Error("settings_admission_windows_active");
    await client.query("UPDATE instance_settings_state SET active_revision=NULL, mode='environment',activation_epoch=activation_epoch+1,updated_at=clock_timestamp()");
    await client.query(`INSERT INTO instance_settings_events(kind,revision,actor_user_id,cli_reference,reason_code,maintenance_reference)
      VALUES ('rollback',$1,$2,$3,'maintenance_environment',$4)`, [exported.activeRevision, actor.userId, actor.cliReference, maintenanceReference]);
  });
}
