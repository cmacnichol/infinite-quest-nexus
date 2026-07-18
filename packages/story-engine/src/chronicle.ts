import type { LegacyTurn } from "../../contracts/src/imports.js";
import { estimateTokens, extractEntities, stripMechanicsLeakage, truncateAtBoundary } from "../../domain/src/text.js";

export type FictionMemory = {
  content: string;
  tokenEstimate: number;
  entities: string[];
  sanitized: boolean;
  removedMechanicsSegments: number;
};

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function turnNarration(turn: LegacyTurn): string {
  return stringValue(turn.narration) || stringValue(turn.story) || stringValue(turn.text);
}

export function buildTurnFictionMemory(turn: LegacyTurn, ordinal: number): FictionMemory {
  const actionResult = stripMechanicsLeakage(stringValue(turn.action));
  const narrationResult = stripMechanicsLeakage(turnNarration(turn));
  const sections = [
    `Turn ${ordinal}`,
    actionResult.text ? `Player action: ${actionResult.text}` : "",
    narrationResult.text ? `Narration: ${narrationResult.text}` : ""
  ].filter(Boolean);
  const content = sections.join("\n");
  return {
    content,
    tokenEstimate: estimateTokens(content),
    entities: extractEntities(`${actionResult.text}\n${narrationResult.text}`),
    sanitized: actionResult.changed || narrationResult.changed,
    removedMechanicsSegments: actionResult.removedSegments + narrationResult.removedSegments
  };
}

export function formatLegacySummary(fullHistory: unknown): string {
  if (!fullHistory) return "";
  if (typeof fullHistory === "string") return stripMechanicsLeakage(fullHistory).text;
  if (typeof fullHistory !== "object" || Array.isArray(fullHistory)) return "";
  const history = fullHistory as Record<string, unknown>;
  const sections = [
    ["Characters", history.characters],
    ["Setting", history.settingDetails ?? history.setting_details],
    ["Plot", history.plotDetails ?? history.plot_details],
    ["Important notes", history.otherImportantNotes ?? history.other_important_notes]
  ].flatMap(([label, value]) => typeof value === "string" && value.trim() ? [`${label}:\n${value.trim()}`] : []);
  return stripMechanicsLeakage(sections.join("\n\n")).text;
}

export function compressTurnMemory(content: string, level: "full" | "balanced" | "compact"): string {
  if (level === "full") return content;
  const actionMatch = content.match(/^Player action:\s*(.+)$/m)?.[1] ?? "";
  const narrationMatch = content.match(/^Narration:\s*([\s\S]+)$/m)?.[1] ?? "";
  const turnLabel = content.match(/^Turn\s+\d+/m)?.[0] ?? "Turn";
  if (level === "balanced") {
    return [turnLabel, actionMatch ? `Player action: ${actionMatch}` : "", narrationMatch ? `Narration: ${truncateAtBoundary(narrationMatch, 1400)}` : ""]
      .filter(Boolean).join("\n");
  }
  return [turnLabel, actionMatch ? `Action: ${truncateAtBoundary(actionMatch, 260)}` : "", narrationMatch ? `Outcome: ${truncateAtBoundary(narrationMatch, 420)}` : ""]
    .filter(Boolean).join("\n");
}
