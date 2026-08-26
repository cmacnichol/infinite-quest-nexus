import { initializeAppTheme, renderAppShell } from "./app-shell";
import {
  createDataTransferApi,
  type DataTransferApi,
  type SystemArchiveJobView,
  type SystemImportPreviewView,
  type SystemUploadProgress,
  type SystemUploadView
} from "./data-transfer-api";

export interface DataTransferPageDependencies {
  api?: DataTransferApi;
  storage?: Storage | null;
  operationStorage?: Storage | null;
  wait?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number;
}

export interface MountedDataTransferPage {
  dispose(): void;
}

const TERMINAL_JOB_STATUSES = new Set<SystemArchiveJobView["status"]>([
  "published", "completed", "cancelled", "rolled_back", "failed", "expired"
]);

const CANCELLABLE_EXPORT_STATUSES = new Set<SystemArchiveJobView["status"]>([
  "queued", "capturing", "writing", "verifying", "cancelling"
]);

const CANCELLABLE_IMPORT_STATUSES = new Set<SystemArchiveJobView["status"]>([
  "queued", "uploading", "validating", "previewed", "revalidating", "waiting_for_gate", "cancelling"
]);

const ACKNOWLEDGEMENTS = [
  "acknowledgeSensitiveArchive",
  "acknowledgeEmptyDestination",
  "acknowledgeInvalidatedAccess",
  "acknowledgeProviderReentry",
  "acknowledgeNonCancellableBoundary"
] as const;

type StoredSystemOperation = Readonly<{
  kind: "export" | "import";
  idempotencyKey: string;
  jobId: string | null;
  previewHandle?: string;
}>;

const OPERATION_STORAGE_PREFIX = "infiniteQuest.systemArchiveOperation.v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function operationStorageKey(ownerId: string, kind: StoredSystemOperation["kind"]): string {
  return `${OPERATION_STORAGE_PREFIX}:${ownerId}:${kind}`;
}

function readStoredOperation(storage: Storage | null, ownerId: string, kind: StoredSystemOperation["kind"]): StoredSystemOperation | null {
  if (!storage) return null;
  try {
    const value: unknown = JSON.parse(storage.getItem(operationStorageKey(ownerId, kind)) ?? "null");
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.kind !== kind || typeof record.idempotencyKey !== "string" || record.idempotencyKey.length < 1 || record.idempotencyKey.length > 200) return null;
    if (record.jobId !== null && (typeof record.jobId !== "string" || !UUID_PATTERN.test(record.jobId))) return null;
    if (record.previewHandle !== undefined && (typeof record.previewHandle !== "string" || record.previewHandle.length < 1 || record.previewHandle.length > 200)) return null;
    return {
      kind,
      idempotencyKey: record.idempotencyKey,
      jobId: record.jobId as string | null,
      ...(typeof record.previewHandle === "string" ? { previewHandle: record.previewHandle } : {})
    };
  } catch {
    return null;
  }
}

function writeStoredOperation(storage: Storage | null, ownerId: string, operation: StoredSystemOperation): void {
  if (!storage) return;
  try {
    storage.setItem(operationStorageKey(ownerId, operation.kind), JSON.stringify(operation));
  } catch {
    // The transfer remains usable for this page when browser session storage is blocked.
  }
}

