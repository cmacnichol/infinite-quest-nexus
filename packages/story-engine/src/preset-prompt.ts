/** Combines a preset's behavioral instruction with the operation's required protocol exactly once. */
export function composePresetPrompt(input: Readonly<{ presetPrompt: string; operationPrompt: string }>): string {
  const presetPrompt = input.presetPrompt.trim();
  const operationPrompt = input.operationPrompt.trim();
  if (!operationPrompt) throw new Error("An operation prompt is required.");
  return presetPrompt ? `${presetPrompt}\n\n${operationPrompt}` : operationPrompt;
}
