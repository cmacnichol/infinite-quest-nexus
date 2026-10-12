import { activityEventSchema, browserActivityObservationSchema, ACTIVITY_DIAGNOSTIC_MESSAGES, activityDiagnosticSchema, activityDiagnosticCodeSchema, type ActivityEvent, type BrowserActivityObservation } from "@infinite-quest/contracts";
import type { ActivityViewState, createActivityController } from "@infinite-quest/client-core";

type Controller = ReturnType<typeof createActivityController>;
type Entry = ActivityEvent | BrowserActivityObservation;
const browser = (entry: Entry): entry is BrowserActivityObservation => "observationId" in entry;
const title = (entry: Entry) => entry.kind.replace(/^[^.]+\./u, "").replace(/_/gu, " ");
const id = (entry: Entry) => browser(entry) ? entry.observationId : entry.eventId;
const groupKey = (entry: Entry) => browser(entry) ? `browser:${id(entry)}` : `${entry.source}:${entry.jobId ?? entry.segmentId ?? entry.generationJobId ?? id(entry)}`;

/** Pick only typed transport facts; exception text and payloads never enter diagnostics. */
export function safeActivityDiagnostic(error: unknown, code = "request_failed", routeTemplate?: string) {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const domainCode = activityDiagnosticCodeSchema.safeParse(value.domainCode);
  const selectedCode = value.name === "ApiContractError" || ["response_schema_mismatch", "malformed_json", "unexpected_empty_response", "request_schema_mismatch"].includes(String(value.kind))
    ? "contract_invalid" : code === "request_failed" && domainCode.success ? domainCode.data : code;
  const candidate = { code: selectedCode, message: ACTIVITY_DIAGNOSTIC_MESSAGES[selectedCode],
    ...(typeof value.statusCode === "number" && value.statusCode >= 100 && value.statusCode <= 599 ? { httpStatus: value.statusCode } : {}),
    ...(typeof value.correlationId === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(value.correlationId) ? { correlationId: value.correlationId } : {}),
    ...(["GET", "POST", "PUT", "PATCH", "DELETE"].includes(String(value.method)) ? { method: value.method } : {}),
    ...(routeTemplate ? { routeTemplate } : {}) };
  const parsed = activityDiagnosticSchema.safeParse(candidate);
  return parsed.success ? parsed.data : { code: "request_failed" as const, message: ACTIVITY_DIAGNOSTIC_MESSAGES.request_failed! };
}

