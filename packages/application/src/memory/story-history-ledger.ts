import { z } from "@infinite-quest/contracts";

export type StoryLedgerSourceTurn = Readonly<{
  turnId: string;
  turnNumber: number;
  inputMode: "action" | "scene";
  action: string;
}>;

export type StoryLedgerEntry = Readonly<Omit<StoryLedgerSourceTurn, "action"> & { direction: string }>;

export type StoryLedger = Readonly<{
  version: "story-ledger-v1";
  entries: readonly StoryLedgerEntry[];
  omittedThroughTurn: number | null;
  coverage?: StoryLedgerCoverage;
}>;

export type StoryLedgerCoverage = Readonly<{
  unreadThroughTurn: number | null;
  missingTurnCount: number;
  filteredDirectionCount: number;
  oversizedDirectionCount: number;
  loadedRows: number;
}>;

export const storyLedgerEntrySchema = z.object({
  turnId: z.string().min(1), turnNumber: z.number().int().min(1), inputMode: z.enum(["action", "scene"]), direction: z.string().min(1).max(480)
}).strict();
export const storyLedgerSchema = z.object({
  version: z.literal("story-ledger-v1"), entries: z.array(storyLedgerEntrySchema), omittedThroughTurn: z.number().int().min(1).nullable(),
  coverage: z.object({ unreadThroughTurn: z.number().int().min(1).nullable(), missingTurnCount: z.number().int().nonnegative(),
    filteredDirectionCount: z.number().int().nonnegative(), oversizedDirectionCount: z.number().int().nonnegative(), loadedRows: z.number().int().nonnegative() }).strict().optional()
}).strict();
