import type { DeploymentSettingsPolicy, InstanceSettings, RuntimeRoleCapacity } from "@infinite-quest/contracts";
import type { ActivationRequest, SettingsProposal, SettingsSeed, SettingsState } from "./types.js";
/** Runtime adapters supply the shared domain resolver; application owns no policy rules. */
export type SettingsPolicyResolverPort = (
  snapshot: InstanceSettings,
  policy: DeploymentSettingsPolicy,
  capacity: RuntimeRoleCapacity
) => { ok: true } | { ok: false };
export interface SettingsRepositoryPort {
  read(): Promise<SettingsState>;
  seed(input: SettingsSeed): Promise<SettingsState>;
  propose(input: SettingsProposal): Promise<SettingsState>;
  activate(input: ActivationRequest): Promise<SettingsState>;
}
export type SettingsOperatorSession = { id: string; actorUserId: string; tokenDigest: string; csrfDigest: string; keyFingerprint: string; expiresAt: Date };
export interface SettingsOperatorRepositoryPort {
  createSession(input: Omit<SettingsOperatorSession, "id">): Promise<SettingsOperatorSession>;
  findSession(input: { tokenDigest: string; actorUserId: string; keyFingerprint: string }): Promise<SettingsOperatorSession | null>;
  revokeSession(id: string): Promise<void>;
  /** Outcome comes from the server's constant-time key comparison, never a request body.
   * False denies session creation even for a valid key; true does not itself authenticate.
   * Limits and failure increments commit atomically across all replicas. */
  recordUnlockAttempt(clientDigest: string, outcome: "success" | "failure"): Promise<boolean>;
  cleanup(): Promise<void>;
}
