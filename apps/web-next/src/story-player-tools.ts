import type { CampaignApi, ShellApi } from "@infinite-quest/client-web";
import type {
  AcceptedTurnCorrectionRequest,
  AcceptedTurnCorrectionView,
  CampaignRuntimeStateResponse,
  CampaignRuntimeStateUpdate,
  MetaResponse
} from "@infinite-quest/contracts";
import type { StoryGenerationController, StoryGenerationSubmission } from "./story-player-generation";

export type StoryToolConfirmation = "correct-narration" | "undo-latest" | "retry-latest" | "branch" | "rewind";

export interface StoryToolTurn {
  readonly id: string;
  readonly turnNumber: number;
  readonly action: string;
}

export interface StoryToolScope {
  readonly campaignId: string;
  readonly campaignTitle?: string;
  readonly activeTurnNumber: number;
  readonly generationActive: boolean;
  readonly viewTurnNumber: number | null;
  readonly turns: readonly StoryToolTurn[];
}

export type StoryReadableExportFormat = "markdown" | "html";

export interface StoryReadableExport {
  readonly body: string;
}

export interface StoryToolBrowser {
  readonly document: Document;
  readonly createObjectUrl: (blob: Blob) => string;
  readonly revokeObjectUrl: (url: string) => void;
  readonly openPrintWindow?: (url?: string, target?: string) => StoryPrintWindow | null;
  readonly printOrigin?: string;
  readonly printStyles?: string;
}

export interface StoryPrintWindow {
  opener: unknown;
  readonly document: Pick<Document, "open" | "write" | "close" | "images">;
  print(): void;
  close(): void;
}

export interface StoryPrintSnapshot {
  readonly title: string;
  readonly turns: readonly {
    readonly turnNumber: number;
    readonly action: string;
    readonly narration: string;
    readonly imageUrls: readonly string[];
  }[];
}

export interface StoryActivityRecord {
  readonly timestamp: string;
  readonly category: string;
  readonly title: string;
  readonly detail: string;
}

export interface StoryToolsController {
  openWorldSetup(): void;
  openCurrentState(): Promise<CampaignRuntimeStateResponse | null>;
  openTurnState(turnNumber: number): Promise<CampaignRuntimeStateResponse | null>;
  saveCurrentState(request: CampaignRuntimeStateUpdate): Promise<CampaignRuntimeStateResponse | null>;
  openNarrationCorrection(turnId: string): Promise<AcceptedTurnCorrectionView | null>;
  saveNarrationCorrection(turnId: string, request: Omit<AcceptedTurnCorrectionRequest, "turnId">): Promise<AcceptedTurnCorrectionView | null>;
  openHistory(): void;
  openActivity(): void;
  openAbout(): Promise<MetaResponse | null>;
  exportMarkdown(): Promise<boolean>;
  exportStandaloneHtml(): Promise<boolean>;
  printStory(): Promise<boolean>;
  recordActivity(category: string, title: string, detail?: Readonly<Record<string, unknown>>): Readonly<StoryActivityRecord>;
  activity(): readonly Readonly<StoryActivityRecord>[];
  copyActivityDiagnostics(): Promise<boolean>;
  clearActivity(): void;
  undoLatest(): Promise<boolean>;
  retryLatest(replacementTurnId: string, submission: StoryGenerationSubmission): Promise<boolean>;
  restartFromTurn(turnNumber: number, operation: "branch" | "rewind"): Promise<boolean>;
  closeActiveDialog(): void;
  dispose(): void;
}

export interface StoryToolsControllerOptions {
  readonly campaigns: Pick<CampaignApi, "state" | "inspectState" | "updateState" | "getTurnCorrection" | "correctTurnNarration" | "rewind" | "branch">;
  readonly generation: Pick<StoryGenerationController, "submitReplacement">;
  readonly current: () => StoryToolScope | null;
  readonly reload: () => Promise<void>;
  readonly navigate: (campaignId: string) => void;
  readonly confirm: (kind: StoryToolConfirmation, target: Readonly<Record<string, string | number>>) => boolean | Promise<boolean>;
  readonly completeHistory?: () => Promise<void>;
  readonly readableExport?: (campaignId: string, format: StoryReadableExportFormat) => Promise<StoryReadableExport>;
  readonly printSnapshot?: () => Promise<StoryPrintSnapshot>;
  readonly meta?: Pick<ShellApi, "get">;
  readonly browser?: StoryToolBrowser;
  readonly copyText?: (text: string) => Promise<void>;
  readonly onActivity?: () => void;
  readonly onDialog?: (dialog: "world" | "current-state" | "correction" | "history" | "activity" | "about" | null) => void;
  readonly onError?: (error: unknown) => void;
}

