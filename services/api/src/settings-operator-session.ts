import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SettingsOperatorRepositoryPort, SettingsOperatorSession } from "../../../packages/application/src/settings/index.js";
export class SettingsHttpError extends Error {
  constructor(readonly statusCode: number, readonly code: string) { super(code); }
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const equal = (left: string, right: string) => timingSafeEqual(Buffer.from(digest(left), "hex"), Buffer.from(digest(right), "hex"));
export interface SettingsOperatorSessionPort {
  unlock(key: string, actor: string, client: string): Promise<{token:string;csrfToken:string;expiresAt:Date}>;
  authorize(token: string, actor: string, csrf?: string): Promise<SettingsOperatorSession>;
  restore(token: string, actor: string): Promise<{csrfToken:string;expiresAt:Date}>;
  revoke(token: string, actor: string, csrf: string): Promise<void>;
}
export function createSettingsOperatorSessions(repository: SettingsOperatorRepositoryPort, readKey: () => string | undefined): SettingsOperatorSessionPort {
  const key = () => { const value = readKey(); if (!value || Buffer.byteLength(value) < 32) throw new SettingsHttpError(503,"settings_management_disabled"); return value; };
  const fingerprint = (secret: string) => createHmac("sha256", secret).update("settings-key-version-v1").digest("hex");
  const csrf = (secret: string, token: string) => createHmac("sha256",secret).update(`settings-csrf-v1:${token}`).digest("base64url");
  const protect = async <T>(action: () => Promise<T>): Promise<T> => { try { return await action(); } catch(error) { if(error instanceof SettingsHttpError) throw error; throw new SettingsHttpError(503,"settings_unavailable"); } };
  const authorize = (token: string, actor: string, suppliedCsrf?: string) => protect(async () => {
    const secret = key();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new SettingsHttpError(401,"settings_unlock_required");
    const session = await repository.findSession({ tokenDigest:digest(token), actorUserId:actor, keyFingerprint:fingerprint(secret) });
    if (!session || session.expiresAt.getTime() <= Date.now()) throw new SettingsHttpError(401,"settings_unlock_required");
    if (suppliedCsrf !== undefined && !equal(digest(suppliedCsrf),session.csrfDigest)) throw new SettingsHttpError(403,"settings_csrf_invalid");
    return session;
  });
  return {
    unlock: (supplied,actor,client) => protect(async () => {
      const secret = key();
      const matches = equal(supplied, secret);
      const admitted = await repository.recordUnlockAttempt(digest(client), matches ? "success" : "failure");
      if (!admitted) throw new SettingsHttpError(429,"settings_unlock_limited");
      if (!matches) throw new SettingsHttpError(401,"settings_unlock_required");
      const token = randomBytes(32).toString("base64url");
      const csrfToken = csrf(secret,token);
      const expiresAt = new Date(Date.now()+900000);
      await repository.createSession({ actorUserId:actor,tokenDigest:digest(token),csrfDigest:digest(csrfToken),keyFingerprint:fingerprint(secret),expiresAt });
      return {token,csrfToken,expiresAt};
    }),
    authorize,
    restore: (token,actor) => protect(async () => { const session = await authorize(token,actor); return {csrfToken:csrf(key(),token),expiresAt:session.expiresAt}; }),
    revoke: (token,actor,suppliedCsrf) => protect(async () => { const session = await authorize(token,actor,suppliedCsrf); await repository.revokeSession(session.id); })
  };
}
