export interface RetainedAppendPrompt {
  readonly campaignId: string;
  readonly expectedTurnNumber: number;
  readonly generationId: string;
  readonly action: string;
  readonly requestedInputMode: "action" | "scene";
}

export interface FailedTurnPromptStore {
  load(campaignId: string): RetainedAppendPrompt | null;
  save(prompt: RetainedAppendPrompt): void;
  clear(campaignId: string): void;
}

export function createFailedTurnPromptStore(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">): FailedTurnPromptStore {
  return {
    load(campaignId) {
      try {
        const raw = storage.getItem(key(campaignId));
        if (raw === null) return null;
        const value: unknown = JSON.parse(raw);
        return isPrompt(value) && value.campaignId === campaignId ? value : null;
      } catch { return null; }
    },
    save(prompt) {
      try { storage.setItem(key(prompt.campaignId), JSON.stringify(prompt)); } catch { /* Draft retention is best effort. */ }
    },
    clear(campaignId) {
      try { storage.removeItem(key(campaignId)); } catch { /* Cleanup must not alter generation state. */ }
    }
  };
}

function key(campaignId: string): string {
  return `infiniteQuestFailedAppendPrompt:v1:${encodeURIComponent(campaignId)}`;
}

function isPrompt(value: unknown): value is RetainedAppendPrompt {
  return typeof value === "object" && value !== null
    && typeof (value as RetainedAppendPrompt).campaignId === "string"
    && typeof (value as RetainedAppendPrompt).expectedTurnNumber === "number"
    && Number.isSafeInteger((value as RetainedAppendPrompt).expectedTurnNumber)
    && (value as RetainedAppendPrompt).expectedTurnNumber > 0
    && typeof (value as RetainedAppendPrompt).generationId === "string"
    && ((value as RetainedAppendPrompt).requestedInputMode === "action" || (value as RetainedAppendPrompt).requestedInputMode === "scene")
    && typeof (value as RetainedAppendPrompt).action === "string"
    && (value as RetainedAppendPrompt).action.length > 0;
}