/**
 * Deliberately static header markup. Campaign/world data is rendered into
 * dialogs with text nodes and must never be interpolated into this slot.
 */
export function storyCampaignToolsMarkup(): string {
  return `<details class="story-campaign-tools" data-campaign-tools>
    <summary><span class="story-campaign-tools-desktop">Campaign Tools</span><span class="story-campaign-tools-mobile">Tools</span></summary>
    <div class="story-campaign-tools-menu" role="group" aria-label="Campaign Tools">
      <button type="button" data-tool-action="open-world-setup">Current World Setup</button>
      <button type="button" data-tool-action="edit-campaign-state">Edit Campaign State</button>
      <button type="button" data-tool-action="open-campaign-history">Turn History &amp; State</button>
      <button type="button" data-tool-action="open-activity">Activity Log</button>
      <button type="button" data-tool-action="open-about">About</button>
      <button type="button" data-tool-action="export-markdown">Markdown</button>
      <button type="button" data-tool-action="export-html">HTML</button>
      <button type="button" data-tool-action="export-pdf">PDF + images</button>
    </div>
  </details>`;
}

/** Installs the native disclosure close contract without a second menu state. */
export function installStoryToolsDisclosure(details: HTMLDetailsElement): () => void {
  const document = details.ownerDocument;
  const summary = details.querySelector<HTMLElement>("summary");
  let disposed = false;
  const close = (restoreFocus: boolean) => {
    if (disposed || !details.open) return;
    details.open = false;
    if (restoreFocus) summary?.focus();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    close(true);
  };
  const onPointerDown = (event: Event) => {
    const target = event.target;
    if (target !== null && !details.contains(target as Node)) close(false);
  };
  const onFocusOut = () => {
    queueMicrotask(() => {
      if (!disposed && details.open && !details.contains(document.activeElement)) close(false);
    });
  };
  details.addEventListener("keydown", onKeyDown);
  details.addEventListener("focusout", onFocusOut);
  document.addEventListener("pointerdown", onPointerDown);
  return () => {
    if (disposed) return;
    disposed = true;
    details.removeEventListener("keydown", onKeyDown);
    details.removeEventListener("focusout", onFocusOut);
    document.removeEventListener("pointerdown", onPointerDown);
  };
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function turnById(scope: StoryToolScope, turnId: string): StoryToolTurn | null {
  return scope.turns.find((turn) => turn.id === turnId) ?? null;
}

function latestTurn(scope: StoryToolScope): StoryToolTurn | null {
  return scope.turns.find((turn) => turn.turnNumber === scope.activeTurnNumber) ?? null;
}

function canMutate(scope: StoryToolScope): boolean {
  return !scope.generationActive && scope.viewTurnNumber === scope.activeTurnNumber && isPositiveInteger(scope.activeTurnNumber);
}

function sameExportScope(left: StoryToolScope, right: StoryToolScope | null): boolean {
  if (right === null || left.campaignId !== right.campaignId || left.activeTurnNumber !== right.activeTurnNumber) return false;
  return latestTurn(left)?.id === latestTurn(right)?.id;
}

function safeExportFilename(title: string | undefined, extension: "md" | "html"): string {
  const slug = (title ?? "infinite-quest-story")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 80);
  return `${slug || "infinite-quest-story"}.${extension}`;
}

function downloadReadableExport(browser: StoryToolBrowser, body: string, filename: string, type: string): void {
  const url = browser.createObjectUrl(new Blob([body], { type }));
  const anchor = browser.document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  try {
    browser.document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    browser.revokeObjectUrl(url);
  }
}