const pageMarkup = `
  <main id="main-content" class="data-transfer-page" data-page="data-transfer">
    <section class="data-transfer-heading" aria-labelledby="data-transfer-title">
      <p class="data-transfer-kicker">Portable data, explicit boundaries</p>
      <h1 id="data-transfer-title">Data Transfer</h1>
      <p>Move a whole owner library, one world, one campaign, or a readable story without changing the specialized formats you already use.</p>
    </section>

    <section class="transfer-purpose-grid" aria-label="Data Transfer purposes">
      <article class="transfer-purpose system-purpose" data-transfer-purpose="system">
        <span class="purpose-index" aria-hidden="true">01</span>
        <h2>System Archive</h2>
        <p>Export or restore the Current Owner's complete portable library and every retained original image.</p>
      </article>
      <article class="transfer-purpose" data-transfer-purpose="archives">
        <span class="purpose-index" aria-hidden="true">02</span>
        <h2>World &amp; Campaign Archives</h2>
        <p>Keep using targeted JSON and Campaign Archive exports from their contextual management screens.</p>
        <div class="purpose-links"><a href="/nexus/#world-library">World Management</a><a href="/nexus/#campaigns">Campaign Management</a></div>
      </article>
      <article class="transfer-purpose" data-transfer-purpose="imports">
        <span class="purpose-index" aria-hidden="true">03</span>
        <h2>Legacy &amp; External Imports</h2>
        <p>Import legacy stories, Infinite Worlds data, CYOA JSON, text, and existing portable backups.</p>
        <div class="purpose-links"><a href="/nexus/#imports">Open import tools</a></div>
      </article>
      <article class="transfer-purpose" data-transfer-purpose="readable">
        <span class="purpose-index" aria-hidden="true">04</span>
        <h2>Readable Story Exports</h2>
        <p>Create Markdown, HTML, or PDF reading copies from a campaign's Data page.</p>
        <div class="purpose-links"><a href="/app/campaigns">Open campaigns</a></div>
      </article>
    </section>

    <section class="system-transfer-workbench" data-system-archive-state="checking" aria-labelledby="system-transfer-title">
      <header class="workbench-heading">
        <div><p class="data-transfer-kicker">Owner-wide portability</p><h2 id="system-transfer-title">System Archive</h2></div>
        <span class="capability-badge" data-system-capability>Checking availability…</span>
      </header>
      <p class="system-capability-message" data-system-capability-message>Asking the server whether owner-wide transfer is enabled.</p>

      <div class="system-transfer-columns">
        <section class="system-operation" aria-labelledby="system-export-title">
          <div class="operation-heading"><span aria-hidden="true">OUT</span><div><h3 id="system-export-title">Export this owner</h3><p>Creates one server-owned ZIP. It contains portable stories, pictures, and settings; credentials and operational work remain excluded.</p></div></div>
          <button type="button" class="data-transfer-primary" data-action="create-system-export" disabled>Create System Archive</button>
          <a class="data-transfer-download" data-system-download hidden>Download published archive</a>
        </section>

        <section class="system-operation" aria-labelledby="system-import-title">
          <div class="operation-heading"><span aria-hidden="true">IN</span><div><h3 id="system-import-title">Import into this instance</h3><p>The destination must contain only its generated initial owner. The browser uploads bytes; all ZIP inspection stays on the server.</p></div></div>
          <label class="system-file-field" for="system-archive-file">System Archive file
            <input id="system-archive-file" type="file" accept=".zip,application/zip,application/x-zip-compressed" disabled />
          </label>
          <div class="system-upload-actions">
            <button type="button" data-action="upload-system-archive" disabled>Upload and preview</button>
            <button type="button" data-action="cancel-system-operation" disabled>Cancel current operation</button>
          </div>
          <div class="system-transfer-progress" data-system-progress role="status" aria-live="polite" aria-atomic="true" hidden>
            <div><strong id="system-transfer-progress-label" data-system-progress-label>Preparing transfer…</strong><span data-system-progress-value>0%</span></div>
            <progress max="100" value="0" aria-labelledby="system-transfer-progress-label"></progress>
          </div>
        </section>
      </div>

      <div class="system-transfer-status" data-system-status role="status" aria-live="polite">System Archive controls are loading.</div>
      <div class="system-transfer-error" data-system-error role="alert" hidden></div>

      <section class="system-import-preview" data-system-preview="empty" aria-labelledby="system-preview-title" hidden>
        <header><div><p class="data-transfer-kicker">Server-owned inspection</p><h3 id="system-preview-title">Import Preview</h3></div><span data-system-preview-expiry></span></header>
        <div class="preview-summary-grid" data-system-preview-summary></div>
        <div class="preview-detail-grid">
          <section><h4>Ownership mapping</h4><p data-system-owner-mapping></p></section>
          <section><h4>Version provenance</h4><p data-system-version-summary></p><p class="archive-identity" data-system-fingerprint></p></section>
          <section><h4>Normalization</h4><p data-system-normalization></p></section>
          <section><h4>Capacity checks</h4><p data-system-staging-capacity></p><p data-system-asset-capacity></p></section>
          <section><h4>Provider recovery</h4><p data-system-provider-summary></p></section>
          <section><h4>External access</h4><p data-system-access-summary></p></section>
          <section><h4>Rebuild work</h4><p data-system-rebuild-summary></p></section>
          <section><h4>Operational omissions</h4><p data-system-omission-summary></p></section>
        </div>
        <div class="system-preview-warnings" data-system-preview-warnings hidden></div>
        <fieldset class="system-acknowledgements" data-system-acknowledgements disabled>
          <legend>Confirm every import boundary</legend>
          <label><input type="checkbox" name="acknowledgeSensitiveArchive" /> This archive contains sensitive story and image data; I will protect the file.</label>
          <label><input type="checkbox" name="acknowledgeEmptyDestination" /> Destination must be empty; this operation does not merge or replace data.</label>
          <label><input type="checkbox" name="acknowledgeInvalidatedAccess" /> External access will be invalidated; share links, sessions, and identity bindings do not transfer.</label>
          <label><input type="checkbox" name="acknowledgeProviderReentry" /> I will enter provider credentials again and explicitly verify and enable each provider.</label>
          <label><input type="checkbox" name="acknowledgeNonCancellableBoundary" /> I understand the non-cancellable boundary begins when authoritative import starts.</label>
        </fieldset>
        <button type="button" class="data-transfer-primary" data-action="commit-system-import" disabled>Import System Archive</button>
      </section>

      <section class="system-import-report" data-system-import-state="idle" aria-labelledby="system-report-title" hidden>
        <header><div><p class="data-transfer-kicker">Durable outcome</p><h3 id="system-report-title">Import Report</h3></div><strong data-system-report-status></strong></header>
        <div class="report-summary-grid" data-system-report-summary></div>
        <div class="report-evidence-grid">
          <section><h4>Ownership mapping</h4><p data-system-report-owner-mapping></p></section>
          <section><h4>Version and archive identity</h4><p data-system-report-version-summary></p><p class="archive-identity" data-system-report-fingerprint></p></section>
          <section><h4>Normalization and access</h4><p data-system-report-normalization></p><p data-system-report-access></p></section>
          <section><h4>Integrity reconciliation</h4><p data-system-report-integrity></p></section>
          <section><h4>Categorized omissions</h4><p data-system-report-omissions></p></section>
          <section><h4>Terminal diagnostics</h4><p data-system-report-diagnostics></p></section>
        </div>
        <div class="recovery-checklist">
          <section><h4>Provider recovery</h4><p>Enter credentials, verify health and model discovery, then explicitly enable each imported profile.</p><a href="/nexus/#providers">Open Provider Setup</a></section>
          <section><h4>Access recovery</h4><p>Create new access relationships on this destination. Source share links and sessions remain invalid.</p></section>
          <section><h4>Rebuilds queued</h4><p data-system-report-rebuilds></p></section>
        </div>
      </section>
    </section>
  </main>
`;

