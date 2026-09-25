import type { StoryTurnOutput } from "../../contracts/src/generation.js";
import { parseStoryOutput } from "./output.js";

/** Recover only an unambiguous complete object. Never fill missing fields. */
export function recoverInterruptedStory(raw: string): StoryTurnOutput | null {
  if (raw.length > 1_000_000) return null;
  let selected: StoryTurnOutput | null = null;
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let objects = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (start < 0) {
      if (character !== "{") continue;
      start = index;
      depth = 1;
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth !== 0) continue;
      if (++objects > 32) return null;
      const parsed = parseStoryOutput(raw.slice(start, index + 1));
      start = -1;
      if (!parsed.ok) continue;
      if (selected && JSON.stringify(selected) !== JSON.stringify(parsed.story)) return null;
      selected = parsed.story;
    }
  }
  return selected;
}
