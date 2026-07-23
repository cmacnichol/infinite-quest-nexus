import {
  campaignCharacterProfileSchema,
  characterProfileSchema,
  type CampaignCharacterProfile,
  type CharacterProfile,
  type PlayableCharacter,
  type WorldContent
} from "../../contracts/src/world-library.js";
import { stripMechanicsLeakage, truncateAtBoundary } from "./text.js";

export type CampaignCharacterSeed = {
  character: PlayableCharacter;
  rpgStats: unknown[];
  defaultTriggers: unknown[];
};

export type WorldCampaignReadinessIssueCode =
  | "no-playable-characters"
  | "missing-character-id"
  | "duplicate-character-id"
  | "missing-character-name"
  | "missing-character-text";

export type WorldCampaignReadinessIssue = {
  code: WorldCampaignReadinessIssueCode;
  message: string;
  characterIndex?: number;
  characterId?: string;
};

export type WorldCampaignReadinessAssessment = {
  ready: boolean;
  issues: WorldCampaignReadinessIssue[];
};

function values(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function mergeNamed(shared: unknown[], characterSpecific: unknown[]): unknown[] {
  const merged = new Map<string, unknown>();
  for (const [index, value] of [...shared, ...characterSpecific].entries()) {
    const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const key = String(row.name || row.label || row.id || index).trim().toLocaleLowerCase();
    merged.set(key, value);
  }
  return [...merged.values()];
}

export function assessWorldCampaignReadiness(content: WorldContent): WorldCampaignReadinessAssessment {
  const issues: WorldCampaignReadinessIssue[] = [];
  const characters = content.playableCharacters;
  if (characters.length === 0) {
    issues.push({
      code: "no-playable-characters",
      message: "This world version has no playable characters."
    });
  }

  const seenIds = new Set<string>();
  for (const [characterIndex, character] of characters.entries()) {
    const id = typeof character.id === "string" ? character.id.trim() : "";
    const name = typeof character.name === "string" ? character.name.trim() : "";
    const characterText = typeof character.characterText === "string" ? character.characterText.trim() : "";
    const hasProfile = character.profile ? hasCharacterProfileGuidance(character.profile) : false;

    if (!id) {
      issues.push({
        code: "missing-character-id",
        message: `Playable character ${characterIndex + 1} is missing an ID.`,
        characterIndex
      });
    } else if (seenIds.has(id)) {
      issues.push({
        code: "duplicate-character-id",
        message: `Playable character ID "${id}" is duplicated.`,
        characterIndex,
        characterId: id
      });
    } else {
      seenIds.add(id);
    }

    if (!name) {
      issues.push({
        code: "missing-character-name",
        message: `Playable character ${characterIndex + 1} is missing a name.`,
        characterIndex,
        ...(id ? { characterId: id } : {})
      });
    }
    if (!characterText && !hasProfile) {
      issues.push({
        code: "missing-character-text",
        message: `Playable character ${name ? `"${name}"` : characterIndex + 1} is missing character guidance.`,
        characterIndex,
        ...(id ? { characterId: id } : {})
      });
    }
  }

  return { ready: issues.length === 0, issues };
}

export function resolvePlayableCharacters(content: WorldContent): PlayableCharacter[] {
  return content.playableCharacters;
}

export function selectPlayableCharacter(content: WorldContent, selectedCharacterId?: string): PlayableCharacter {
  const characters = resolvePlayableCharacters(content);
  if (characters.length === 0) {
    throw Object.assign(new Error("This world version has no playable characters."), { statusCode: 400 });
  }
  if (!selectedCharacterId && characters.length > 1) {
    throw Object.assign(new Error("Select a playable character for this campaign."), { statusCode: 400 });
  }
  const selected = selectedCharacterId
    ? characters.find((character) => character.id === selectedCharacterId)
    : characters[0];
  if (!selected) {
    throw Object.assign(new Error("The selected playable character does not belong to this world version."), { statusCode: 400 });
  }
  return selected;
}

export function campaignCharacterSeed(content: WorldContent, selectedCharacterId?: string): CampaignCharacterSeed {
  const character = selectPlayableCharacter(content, selectedCharacterId);
  return {
    character,
    rpgStats: mergeNamed(values(content.rpgStats), values(character.rpgStats)),
    defaultTriggers: mergeNamed(values(content.defaultTriggers), values(character.defaultTriggers))
  };
}

export function characterSnapshot(character: PlayableCharacter): Record<string, unknown> {
  const snapshot: Record<string, unknown> = { ...character };
  delete snapshot.legacy;
  return snapshot;
}

export function characterTextFromSnapshot(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  return typeof (snapshot as Record<string, unknown>).characterText === "string"
    ? String((snapshot as Record<string, unknown>).characterText).trim()
    : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonemptyEntries(value: Record<string, unknown>): Record<string, unknown> {
  const entries: Array<[string, unknown]> = [];
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      if (item.trim()) entries.push([key, item.trim()]);
      continue;
    }
    if (Array.isArray(item)) {
      const values = item.map((entry) => String(entry).trim()).filter(Boolean);
      if (values.length) entries.push([key, values]);
      continue;
    }
    const nested = objectValue(item);
    if (!nested) continue;
    const cleaned = nonemptyEntries(nested);
    if (Object.keys(cleaned).length) entries.push([key, cleaned]);
  }
  return Object.fromEntries(entries);
}

export function hasCharacterProfileGuidance(profile: CharacterProfile): boolean {
  const cleaned = nonemptyEntries(profile.story as unknown as Record<string, unknown>);
  return Object.keys(cleaned).length > 0;
}

