import type { CampaignTransferFinding } from "../../contracts/src/campaign-transfer.js";
import type { WorldContent } from "../../contracts/src/world-library.js";
import { assessWorldCampaignReadiness } from "./world-characters.js";

type CompatibilityInput = {
  sourceWorldId: string;
  targetWorldId: string;
  targetWorldStatus: string;
  sourceContent: WorldContent;
  targetContent: WorldContent;
  selectedCharacterId: string | null;
  characterSnapshot: Record<string, unknown> | null;
  campaignState: {
    rpgStats: unknown[];
    defaultTriggers: unknown[];
    eventTriggers: unknown[];
  };
  activeGenerationJobs?: number;
  activeImageJobs?: number;
};

function identity(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const candidate = row.id ?? row.name ?? row.label;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim().toLocaleLowerCase() : null;
}

function conflicts(source: unknown[], target: unknown[]): string[] {
  const targetById = new Map(target.flatMap((value) => {
    const id = identity(value);
    return id ? [[id, value] as const] : [];
  }));
  return source.flatMap((value) => {
    const id = identity(value);
    const targetValue = id ? targetById.get(id) : undefined;
    return targetValue !== undefined && JSON.stringify(value) !== JSON.stringify(targetValue) ? [id!] : [];
  });
}

export function assessCampaignTransferCompatibility(input: CompatibilityInput): CampaignTransferFinding[] {
  const findings: CampaignTransferFinding[] = [];
  if (input.sourceWorldId === input.targetWorldId) {
    findings.push({
      code: "same_world_use_version_migration",
      severity: "blocking",
      scope: "world",
      message: "Use campaign version migration when the source and target versions belong to the same world."
    });
  }
  if (input.targetWorldStatus === "archived") {
    findings.push({ code: "target_world_archived", severity: "blocking", scope: "world", message: "Archived worlds cannot receive campaigns." });
  }
  const readiness = assessWorldCampaignReadiness(input.targetContent);
  for (const issue of readiness.issues) {
    findings.push({
      code: `target_${issue.code.replaceAll("-", "_")}`,
      severity: "blocking",
      scope: "world",
      message: issue.message
    });
  }
  if (input.sourceContent.schemaVersion !== input.targetContent.schemaVersion) {
    findings.push({
      code: "world_schema_version_changed",
      severity: "warning",
      scope: "world",
      message: `The target uses world schema ${input.targetContent.schemaVersion}; the source uses schema ${input.sourceContent.schemaVersion}.`
    });
  }
  const snapshotName = typeof input.characterSnapshot?.name === "string" ? input.characterSnapshot.name.trim() : "";
  const targetCharacter = input.targetContent.playableCharacters.find((character) => (
    character.id === input.selectedCharacterId || (snapshotName && character.name.toLocaleLowerCase() === snapshotName.toLocaleLowerCase())
  ));
  if (!targetCharacter) {
    findings.push({
      code: "source_character_preserved_outside_target_roster",
      severity: "info",
      scope: "character",
      message: "The source character snapshot will be preserved even though it is not in the target world's roster."
    });
  }
  const checks: Array<[string, unknown[], unknown[]]> = [
    ["rpg_stats", input.campaignState.rpgStats, input.targetContent.rpgStats],
    ["default_triggers", input.campaignState.defaultTriggers, input.targetContent.defaultTriggers],
    ["event_triggers", input.campaignState.eventTriggers, input.targetContent.eventTriggers]
  ];
  for (const [kind, source, target] of checks) {
    const ids = conflicts(source, target);
    if (ids.length) {
      findings.push({
        code: `conflicting_${kind}`,
        severity: "warning",
        scope: "state",
        message: `The campaign and target world define ${ids.length} conflicting ${kind.replaceAll("_", " ")} entries; campaign state will remain authoritative.`,
        details: { ids }
      });
    }
  }
  if ((input.activeGenerationJobs || 0) > 0) {
    findings.push({ code: "active_generation_job", severity: "blocking", scope: "jobs", message: "Wait for or discard the active story job before transferring." });
  }
  if ((input.activeImageJobs || 0) > 0) {
    findings.push({ code: "active_image_job", severity: "blocking", scope: "jobs", message: "Wait for or discard active illustration jobs before transferring." });
  }
  return findings;
}
