import type { CampaignCastApi } from "@infinite-quest/client-web";
import type { CastBoundary, CastDiscoveryStatus, CastBackfillRequest, CastBackfillRetry } from "@infinite-quest/contracts";

export function renderLegacyCastScan(container: HTMLElement, options: {
  api: CampaignCastApi["scans"]; campaignId: string; authority: { revision: number; boundary: CastBoundary };
  data: Awaited<ReturnType<CampaignCastApi["scans"]["latest"]>>; discovery: CastDiscoveryStatus | null;
  current(): boolean; generationActive(): boolean; refresh(): Promise<void>;
}) {
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => {
    const value = document.createElement(tag); value.textContent = text; return value;
  };
  const root = node("section"), feedback = node("p"); feedback.setAttribute("role", "status");
  const button = (label: string, action: () => void, disabled = false) => {
    const value = node("button", label); value.type = "button"; value.disabled = disabled; value.addEventListener("click", action); return value;
  };
  let busy = false;
  async function run(action: () => Promise<unknown>, refresh = true) {
    if (busy || !options.current()) return;
    busy = true;
    const controls = [...root.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button")].map(control => ({ control, disabled: control.disabled }));
    controls.forEach(({ control }) => { control.disabled = true; }); feedback.textContent = "Working…";
    let conflict = false;
    try {
      await action();
      if (options.current()) { feedback.textContent = ""; if (refresh) await options.refresh(); }
    } catch (error) {
      if (!options.current()) return;
      conflict = (error as { statusCode?: number }).statusCode === 409;
      feedback.textContent = conflict ? "The story or cast changed. Refresh scan before trying again."
        : `Could not update the scan. ${error instanceof Error ? error.message : "Please try again."}`;
    } finally {
      busy = false;
      if (options.current()) controls.forEach(({ control, disabled }) => { control.disabled = conflict || disabled; });
    }
  }
  const scan = options.data.scan, enabled = options.data.capabilities.castBackfill;
  root.append(node("p", "Discover supporting characters from accepted story turns. Your character edits are preserved. Cancellation keeps characters already discovered."));
  if (!enabled) root.append(node("p", "New history scans are disabled. Saved progress remains available."));
  if (scan) {
    const total = scan.throughTurn - scan.fromTurn + 1;
    root.append(node("h3", `Scan ${scan.status}`), node("p", `Turns ${scan.fromTurn}–${scan.throughTurn}: ${scan.completeTurns} of ${total} turns complete.`));
    if (scan.failedTurns) root.append(node("p", `${scan.failedTurns} failed turn${scan.failedTurns === 1 ? "" : "s"}.`));
    if (scan.pendingReviewCount) root.append(node("p", `${scan.pendingReviewCount} character matches need review. These are separate from scan failures.`));
    const actions = node("div"); actions.className = "cast-toolbar";
    const control = (action: "pause" | "resume" | "cancel") => { void run(() => options.api.control(options.campaignId, scan.id, action)); };
    if (["queued", "running"].includes(scan.status)) actions.append(button("Pause scan", () => control("pause")));
    if (scan.status === "paused") actions.append(button("Resume scan", () => control("resume"), !enabled));
    if (!["complete", "cancelled"].includes(scan.status)) actions.append(button("Cancel scan", () => control("cancel")));
    if (scan.firstFailedTurn) {
      const retry: CastBackfillRetry = { turnNumber: scan.firstFailedTurn, expectedCastRevision: options.authority.revision,
        expectedBoundary: options.authority.boundary, idempotencyKey: crypto.randomUUID() };
      actions.append(button(`Retry turn ${scan.firstFailedTurn}`, () => {
        if (options.generationActive()) return;
        void run(() => options.api.retry(options.campaignId, scan.id, retry));
      }, !enabled || options.generationActive() || scan.status === "cancelled"));
    }
    root.append(actions);
  }
  if (enabled && (!scan || ["complete", "cancelled"].includes(scan.status)) && options.authority.boundary.turnNumber > 0) {
    root.append(node("p", "Choose one continuous range that touches existing tracking. Earlier turns outside the selected range will remain untracked."));
    const form = node("form"); form.className = "cast-toolbar";
    const from = node("input"), through = node("input");
    from.id = "cast-scan-from"; through.id = "cast-scan-through";
    for (const input of [from, through]) { input.type = "number"; input.min = "1"; input.max = String(options.authority.boundary.turnNumber); input.required = true; input.step = "1"; }
    from.value = "1";
    through.value = String(options.discovery?.coverageStartTurn && options.discovery.coverageStartTurn > 1
      ? Math.min(options.discovery.coverageStartTurn - 1, options.authority.boundary.turnNumber) : options.authority.boundary.turnNumber);
    const fromLabel = node("label", "From turn"), throughLabel = node("label", "Through turn");
    fromLabel.htmlFor = from.id; throughLabel.htmlFor = through.id;
    const preview = node("section"); preview.setAttribute("aria-label", "Scan preview");
    let request: CastBackfillRequest | null = null;
    for (const input of [from, through]) input.addEventListener("input", () => { request = null; preview.replaceChildren(); });
    const submit = node("button", "Preview scan"); submit.type = "submit";
    form.append(fromLabel, from, throughLabel, through, submit);
    form.addEventListener("submit", event => {
      event.preventDefault();
      request = { fromTurn: Number(from.value), throughTurn: Number(through.value), expectedBoundary: options.authority.boundary, idempotencyKey: crypto.randomUUID() };
      const submitted = request;
      void run(async () => {
        const result = await options.api.preview(options.campaignId, submitted);
        if (!options.current() || request !== submitted) return;
        preview.replaceChildren(node("h3", "Ready to scan"), node("p", `${result.turnCount} turn${result.turnCount === 1 ? "" : "s"}; ${result.estimatedChunkRequests} estimated request${result.estimatedChunkRequests === 1 ? "" : "s"}; ${result.completedTurns} turns already scanned.`),
          node("p", result.selection.kind === "model" ? `Text model: ${result.selection.modelId}.` : `Text preset: ${result.selection.slug}.`),
          node("p", "Provider usage may incur costs. This estimate excludes retries and is not a price quote."));
        if (result.manualScanTurns.length) preview.append(node("p", `Turns ${result.manualScanTurns.join(", ")} exceed the automatic scan limit. Review these characters manually.`));
        preview.append(button("Start scan", () => {
          if (!request || options.generationActive()) return;
          const startRequest = request;
          void run(() => options.api.start(options.campaignId, startRequest));
        }, options.generationActive()));
      }, false);
    });
    root.append(form, preview);
  }
  if (options.generationActive()) root.append(node("p", "Finish or resolve the current generation before starting or retrying a scan."));
  root.append(feedback);
  container.append(root, button("Refresh scan", () => { if (!busy) void options.refresh(); }));
}
