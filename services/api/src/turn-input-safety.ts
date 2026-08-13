import { mechanicsLanguageMatches } from "../../../packages/story-engine/src/index.js";

export function safeTurnInput(value: string): string {
  const trimmed = value.trim();
  const matches = mechanicsLanguageMatches(trimmed);
  if (!trimmed || matches.length) {
    const findings = matches.map((match) => ({
      category: match.category,
      text: match.text,
      index: match.index
    }));
    const findingSummary = findings.length
      ? ` Blocked ${findings.length === 1 ? "fragment" : "fragments"}: ${findings.map((finding) => `"${finding.text}" (${finding.category.replaceAll("_", " ")})`).join(", ")}.`
      : " The input was empty after trimming whitespace.";
    throw Object.assign(new Error(`The turn input contains game-mechanics or engine language that cannot be sent to story generation.${findingSummary} Edit the input and retry; no part of it was silently removed.`), {
      statusCode: 400,
      code: "unsafe_turn_input",
      details: { code: "unsafe_turn_input", findings }
    });
  }
  return trimmed;
}
