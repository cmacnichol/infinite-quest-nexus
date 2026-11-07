import { createSettingsSession, settingsValue, type InstanceSettingsApi } from "@infinite-quest/client-core";
import { createInstanceSettingsApi, createNexusApiClient, createNoopSessionPort } from "@infinite-quest/client-web";
import { type CampaignSummary, type MetaResponse, type SettingsFieldDescriptor } from "@infinite-quest/contracts";
import { mountAppShell } from "../app-shell-lifecycle";
import type { MountedPage } from "../world-library-page";
import { safeSettingsReturn, SETTINGS_SECTIONS, type SettingsRoute } from "./sections";
import { displayUnit, fromDisplayUnit, readableValue, readableRangeValue } from "./instance-editor";
import { createOwnerSettingsApis } from "./owner-settings-api";
import { mountProviderEditor } from "./provider-editor.js";
import { mountPromptEditor } from "./prompt-editor.js";
import { mountCampaignSettings } from "./campaign-editor";
import "./settings.css";
export { parseSettingsRoute } from "./sections";
export type { SettingsRoute } from "./sections";

const MISSING_REASON = "Enter a reason before saving.";
const LABELS: Record<string, string> = {
  workerPollIntervalMs: "Queue polling interval", textProviderConcurrency: "Text provider capacity", workerGenerationConcurrency: "Story generation capacity",
  archivePreviewTtlSeconds: "Import preview retention", systemArchiveArtifactTtlSeconds: "Archive download retention", systemArchiveUploadTtlSeconds: "Archive upload retention", systemArchiveChunkBytes: "Archive transfer chunk size",
  aiAuthoringJobsEnabled: "AI authoring jobs", aiStorySourceAuthoringEnabled: "Story source authoring", castEditingEnabled: "Character editing", castDiscoveryEnabled: "Character discovery", castAutoMatchEnabled: "Automatic character matching", castContextEnabled: "Character context", castBackfillEnabled: "Character history backfill",
  worldSharingEnabled: "World share links", systemArchiveEnabled: "System Archive", apiDefaultBodyLimitBytes: "Standard request size", apiImportBodyLimitBytes: "Import request size", apiAssetBodyLimitBytes: "Artwork request size", apiRateLimitWindowSeconds: "Request rate window", apiRateLimitProviderRequests: "Provider requests per window", apiRateLimitGenerationRequests: "Story requests per window", apiRateLimitImportRequests: "Import requests per window", apiConcurrencyProviderRequests: "Concurrent provider requests", apiConcurrencyImportRequests: "Concurrent imports"
};
const ARCHIVE_LABELS: Record<string, string> = { maxCompressedBytes: "Compressed size limit", maxUncompressedBytes: "Expanded size limit", maxEntries: "File count limit", maxExpansionRatio: "Expansion ratio limit", maxManifestBytes: "Manifest size limit", maxJsonEntryBytes: "JSON file size limit", maxOriginalImageBytes: "Original image size limit" };
function fieldLabel(field: SettingsFieldDescriptor) { const [group, child] = field.key.split("."); return child ? `${group === "campaignArchiveLimits" ? "Campaign archive" : "System Archive"} · ${ARCHIVE_LABELS[child]}` : LABELS[field.key] ?? field.label; }
function node<K extends keyof HTMLElementTagNameMap>(document: Document, tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag); if (text) element.textContent = text; if (className) element.className = className; return element;
}
/** Thin mount seam: owner/campaign editors keep their own authority and are loaded only on entry. */
export function mountSettingsPage(root: HTMLElement, route: SettingsRoute, options: { api?: InstanceSettingsApi } = {}): MountedPage {
  const shell = mountAppShell(root, '<main id="main-content" data-page="settings"><header class="settings-heading"><h1>Settings</h1><p>Configure this installation and find your campaign tools. Personal preferences are in User Profile.</p></header><div class="settings-layout"><nav aria-label="Settings sections" class="settings-nav"></nav><section class="settings-content" aria-labelledby="settings-section-title"></section></div></main>', "settings");
  const document = root.ownerDocument; const window = document.defaultView!;
  const content = root.querySelector<HTMLElement>(".settings-content")!;
  const nav = root.querySelector<HTMLElement>(".settings-nav")!;
  const session = createSettingsSession(options.api ?? createInstanceSettingsApi());
  let ownerEditor: { dispose(): void } | null = null;
  let editing = false;
  let pendingTextEdit = false;
  function guardInstallationDraft(event: BeforeUnloadEvent) {
    const { view, draft } = session.state;
    if (!view || !draft) return;
    const saved = view.requested ?? view.active;
    if (pendingTextEdit || view.fields.some(({ key }) => settingsValue(draft, key) !== settingsValue(saved, key))) {
      event.preventDefault();
      event.returnValue = "";
    }
  }
  let disposed = false; let review = false; let resetPreview = false; let validation: string[] = []; let reason = "";
  function clearDraftDetails() {
    reason = "";
    validation = [];
    review = false;
    resetPreview = false;
    pendingTextEdit = false;
  }
  let campaigns: CampaignSummary[] | null = null; let campaignFailed = false;
  const controller = new AbortController();
  const ownerApi = createNexusApiClient({ basePath: "/api/v1", session: createNoopSessionPort() });
  let meta: MetaResponse | null = null;
  for (const [key, title] of SETTINGS_SECTIONS) {
    const link = node(document, "a", title); const url = new URL("/app/settings", window.location.origin);
    url.searchParams.set("section", key); if (route.campaignId) url.searchParams.set("campaignId", route.campaignId);
    const back = safeSettingsReturn(new URL(window.location.href).searchParams.get("returnTo"));
    if (back) url.searchParams.set("returnTo", back);
    link.href = url.pathname + url.search; if (key === route.section) link.setAttribute("aria-current", "page"); nav.append(link);
  }
  const button = (text: string, action: () => void, disabled = false) => { const element = node(document, "button", text); element.type = "button"; element.disabled = disabled; element.addEventListener("click", action); return element; };
  function render() {
    if (disposed) return;
    if (ownerEditor) return;
    const focus = (document.activeElement as HTMLElement | null)?.dataset?.focus;
    pendingTextEdit = false;
    content.replaceChildren();
    const title = node(document, "h2", SETTINGS_SECTIONS.find(([key]) => key === route.section)![1]); title.id = "settings-section-title"; content.append(title);
    if (["providers", "prompts", "campaign"].includes(route.section)) {
      content.append(node(document, "p", route.section === "campaign" ? "Scope: selected campaign · your campaigns only" : "Scope: your account", "settings-scope"));
      if (route.section === "providers" || route.section === "prompts") {
        const host = node(document, "div", undefined, "settings-owner-editor");
        content.append(host);
        const ports = createOwnerSettingsApis();
        ownerEditor = route.section === "providers" ? mountProviderEditor(host, ports.providers)
          : mountPromptEditor(host, ports.prompts, route.campaignId, new URL(window.location.href).searchParams.get("prompt"), route.campaignSelectionRequired);
      } else if (!campaigns) {
        content.append(node(document, "p", campaignFailed ? "Your campaigns could not be loaded. Reload to retry." : "Loading your campaigns…", "settings-status"));
      } else {
        const host = node(document, "div", undefined, "settings-campaign-editor");
        content.append(host);
        ownerEditor = mountCampaignSettings(host, campaigns, route.campaignId, async signal => (await ownerApi.campaigns.list(signal)).campaigns);
      }
      return;
    }
    const state = session.state;
    content.append(node(document, "p", "Scope: installation · shared across this deployment · restart required", "settings-scope"));
    content.append(node(document, "p", state.localSingleUser ? "Save stages a requested revision. Activate it with the guarded settings command, then restart the application." : "Save stages a requested revision. Only an operator's coordinated restart can activate it. Story and campaign records are unchanged.", "settings-help"));
    if (state.message) { const message = node(document, "p", state.message, "settings-status"); message.setAttribute("role", state.conflict ? "alert" : "status"); content.append(message); }
    if (!state.unlocked) {
      clearDraftDetails();
      if (state.busy) content.append(node(document, "p", "Checking installation access…"));
      else if (state.localSingleUser) content.append(node(document, "p", "Local installation access is unavailable. Reload Settings to retry."));
      else if (!state.managementEnabled) content.append(node(document, "p", "Installation management is locked. It requires HTTPS and deployment-provisioned operator access. Your personal and campaign settings remain available."));
      else {
        const form = node(document, "form"); const label = node(document, "label", "Operator management key", "settings-key-label"); const input = node(document, "input"); input.type = "password"; input.autocomplete = "off"; input.required = true; input.maxLength = 4096; input.dataset.focus = "unlock-key";
        const unlock = node(document, "button", "Unlock installation settings"); unlock.type = "submit";
        label.append(input); form.append(label, unlock); form.addEventListener("submit", event => { event.preventDefault(); const key = input.value; input.value = ""; void session.unlock(key); }); content.append(form);
        content.append(node(document, "p", "Operator access expires after 15 minutes. The key stays only in this form until submission.", "settings-help"));
      }
      return;
    }
    if (!state.localSingleUser) content.append(button("Lock installation settings", () => { void session.logout(); }));
    if (!state.view || !state.draft) { content.append(node(document, "p", state.busy ? "Loading installation settings…" : "Installation values are unavailable.")); return; }
    const { view, draft } = state;
    const revisions = node(document, "dl", undefined, "settings-revisions");
    for (const [label, value] of [["Active revision", view.activeRevision ?? "Environment configuration"], ["Saved revision", view.requestedRevision ?? "Not initialized"]]) { revisions.append(node(document, "dt", label), node(document, "dd", value)); }
    content.append(revisions);
    if (route.section === "diagnostics") {
      content.append(node(document, "p", view.activationStatus === "restart_required" ? "Application status: running with a staged revision awaiting coordinated restart." : "Application status: serving the active configuration."));
      content.append(node(document, "p", meta ? `Application version: ${meta.application.version}${meta.application.builtAt ? ` · Built ${new Date(meta.application.builtAt).toLocaleDateString()}` : ""}` : "Application build information unavailable.", "settings-help"));
    }
    const fields = view.fields.filter(field => field.section === route.section);
    function saveDisabled() {
      const current = session.state;
      const draft = current.draft;
      return current.busy || current.conflict || view.requestedRevision === null || validation.length > 0 ||
        !draft || !fields.some(field => settingsValue(draft, field.key) !== settingsValue(view.requested ?? view.active, field.key));
    }
    if (validation.length) { const summary = node(document, "div", undefined, "settings-validation"); summary.setAttribute("role", "alert"); summary.tabIndex = -1; summary.append(node(document, "h3", "Check these values")); const list = node(document, "ul"); for (const error of validation) list.append(node(document, "li", error)); summary.append(list); content.append(summary); }
    const list = node(document, "div", undefined, "settings-fields");
    for (const field of fields) {
      const row = node(document, "div", undefined, "settings-field"); const label = node(document, "label", fieldLabel(field)); const id = `setting-${field.key.replaceAll(".", "-")}`; label.htmlFor = id;
      const unit = displayUnit(field); const value = settingsValue(draft, field.key); let input: HTMLInputElement | HTMLSelectElement;
      if (field.kind === "enum") { input = node(document, "select"); for (const level of ["fatal", "error", "warn", "info", "debug", "trace", "silent"]) input.append(new Option(level, level)); input.value = String(value); }
      else { input = node(document, "input"); if (field.kind === "boolean") { input.type = "checkbox"; input.checked = value === true; } else { input.type = "text"; input.inputMode = "decimal"; input.value = readableValue(field, value).split(" ")[0]!; } }
      input.id = id; input.dataset.focus = id; input.disabled = state.busy || view.requestedRevision === null || field.lockReason === "deployment_disabled";
      const help = node(document, "p", undefined, "settings-help"); help.id = `${id}-help`; input.setAttribute("aria-describedby", help.id);
      help.textContent = field.lockReason === "deployment_disabled" ? "Blocked by deployment policy. Settings cannot enable this capability." : field.lockReason === "dependency_disabled" ? "Currently blocked by a disabled dependency. A saved preference will not bypass that dependency." : field.kind === "integer" && field.permittedRange ? `Permitted: ${readableRangeValue(field, field.permittedRange.min)} – ${readableRangeValue(field, field.permittedRange.max)}.` : "Applies after an operator activates the saved revision and restarts the deployment.";
      if (field.kind === "integer") {
        const displayedValue = input.value;
        input.addEventListener("input", () => { pendingTextEdit = input.value !== displayedValue; });
      }
      input.addEventListener("change", () => {
        pendingTextEdit = false;
        try {
          const next = field.kind === "boolean" ? (input as HTMLInputElement).checked : field.kind === "enum" ? input.value : fromDisplayUnit(input.value, unit.factor);
          if (typeof next === "number" && field.permittedRange && (next < field.permittedRange.min || next > field.permittedRange.max)) throw new Error("Outside the permitted range.");
          validation = []; review = false; resetPreview = false;
          // Keep the live control mounted through blur/Tab so keyboard focus is never lost.
          editing = true;
          try { session.edit(field.key, next); } finally { editing = false; }
          content.querySelectorAll(".settings-validation, .settings-review, .settings-status").forEach(element => element.remove());
          const saveButton = content.querySelector<HTMLButtonElement>("[data-settings-save]");
          if (saveButton && session.state.draft) {
            saveButton.textContent = "Save section";
            saveButton.disabled = saveDisabled();
          }
        } catch (error) { validation = [`${fieldLabel(field)}: ${error instanceof Error ? error.message : "Invalid value."}`]; render(); content.querySelector<HTMLElement>(".settings-validation")?.focus(); }
      });
      const explanations: Record<string, string> = {
        workerPollIntervalMs: "How often workers look for queued jobs. Shorter intervals increase database polling.",
        textProviderConcurrency: "Shared text-provider slots used when character discovery is enabled. This lane is separate from per-worker story-generation capacity.",
        workerGenerationConcurrency: "Story jobs admitted simultaneously by each worker. More slots increase provider and database load.",
        apiRateLimitWindowSeconds: "Counts below apply together within this window. The complete rate tuple must be approved by deployment policy.",
        apiDefaultBodyLimitBytes: "Maximum standard API request payload; larger requests are rejected.",
        apiImportBodyLimitBytes: "Maximum import request payload. Archive expansion limits still apply independently.",
        apiAssetBodyLimitBytes: "Maximum artwork upload payload; does not select an image provider.",
        apiRateLimitProviderRequests: "Provider operations permitted per request-rate window.",
        apiRateLimitGenerationRequests: "Story-generation requests permitted per request-rate window.",
        apiRateLimitImportRequests: "Import requests permitted per request-rate window.",
        apiConcurrencyProviderRequests: "Provider API operations allowed in flight at once.",
        apiConcurrencyImportRequests: "Import API operations allowed in flight at once.",
        archivePreviewTtlSeconds: "How long an import preview remains available for confirmation.",
        systemArchiveArtifactTtlSeconds: "How long a completed System Archive download remains available.",
        systemArchiveUploadTtlSeconds: "How long a pending System Archive upload remains available.",
        systemArchiveChunkBytes: "Size of each archive transfer chunk. Larger chunks require more request memory.",
        logLevel: "Diagnostic verbosity after restart. More detailed logging increases output volume."
      };
      if (explanations[field.key]) help.textContent = `${explanations[field.key]} ${help.textContent}`;
      const control = node(document, "div", undefined, "settings-field-control"); control.append(input); if (field.kind === "integer") control.append(node(document, "span", unit.label));
      const comparison = node(document, "p", `Active: ${readableValue(field, settingsValue(view.active, field.key))} · Saved: ${readableValue(field, settingsValue(view.requested ?? view.active, field.key))}`, "settings-comparison");
      row.append(label, control, help, comparison); list.append(row);
    }
    content.append(list);
    const changed = fields.filter(field => settingsValue(draft, field.key) !== settingsValue(view.requested ?? view.active, field.key));
    const footer = node(document, "div", undefined, "settings-actions");
    const reasonLabel = node(document, "label", "Reason for this change"); const reasonInput = node(document, "input"); reasonInput.maxLength = 1000; reasonInput.value = reason; reasonInput.dataset.focus = "reason"; reasonLabel.append(reasonInput); footer.append(reasonLabel);
    const save = () => { if (!reason.trim()) { validation = [MISSING_REASON]; render(); content.querySelector<HTMLElement>(".settings-validation")?.focus(); return; } if (!review && (route.section === "sharing" || route.section === "performance")) { review = true; render(); content.querySelector<HTMLElement>(".settings-review")?.focus(); return; } review = false; void session.save(fields.map(field => field.key), reason); };
    const saveButton = button(review ? "Confirm staged Save" : "Save section", save, saveDisabled());
    saveButton.dataset.settingsSave = "";
    reasonInput.addEventListener("input", () => {
      reason = reasonInput.value;
      if (reason.trim() && validation.length === 1 && validation[0] === MISSING_REASON) {
        validation = [];
        content.querySelector(".settings-validation")?.remove();
        saveButton.disabled = saveDisabled();
      }
    });
    footer.append(saveButton);
    footer.append(button(state.conflict ? "Discard all drafts and reload" : "Discard section draft", () => { validation = []; review = false; resetPreview = false; session.discard(fields.map(field => field.key)); if (state.conflict) void session.load(); }, state.busy));
    footer.append(button("Preview safe defaults", () => { resetPreview = !resetPreview; review = false; render(); }, state.busy || !view.resetDefaults));
    if (!view.resetDefaults) footer.append(node(document, "p", "Safe defaults are unavailable under the current deployment policy. No reset will be staged.", "settings-help"));
    content.append(footer);
    if (resetPreview && view.resetDefaults) {
      const preview = node(document, "section", undefined, "settings-review"); preview.append(node(document, "h3", "Preview safe seeded defaults"));
      for (const field of fields) preview.append(node(document, "p", `${fieldLabel(field)}: ${readableValue(field, settingsValue(draft, field.key))} → ${readableValue(field, settingsValue(view.resetDefaults, field.key))}`));
      preview.append(button("Use defaults in draft", () => { const defaults = view.resetDefaults!; resetPreview = false; for (const field of fields) if (field.lockReason !== "deployment_disabled") session.edit(field.key, settingsValue(defaults, field.key)); render(); })); content.append(preview);
    }
    if (review) {
      const summary = node(document, "section", undefined, "settings-review"); summary.tabIndex = -1; summary.append(node(document, "h3", "Review staged policy changes"), node(document, "p", "These changes affect sharing or resource policy across the installation. Confirming saves them for a coordinated restart; running limits stay unchanged."));
      for (const field of changed) summary.append(node(document, "p", `${fieldLabel(field)}: ${readableValue(field, settingsValue(view.requested ?? view.active, field.key))} → ${readableValue(field, settingsValue(draft, field.key))}`)); content.append(summary);
    }
    if (focus) content.querySelector<HTMLElement>(`[data-focus="${focus}"]`)?.focus();
  }
  const unsubscribe = session.subscribe(() => { if (!editing) render(); });
  const installation = !["providers", "prompts", "campaign"].includes(route.section);
  if (installation) {
    window.addEventListener("beforeunload", guardInstallationDraft);
    void session.load();
  }
  if (route.section === "campaign") void ownerApi.campaigns.list(controller.signal).then(value => { if (!disposed) { campaigns = value.campaigns; render(); } }).catch(() => { if (!disposed) { campaignFailed = true; render(); } });
  if (route.section === "diagnostics") void ownerApi.meta.get(controller.signal).then(value => { if (!disposed) { meta = value; render(); } }).catch(() => undefined);
  function disposePage(): void {
    if (disposed) return;
    disposed = true;
    campaigns = null;
    campaignFailed = false;
    meta = null;
    clearDraftDetails();
    ownerEditor?.dispose();
    ownerEditor = null;
    controller.abort();
    window.clearInterval(expiryTimer);
    window.removeEventListener("beforeunload", guardInstallationDraft);
    window.removeEventListener("app-identity-changed", onIdentityChange);
    unsubscribe();
    session.dispose();
    shell.dispose();
    content.replaceChildren();
  }
  // Identity changes invalidate the whole route, including its owner-scoped list and links.
  // Disposing also guards late responses even if a transport ignores cancellation.
  const onIdentityChange = () => {
    void session.logout();
    disposePage();
    const main = node(document, "main");
    main.id = "main-content";
    const message = node(document, "p", "Your account changed. Reload Settings to continue.");
    message.setAttribute("role", "status");
    const reload = node(document, "a", "Reload Settings");
    reload.href = "/app/settings";
    main.append(message, reload);
    root.replaceChildren(main);
  };
  window.addEventListener("app-identity-changed", onIdentityChange);
  const expiryTimer = window.setInterval(() => {
    if (session.state.expiresAt && Date.parse(session.state.expiresAt) <= Date.now()) void session.logout();
  }, 1000);
  return { dispose: disposePage };
}
