import { describe, expect, it } from "vitest";
import { createSettingsSession, type InstanceSettingsApi } from "../../packages/client-core/src/settings-session.js";
import { settingsFixture } from "../fixtures/instance-settings.js";
import { instanceSettingsSchema, type InstanceSettingsView } from "../../packages/contracts/src/instance-settings.js";
const view = (): InstanceSettingsView => ({ activeRevision: "1", requestedRevision: "1", active: settingsFixture(), requested: settingsFixture(), resetDefaults: settingsFixture(), fields: [], activationStatus: "active" });
function fixture() {
  let current = view();
  const api: InstanceSettingsApi = {
    status: async () => ({ managementEnabled: true, unlocked: true, csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00Z" }),
    unlock: async () => ({ csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00Z" }), logout: async () => {},
    get: async () => current,
    patch: async (patch) => { current = { ...current, requestedRevision: "2", requested: instanceSettingsSchema.parse({ ...current.requested!, ...patch.changes }), activationStatus: "restart_required" }; return current; }
  };
  return { api, session: createSettingsSession(api) };
}
describe("settings session", () => {
  it("stages Save without changing active values", async () => {
    const { session } = fixture(); await session.load(); const before = session.state.view!.active.logLevel;
    session.edit("logLevel", "debug"); await session.save(["logLevel"], "Adjust diagnostics");
    expect(session.state.view!.active.logLevel).toBe(before);
    expect(session.state.view!.requested!.logLevel).toBe("debug");
    expect(session.state.message).toBe("Saved — restart required");
  });
  it("retains drafts on conflict and clears everything on logout", async () => {
    const { api, session } = fixture(); await session.load(); session.edit("logLevel", "trace");
    api.patch = async () => { throw Object.assign(new Error(), { status: 409, code: "settings_conflict" }); };
    await session.save(["logLevel"], "Conflict test"); expect(session.state.draft!.logLevel).toBe("trace");
    expect(session.state.conflict).toBe(true); await session.logout();
    expect(session.state.draft).toBeNull(); expect(session.state.view).toBeNull(); expect(session.state.unlocked).toBe(false);
  });
  it("ignores late responses after disposal or logout", async () => {
    const { api, session } = fixture(); let finish!: (value: InstanceSettingsView) => void;
    api.get = () => new Promise((resolve) => { finish = resolve; });
    const loading = session.load(); await Promise.resolve(); session.dispose(); finish(view()); await loading;
    expect(session.state.view).toBeNull();
  });
});
