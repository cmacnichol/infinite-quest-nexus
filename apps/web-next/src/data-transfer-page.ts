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
          <div class="system-transfer-progress" data-system-progress hidden>
            <div><strong data-system-progress-label>Preparing transfer…</strong><span data-system-progress-value>0%</span></div>
            <progress max="100" value="0"></progress>
          </div>
        </section>
      </div>

      <div class="system-transfer-status" data-system-status role="status" aria-live="polite">System Archive controls are loading.</div>
      <div class="system-transfer-error" data-system-error role="alert" hidden></div>

      <section class="system-import-preview" data-system-preview="empty" aria-labelledby="system-preview-title" hidden>
        <header><div><p class="data-transfer-kicker">Server-owned inspection</p><h3 id="system-preview-title">Import Preview</h3></div><span data-system-preview-expiry></span></header>
        <div class="preview-summary-grid" data-system-preview-summary></div>
        <div class="preview-detail-grid">
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
  let currentJob: SystemArchiveJobView | null = null;
  let currentPreview: SystemImportPreviewView | null = null;
  let actionBusy = false;
  let operationController: AbortController | null = null;
  let operationKind: "export" | "upload" | "import" | null = null;

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
    const jobCancellable = currentJob !== null && isJobCancellable(currentJob);
    const localOperationCancellable = operationController !== null
      && (operationKind === "upload" || (operationKind === "export" && currentJob === null));
    exportButton.disabled = !capabilityAvailable || actionBusy || (currentJob?.kind === "export" && !TERMINAL_JOB_STATUSES.has(currentJob.status));
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
    requiredElement<HTMLElement>(previewRegion, "[data-system-provider-summary]").textContent =
      `${formatCount(value.disabledProviders)} disabled providers. Credentials are excluded and must be entered again.`;
    requiredElement<HTMLElement>(previewRegion, "[data-system-access-summary]").textContent = value.invalidatedAccess.length
      ? `External access will be invalidated: ${value.invalidatedAccess.join(", ")}.`
      : "No external access categories were reported.";
    requiredElement<HTMLElement>(previewRegion, "[data-system-rebuild-summary]").textContent =
      `Chronicle index: ${formatCount(value.rebuilds.chronicleIndex.itemCount)} campaigns. Asset thumbnails: ${formatCount(value.rebuilds.assetThumbnails.itemCount)} originals.`;
    requiredElement<HTMLElement>(previewRegion, "[data-system-omission-summary]").textContent =
      `${formatCount(value.omittedOperationalRows)} active or rebuildable operational rows are intentionally excluded.`;
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
    requiredElement<HTMLElement>(reportRegion, "[data-system-report-rebuilds]").textContent =
      `Chronicle index: ${report.rebuildState.chronicleIndex.status} for ${formatCount(report.rebuildState.chronicleIndex.itemCount)} campaigns. `
      + `Asset thumbnails: ${report.rebuildState.assetThumbnails.status} for ${formatCount(report.rebuildState.assetThumbnails.itemCount)} originals.`;
  }

  function renderJob(job: SystemArchiveJobView): void {
    currentJob = job;
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
      currentJob = null;
      const job = await api.createExport(randomIdempotencyKey("browser-export"), signal);
      await monitorJob(job);
    });
  }

  async function cancelCurrent(): Promise<void> {
    clearError();
    operationController?.abort(new DOMException("Transfer cancelled", "AbortError"));
    try {
      if (currentJob && isJobCancellable(currentJob)) {
        renderJob(await api.cancelJob(currentJob.kind, currentJob.id, controller.signal));
        return;
      }
      if (currentUpload) {
        await api.cancelUpload(currentUpload.id, controller.signal);
        currentUpload = null;
        announce("System Archive upload cancelled.");
        return;
      }
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
    await runAction("import", async (signal) => {
      const job = await api.commit(currentPreview!.previewHandle!, randomIdempotencyKey("browser-import"), signal);
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

  void api.capability(controller.signal).then((capability) => {
    if (disposed) return;
    capabilityAvailable = capability.systemArchive;
    workbench.dataset.systemArchiveState = capabilityAvailable ? "available" : "disabled";
    capabilityBadge.textContent = capabilityAvailable ? "Available" : "Disabled by operator";
    capabilityMessage.textContent = capabilityAvailable
      ? "System Archive is available. Transfers are durable and can resume after a disconnected browser session."
      : "System Archive is not enabled on this instance. World, Campaign, legacy, external, and readable formats remain available.";
    announce(capabilityAvailable ? "Choose an owner-wide export or a System Archive file." : "Specialized Data Transfer tools remain available.");
    updateControls();
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
