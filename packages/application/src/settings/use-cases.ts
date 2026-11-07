import { instanceSettingsSchema, instanceSettingsPatchSchema, deploymentSettingsPolicySchema, type DeploymentSettingsPolicy, type InstanceSettings } from "@infinite-quest/contracts";

import type { SettingsRepositoryPort, SettingsPolicyResolverPort } from "./ports.js";
import type { SettingsActor, SettingsSeed, ActivationRequest } from "./types.js";
import { SettingsConflictError } from "./types.js";
export function validateSettingsSnapshot(value: unknown): InstanceSettings { return instanceSettingsSchema.parse(value); }
export function validateSettingsPolicy(snapshot: InstanceSettings, policy: DeploymentSettingsPolicy, resolvePolicy: SettingsPolicyResolverPort): void {
  if (typeof resolvePolicy !== "function") throw new Error("settings_policy_resolver_required");
  deploymentSettingsPolicySchema.parse(policy);
  for (const role of policy.expectedRoles) {
    if (!resolvePolicy(snapshot, policy, { role: role.role, databaseMaxConnections: role.databaseMaxConnections }).ok) throw new Error("settings_policy_rejected");
  }
}
export function createSettingsUseCases(repository: SettingsRepositoryPort, policy: DeploymentSettingsPolicy, resolvePolicy: SettingsPolicyResolverPort) {
  if (typeof resolvePolicy !== "function") throw new Error("settings_policy_resolver_required");
  const validate = (value: unknown) => { const snapshot = validateSettingsSnapshot(value); validateSettingsPolicy(snapshot, policy, resolvePolicy); return snapshot; };
  return {
    read: () => repository.read(),
    seed: (input: SettingsSeed) => {
      if (input.installationId !== policy.installationId) throw new Error("settings_installation_mismatch");
      return repository.seed({ ...input, snapshot: validate(input.snapshot) });
    },
    async propose(patch: unknown, actor: SettingsActor) {
      const parsed = instanceSettingsPatchSchema.parse(patch);
      const state = await repository.read();
      if (!state.requested || state.requestedRevision !== parsed.expectedRequestedRevision) throw new SettingsConflictError(state.requestedRevision);
      const snapshot = validate({ ...state.requested, ...parsed.changes,
        campaignArchiveLimits: { ...state.requested.campaignArchiveLimits, ...parsed.changes.campaignArchiveLimits },
        systemArchiveLimits: { ...state.requested.systemArchiveLimits, ...parsed.changes.systemArchiveLimits } });
      return repository.propose({ expectedRequestedRevision: state.requestedRevision!, snapshot, actor, reason: parsed.reason });
    },
    proposeRollback: (input: Parameters<SettingsRepositoryPort["propose"]>[0]) => repository.propose({ ...input, snapshot: validate(input.snapshot), kind: "rollback" }),
    async activate(input: ActivationRequest) {
      const state = await repository.read();
      if (state.installationId !== policy.installationId) throw new Error("settings_installation_mismatch");
      if (!state.requested) throw new Error("settings_uninitialized");
      validate(state.requested);
      return repository.activate(input);
    }
  };
}
