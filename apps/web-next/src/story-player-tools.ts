import type { CampaignApi } from "@infinite-quest/client-web";
import type {
  AcceptedTurnCorrectionRequest,
  AcceptedTurnCorrectionView,
  CampaignRuntimeStateResponse,
  CampaignRuntimeStateUpdate
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
  readonly activeTurnNumber: number;
  readonly generationActive: boolean;
  readonly viewTurnNumber: number | null;
  readonly turns: readonly StoryToolTurn[];
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
  openAbout(): void;
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
      <button type="button" data-tool-action="open-activity" disabled>Activity Log</button>
      <button type="button" data-tool-action="open-about" disabled>About</button>
      <button type="button" data-tool-action="export-markdown" disabled>Markdown</button>
      <button type="button" data-tool-action="export-html" disabled>HTML</button>
      <button type="button" data-tool-action="export-pdf" disabled>PDF + images</button>
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

/**
 * Owns only Story-tool intent and persisted-target guards. The page keeps UI
 * drafts locally, so rejected mutations never need to clear them here.
 */
export function createStoryToolsController(options: StoryToolsControllerOptions): StoryToolsController {
  let disposed = false;
  let mutationPending = false;

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
    openAbout() {
      show("about");
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
