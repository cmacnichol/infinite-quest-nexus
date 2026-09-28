/** Platform-safe conservative token estimate shared by pure planning code. */
export function estimateTokens(text: string): number {
  const normalized = text.trim();
  if (!normalized) return 0;
  const words = normalized.match(/[\p{L}\p{N}_'-]+|[^\s]/gu)?.length ?? 0;
  return Math.max(1, Math.ceil(Math.max(normalized.length / 4, words * 0.72)));
}
