import { createIndexedDbActivityCache } from "../../../packages/client-web/src/activity/indexeddb-cache.js";
import { createActivityTabNotifications, createActivityConnectivitySource } from "../../../packages/client-web/src/activity/platform.js";
import { createActivityController } from "../../../packages/client-core/src/activity/controller.js";
import { event, observation, page, scope, now } from "../../fixtures/activity-client.js";
const params = new URLSearchParams(location.search);
const cache = createIndexedDbActivityCache({ databaseName: params.get("db") ?? "activity-test", clock: { now: () => now, isoAt: value => new Date(value).toISOString() }, ...(params.has("denied") ? { indexedDB: null } : {}) });
const notifications = createActivityTabNotifications();
const api = { list: async (_id: string, _query: import("@infinite-quest/contracts").ActivityPageQuery) => page([]) };
const access = { verify: async () => true };
const trace: string[] = [];
const controller = createActivityController({ cache, notifyTabs: notifications, api, verifyAccess: () => access.verify(), clock: { now: () => now, isoAt: value => new Date(value).toISOString() }, createAbortController: () => new AbortController(), visibility: { current: () => true, subscribe: () => () => {} }, connectivity: createActivityConnectivitySource(), scheduler: { wait: (ms, signal) => new Promise(resolve => { const timeout = setTimeout(resolve, ms); signal.addEventListener("abort", () => { clearTimeout(timeout); resolve(); }, { once:true }); }) }, random: () => 0.5 });
controller.subscribe(state => { document.querySelector("#state")!.textContent = JSON.stringify({ observations: state.observations.map(entry=>entry.sequence), storageUnavailable: state.storageUnavailable }); });
const harness = { cache, controller, scope, event, observation, page, notifications, api, access, trace };
declare global { interface Window { activity: typeof harness } }
window.activity = harness;
