import { describe, it, expect, vi } from "vitest";
import { createSettingsOperatorSessions } from "../../services/api/src/settings-operator-session.js";
const key = "management-key-".repeat(4);
function fixture() {
  let saved: any;
  const repository = { recordUnlockAttempt: vi.fn(async (_client: string, _outcome: string) => true), createSession: vi.fn(async (input: any) => (saved = { ...input, id: "session" })), findSession: vi.fn(async (input: any) => saved && input.actorUserId === saved.actorUserId && input.keyFingerprint === saved.keyFingerprint && input.tokenDigest === saved.tokenDigest ? saved : null), revokeSession: vi.fn(async () => { saved = null; }), cleanup: vi.fn() };
  return { repository, service: createSettingsOperatorSessions(repository, () => key) };
}
describe("operator unlock", () => {
  it("stores only digests and binds actor, key fingerprint and CSRF", async () => {
    const {service, repository} = fixture();
    const unlocked = await service.unlock(key, "actor", "client");
    expect(JSON.stringify(repository.createSession.mock.calls)).not.toContain(key);
    expect(JSON.stringify(repository.createSession.mock.calls)).not.toContain(unlocked.token);
    expect(await service.authorize(unlocked.token, "actor", unlocked.csrfToken)).toMatchObject({id:"session"});
    await expect(service.authorize(unlocked.token, "other", unlocked.csrfToken)).rejects.toThrow();
    await expect(service.authorize(unlocked.token, "actor", "wrong")).rejects.toThrow();
    const restored = await service.restore(unlocked.token,"actor");
    expect(restored.csrfToken).toBe(unlocked.csrfToken);expect(restored.expiresAt).toEqual(unlocked.expiresAt);
    await service.revoke(unlocked.token, "actor", unlocked.csrfToken);
    await expect(service.authorize(unlocked.token, "actor")).rejects.toThrow();
  });
  it("rejects expired sessions even when a stale repository returns one",async()=>{
    const {service,repository}=fixture();const unlocked=await service.unlock(key,"actor","client");repository.findSession.mockResolvedValue({...repository.createSession.mock.results[0]!.value,expiresAt:new Date(0)});await expect(service.authorize(unlocked.token,"actor")).rejects.toThrow("settings_unlock_required");
  });
  it("supplies trusted failure outcome and denies valid keys when accounting refuses or fails", async () => {
    const {service, repository} = fixture();
    await expect(service.unlock("wrong", "actor", "client")).rejects.toThrow();
    expect(repository.recordUnlockAttempt.mock.calls[0]?.[1]).toBe("failure");
    repository.recordUnlockAttempt.mockResolvedValue(false);
    await expect(service.unlock(key, "actor", "client")).rejects.toThrow();
    expect(repository.createSession).not.toHaveBeenCalled();
    repository.recordUnlockAttempt.mockRejectedValue(new Error("private database URL"));
    await expect(service.unlock(key, "actor", "client")).rejects.toThrow("settings_unavailable");
  });
});
