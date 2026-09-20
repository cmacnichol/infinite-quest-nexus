import { composeTextExecutionPrompt } from "@infinite-quest/contracts";

/** Compatibility export for existing Story callers; contracts own the shared pure composition. */
export const composePresetPrompt = composeTextExecutionPrompt;
