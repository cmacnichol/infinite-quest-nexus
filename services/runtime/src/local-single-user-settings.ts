import { randomUUID } from "node:crypto";
import { initialOwnerId, type DatabasePool, type RuntimeConfig } from "../../../packages/database/src/index.js";
import { createInstanceSettingsRepository } from "../../../packages/database/src/instance-settings-repository.js";
import { compatibleInstanceSettingsSchema, type DeploymentSettingsPolicy } from "../../../packages/contracts/src/instance-settings.js";
import { loadDeploymentSettingsPolicy, projectRuntimeSettings, settingsDigest } from "./instance-settings.js";
import { createLocalSingleUserPolicy } from "./settings-operator.js";
import { createSettingsActivationGuard } from "./settings-activation.js";

/** Rebuild only from the immutable initial seed, so changing requested settings cannot change policy. */
export async function loadLocalSingleUserPolicy(pool: DatabasePool, bootstrap: RuntimeConfig): Promise<DeploymentSettingsPolicy> {
  const state = await createInstanceSettingsRepository(pool).read();
  if (!state.installationId || !state.requestedRevision) throw new Error("settings_uninitialized");
  if (bootstrap.instanceSettingsPolicyFile) {
    const policy = loadDeploymentSettingsPolicy(bootstrap.instanceSettingsPolicyFile);
    const { rows: [revision] } = await pool.query("SELECT policy_digest FROM instance_settings_revisions WHERE revision=$1", [state.activeRevision ?? state.requestedRevision]);
    if (policy.installationId !== state.installationId || revision?.policy_digest !== settingsDigest(policy)) throw new Error("settings_policy_mismatch");
    return policy;
  }
  const { rows: [seed] } = await pool.query("SELECT snapshot,policy_digest,local_single_user FROM instance_settings_revisions WHERE revision=1 AND kind='seed'");
  if (!seed || seed.local_single_user !== true) throw new Error("settings_local_existing_installation");
  const legacy = !("castPresetsEnabled" in seed.snapshot) && !("castContextWithoutDiscoveryEnabled" in seed.snapshot);
  const policy = createLocalSingleUserPolicy(compatibleInstanceSettingsSchema.parse(seed.snapshot), state.installationId, bootstrap.databaseMaxConnections);
  if (!("castLifecycleEnabled" in seed.snapshot)) {
    policy.version = 2;
    delete policy.featureGates.castLifecycleEnabled;
  }
  if (legacy) {
    policy.version = 1;
    // The historical policy remains byte-for-byte digestible; effective gates are derived at use sites.
    delete policy.featureGates.castPresetsEnabled;
    delete policy.featureGates.castContextWithoutDiscoveryEnabled;
    policy.featureGates.castContextEnabled = seed.snapshot.castContextEnabled;
    policy.featureGates.castEditingEnabled = seed.snapshot.castEditingEnabled;
  }
  if (seed.policy_digest !== settingsDigest(policy)) throw new Error("settings_policy_mismatch");
  return policy;
}

/** Seed and activate once, under the same repository locks and drain guard as the operator. */
export async function initializeLocalSingleUserSettings(pool: DatabasePool, bootstrap: RuntimeConfig): Promise<DeploymentSettingsPolicy> {
  const repository = createInstanceSettingsRepository(pool);
  let state = await repository.read();
  if (!state.requestedRevision) {
    if (bootstrap.instanceSettingsPolicyFile) throw new Error("settings_local_existing_installation");
    const snapshot = projectRuntimeSettings(bootstrap);
    const policy = createLocalSingleUserPolicy(snapshot, randomUUID(), bootstrap.databaseMaxConnections);
    const actor = { userId: await initialOwnerId(pool), localSingleUser: true as const };
    try {
      state = await repository.seed({ installationId: policy.installationId, snapshot, seedDigest: settingsDigest(snapshot), policyDigest: settingsDigest(policy), actor });
    } catch (error) {
      // Another startup may have won the seed race. Only accept its persisted local seed.
      state = await repository.read();
      if (!state.requestedRevision) throw error;
    }
  }
  const policy = await loadLocalSingleUserPolicy(pool, bootstrap);
  if (!bootstrap.instanceSettingsPolicyFile && state.mode === "environment" && state.activationEpoch === "0" && state.requestedRevision === "1") {
    const actor = { userId: await initialOwnerId(pool), localSingleUser: true as const };
    try {
      await createInstanceSettingsRepository(pool, { activationGuard: createSettingsActivationGuard(policy, { implicitLocal: !bootstrap.instanceSettingsPolicyFile }) }).activate({
        expectedActiveRevision: null, expectedRequestedRevision: "1", policyDigest: settingsDigest(policy),
        maintenanceReference: "local-single-user-initialization", actor
      });
    } catch (error) {
      const committed = await repository.read();
      if (committed.mode !== "database" || committed.activeRevision !== "1" || committed.requestedRevision !== "1" || committed.activationEpoch !== "1" || committed.policyDigest !== settingsDigest(policy)) throw error;
    }
  }
  return policy;
}
