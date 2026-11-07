import { readFileSync } from "node:fs";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import type { RuntimeConfig } from "../../../packages/database/src/config.js";
import { createSettingsOperatorRepository } from "../../../packages/database/src/settings-operator-repository.js";
import { createInstanceSettingsRepository } from "../../../packages/database/src/instance-settings-repository.js";
import { createSettingsUseCases, SettingsConflictError, type SettingsState } from "../../../packages/application/src/settings/index.js";
import {
  instanceSettingsHistorySchema, instanceSettingsPatchSchema, instanceSettingsViewSchema, instanceSettingsSchema,
  settingsFeatureGatesSchema, type DeploymentSettingsPolicy, type InstanceSettings, type SettingsFieldKey, type SettingsFeatureKey
} from "../../../packages/contracts/src/instance-settings.js";
import { resolveInstanceSettings, INSTANCE_SETTING_FIELDS } from "../../../packages/domain/src/instance-settings.js";
import { createSettingsOperatorSessions, SettingsHttpError } from "./settings-operator-session.js";

function effectiveValue(snapshot: InstanceSettings, key: SettingsFieldKey) {
  const [group, property] = key.split(".");
  if (property) {
    return snapshot[group as "campaignArchiveLimits" | "systemArchiveLimits"][property as keyof InstanceSettings["campaignArchiveLimits"]];
  }
  return snapshot[key as Exclude<SettingsFieldKey, `${string}.${string}`>];
}

export type SettingsRuntimePorts = Readonly<{
  loadDeploymentSettingsPolicy(path: string): DeploymentSettingsPolicy;
  projectRuntimeSettings(config: RuntimeConfig): InstanceSettings;
  settingsDigest(value: unknown): string;
}>;

