import {
  campaignCharacterProfileSchema,
  characterProfileSchema,
  type CharacterProfile
} from "../../contracts/src/world-library.js";
import { stripCredentialLeakage, stripMechanicsLeakage } from "./text.js";
import { effectiveCampaignCharacter } from "./world-characters.js";

export type CharacterFictionAuthority = Readonly<{
  source: "campaign_profile" | "origin_snapshot" | "legacy_guidance" | "none";
  name: string;
  characterText: string;
  profile: CharacterProfile | null;
  omittedExtensionFieldCount: number;
}>;

const IDENTITY_FIELDS = ["aliases", "pronouns"] as const;
const STORY_FIELDS = [
  "role", "background", "personality", "motivations", "goals", "fearsAndConflicts",
  "keyRelationships", "narrativeHooks", "voiceAndMannerisms", "otherGuidance"
] as const;
const APPEARANCE_FIELDS = [
  "ancestryOrSpecies", "apparentAge", "genderPresentation", "build", "skinOrComplexion",
  "face", "eyes", "hair", "distinguishingFeatures", "clothing", "equipmentAndAccessories",
  "otherVisualDetails"
] as const;
const PROFILE_FIELDS = new Set(["identity", "story", "appearance", "unclassifiedNotes"]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function fictionText(value: unknown): string {
  return stripCredentialLeakage(stripMechanicsLeakage(typeof value === "string" ? value.trim() : "").text).trim();
}

function fictionStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(fictionText).filter(Boolean) : [];
}

function projectSection(source: Record<string, unknown>, fields: readonly string[]): { value: Record<string, unknown>; omissions: number } {
  const value: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = source[field];
    const projected = Array.isArray(raw) ? fictionStrings(raw) : fictionText(raw);
    if (Array.isArray(projected) ? projected.length : projected) value[field] = projected;
  }
  return { value, omissions: Object.keys(source).filter((key) => !fields.includes(key)).length };
}

/**
 * Complete private character authority. Unlike characterNarrativeContext this
 * never applies presentation caps or prefix truncation: protected overflow is
 * handled by the request planner as a recoverable failure.
 */
export function completeCharacterFictionProfile(profile: CharacterProfile): Readonly<{ profile: CharacterProfile; omittedExtensionFieldCount: number }> {
  const raw = profile as unknown as Record<string, unknown>;
  const identity = projectSection(record(raw.identity), IDENTITY_FIELDS);
  const story = projectSection(record(raw.story), STORY_FIELDS);
  const appearance = projectSection(record(raw.appearance), APPEARANCE_FIELDS);
  const unclassifiedNotes = fictionText(raw.unclassifiedNotes);
  const output = characterProfileSchema.parse({
    ...(Object.keys(identity.value).length ? { identity: identity.value } : {}),
    ...(Object.keys(story.value).length ? { story: story.value } : {}),
    ...(Object.keys(appearance.value).length ? { appearance: appearance.value } : {}),
    ...(unclassifiedNotes ? { unclassifiedNotes } : {})
  });
  return {
    profile: output,
    omittedExtensionFieldCount: Object.keys(raw).filter((key) => !PROFILE_FIELDS.has(key)).length
      + identity.omissions + story.omissions + appearance.omissions
  };
}

export function characterFictionAuthority(campaignProfile: unknown, snapshot: unknown): CharacterFictionAuthority {
  const campaign = campaignCharacterProfileSchema.safeParse(campaignProfile);
  const snapshotRecord = record(snapshot);
  const snapshotProfile = characterProfileSchema.safeParse(snapshotRecord.profile);
  const effective = effectiveCampaignCharacter(campaignProfile, snapshot);
  const source = campaign.success ? "campaign_profile"
    : snapshotProfile.success ? "origin_snapshot"
      : effective.legacyGuidance ? "legacy_guidance" : "none";
  if (!effective.profile) {
    return {
      source,
      name: fictionText(effective.name),
      characterText: fictionText(effective.legacyGuidance),
      profile: null,
      omittedExtensionFieldCount: 0
    };
  }
  const projected = completeCharacterFictionProfile(effective.profile);
  return {
    source,
    name: fictionText(effective.name),
    characterText: "",
    profile: projected.profile,
    omittedExtensionFieldCount: projected.omittedExtensionFieldCount
  };
}