function requiredElement<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error("The Data Transfer interface could not be initialized.");
  return element;
}

function randomIdempotencyKey(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random}`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} bytes`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let size = value;
  let index = -1;
  do {
    size /= 1024;
    index += 1;
  } while (size >= 1024 && index < units.length - 1);
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[index]}`;
}

function formatOwnerMapping(mapping: SystemImportPreviewView["ownerMapping"]): string {
  return `Source owner ${mapping.sourceOwnerId}. Destination owner ${mapping.destinationOwnerId}.`;
}

function formatVersions(versions: SystemImportPreviewView["versions"]): string {
  return `Archive format ${versions.archiveFormat}. Source application ${versions.sourceApplication}. Source migration ${versions.sourceMigration}. `
    + `Destination application ${versions.destinationApplication}. Destination migration ${versions.destinationMigration}.`;
}

function formatCapacity(label: string, capacity: SystemImportPreviewView["space"]["staging"]): string {
  const available = capacity.availableBytes === null ? "unknown available" : `${formatBytes(capacity.availableBytes)} available`;
  return `${label} capacity: ${formatBytes(capacity.requiredBytes)} required · ${available} · ${capacity.verified ? "verified" : "not verified"} · `
    + `${capacity.sufficient ? "sufficient" : "insufficient"} · ${capacity.overrideUsed ? "operator override used" : "no capacity override"}.`;
}

function formatOperationalOmissions(omissions: SystemImportPreviewView["operationalOmissions"]): string {
  return Object.entries(omissions).map(([category, count]) => `${category} ${formatCount(count)}`).join(" · ");
}

function appendSummary(document: Document, container: Element, label: string, value: string): void {
  const item = document.createElement("div");
  const term = document.createElement("span");
  const detail = document.createElement("strong");
  term.textContent = label;
  detail.textContent = value;
  item.append(term, detail);
  container.append(item);
}

function isJobCancellable(job: SystemArchiveJobView): boolean {
  return job.kind === "export"
    ? CANCELLABLE_EXPORT_STATUSES.has(job.status)
    : CANCELLABLE_IMPORT_STATUSES.has(job.status);
}

export function mountDataTransferPage(
  root: HTMLElement,
  dependencies: DataTransferPageDependencies = {}
): MountedDataTransferPage {
  renderAppShell(root, pageMarkup, "data-transfer");
  const theme = initializeAppTheme(root);
  const document = root.ownerDocument;
  const view = document.defaultView;
  if (!view) {
    theme.dispose();
    throw new Error("The Data Transfer interface could not be initialized.");
  }
  const api = dependencies.api ?? createDataTransferApi({ storage: dependencies.storage });
  let operationStorage = dependencies.operationStorage;
  if (operationStorage === undefined) {
    try {
      operationStorage = view.sessionStorage;
    } catch {
      operationStorage = null;
    }
  }
  const wait = dependencies.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => view.setTimeout(resolve, milliseconds)));
  const pollIntervalMs = dependencies.pollIntervalMs ?? 1_000;
  const controller = new AbortController();
  const workbench = requiredElement<HTMLElement>(root, "[data-system-archive-state]");
  const capabilityBadge = requiredElement<HTMLElement>(root, "[data-system-capability]");
  const capabilityMessage = requiredElement<HTMLElement>(root, "[data-system-capability-message]");
  const exportButton = requiredElement<HTMLButtonElement>(root, '[data-action="create-system-export"]');
  const fileInput = requiredElement<HTMLInputElement>(root, "#system-archive-file");
  const uploadButton = requiredElement<HTMLButtonElement>(root, '[data-action="upload-system-archive"]');
  const cancelButton = requiredElement<HTMLButtonElement>(root, '[data-action="cancel-system-operation"]');
  const commitButton = requiredElement<HTMLButtonElement>(root, '[data-action="commit-system-import"]');
  const download = requiredElement<HTMLAnchorElement>(root, "[data-system-download]");
  const status = requiredElement<HTMLElement>(root, "[data-system-status]");
  const error = requiredElement<HTMLElement>(root, "[data-system-error]");
  const progressRegion = requiredElement<HTMLElement>(root, "[data-system-progress]");
  const progress = requiredElement<HTMLProgressElement>(progressRegion, "progress");
  const progressLabel = requiredElement<HTMLElement>(progressRegion, "[data-system-progress-label]");
  const progressValue = requiredElement<HTMLElement>(progressRegion, "[data-system-progress-value]");
  const previewRegion = requiredElement<HTMLElement>(root, "[data-system-preview]");
  const acknowledgements = requiredElement<HTMLFieldSetElement>(root, "[data-system-acknowledgements]");
  const reportRegion = requiredElement<HTMLElement>(root, "[data-system-import-state]");
  let disposed = false;
  let capabilityAvailable = false;
  let selectedFile: File | null = null;
  let currentUpload: SystemUploadView | null = null;
  const currentJobs: Record<SystemArchiveJobView["kind"], SystemArchiveJobView | null> = {
    export: null,
    import: null
  };
  let currentExportOperation: StoredSystemOperation | null = null;
  let currentImportOperation: StoredSystemOperation | null = null;
  let currentPreview: SystemImportPreviewView | null = null;
  let actionBusy = false;
  let operationController: AbortController | null = null;
  let operationKind: "export" | "upload" | "import" | null = null;
  let sessionOwnerId: string | null = null;

  function announce(message: string): void {
    status.textContent = message;
  }

  function announceError(reason: unknown): void {
    const message = reason instanceof Error ? reason.message : String(reason);
    error.textContent = message;
    error.hidden = false;
    announce("Data Transfer needs attention.");
  }

  function clearError(): void {
    error.textContent = "";
    error.hidden = true;
  }

  function updateControls(): void {
    const jobCancellable = Object.values(currentJobs).some((job) => job !== null && isJobCancellable(job));
    const localOperationCancellable = operationController !== null
      && (operationKind === "upload" || (operationKind === "export" && currentJobs.export === null));
    exportButton.disabled = !capabilityAvailable || actionBusy || (currentJobs.export !== null && !TERMINAL_JOB_STATUSES.has(currentJobs.export.status));
    fileInput.disabled = !capabilityAvailable || actionBusy;
    uploadButton.disabled = !capabilityAvailable || actionBusy || selectedFile === null;
    cancelButton.disabled = !capabilityAvailable || (!jobCancellable && currentUpload === null && !localOperationCancellable);
    commitButton.disabled = !capabilityAvailable || actionBusy || currentPreview?.valid !== true;
  }

  function setBusy(busy: boolean): void {
    actionBusy = busy;
    workbench.setAttribute("aria-busy", String(busy));
    updateControls();
  }

  function renderProgress(value: SystemUploadProgress): void {
    const percent = value.byteLength > 0 ? Math.min(100, Math.round(value.receivedBytes / value.byteLength * 100)) : 0;
    progressRegion.hidden = false;
    progress.value = percent;
    progressValue.textContent = `${percent}%`;
    progressLabel.textContent = value.phase === "hashing"
      ? "Checking archive integrity…"
      : value.phase === "uploading"
        ? `Uploading resumable chunks · ${formatBytes(value.receivedBytes)} of ${formatBytes(value.byteLength)}`
        : "Verifying the completed server upload…";
  }

  function renderPreview(value: SystemImportPreviewView): void {
    currentPreview = value;
    previewRegion.hidden = false;
    previewRegion.dataset.systemPreview = value.valid ? "ready" : "invalid";
    const summary = requiredElement<HTMLElement>(previewRegion, "[data-system-preview-summary]");
    summary.replaceChildren();
    appendSummary(document, summary, "Destination", value.destinationEmpty ? "Empty and eligible" : "Not empty");
    appendSummary(document, summary, "Portable records", formatCount(Object.values(value.recordsByDomain).reduce((total, count) => total + count, 0)));
    appendSummary(document, summary, "Original images", `${formatCount(value.assets.originalCount)} · ${formatBytes(value.assets.totalBytes)}`);
    appendSummary(document, summary, "Source owners", String(value.sourceOwnerCount));
    requiredElement<HTMLElement>(previewRegion, "[data-system-preview-expiry]").textContent = value.expiresAt
      ? `Preview expires ${new Date(value.expiresAt).toLocaleString()}`
      : "No commit authority issued";
    requiredElement<HTMLElement>(previewRegion, "[data-system-owner-mapping]").textContent = formatOwnerMapping(value.ownerMapping);
    requiredElement<HTMLElement>(previewRegion, "[data-system-version-summary]").textContent = formatVersions(value.versions);
    requiredElement<HTMLElement>(previewRegion, "[data-system-fingerprint]").textContent = value.archiveFingerprint
      ? `Archive fingerprint ${value.archiveFingerprint}.`
      : "Archive fingerprint unavailable.";
    requiredElement<HTMLElement>(previewRegion, "[data-system-normalization]").textContent =
      `Normalization ${value.normalization.join(" · ") || "none"}.`;
    requiredElement<HTMLElement>(previewRegion, "[data-system-staging-capacity]").textContent = formatCapacity("Staging", value.space.staging);
    requiredElement<HTMLElement>(previewRegion, "[data-system-asset-capacity]").textContent = formatCapacity("Asset-root", value.space.assetRoot);
    requiredElement<HTMLElement>(previewRegion, "[data-system-provider-summary]").textContent =
      `${formatCount(value.disabledProviders)} disabled providers. Credentials are excluded and must be entered again.`;
    requiredElement<HTMLElement>(previewRegion, "[data-system-access-summary]").textContent = value.invalidatedAccess.length
      ? `External access will be invalidated: ${value.invalidatedAccess.join(", ")}.`
      : "No external access categories were reported.";
    requiredElement<HTMLElement>(previewRegion, "[data-system-rebuild-summary]").textContent =
      `Chronicle index: ${formatCount(value.rebuilds.chronicleIndex.itemCount)} campaigns. Asset thumbnails: ${formatCount(value.rebuilds.assetThumbnails.itemCount)} originals.`;
    requiredElement<HTMLElement>(previewRegion, "[data-system-omission-summary]").textContent =
      `${formatCount(value.omittedOperationalRows)} rows excluded · ${formatOperationalOmissions(value.operationalOmissions)}.`;
    const warnings = requiredElement<HTMLElement>(previewRegion, "[data-system-preview-warnings]");
    const diagnostics = [...value.warnings, ...value.errors];
    warnings.hidden = diagnostics.length === 0;
    warnings.textContent = diagnostics.join(" ");
    acknowledgements.disabled = !value.valid;
    for (const checkbox of acknowledgements.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      checkbox.checked = false;
      checkbox.removeAttribute("aria-invalid");
    }
    updateControls();
  }

  function invalidatePreviewAuthority(): void {
    currentPreview = null;
    previewRegion.hidden = true;
    previewRegion.dataset.systemPreview = "empty";
    acknowledgements.disabled = true;
    for (const checkbox of acknowledgements.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      checkbox.checked = false;
      checkbox.removeAttribute("aria-invalid");
    }
    updateControls();
  }

  function renderReport(job: SystemArchiveJobView): void {
    if (job.kind !== "import" || !job.report) return;
    const report = job.report;
    reportRegion.hidden = false;
    reportRegion.dataset.systemImportState = job.status;
    requiredElement<HTMLElement>(reportRegion, "[data-system-report-status]").textContent = job.status === "completed"
      ? "Integrity verified"
      : job.status.replaceAll("_", " ");
    const summary = requiredElement<HTMLElement>(reportRegion, "[data-system-report-summary]");
    summary.replaceChildren();
    appendSummary(document, summary, "Records restored", formatCount(Object.values(report.recordsByDomain).reduce((total, count) => total + count, 0)));
    appendSummary(document, summary, "Original images", `${formatCount(report.assetCount)} · ${formatBytes(report.assetBytes)}`);
    appendSummary(document, summary, "Providers disabled", formatCount(report.disabledProviders));
    appendSummary(document, summary, "Access categories invalidated", formatCount(report.invalidatedAccess.length));
    requiredElement<HTMLElement>(reportRegion, "[data-system-report-owner-mapping]").textContent = formatOwnerMapping(report.ownerMapping);
    requiredElement<HTMLElement>(reportRegion, "[data-system-report-version-summary]").textContent = formatVersions(report.versions);
    requiredElement<HTMLElement>(reportRegion, "[data-system-report-fingerprint]").textContent = `Archive fingerprint ${report.archiveFingerprint}.`;
    requiredElement<HTMLElement>(reportRegion, "[data-system-report-normalization]").textContent =
      `Normalization ${report.normalization.join(" · ")}.`;
    requiredElement<HTMLElement>(reportRegion, "[data-system-report-access]").textContent =
      `Invalidated access ${report.invalidatedAccess.join(" · ")}.`;
    requiredElement<HTMLElement>(reportRegion, "[data-system-report-integrity]").textContent =
      "Fingerprint verified · Records matched · Original assets matched.";
    requiredElement<HTMLElement>(reportRegion, "[data-system-report-omissions]").textContent =
      `${formatCount(report.omittedOperationalRows)} rows excluded · ${formatOperationalOmissions(report.operationalOmissions)}.`;
    const diagnostics = [
      ...report.warnings.map((warning) => `Warning ${warning}`),
      ...report.errors.map((code) => `Error ${code}`)
    ];
    requiredElement<HTMLElement>(reportRegion, "[data-system-report-diagnostics]").textContent = diagnostics.length
      ? diagnostics.join(" · ")
      : "No terminal warnings or errors.";
    requiredElement<HTMLElement>(reportRegion, "[data-system-report-rebuilds]").textContent =
      `Chronicle index: ${report.rebuildState.chronicleIndex.status} for ${formatCount(report.rebuildState.chronicleIndex.itemCount)} campaigns. `
      + `Asset thumbnails: ${report.rebuildState.assetThumbnails.status} for ${formatCount(report.rebuildState.assetThumbnails.itemCount)} originals.`;
  }

  function renderJob(job: SystemArchiveJobView): void {
    currentJobs[job.kind] = job;
    announce(`${job.kind === "export" ? "System Export" : "System Import"}: ${job.status.replaceAll("_", " ")}.`);
    if (job.kind === "export" && job.status === "published") {
      download.href = api.downloadUrl(job.id);
      download.hidden = false;
    }
    if (job.kind === "import") renderReport(job);
    updateControls();
  }

  async function monitorJob(job: SystemArchiveJobView): Promise<SystemArchiveJobView> {
    let latest = job;
    renderJob(latest);
    while (!disposed && !TERMINAL_JOB_STATUSES.has(latest.status)) {
      await wait(pollIntervalMs);
      if (disposed) return latest;
      latest = await api.getJob(latest.kind, latest.id, controller.signal);
      renderJob(latest);
    }
    return latest;
  }

  async function runAction(kind: "export" | "upload" | "import", work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    clearError();
    const actionController = new AbortController();
    operationController = actionController;
    operationKind = kind;
    setBusy(true);
    try {
      await work(actionController.signal);
    } catch (reason) {
      if (!disposed && !(reason instanceof Error && reason.name === "AbortError")) announceError(reason);
    } finally {
      if (operationController === actionController) {
        operationController = null;
        operationKind = null;
      }
      if (!disposed) setBusy(false);
    }
  }

  async function uploadAndPreview(): Promise<void> {
    if (!selectedFile) return;
    await runAction("upload", async (signal) => {
      announce("Preparing a resumable System Archive upload.");
      const uploaded = await api.createUpload(selectedFile!, {
        signal,
        onProgress: renderProgress,
        onUploadAvailable(value) {
          currentUpload = value;
          updateControls();
        }
      });
      currentUpload = uploaded;
      if (uploaded.status !== "completed") throw new Error("System Archive upload did not complete.");
      announce("The upload is complete. The server is inspecting its logical records and original images.");
      const inspected = await api.preview(uploaded.id, signal);
      renderPreview(inspected);
      announce(inspected.valid ? "System Archive preview is ready for review." : "System Archive cannot be imported into this destination.");
    });
  }

  async function createExport(): Promise<void> {
    await runAction("export", async (signal) => {
      download.hidden = true;
      currentJobs.export = null;
      const idempotencyKey = randomIdempotencyKey("browser-export");
      const exportOperation: StoredSystemOperation = { kind: "export", idempotencyKey, jobId: null };
      currentExportOperation = exportOperation;
      if (!sessionOwnerId) throw new Error("The Current Owner session is not available for System Archive export.");
      writeStoredOperation(operationStorage ?? null, sessionOwnerId, exportOperation);
      const job = await resolveStoredExport(sessionOwnerId, exportOperation, signal);
      await monitorJob(job);
    });
  }

  async function resolveStoredExport(
    ownerId: string,
    stored: StoredSystemOperation,
    signal: AbortSignal
  ): Promise<SystemArchiveJobView> {
    const job = stored.jobId
      ? await api.getJob("export", stored.jobId, signal)
      : await api.createExport(stored.idempotencyKey, signal);
    currentExportOperation = { ...stored, jobId: job.id };
    writeStoredOperation(operationStorage ?? null, ownerId, currentExportOperation);
    return job;
  }

  async function recoverExport(ownerId: string): Promise<void> {
    const stored = readStoredOperation(operationStorage ?? null, ownerId, "export");
    if (!stored) return;
    currentExportOperation = stored;
    const job = await resolveStoredExport(ownerId, stored, controller.signal);
    await monitorJob(job);
  }

  async function resolveStoredImport(
    ownerId: string,
    stored: StoredSystemOperation,
    signal: AbortSignal
  ): Promise<SystemArchiveJobView> {
    const job = stored.jobId
      ? await api.getJob("import", stored.jobId, signal)
      : await api.commit(stored.previewHandle!, stored.idempotencyKey, signal);
    currentImportOperation = { ...stored, jobId: job.id };
    writeStoredOperation(operationStorage ?? null, ownerId, currentImportOperation);
    return job;
  }

  async function recoverImport(ownerId: string): Promise<void> {
    const stored = readStoredOperation(operationStorage ?? null, ownerId, "import");
    if (!stored || (!stored.jobId && !stored.previewHandle)) return;
    currentImportOperation = stored;
    invalidatePreviewAuthority();
    const job = await resolveStoredImport(ownerId, stored, controller.signal);
    currentUpload = null;
    await monitorJob(job);
  }

  async function cancelCurrent(): Promise<void> {
    clearError();
    operationController?.abort(new DOMException("Transfer cancelled", "AbortError"));
    try {
      const storedImport = sessionOwnerId
        ? readStoredOperation(operationStorage ?? null, sessionOwnerId, "import")
        : null;
      const activeImportOperation = currentImportOperation ?? storedImport;
      const currentJobMatchesActiveImport = activeImportOperation?.jobId !== null
        && currentJobs.import?.id === activeImportOperation?.jobId;
      if (sessionOwnerId && activeImportOperation && !currentJobMatchesActiveImport) {
        invalidatePreviewAuthority();
        const recovered = await resolveStoredImport(sessionOwnerId, activeImportOperation, controller.signal);
        currentUpload = null;
        renderJob(recovered);
        if (isJobCancellable(recovered)) {
          renderJob(await api.cancelJob("import", recovered.id, controller.signal));
        }
        return;
      }
      const storedExport = sessionOwnerId
        ? readStoredOperation(operationStorage ?? null, sessionOwnerId, "export")
        : null;
      const activeExportOperation = currentExportOperation ?? storedExport;
      const currentJobMatchesActiveExport = activeExportOperation?.jobId !== null
        && currentJobs.export?.id === activeExportOperation?.jobId;
      if (sessionOwnerId && activeExportOperation && !currentJobMatchesActiveExport) {
        const recovered = await resolveStoredExport(sessionOwnerId, activeExportOperation, controller.signal);
        renderJob(recovered);
        if (isJobCancellable(recovered)) {
          renderJob(await api.cancelJob("export", recovered.id, controller.signal));
        }
        return;
      }
      const jobToCancel = [currentJobs.import, currentJobs.export]
        .find((job): job is SystemArchiveJobView => job !== null && isJobCancellable(job));
      if (jobToCancel) {
        if (jobToCancel.kind === "import") invalidatePreviewAuthority();
        renderJob(await api.cancelJob(jobToCancel.kind, jobToCancel.id, controller.signal));
        return;
      }
      if (currentUpload) {
        invalidatePreviewAuthority();
        await api.cancelUpload(currentUpload.id, controller.signal);
        currentUpload = null;
        announce("System Archive upload cancelled.");
        return;
      }
      if (operationKind === "upload") invalidatePreviewAuthority();
      announce("Local System Archive work cancelled.");
    } catch (reason) {
      if (!disposed) announceError(reason);
    } finally {
      if (!disposed) updateControls();
    }
  }

  async function commitImport(): Promise<void> {
    if (!currentPreview?.valid || !currentPreview.previewHandle) return;
    let firstInvalid: HTMLInputElement | null = null;
    for (const name of ACKNOWLEDGEMENTS) {
      const checkbox = requiredElement<HTMLInputElement>(acknowledgements, `input[name="${name}"]`);
      checkbox.removeAttribute("aria-invalid");
      if (!checkbox.checked) {
        checkbox.setAttribute("aria-invalid", "true");
        firstInvalid ??= checkbox;
      }
    }
    if (firstInvalid) {
      announceError(new Error("Review every acknowledgement before importing this System Archive."));
      firstInvalid.focus();
      return;
    }
    const previewHandle = currentPreview.previewHandle;
    const idempotencyKey = randomIdempotencyKey("browser-import");
    const importOperation: StoredSystemOperation = {
      kind: "import",
      idempotencyKey,
      jobId: null,
      previewHandle
    };
    currentImportOperation = importOperation;
    currentJobs.import = null;
    if (sessionOwnerId) {
      writeStoredOperation(operationStorage ?? null, sessionOwnerId, importOperation);
    }
    invalidatePreviewAuthority();
    await runAction("import", async (signal) => {
      const job = await api.commit(previewHandle, idempotencyKey, signal);
      if (sessionOwnerId) {
        currentImportOperation = { ...importOperation, jobId: job.id };
        writeStoredOperation(operationStorage ?? null, sessionOwnerId, currentImportOperation);
      }
      currentUpload = null;
      await monitorJob(job);
    });
  }

  const onFileChange = () => {
    selectedFile = fileInput.files?.[0] ?? null;
    currentPreview = null;
    previewRegion.hidden = true;
    reportRegion.hidden = true;
    progressRegion.hidden = true;
    updateControls();
    if (selectedFile) void uploadAndPreview();
  };
  const onUpload = () => { void uploadAndPreview(); };
  const onExport = () => { void createExport(); };
  const onCancel = () => { void cancelCurrent(); };
  const onCommit = () => { void commitImport(); };
  fileInput.addEventListener("change", onFileChange);
  uploadButton.addEventListener("click", onUpload);
  exportButton.addEventListener("click", onExport);
  cancelButton.addEventListener("click", onCancel);
  commitButton.addEventListener("click", onCommit);

  void Promise.all([api.capability(controller.signal), api.sessionOwnerId(controller.signal)]).then(([capability, ownerId]) => {
    if (disposed) return;
    sessionOwnerId = ownerId;
    capabilityAvailable = capability.systemArchive;
    workbench.dataset.systemArchiveState = capabilityAvailable ? "available" : "disabled";
    capabilityBadge.textContent = capabilityAvailable ? "Available" : "Disabled by operator";
    capabilityMessage.textContent = capabilityAvailable
      ? "System Archive is available. Transfers are durable and can resume after a disconnected browser session."
      : "System Archive is not enabled on this instance. World, Campaign, legacy, external, and readable formats remain available.";
    announce(capabilityAvailable ? "Choose an owner-wide export or a System Archive file." : "Specialized Data Transfer tools remain available.");
    updateControls();
    if (capabilityAvailable) {
      void recoverExport(ownerId).catch((reason) => { if (!disposed) announceError(reason); });
      void recoverImport(ownerId).catch((reason) => { if (!disposed) announceError(reason); });
    }
  }).catch((reason) => {
    if (disposed) return;
    capabilityAvailable = false;
    workbench.dataset.systemArchiveState = "disabled";
    capabilityBadge.textContent = "Availability unknown";
    capabilityMessage.textContent = "System Archive availability could not be confirmed. Specialized formats remain available.";
    announceError(reason);
    updateControls();
  });

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      operationController?.abort(new DOMException("Data Transfer page closed", "AbortError"));
      controller.abort(new DOMException("Data Transfer page closed", "AbortError"));
      fileInput.removeEventListener("change", onFileChange);
      uploadButton.removeEventListener("click", onUpload);
      exportButton.removeEventListener("click", onExport);
      cancelButton.removeEventListener("click", onCancel);
      commitButton.removeEventListener("click", onCommit);
      theme.dispose();
    }
  };
}