export function createInstanceSettingsHttpComposition(
  pool: DatabasePool, bootstrap: RuntimeConfig, running: RuntimeConfig,
  { loadDeploymentSettingsPolicy, projectRuntimeSettings, settingsDigest }: SettingsRuntimePorts
) {
  const repository = createInstanceSettingsRepository(pool);
  // Capture the configuration this process actually serves, before any mounted policy changes.
  const runningConfig = structuredClone(running);
  const readPolicy = () => {
    try {
      return bootstrap.instanceSettingsPolicyFile ? loadDeploymentSettingsPolicy(bootstrap.instanceSettingsPolicyFile) : undefined;
    } catch {
      return undefined;
    }
  };
  const runningPolicy = readPolicy();
  const runningPolicyDigest = runningPolicy ? settingsDigest(runningPolicy) : null;
  const readKey = () => {
    try {
      return bootstrap.settingsManagementEnabled && bootstrap.settingsManagementKeyFile
        ? readFileSync(bootstrap.settingsManagementKeyFile, "utf8").trim()
        : undefined;
    } catch {
      return undefined;
    }
  };
  const enabled = () => {
    const mounted = readPolicy();
    return !!mounted && mounted.minimumSettingsProtocolVersion <= 1 && Buffer.byteLength(readKey() ?? "") >= 32;
  };
  const currentPolicy = () => {
    const mounted = readPolicy();
    if (!mounted || mounted.minimumSettingsProtocolVersion > 1) {
      throw new SettingsHttpError(503, "settings_management_disabled");
    }
    if (settingsDigest(mounted) !== runningPolicyDigest) {
      throw new SettingsHttpError(503, "settings_policy_mismatch");
    }
    return mounted;
  };
  const constrainedPolicy = () => {
    const mounted = currentPolicy();
    const gates = { ...mounted.featureGates };
    for (const key of Object.keys(settingsFeatureGatesSchema.shape) as SettingsFeatureKey[]) {
      gates[key] = gates[key] && bootstrap[key] === true;
    }
    return { ...mounted, featureGates: gates };
  };
  const validateRunningPolicy = async (state: SettingsState) => {
    const mounted = currentPolicy();
    if (state.requestedRevision && state.installationId !== mounted.installationId) {
      throw new SettingsHttpError(503, "settings_policy_mismatch");
    }
    if (state.activeRevision) {
      // State.policyDigest belongs to requested, which may deliberately target a future policy.
      const { rows: [revision] } = await pool.query<{ policy_digest: string }>(
        "SELECT policy_digest FROM instance_settings_revisions WHERE revision=$1", [state.activeRevision]
      );
      if (!revision || revision.policy_digest !== runningPolicyDigest) {
        throw new SettingsHttpError(503, "settings_policy_mismatch");
      }
    }
  };
  const view = async (state: SettingsState) => {
    await validateRunningPolicy(state);
    const active = projectRuntimeSettings(runningConfig);
    const resolution = resolveInstanceSettings(active, constrainedPolicy(), {
      role: bootstrap.role, databaseMaxConnections: bootstrap.databaseMaxConnections
    });
    if (!resolution.ok) throw new SettingsHttpError(503, "settings_policy_rejected");
    // Defaults come from the immutable seed, never the current shell environment.
    // A stricter numeric/rate policy makes reset unavailable rather than rounding or clamping.
    let resetSource: InstanceSettings | null = active;
    if (state.requestedRevision) {
      const { rows: [seed] } = await pool.query<{ snapshot: unknown }>(
        "SELECT snapshot FROM instance_settings_revisions WHERE revision=1 AND kind='seed'"
      );
      const parsed = instanceSettingsSchema.safeParse(seed?.snapshot);
      resetSource = parsed.success ? parsed.data : null;
    }
    const resetResolution = resetSource ? resolveInstanceSettings(resetSource, constrainedPolicy(), {
      role: bootstrap.role, databaseMaxConnections: bootstrap.databaseMaxConnections
    }) : null;
    const resetDefaults = resetResolution?.ok ? resetResolution.effective : null;
    return instanceSettingsViewSchema.parse({
      activeRevision: state.activeRevision,
      requestedRevision: state.requestedRevision,
      active,
      requested: state.requested,
      resetDefaults,
      fields: resolution.fields.map(field => ({
        ...field,
        // Policy locks/ranges constrain proposals; they do not hot-apply to the running process.
        effectiveValue: effectiveValue(active, field.key),
        source: state.mode === "environment" ? "environment" : "database"
      })),
      activationStatus: state.mode === "environment"
        ? state.requestedRevision ? "restart_required" : "environment"
        : state.activeRevision === state.requestedRevision ? "active" : "restart_required"
    });
  };
  return {
    enabled,
    operatorSessions: createSettingsOperatorSessions(createSettingsOperatorRepository(pool), readKey),
    settings: {
      read: async () => view(await repository.read()),
      patch: async (input: unknown, actor: { userId: string; operatorSessionId: string }) => {
        const patch = instanceSettingsPatchSchema.parse(input);
        const state = await repository.read();
        await validateRunningPolicy(state);
        const mounted = currentPolicy();
        const effectivePolicy = constrainedPolicy();
        if (!state.requested) throw new SettingsHttpError(503, "settings_uninitialized");
        if (state.policyDigest !== settingsDigest(mounted)) throw new SettingsHttpError(503, "settings_policy_mismatch");
        if (state.requestedRevision !== patch.expectedRequestedRevision) throw new SettingsConflictError(state.requestedRevision);
        for (const key of Object.keys(settingsFeatureGatesSchema.shape) as SettingsFeatureKey[]) {
          if (patch.changes[key] === true && !effectivePolicy.featureGates[key]) {
            throw new SettingsHttpError(422, "settings_deployment_disabled");
          }
        }
        try {
          const state = await createSettingsUseCases(repository, effectivePolicy, resolveInstanceSettings).propose(patch, actor);
          return await view(state);
        } catch (error) {
          if (error instanceof Error && error.message === "settings_policy_rejected") {
            throw new SettingsHttpError(422, "settings_policy_rejected");
          }
          throw error;
        }
      },
      history: async (cursor: string | undefined, limit: number) => {
        await validateRunningPolicy(await repository.read());
        const { rows } = await pool.query(`
          SELECT id::text,kind,revision,actor_user_id,operator_session_id,reason_code,changed_keys,created_at
          FROM instance_settings_events WHERE ($1::bigint IS NULL OR id<$1::bigint)
          ORDER BY instance_settings_events.id DESC LIMIT $2`, [cursor ?? null, limit + 1]);
        const allowed = new Set<string>(INSTANCE_SETTING_FIELDS.map(field => field.key));
        const events = rows.slice(0, limit).map(row => ({
          id: row.id, kind: row.kind, revision: row.revision, actorUserId: row.actor_user_id,
          operatorSessionId: row.operator_session_id, reasonCode: row.reason_code,
          changedKeys: Array.isArray(row.changed_keys)
            ? row.changed_keys.filter((key: unknown) => typeof key === "string" && allowed.has(key))
            : [],
          createdAt: new Date(row.created_at).toISOString()
        }));
        return instanceSettingsHistorySchema.parse({ events, nextCursor: rows.length > limit ? events.at(-1)!.id : null });
      }
    }
  };
}
