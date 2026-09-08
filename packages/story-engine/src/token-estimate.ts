import { estimateTokens } from "../../domain/src/index.js";

/**
 * Estimates story tokens without a model-specific tokenizer. ASCII is measured
 * with the domain estimate and a conservative character floor; non-ASCII uses
 * UTF-8 bytes. This is not a guarantee of a provider tokenizer's result.
 */
export function estimateStoryTokens(text: string): number {
  return (text.match(/[\x00-\x7f]+|[^\x00-\x7f]+/gu) ?? []).reduce((total, run) => {
    const tokens = /^[\x00-\x7f]+$/u.test(run)
      ? Math.max(estimateTokens(run), Math.ceil(run.length / 3))
      : new TextEncoder().encode(run).length;
    return total + tokens;
  }, 0);
}
