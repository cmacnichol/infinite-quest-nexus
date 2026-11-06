import { campaignCharacterProfileUpdateSchema, type CampaignCharacterProfile, type CampaignCharacterProfileUpdate } from "@infinite-quest/contracts";

export type CharacterSectionName = "Identity" | "Personality and voice" | "Appearance" | "Current situation" | "History" | "Mechanics";
export type ProfileFieldDescriptor = { path: string; label: string; section: CharacterSectionName; input: "text" | "textarea" | "list" };
const field = (path: string, label: string, section: CharacterSectionName, input: ProfileFieldDescriptor["input"] = "textarea"): ProfileFieldDescriptor => ({ path, label, section, input });
export const PROFILE_FIELDS: readonly ProfileFieldDescriptor[] = [
  field("name", "Name", "Identity", "text"), field("identity.aliases", "Aliases", "Identity", "list"), field("identity.pronouns", "Pronouns", "Identity", "text"),
  field("story.role", "Role", "Identity"), field("story.personality", "Personality", "Personality and voice"), field("story.voiceAndMannerisms", "Voice and mannerisms", "Personality and voice"),
  field("story.motivations", "Motivations", "Current situation"), field("story.goals", "Goals", "Current situation"), field("story.fearsAndConflicts", "Fears and conflicts", "Current situation"),
  field("story.background", "Background", "History"), field("story.keyRelationships", "Key relationships", "History"), field("story.narrativeHooks", "Narrative hooks", "History"), field("story.otherGuidance", "Other guidance", "History"),
  ...[["ancestryOrSpecies", "Ancestry or species"], ["apparentAge", "Apparent age"], ["genderPresentation", "Gender presentation"], ["build", "Build"], ["skinOrComplexion", "Skin or complexion"], ["face", "Face"], ["eyes", "Eyes"], ["hair", "Hair"], ["clothing", "Clothing"], ["equipmentAndAccessories", "Equipment and accessories"], ["otherVisualDetails", "Other visual details"]].map(([key, label]) => field(`appearance.${key}`, label!, "Appearance")),
  field("appearance.distinguishingFeatures", "Distinguishing features", "Appearance", "list"), field("unclassifiedNotes", "Other notes", "History")
];
export const SUPPORTING_FIELDS: readonly ProfileFieldDescriptor[] = [
  field("identity.pronouns", "Pronouns", "Identity", "text"), field("story.role", "Role", "Identity"), field("story.background", "Background", "History"),
  field("story.personality", "Personality", "Personality and voice"), field("story.motivations", "Motivations", "Current situation"), field("story.goals", "Goals", "Current situation"), field("story.voiceAndMannerisms", "Voice and mannerisms", "Personality and voice"),
  field("appearance.description", "Appearance", "Appearance"), field("state.location", "Location", "Current situation"), field("state.condition", "Condition", "Current situation"), field("state.clothing", "Clothing", "Current situation")
];
export type ProfileDraft = { loaded: CampaignCharacterProfile; values: Record<string, string | string[]> };
export function createProfileDraft(profile: CampaignCharacterProfile): ProfileDraft { return { loaded: { ...profile, profile: { ...profile.profile, identity: { ...profile.profile.identity }, story: { ...profile.profile.story }, appearance: { ...profile.profile.appearance } } }, values: {} }; }
export function setProfileDraftField(draft: ProfileDraft, path: string, value: string | string[]): ProfileDraft {
  const descriptor = PROFILE_FIELDS.find((entry) => entry.path === path);
  if (!descriptor || (descriptor.input === "list") !== Array.isArray(value)) throw new Error("Invalid profile field or value.");
  return { ...draft, values: { ...draft.values, [path]: Array.isArray(value) ? [...value] : value } };
}
export function buildProfileUpdate(draft: ProfileDraft, expectedRevision: number): CampaignCharacterProfileUpdate {
  const result = { ...draft.loaded, profile: { ...draft.loaded.profile, identity: { ...draft.loaded.profile.identity }, story: { ...draft.loaded.profile.story }, appearance: { ...draft.loaded.profile.appearance } } };
  for (const [path, value] of Object.entries(draft.values)) {
    const [section, key] = path.split(".");
    if (!PROFILE_FIELDS.some((entry) => entry.path === path)) throw new Error("Invalid profile field.");
    if (!key && section === "name") result.name = value as string;
    else if (!key) (result.profile as unknown as Record<string, unknown>)[section!] = value;
    else (result.profile as unknown as Record<string, Record<string, unknown>>)[section!]![key] = value;
  }
  return campaignCharacterProfileUpdateSchema.parse({ ...result, expectedRevision, editSource: "manual" });
}


