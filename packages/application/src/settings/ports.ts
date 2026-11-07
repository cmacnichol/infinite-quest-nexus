import type { ActivationRequest, SettingsProposal, SettingsSeed, SettingsState } from "./types.js";
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
  recordUnlockAttempt(clientDigest: string): Promise<boolean>;
  cleanup(): Promise<void>;
}
