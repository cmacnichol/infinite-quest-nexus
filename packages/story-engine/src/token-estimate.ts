import { estimateTokens } from "../../domain/src/index.js";

/**
 * Estimates story tokens without a model-specific tokenizer. ASCII is measured
 * with the domain estimate and a conservative character floor; non-ASCII uses
 * UTF-8 bytes. This is not a guarantee of a provider tokenizer's result.
 */
export function estimateStoryTokens(text: string): number {
  // Scan runs without a quantified alternation: very large mixed-script
  // candidate bodies can exhaust the regular-expression engine's stack.
  let total = 0;
  let start = 0;
  while (start < text.length) {
    const ascii = text.charCodeAt(start) <= 0x7f;
    let end = start + 1;
    while (end < text.length && (text.charCodeAt(end) <= 0x7f) === ascii) end++;
    const run = text.slice(start, end);
    total += ascii ? Math.max(estimateTokens(run), Math.ceil(run.length / 3)) : new TextEncoder().encode(run).length;
    start = end;
  }
  return total;
}