const SAFE_ACTIVITY_DETAIL_FIELDS = ["campaignId", "turnNumber", "jobId", "status", "operationKind", "retryCount", "correlationId"] as const;

function safeActivityText(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}

function safeActivityDetail(detail: Readonly<Record<string, unknown>> | undefined): string {
  if (!detail) return "";
  const fields: string[] = [];
  for (const key of SAFE_ACTIVITY_DETAIL_FIELDS) {
    const value = detail[key];
    if (typeof value === "string" && safeActivityText(value)) fields.push(`${key}=${safeActivityText(value)}`);
    if (typeof value === "number" && Number.isFinite(value)) fields.push(`${key}=${value}`);
  }
  return fields.join(" ");
}

function escapePrintText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function sameOriginAssetUrl(value: string, origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    const url = new URL(value, origin);
    return url.origin === origin && (url.protocol === "http:" || url.protocol === "https:") ? url.href : null;
  } catch {
    return null;
  }
}

function printMarkup(snapshot: StoryPrintSnapshot, origin: string | undefined, styles: string | undefined): string {
  const title = escapePrintText(snapshot.title || "Infinite Quest Story");
  const turns = snapshot.turns.map((turn) => {
    const paragraphs = escapePrintText(turn.narration).split(/\r?\n+/).filter(Boolean).map((paragraph) => `<p>${paragraph}</p>`).join("") || "<p></p>";
    const images = turn.imageUrls.map((value) => sameOriginAssetUrl(value, origin)).filter((value): value is string => value !== null)
      .map((url) => `<figure><img src="${escapePrintText(url)}" alt="Illustration for turn ${turn.turnNumber}"></figure>`).join("");
    return `<section class="turn"><h2>Turn ${turn.turnNumber}: ${escapePrintText(turn.action)}</h2>${paragraphs}${images}</section>`;
  }).join("") || "<p>No accepted story turns are available yet.</p>";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>${styles ?? ""}</style></head><body><h1>${title}</h1>${turns}</body></html>`;
}

async function waitForPrintImages(document: Pick<Document, "images">): Promise<void> {
  const images = [...document.images];
  if (!images.length) return;
  await Promise.race([
    Promise.all(images.map((image) => image.complete ? Promise.resolve() : new Promise<void>((resolve) => {
      image.addEventListener("load", () => resolve(), { once: true });
      image.addEventListener("error", () => resolve(), { once: true });
    }))),
    new Promise<void>((resolve) => globalThis.setTimeout(resolve, 3_000))
  ]);
}

/**
 * Owns only Story-tool intent and persisted-target guards. The page keeps UI
 * drafts locally, so rejected mutations never need to clear them here.
 */
export function createStoryToolsController(options: StoryToolsControllerOptions): StoryToolsController {
  let disposed = false;
  let mutationPending = false;
  let activityRecords: readonly StoryActivityRecord[] = [];

  const scope = (): StoryToolScope | null => disposed ? null : options.current();
  const show = (dialog: Parameters<NonNullable<StoryToolsControllerOptions["onDialog"]>>[0]) => {
    if (!disposed) options.onDialog?.(dialog);
  };
  const confirm = async (kind: StoryToolConfirmation, target: Readonly<Record<string, string | number>>) => !disposed && await options.confirm(kind, target);
  const fail = (error: unknown): never => {
    options.onError?.(error);
    throw error;
  };
  const beginMutation = (): boolean => {
    if (disposed || mutationPending) return false;
    mutationPending = true;
    return true;
  };
  const exportReadable = async (format: StoryReadableExportFormat): Promise<boolean> => {
    const current = scope();
    if (current === null || !options.completeHistory || !options.readableExport || !options.browser) return false;
    try {
      await options.completeHistory();
      if (disposed || !sameExportScope(current, scope())) return false;
      const exported = await options.readableExport(current.campaignId, format);
      if (disposed || !sameExportScope(current, scope())) return false;
      const isMarkdown = format === "markdown";
      downloadReadableExport(
        options.browser,
        exported.body,
        safeExportFilename(current.campaignTitle, isMarkdown ? "md" : "html"),
        isMarkdown ? "text/markdown;charset=utf-8" : "text/html;charset=utf-8"
      );
      return true;
    } catch (error) {
      options.onError?.(error);
      return false;
    }
  };

  return {
    openWorldSetup() {
      show("world");
    },
    async openCurrentState() {
      const current = scope();
      if (!current) return null;
      try {
        const result = await options.campaigns.state(current.campaignId, undefined, undefined);
        return disposed || scope()?.campaignId !== current.campaignId ? null : result;
      } catch (error) {
        return fail(error);
      }
    },
    async openTurnState(turnNumber) {
      const current = scope();
      if (!current || !isPositiveInteger(turnNumber) || !current.turns.some((turn) => turn.turnNumber === turnNumber)) return null;
      try {
        const result = await options.campaigns.inspectState(current.campaignId, turnNumber, undefined);
        return disposed || scope()?.campaignId !== current.campaignId ? null : result;
      } catch (error) {
        return fail(error);
      }
    },
    async saveCurrentState(request) {
      const current = scope();
      if (!current || !canMutate(current) || !beginMutation()) return null;
      try {
        const result = await options.campaigns.updateState(current.campaignId, request, undefined);
        if (disposed || scope()?.campaignId !== current.campaignId) return null;
        await options.reload();
        return result;
      } catch (error) {
        return fail(error);
      } finally {
        mutationPending = false;
      }
    },
    async openNarrationCorrection(turnId) {
      const current = scope();
      const turn = current === null ? null : turnById(current, turnId);
      if (!current || !turn || !canMutate(current) || turn.turnNumber !== current.activeTurnNumber) return null;
      try {
        const result = await options.campaigns.getTurnCorrection(current.campaignId, turn.id, undefined);
        return disposed || scope()?.campaignId !== current.campaignId ? null : result;
      } catch (error) {
        return fail(error);
      }
    },
    async saveNarrationCorrection(turnId, request) {
      const current = scope();
      const turn = current === null ? null : turnById(current, turnId);
      if (!current || !turn || !canMutate(current) || turn.turnNumber !== current.activeTurnNumber || !beginMutation()) return null;
      try {
        if (!await confirm("correct-narration", { turnId: turn.id, turnNumber: turn.turnNumber })) return null;
        const beforeWrite = scope();
        if (!beforeWrite || beforeWrite.campaignId !== current.campaignId || !canMutate(beforeWrite)
          || latestTurn(beforeWrite)?.id !== turn.id) return null;
        const result = await options.campaigns.correctTurnNarration(current.campaignId, turn.id, request, undefined);
        if (disposed || scope()?.campaignId !== current.campaignId) return null;
        await options.reload();
        return result;
      } catch (error) {
        return fail(error);
      } finally {
        mutationPending = false;
      }
    },
    openHistory() {
      show("history");
    },
    openActivity() {
      show("activity");
    },
    async openAbout() {
      show("about");
      if (!options.meta) return null;
      try {
        const result = await options.meta.get(undefined);
        return disposed ? null : result;
      } catch (error) {
        return fail(error);
      }
    },
    async exportMarkdown() {
      return exportReadable("markdown");
    },
    async exportStandaloneHtml() {
      return exportReadable("html");
    },
    async printStory() {
      const current = scope();
      const openPrintWindow = options.browser?.openPrintWindow;
      if (current === null || !options.completeHistory || !options.printSnapshot || !openPrintWindow) return false;
      const printWindow = openPrintWindow("", "_blank");
      if (printWindow === null) return false;
      printWindow.opener = null;
      try {
        await options.completeHistory();
        if (disposed || !sameExportScope(current, scope())) {
          printWindow.close();
          return false;
        }
        const snapshot = await options.printSnapshot();
        if (disposed || !sameExportScope(current, scope())) {
          printWindow.close();
          return false;
        }
        printWindow.document.open();
        printWindow.document.write(printMarkup(snapshot, options.browser?.printOrigin, options.browser?.printStyles));
        printWindow.document.close();
        await waitForPrintImages(printWindow.document);
        if (disposed || !sameExportScope(current, scope())) {
          printWindow.close();
          return false;
        }
        printWindow.print();
        return true;
      } catch (error) {
        printWindow.close();
        options.onError?.(error);
        return false;
      }
    },
    recordActivity(category, title, detail) {
      const record: StoryActivityRecord = {
        timestamp: new Date().toISOString(),
        category: safeActivityText(category) || "system",
        title: safeActivityText(title),
        detail: safeActivityDetail(detail)
      };
      if (disposed) return record;
      activityRecords = [...activityRecords, record];
      options.onActivity?.();
      return record;
    },
    activity() {
      return activityRecords.map((record) => ({ ...record }));
    },
    async copyActivityDiagnostics() {
      if (disposed || !options.copyText) return false;
      const text = activityRecords.map((record) => `[${record.timestamp}] [${record.category}] ${record.title}${record.detail ? `\n${record.detail}` : ""}`).join("\n\n");
      try {
        await options.copyText(text);
        return true;
      } catch (error) {
        options.onError?.(error);
        return false;
      }
    },
    clearActivity() {
      if (disposed || activityRecords.length === 0) return;
      activityRecords = [];
      options.onActivity?.();
    },
    async undoLatest() {
      const current = scope();
      const turn = current === null ? null : latestTurn(current);
      if (!current || !turn || !canMutate(current) || !beginMutation()) return false;
      try {
        if (!await confirm("undo-latest", { activeTurnNumber: current.activeTurnNumber })) return false;
        const beforeWrite = scope();
        if (!beforeWrite || beforeWrite.campaignId !== current.campaignId || !canMutate(beforeWrite)
          || latestTurn(beforeWrite)?.id !== turn.id) return false;
        await options.campaigns.rewind(current.campaignId, {
          targetTurnNumber: current.activeTurnNumber - 1,
          expectedCurrentTurnNumber: current.activeTurnNumber
        }, undefined);
        if (disposed || scope()?.campaignId !== current.campaignId) return false;
        await options.reload();
        return true;
      } catch (error) {
        fail(error);
        return false;
      } finally {
        mutationPending = false;
      }
    },
    async retryLatest(replacementTurnId, submission) {
      const current = scope();
      const turn = current === null ? null : turnById(current, replacementTurnId);
      if (!current || !turn || !canMutate(current) || turn.turnNumber !== current.activeTurnNumber || !beginMutation()) return false;
      try {
        if (!await confirm("retry-latest", { turnId: turn.id, turnNumber: turn.turnNumber })) return false;
        const beforeWrite = scope();
        if (!beforeWrite || beforeWrite.campaignId !== current.campaignId || !canMutate(beforeWrite)
          || latestTurn(beforeWrite)?.id !== replacementTurnId) return false;
        return await options.generation.submitReplacement(replacementTurnId, submission);
      } catch (error) {
        fail(error);
        return false;
      } finally {
        mutationPending = false;
      }
    },
    async restartFromTurn(turnNumber, operation) {
      const current = scope();
      const turn = current === null ? null : current.turns.find((candidate) => candidate.turnNumber === turnNumber) ?? null;
      if (!current || !turn || current.generationActive || !beginMutation()) return false;
      try {
        if (!await confirm(operation, { turnId: turn.id, turnNumber: turn.turnNumber, activeTurnNumber: current.activeTurnNumber })) return false;
        const beforeWrite = scope();
        if (!beforeWrite || beforeWrite.campaignId !== current.campaignId || beforeWrite.generationActive
          || !beforeWrite.turns.some((candidate) => candidate.id === turn.id && candidate.turnNumber === turn.turnNumber)) return false;
        if (operation === "branch") {
          const branch = await options.campaigns.branch(current.campaignId, {
            targetTurnNumber: turn.turnNumber,
            expectedCurrentTurnNumber: current.activeTurnNumber
          }, undefined);
          if (!disposed) options.navigate(branch.id);
          return !disposed;
        }
        await options.campaigns.rewind(current.campaignId, {
          targetTurnNumber: turn.turnNumber,
          expectedCurrentTurnNumber: current.activeTurnNumber
        }, undefined);
        if (disposed || scope()?.campaignId !== current.campaignId) return false;
        await options.reload();
        return true;
      } catch (error) {
        fail(error);
        return false;
      } finally {
        mutationPending = false;
      }
    },
    closeActiveDialog() {
      show(null);
    },
    dispose() {
      disposed = true;
    }
  };
}
