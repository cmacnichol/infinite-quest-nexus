import type { InstanceSettings } from "@infinite-quest/contracts";
/** Trusted adapters supply actor attribution; never accept this from request bodies. */
export type SettingsActor = { userId: string } & ({ operatorSessionId: string; cliReference?: never } | { cliReference: string; operatorSessionId?: never });
export type SettingsState = { installationId: string | null; mode: "environment" | "database"; schemaVersion: number; activeRevision: string | null; requestedRevision: string | null; activationEpoch: string; active: InstanceSettings | null; requested: InstanceSettings | null; policyDigest: string | null };
export type SettingsProposal = { expectedRequestedRevision: string; snapshot: InstanceSettings; actor: SettingsActor; reason: string; policyDigest?: string; kind?: "proposal" | "rollback" };
export type SettingsSeed = { installationId: string; snapshot: InstanceSettings; policyDigest: string; seedDigest: string; actor: SettingsActor };
export type ActivationRequest = { expectedActiveRevision: string | null; expectedRequestedRevision: string; policyDigest: string; maintenanceReference: string; actor: SettingsActor };
export class SettingsConflictError extends Error {
  constructor(public readonly currentRevision: string | null) { super("settings_conflict"); }
}