export function createStoryActivityView({ controller, document, copyText, download, openRecovery, openDialog, refreshIdentity }: {
  controller: Controller; document: Document; copyText(text: string): Promise<void>;
  download(text: string, filename: string): void; openRecovery(): Promise<void>;
  openDialog?(dialog: HTMLDialogElement): void;
  refreshIdentity?(): Promise<unknown>;
}) {
  const element = <T extends HTMLElement>(name: string) => document.getElementById(name) as T | null;
  const dialog = element<HTMLDialogElement>("activityLogDialog");
  const list = element<HTMLDivElement>("activityLogList");
  const status = element<HTMLParagraphElement>("activityLogStatus");
  const notices = element<HTMLParagraphElement>("activityLogNotices");
  const filter = element<HTMLSelectElement>("activityLogFilter");
  const search = element<HTMLInputElement>("activityLogSearch");
  const rows = new Map<string, HTMLDetailsElement>();
  const selected = new Set<string>();
  const cleanups: Array<() => void> = [];
  let state = controller.getState();
  let filtered: Entry[] = [];
  let lastScope: string | null = null;
  let previousIds = new Set<string>();
  let pendingCount = 0;
  const say = (text: string) => { if (status) status.textContent = text; };
  function on(target: HTMLElement | null, name: string, handler: EventListener) {
    target?.addEventListener(name, handler); cleanups.push(() => target?.removeEventListener(name, handler));
  }
  function entries() {
    const server = state.events.flatMap(value => { const parsed = activityEventSchema.safeParse(value); return parsed.success ? [parsed.data] : []; });
    const local = state.observations.flatMap(value => { const parsed = browserActivityObservationSchema.safeParse(value); return parsed.success ? [parsed.data] : []; });
    return [...server, ...local].sort((a, b) => (browser(b) ? b.observedAt : b.occurredAt).localeCompare(browser(a) ? a.observedAt : a.occurredAt));
  }
  function exportText() {
    const selection = selected.size ? filtered.filter(entry => selected.has(groupKey(entry))) : filtered;
    return JSON.stringify({ version: 1, scope: state.scope, coverage: state.snapshot.coverage,
      selection: selected.size ? "selected operation groups" : "loaded filtered activity", loadedOnly: true,
      lastSuccessfulSync: state.snapshot.lastSuccessfulSync, entries: selection }, null, 2);
  }
  function render(next: ActivityViewState) {
    state = next;
    const scope = state.scope ? `${state.scope.apiBase}:${state.scope.ownerUserId}:${state.scope.campaignId}` : null;
    if (scope !== lastScope) { list?.replaceChildren(); rows.clear(); selected.clear(); previousIds.clear(); pendingCount = 0; lastScope = scope; if (scope) say(""); }
    const all = entries();
    const fresh = all.filter(entry => !previousIds.has(id(entry))).length;
    if (previousIds.size && fresh && (state.snapshot.browsingOlder || (list?.parentElement?.scrollTop ?? 0) > 40)) pendingCount += fresh;
    previousIds = new Set(all.map(id));
    const query = search?.value.trim().toLowerCase() ?? "";
    filtered = all.filter(entry => {
      const choice = filter?.value ?? "all";
      if (choice === "errors" && !["warning", "error"].includes(entry.severity)) return false;
      if (choice === "generation" && (browser(entry) || entry.source !== "generation")) return false;
      if (choice === "illustrations" && (browser(entry) || entry.source === "generation")) return false;
      if (choice === "browser" && !browser(entry)) return false;
      return !query || [entry.jobId, entry.generationJobId, entry.segmentId, entry.turnId, entry.diagnostic?.code, browser(entry) ? null : entry.turnNumber, entry.kind].some(value => String(value ?? "").toLowerCase().includes(query));
    });
    const groups = new Map<string, Entry[]>();
    for (const entry of filtered) { const key = groupKey(entry); groups.set(key, [...(groups.get(key) ?? []), entry]); }
    const scroll = list?.parentElement?.scrollTop ?? 0;
    const active = document.activeElement as HTMLElement | null;
    const anchor = scroll > 40 ? Array.from(list?.children ?? []).find(node => (node as HTMLElement).getBoundingClientRect?.().bottom > (list?.parentElement?.getBoundingClientRect?.().top ?? 0)) as HTMLElement | undefined : undefined;
    const anchorTop = anchor?.getBoundingClientRect?.().top;
    const loadedKeys = new Set(all.map(groupKey));
    for (const [key, node] of rows) { if (!groups.has(key)) node.remove(); if (!loadedKeys.has(key)) { rows.delete(key); selected.delete(key); } }
    for (const [key, items] of groups) {
      let node = rows.get(key);
      if (!node) {
        node = document.createElement("details"); node.className = "activity-log-entry"; node.dataset.group = key;
        const summary = document.createElement("summary");
        const heading = document.createElement("span"); heading.className = "activity-log-title"; summary.append(heading);
        const body = document.createElement("div"); body.className = "activity-log-details";
        const label = document.createElement("label");
        const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.setAttribute("aria-label", "Select operation group");
        checkbox.addEventListener("change", () => { if (checkbox.checked) selected.add(key); else selected.delete(key); });
        label.append(checkbox, document.createTextNode(" Select for diagnostics")); body.append(label);
        const events = document.createElement("div"); events.className = "activity-log-events"; body.append(events);
        if (!browser(items[0]!) && items[0]!.source === "generation") {
          const recovery = document.createElement("button"); recovery.type = "button"; recovery.textContent = "View current recovery options";
          recovery.addEventListener("click", () => { void openRecovery().then(() => dialog?.close()).catch(() => say("Current recovery options could not be loaded. Try again.")); }); body.append(recovery);
        }
        node.append(summary, body); rows.set(key, node); list?.append(node);
      }
      if (!node.isConnected) list?.append(node);
      const latest = items[0]!;
      node.className = `activity-log-entry ${latest.severity}`;
      node.querySelector("summary span")!.textContent = `${new Date(browser(latest) ? latest.observedAt : latest.occurredAt).toLocaleString()} · ${browser(latest) ? "This browser" : latest.source === "generation" ? "Generation" : "Illustration"} · ${title(latest)} · ${latest.severity}${browser(latest) ? "" : ` · ${title(latest) === latest.status ? "" : `${latest.status} · `}Turn ${latest.turnNumber ?? "unavailable"}`} (${items.length})`;
      const container = node.querySelector(".activity-log-events")!;
      for (const entry of items) {
        let row = Array.from(container.children).find(child => (child as HTMLElement).dataset.entryId === id(entry)) as HTMLElement | undefined;
        if (!row) { row = document.createElement("pre"); row.dataset.entryId = id(entry); container.append(row); }
        const diagnostic = entry.diagnostic;
        row.textContent = [`${new Date(browser(entry) ? entry.observedAt : entry.occurredAt).toLocaleString()} · ${title(entry)} · ${entry.severity}`,
          `Status: ${browser(entry) ? "Browser observation" : entry.status}`, `Diagnostic: ${diagnostic?.code ?? "unavailable"}`, diagnostic?.message ?? "No diagnostic was recorded.",
          `Job: ${entry.jobId ?? entry.generationJobId ?? "unavailable"}`, `Segment: ${entry.segmentId ?? "unavailable"}`, `Turn: ${browser(entry) ? "unavailable" : entry.turnNumber ?? "unavailable"}`,
          `Attempt: ${browser(entry) ? "unavailable" : entry.attemptNumber ?? "unavailable"}`, `Phase: ${diagnostic?.phase ?? "unavailable"}`, `Correlation: ${diagnostic?.correlationId ?? "unavailable"}`, `HTTP status: ${diagnostic?.httpStatus ?? "unavailable"}`,
          `Provider profile: ${diagnostic?.providerProfileId ?? "unavailable"}`, `Model: ${diagnostic?.modelId ?? "unavailable"}`].join("\n");
      }
      for (const row of Array.from(container.children)) if (!items.some(entry => id(entry) === (row as HTMLElement).dataset.entryId)) row.remove();
    }
    if (list) {
      let position = list.firstElementChild;
      for (const key of groups.keys()) { const node = rows.get(key)!; if (node !== position) list.insertBefore(node, position); position = node.nextElementSibling; }
    }
    if (active?.isConnected && document.activeElement !== active) active.focus({ preventScroll: true });
    const empty = element("activityLogEmpty");
    if (empty) { empty.hidden = groups.size !== 0; empty.textContent = all.length ? "No loaded activity matches these filters." : "No activity is loaded. Refresh history or show previous activity."; }
    if (list?.parentElement) list.parentElement.scrollTop = scroll + (anchorTop !== undefined && anchor?.isConnected ? (anchor.getBoundingClientRect?.().top ?? anchorTop) - anchorTop : 0);
    const messages = [state.identityRequired ? state.activationPending ? "Identity and campaign access must be verified before showing cached history. Reconnect or refresh to retry." : "Identity and campaign access must be verified before showing cached history. Reconnect or refresh to retry." : null,
      state.cached ? "Showing cached activity." : null, state.delayed ? "History may be delayed." : null,
      state.storageUnavailable ? "Local history storage unavailable; this session uses memory." : null,
      state.unsupported ? "This server does not support durable Activity history. Only This browser observations are available." : null,
      state.snapshot.lastSuccessfulSync !== null ? `Last synced ${new Date(state.snapshot.lastSuccessfulSync).toLocaleString()}.` : null,
      state.incomplete ? "Durable history is incomplete." : null, state.gap ? `History gap after ${state.gap === "retention" ? "retention expiry" : "database restore"}.` : null,
      state.snapshot.coverage?.capturedSince ? `Durable history began ${new Date(state.snapshot.coverage.capturedSince).toLocaleString()}. Earlier activity cannot be recovered. Server retention: 30 days.` : "Durable capture start is unavailable. Earlier browser activity cannot be recovered."];
    if (notices) notices.textContent = messages.filter(Boolean).join(" ");
    const older = element<HTMLButtonElement>("btnActivityOlder"); if (older) older.disabled = !state.scope || !state.snapshot.hasOlder || state.syncing;
    const latestButton = element<HTMLButtonElement>("btnActivityLatest"); if (latestButton) { latestButton.hidden = !state.snapshot.browsingOlder && !pendingCount; latestButton.textContent = pendingCount ? `${pendingCount} new entries · Return to latest` : "Return to latest"; }
    const hide = element<HTMLButtonElement>("btnClearActivityLog"); if (hide) { hide.disabled = !state.scope; hide.textContent = state.snapshot.hiddenThrough ? "Show previous activity" : "Hide previous activity"; }
  }
  on(filter, "change", () => render(state)); on(search, "input", () => render(state));
  on(element("btnActivityRefresh"), "click", () => { void (!state.scope && refreshIdentity ? refreshIdentity() : controller.refresh()); });
  on(element("btnActivityOlder"), "click", () => { void controller.loadOlder(); });
  on(element("btnActivityLatest"), "click", () => { pendingCount = 0; void controller.returnToLatest(); });
  on(element("btnClearActivityLog"), "click", () => { void (state.snapshot.hiddenThrough ? controller.showPrevious() : controller.hidePrevious()); });
  on(element("btnCopyActivityLog"), "click", () => { void copyText(exportText()).then(() => say("Diagnostics copied.")).catch(() => say("Clipboard unavailable. Download diagnostics instead.")); });
  on(element("btnDownloadActivityLog"), "click", () => { try { download(exportText(), "story-activity-diagnostics-v1.json"); say("Diagnostics downloaded."); } catch { say("Diagnostics could not be downloaded."); } });
  for (const name of ["btnCloseActivityLog", "btnActivityLogDone"]) on(element(name), "click", () => dialog?.close());
  on(dialog, "keydown", event => { if ((event as KeyboardEvent).key === "Escape") { event.preventDefault(); event.stopPropagation(); dialog?.close(); } });
  on(dialog, "close", () => controller.setDialogOpen(false));
  const unsubscribe = controller.subscribe(render); render(state);
  return { open() { render(controller.getState()); if (dialog && !dialog.open) { if (openDialog) openDialog(dialog); else dialog.showModal(); } controller.setDialogOpen(true); }, render, dispose() { unsubscribe(); cleanups.forEach(cleanup => cleanup()); controller.setDialogOpen(false); } };
}