export function campaignProfileFromCharacter(character: PlayableCharacter): CampaignCharacterProfile | null {
  if (!character.profile) return null;
  return campaignCharacterProfileSchema.parse({ name: character.name, profile: character.profile });
}

export function effectiveCampaignCharacter(
  campaignProfile: unknown,
  snapshot: unknown
): { name: string; profile: CharacterProfile | null; legacyGuidance: string } {
  const stored = campaignCharacterProfileSchema.safeParse(campaignProfile);
  const source = objectValue(snapshot);
  const snapshotProfile = characterProfileSchema.safeParse(source?.profile);
  const name = stored.success
    ? stored.data.name
    : typeof source?.name === "string" ? source.name.trim() : "";
  return {
    name,
    profile: stored.success ? stored.data.profile : snapshotProfile.success ? snapshotProfile.data : null,
    legacyGuidance: typeof source?.characterText === "string" ? source.characterText.trim() : ""
  };
}

export function characterNarrativeContext(
  campaignProfile: unknown,
  snapshot: unknown,
  maximumCharacters = 12_000,
  maximumFieldCharacters = 1_600
): Record<string, unknown> | null {
  const effective = effectiveCampaignCharacter(campaignProfile, snapshot);
  let remaining = Math.max(0, maximumCharacters);
  const boundedText = (value: unknown, fieldMaximum = maximumFieldCharacters): string => {
    if (remaining <= 0) return "";
    const sanitized = stripMechanicsLeakage(String(value || "").trim()).text;
    const bounded = truncateAtBoundary(sanitized, Math.min(fieldMaximum, remaining));
    remaining -= bounded.length;
    return bounded;
  };
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") return boundedText(value);
    if (Array.isArray(value)) {
      return value.map((item) => boundedText(item, Math.min(400, maximumFieldCharacters))).filter(Boolean);
    }
    const source = objectValue(value);
    if (!source) return undefined;
    return nonemptyEntries(Object.fromEntries(Object.entries(source).map(([key, item]) => [key, visit(item)])));
  };
  const name = boundedText(effective.name, 200);
  if (effective.profile) {
    const profile = visit(effective.profile) as Record<string, unknown>;
    return nonemptyEntries({ name, ...profile });
  }
  return effective.name || effective.legacyGuidance
    ? nonemptyEntries({ name, guidance: boundedText(effective.legacyGuidance) })
    : null;
}

export function characterLegacyText(campaignProfile: unknown, snapshot: unknown): string | null {
  const effective = effectiveCampaignCharacter(campaignProfile, snapshot);
  if (!effective.profile) {
    return [effective.name, effective.legacyGuidance].filter(Boolean).join("\n\n") || null;
  }
  const sections: string[] = [effective.name];
  const append = (heading: string, values: unknown[]) => {
    const content = values.flatMap((value) => Array.isArray(value) ? value : [value])
      .map((value) => String(value || "").trim()).filter(Boolean);
    if (content.length) sections.push(`${heading}\n${content.join("\n")}`);
  };
  append("Identity", [effective.profile.identity.aliases.length ? `Aliases: ${effective.profile.identity.aliases.join(", ")}` : "", effective.profile.identity.pronouns]);
  append("Story", Object.values(effective.profile.story));
  append("Appearance", Object.values(effective.profile.appearance));
  append("Other notes", [effective.profile.unclassifiedNotes]);
  return sections.filter(Boolean).join("\n\n") || null;
}

export function characterVisualReference(
  campaignProfile: unknown,
  snapshot: unknown,
  maximumCharacters = 900
): string {
  const effective = effectiveCampaignCharacter(campaignProfile, snapshot);
  const profile = effective.profile;
  const appearanceValues = profile ? [
    profile.appearance.ancestryOrSpecies ? `Ancestry or species: ${profile.appearance.ancestryOrSpecies}` : "",
    profile.appearance.apparentAge ? `Apparent age: ${profile.appearance.apparentAge}` : "",
    profile.appearance.genderPresentation ? `Gender presentation: ${profile.appearance.genderPresentation}` : "",
    profile.appearance.build ? `Build: ${profile.appearance.build}` : "",
    profile.appearance.skinOrComplexion ? `Skin or complexion: ${profile.appearance.skinOrComplexion}` : "",
    profile.appearance.face ? `Face: ${profile.appearance.face}` : "",
    profile.appearance.eyes ? `Eyes: ${profile.appearance.eyes}` : "",
    profile.appearance.hair ? `Hair: ${profile.appearance.hair}` : "",
    profile.appearance.distinguishingFeatures.length ? `Distinguishing features: ${profile.appearance.distinguishingFeatures.join("; ")}` : "",
    profile.appearance.clothing ? `Clothing: ${profile.appearance.clothing}` : "",
    profile.appearance.equipmentAndAccessories ? `Equipment and accessories: ${profile.appearance.equipmentAndAccessories}` : "",
    profile.appearance.otherVisualDetails ? `Other visual details: ${profile.appearance.otherVisualDetails}` : ""
  ].filter(Boolean) : [];
  if (profile && appearanceValues.length === 0) return "";
  const values = profile ? [
    effective.name ? `Name: ${effective.name}` : "",
    profile.identity.aliases.length ? `Aliases: ${profile.identity.aliases.join(", ")}` : "",
    ...appearanceValues
  ] : [
    effective.name ? `Name: ${effective.name}` : "",
    effective.legacyGuidance
  ];
  const sanitized = stripMechanicsLeakage(values.filter(Boolean).join("\n")).text;
  return truncateAtBoundary(sanitized, maximumCharacters);
}
