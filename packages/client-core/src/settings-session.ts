import type { InstanceSettings, InstanceSettingsPatch, InstanceSettingsView, SettingsFieldKey } from "@infinite-quest/contracts";
export type OperatorStatus = { managementEnabled: boolean; unlocked: false } | { managementEnabled: true; unlocked: true; csrfToken: string; expiresAt: string } | { managementEnabled: true; unlocked: true; accessMode: "local-single-user" };
export interface InstanceSettingsApi {
  status(): Promise<OperatorStatus>;
  unlock(managementKey: string): Promise<{ csrfToken: string; expiresAt: string }>;
  logout(csrfToken: string): Promise<void>;
  get(): Promise<InstanceSettingsView>;
  patch(patch: InstanceSettingsPatch, csrfToken: string): Promise<InstanceSettingsView>;
}
export interface SettingsState {
  readonly unlocked: boolean; readonly managementEnabled: boolean; readonly busy: boolean;
  readonly view: InstanceSettingsView | null; readonly draft: InstanceSettings | null;
  readonly message: string; readonly conflict: boolean; readonly expiresAt: string | null; readonly localSingleUser: boolean;
}
export interface SettingsSession {
  readonly state: SettingsState;
  load(): Promise<void>; unlock(key: string): Promise<void>; logout(): Promise<void>;
  edit(key: SettingsFieldKey, value: boolean | number | string): void;
  save(keys: readonly SettingsFieldKey[], reason: string): Promise<void>;
  discard(keys?: readonly SettingsFieldKey[]): void;
  subscribe(listener: (state: SettingsState) => void): () => void;
  dispose(): void;
}
export function settingsValue(settings: InstanceSettings, key: SettingsFieldKey): boolean | number | string {
  const [group, child] = key.split(".");
  const value = settings[group as keyof InstanceSettings];
  return child ? (value as Record<string, number>)[child]! : value as boolean | number | string;
}
function assign(settings: InstanceSettings, key: SettingsFieldKey, value: unknown): void {
  const [group, child] = key.split(".");
  if (child) (settings[group as keyof InstanceSettings] as Record<string, unknown>)[child] = value;
  else (settings as unknown as Record<string, unknown>)[group!] = value;
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const empty = (): SettingsState => ({ unlocked: false, managementEnabled: false, busy: false, view: null, draft: null, message: "", conflict: false, expiresAt: null, localSingleUser: false });
export function createSettingsSession(api: InstanceSettingsApi): SettingsSession {
  let state = empty(); let csrf = ""; let epoch = 0; let disposed = false;
  const listeners = new Set<(state: SettingsState) => void>();
  const publish = (patch: Partial<SettingsState>) => { if (!disposed) { state = { ...state, ...patch }; for (const listener of listeners) listener(state); } };
  const clear = () => { csrf = ""; state = empty(); };
  const failure = (error: unknown) => {
    const { status, code } = error as { status?: number; code?: string };
    if (status === 401 || status === 403) { const { managementEnabled, localSingleUser } = state; clear(); publish({ managementEnabled, localSingleUser, message: localSingleUser ? "Local access was denied. Installation drafts were cleared." : "Operator unlock required. Installation drafts were cleared." }); }
    else publish({ busy: false, conflict: status === 409, message: status === 409 ? "Saved settings changed elsewhere. Your draft is retained. Discard and reload to compare before saving." : code === "settings_policy_mismatch" ? "Installation management unavailable: deployment policy changed. Contact the operator." : status === 422 ? "Changes were not saved. Check permitted ranges, dependencies and approved request-rate policy." : "Installation management unavailable. Try again or contact the operator." });
  };
  const install = (view: InstanceSettingsView) => publish({ view: clone(view), draft: clone(view.requested ?? view.active), busy: false, conflict: false });
  return {
    get state() { return state; },
    async load() {
      const operation = ++epoch; publish({ busy: true, message: "" });
      try {
        const status = await api.status(); if (disposed || operation !== epoch) return;
        if (!status.unlocked) { clear(); publish({ managementEnabled: status.managementEnabled }); return; }
        const local = "accessMode" in status;
        csrf = local ? "" : status.csrfToken; publish({ unlocked: true, managementEnabled: true, expiresAt: local ? null : status.expiresAt, localSingleUser: local });
        const view = await api.get(); if (!disposed && operation === epoch) install(view);
      } catch (error) { if (!disposed && operation === epoch) failure(error); }
    },
    async unlock(key) {
      const operation = ++epoch; publish({ busy: true, message: "" });
      try {
        const result = await api.unlock(key); if (disposed || operation !== epoch) return;
        csrf = result.csrfToken; publish({ unlocked: true, managementEnabled: true, expiresAt: result.expiresAt });
        const view = await api.get(); if (!disposed && operation === epoch) install(view);
      } catch (error) { if (!disposed && operation === epoch) failure(error); }
    },
    async logout() {
      const token = csrf; const managementEnabled = state.managementEnabled; ++epoch; clear(); publish({ managementEnabled });
      try { if (token) await api.logout(token); } catch { publish({ message: "Local drafts cleared. The operator session could not be closed; it expires automatically." }); }
    },
    edit(key, value) {
      if (disposed || !state.draft || state.busy) return;
      const draft = clone(state.draft); assign(draft, key, value); publish({ draft, message: "" });
    },
    async save(keys, reason) {
      if (!state.view || !state.draft || (!csrf && !state.localSingleUser) || state.busy || state.conflict) return;
      const changes: Record<string, unknown> = {};
      const saved = state.view.requested ?? state.view.active;
      for (const key of keys) {
        const value = settingsValue(state.draft, key); if (value === settingsValue(saved, key)) continue;
        const [group, child] = key.split(".");
        if (child) { const nested = changes[group!] as Record<string, unknown> | undefined ?? {}; nested[child] = value; changes[group!] = nested; }
        else changes[key] = value;
      }
      if (!Object.keys(changes).length) { publish({ message: "No changes to save." }); return; }
      const operation = ++epoch; const previousDraft = clone(state.draft); publish({ busy: true, message: "" });
      try {
        const view = await api.patch({ expectedRequestedRevision: state.view.requestedRevision, changes: changes as InstanceSettingsPatch["changes"], reason }, csrf);
        if (disposed || operation !== epoch) return;
        const draft = clone(view.requested ?? view.active);
        // Saving one section never silently discards another section's unsaved edits.
        for (const key of view.fields.map((field) => field.key)) if (!keys.includes(key)) assign(draft, key, settingsValue(previousDraft, key));
        publish({ view: clone(view), draft, busy: false, message: "Saved — restart required", conflict: false });
      } catch (error) { if (!disposed && operation === epoch) failure(error); }
    },
    discard(keys) {
      if (!state.view) return;
      const saved = state.view.requested ?? state.view.active;
      const draft = clone(state.draft ?? saved);
      if (keys) for (const key of keys) assign(draft, key, settingsValue(saved, key));
      publish({ draft: keys ? draft : clone(saved), message: "Draft discarded.", conflict: false });
    },
    subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
    dispose() { ++epoch; clear(); disposed = true; listeners.clear(); }
  };
}
