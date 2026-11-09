import { campaignCharacterProfileUpdateSchema, type CampaignCharacterProfile, type CampaignCharacterProfileUpdate } from "@infinite-quest/contracts";

export type CharacterSectionName = "Identity" | "Personality and voice" | "Appearance" | "Current situation" | "History" | "Mechanics";
export type ProfileFieldDescriptor = { path: string; label: string; section: CharacterSectionName; input: "text" | "textarea" | "list" };
export type CharacterEditorFieldDescriptor = ProfileFieldDescriptor & {
  maxLength: number; maxItems?: number; profileOrder?: number; supportingOrder?: number;
  world?: { placement: "core" | "optional"; group: "name" | "core" | "identity" | "story" | "appearance" | "notes"; order: number; id: string; label: string; input: "text" | "textarea"; title: string; placeholder: string };
};
/** Shared registry for the legacy views and World editor. */
export const CHARACTER_FIELD_DESCRIPTORS: readonly CharacterEditorFieldDescriptor[] = [
  {
    "path": "name",
    "label": "Name",
    "section": "Identity",
    "input": "text",
    "maxLength": 200,
    "profileOrder": 0,
    "world": {
      "group": "name",
      "placement": "core",
      "order": 0,
      "id": "characterName",
      "label": "Character name",
      "input": "text",
      "title": "The character's canonical name. This name is used in campaign context and image references.",
      "placeholder": "e.g., Mira Vale"
    }
  },
  {
    "path": "identity.aliases",
    "label": "Aliases",
    "section": "Identity",
    "input": "list",
    "maxLength": 200,
    "maxItems": 20,
    "profileOrder": 1,
    "world": {
      "group": "identity",
      "placement": "optional",
      "order": 0,
      "id": "characterAliases",
      "label": "Aliases",
      "input": "textarea",
      "title": "Other names, titles, or nicknames used for this character. Use one alias per line.",
      "placeholder": "e.g., The Fox\nLantern Bearer"
    }
  },
  {
    "path": "identity.pronouns",
    "label": "Pronouns",
    "section": "Identity",
    "input": "text",
    "maxLength": 2000,
    "profileOrder": 2,
    "supportingOrder": 0,
    "world": {
      "group": "identity",
      "placement": "optional",
      "order": 1,
      "id": "characterPronouns",
      "label": "Pronouns",
      "input": "text",
      "title": "The pronouns used when referring to this character.",
      "placeholder": "e.g., she/her"
    }
  },
  {
    "path": "story.role",
    "label": "Role",
    "section": "Identity",
    "input": "textarea",
    "maxLength": 20000,
    "profileOrder": 3,
    "supportingOrder": 1,
    "world": {
      "group": "core",
      "placement": "core",
      "order": 0,
      "id": "characterRole",
      "label": "Role",
      "input": "textarea",
      "title": "Their current story function, occupation, or place in the world.",
      "placeholder": "e.g., Expedition leader and reluctant guide"
    }
  },
  {
    "path": "story.personality",
    "label": "Personality",
    "section": "Personality and voice",
    "input": "textarea",
    "maxLength": 20000,
    "profileOrder": 4,
    "supportingOrder": 3,
    "world": {
      "group": "core",
      "placement": "core",
      "order": 2,
      "id": "characterPersonality",
      "label": "Personality",
      "input": "textarea",
      "title": "Stable traits, temperament, and typical emotional responses.",
      "placeholder": "e.g., Patient, observant, and protective"
    }
  },
  {
    "path": "story.voiceAndMannerisms",
    "label": "Voice and mannerisms",
    "section": "Personality and voice",
    "input": "textarea",
    "maxLength": 20000,
    "profileOrder": 5,
    "supportingOrder": 6,
    "world": {
      "group": "story",
      "placement": "optional",
      "order": 5,
      "id": "characterVoiceAndMannerisms",
      "label": "Voice and mannerisms",
      "input": "textarea",
      "title": "Speech patterns, vocabulary, habits, gestures, and other recognizable behavior.",
      "placeholder": "e.g., Speaks softly and checks the horizon before answering"
    }
  },
  {
    "path": "story.motivations",
    "label": "Motivations",
    "section": "Current situation",
    "input": "textarea",
    "maxLength": 20000,
    "profileOrder": 6,
    "supportingOrder": 4,
    "world": {
      "group": "story",
      "placement": "optional",
      "order": 0,
      "id": "characterMotivations",
      "label": "Motivations",
      "input": "textarea",
      "title": "Why the character acts: needs, values, desires, or driving forces.",
      "placeholder": "e.g., Protect travelers from the dangers she survived"
    }
  },
  {
    "path": "story.goals",
    "label": "Goals",
    "section": "Current situation",
    "input": "textarea",
    "maxLength": 20000,
    "profileOrder": 7,
    "supportingOrder": 5,
    "world": {
      "group": "story",
      "placement": "optional",
      "order": 1,
      "id": "characterGoals",
      "label": "Goals",
      "input": "textarea",
      "title": "Concrete outcomes the character is trying to achieve.",
      "placeholder": "e.g., Find the vanished road and return its travelers"
    }
  },
  {
    "path": "story.fearsAndConflicts",
    "label": "Fears and conflicts",
    "section": "Current situation",
    "input": "textarea",
    "maxLength": 20000,
    "profileOrder": 8,
    "world": {
      "group": "story",
      "placement": "optional",
      "order": 2,
      "id": "characterFearsAndConflicts",
      "label": "Fears and conflicts",
      "input": "textarea",
      "title": "Fears, pressures, dilemmas, rivalries, or internal and external conflicts.",
      "placeholder": "e.g., Fears leading others into the same loss"
    }
  },
  {
    "path": "story.background",
    "label": "Background",
    "section": "History",
    "input": "textarea",
    "maxLength": 20000,
    "profileOrder": 9,
    "supportingOrder": 2,
    "world": {
      "group": "core",
      "placement": "core",
      "order": 1,
      "id": "characterBackground",
      "label": "Background",
      "input": "textarea",
      "title": "Relevant history, upbringing, and past events that shape the character.",
      "placeholder": "e.g., Raised among moving roads and vanished settlements"
    }
  },
  {
    "path": "story.keyRelationships",
    "label": "Key relationships",
    "section": "History",
    "input": "textarea",
    "maxLength": 20000,
    "profileOrder": 10,
    "world": {
      "group": "story",
      "placement": "optional",
      "order": 3,
      "id": "characterKeyRelationships",
      "label": "Key relationships",
      "input": "textarea",
      "title": "Important connections to people, groups, creatures, or places and how they relate.",
      "placeholder": "e.g., Owes the Cartographer Guild a dangerous favor"
    }
  },
  {
    "path": "story.narrativeHooks",
    "label": "Narrative hooks",
    "section": "History",
    "input": "textarea",
    "maxLength": 20000,
    "profileOrder": 11,
    "world": {
      "group": "story",
      "placement": "optional",
      "order": 4,
      "id": "characterNarrativeHooks",
      "label": "Narrative hooks",
      "input": "textarea",
      "title": "Open questions, secrets, obligations, or situations that can naturally drive scenes.",
      "placeholder": "e.g., Carries a map that changes after dusk"
    }
  },
  {
    "path": "story.otherGuidance",
    "label": "Other guidance",
    "section": "History",
    "input": "textarea",
    "maxLength": 20000,
    "profileOrder": 12,
    "world": {
      "group": "story",
      "placement": "optional",
      "order": 6,
      "id": "characterOtherGuidance",
      "label": "Other guidance",
      "input": "textarea",
      "title": "Other story-relevant guidance that does not fit a more specific story field.",
      "placeholder": "e.g., Never knowingly abandons a traveler"
    }
  },
  {
    "path": "appearance.ancestryOrSpecies",
    "label": "Ancestry or species",
    "section": "Appearance",
    "input": "textarea",
    "maxLength": 2000,
    "profileOrder": 13,
    "world": {
      "group": "appearance",
      "placement": "optional",
      "order": 0,
      "id": "characterAncestryOrSpecies",
      "label": "Ancestry or species",
      "input": "text",
      "title": "Species, ancestry, lineage, or other biological or cultural origin when stated.",
      "placeholder": "e.g., Human"
    }
  },
  {
    "path": "appearance.apparentAge",
    "label": "Apparent age",
    "section": "Appearance",
    "input": "textarea",
    "maxLength": 2000,
    "profileOrder": 14,
    "world": {
      "group": "appearance",
      "placement": "optional",
      "order": 1,
      "id": "characterApparentAge",
      "label": "Apparent age",
      "input": "text",
      "title": "How old the character appears. Leave blank when the source does not establish it.",
      "placeholder": "e.g., Early thirties"
    }
  },
  {
    "path": "appearance.genderPresentation",
    "label": "Gender presentation",
    "section": "Appearance",
    "input": "textarea",
    "maxLength": 2000,
    "profileOrder": 15,
    "world": {
      "group": "appearance",
      "placement": "optional",
      "order": 2,
      "id": "characterGenderPresentation",
      "label": "Gender presentation",
      "input": "text",
      "title": "How the character presents their gender visually or socially, if established.",
      "placeholder": "e.g., Feminine presentation"
    }
  },
  {
    "path": "appearance.build",
    "label": "Build",
    "section": "Appearance",
    "input": "textarea",
    "maxLength": 2000,
    "profileOrder": 16,
    "world": {
      "group": "appearance",
      "placement": "optional",
      "order": 3,
      "id": "characterBuild",
      "label": "Build",
      "input": "text",
      "title": "Body type, height impression, posture, or physical bearing.",
      "placeholder": "e.g., Lean and wiry"
    }
  },
  {
    "path": "appearance.skinOrComplexion",
    "label": "Skin or complexion",
    "section": "Appearance",
    "input": "textarea",
    "maxLength": 2000,
    "profileOrder": 17,
    "world": {
      "group": "appearance",
      "placement": "optional",
      "order": 4,
      "id": "characterSkinOrComplexion",
      "label": "Skin or complexion",
      "input": "text",
      "title": "Skin tone, complexion, fur, scales, or equivalent visible covering.",
      "placeholder": "e.g., Sun-browned complexion"
    }
  },
  {
    "path": "appearance.face",
    "label": "Face",
    "section": "Appearance",
    "input": "textarea",
    "maxLength": 20000,
    "profileOrder": 18,
    "world": {
      "group": "appearance",
      "placement": "optional",
      "order": 5,
      "id": "characterFace",
      "label": "Face",
      "input": "textarea",
      "title": "Face shape, expression, facial hair, or other facial characteristics.",
      "placeholder": "e.g., Angular face with a guarded expression"
    }
  },
  {
    "path": "appearance.eyes",
    "label": "Eyes",
    "section": "Appearance",
    "input": "textarea",
    "maxLength": 2000,
    "profileOrder": 19,
    "world": {
      "group": "appearance",
      "placement": "optional",
      "order": 6,
      "id": "characterEyes",
      "label": "Eyes",
      "input": "text",
      "title": "Eye color, shape, expression, or unusual qualities.",
      "placeholder": "e.g., Watchful green eyes"
    }
  },
  {
    "path": "appearance.hair",
    "label": "Hair",
    "section": "Appearance",
    "input": "textarea",
    "maxLength": 20000,
    "profileOrder": 20,
    "world": {
      "group": "appearance",
      "placement": "optional",
      "order": 7,
      "id": "characterHair",
      "label": "Hair",
      "input": "textarea",
      "title": "Hair color, length, texture, style, or equivalent feature.",
      "placeholder": "e.g., Black hair worn in a long braid"
    }
  },
  {
    "path": "appearance.clothing",
    "label": "Clothing",
    "section": "Appearance",
    "input": "textarea",
    "maxLength": 20000,
    "profileOrder": 21,
    "world": {
      "group": "appearance",
      "placement": "optional",
      "order": 9,
      "id": "characterClothing",
      "label": "Clothing",
      "input": "textarea",
      "title": "Typical garments, armor, uniform, colors, and overall style.",
      "placeholder": "e.g., Weathered blue cloak over travel leathers"
    }
  },
  {
    "path": "appearance.equipmentAndAccessories",
    "label": "Equipment and accessories",
    "section": "Appearance",
    "input": "textarea",
    "maxLength": 20000,
    "profileOrder": 22,
    "world": {
      "group": "appearance",
      "placement": "optional",
      "order": 10,
      "id": "characterEquipmentAndAccessories",
      "label": "Equipment and accessories",
      "input": "textarea",
      "title": "Visible carried gear, jewelry, tools, weapons, or signature accessories.",
      "placeholder": "e.g., Brass lantern and a worn map case"
    }
  },
  {
    "path": "appearance.otherVisualDetails",
    "label": "Other visual details",
    "section": "Appearance",
    "input": "textarea",
    "maxLength": 20000,
    "profileOrder": 23,
    "world": {
      "group": "appearance",
      "placement": "optional",
      "order": 11,
      "id": "characterOtherVisualDetails",
      "label": "Other visual details",
      "input": "textarea",
      "title": "Any remaining stable visual details not covered by the fields above.",
      "placeholder": "e.g., Smells faintly of cedar smoke"
    }
  },
  {
    "path": "appearance.distinguishingFeatures",
    "label": "Distinguishing features",
    "section": "Appearance",
    "input": "list",
    "maxLength": 2000,
    "maxItems": 50,
    "profileOrder": 24,
    "world": {
      "group": "appearance",
      "placement": "optional",
      "order": 8,
      "id": "characterDistinguishingFeatures",
      "label": "Distinguishing features",
      "input": "textarea",
      "title": "Scars, tattoos, marks, prosthetics, unusual features, or other immediately recognizable details. Use one feature per line.",
      "placeholder": "e.g., Crescent scar under left eye\nSilver compass tattoo on wrist"
    }
  },
  {
    "path": "unclassifiedNotes",
    "label": "Other notes",
    "section": "History",
    "input": "textarea",
    "maxLength": 200000,
    "profileOrder": 25,
    "world": {
      "group": "notes",
      "placement": "optional",
      "order": 0,
      "id": "characterUnclassifiedNotes",
      "label": "Unclassified notes",
      "input": "textarea",
      "title": "Source material that does not yet fit a targeted field. It remains available for later review or AI organization.",
      "placeholder": "e.g., The old road recognizes her voice, but no one knows why"
    }
  },
  {
    "path": "appearance.description",
    "label": "Appearance",
    "section": "Appearance",
    "input": "textarea",
    "maxLength": 20000,
    "supportingOrder": 7
  },
  {
    "path": "state.location",
    "label": "Location",
    "section": "Current situation",
    "input": "textarea",
    "maxLength": 20000,
    "supportingOrder": 8
  },
  {
    "path": "state.condition",
    "label": "Condition",
    "section": "Current situation",
    "input": "textarea",
    "maxLength": 20000,
    "supportingOrder": 9
  },
  {
    "path": "state.clothing",
    "label": "Clothing",
    "section": "Current situation",
    "input": "textarea",
    "maxLength": 20000,
    "supportingOrder": 10
  }
];
const legacyView = (order: "profileOrder" | "supportingOrder"): readonly ProfileFieldDescriptor[] => CHARACTER_FIELD_DESCRIPTORS
  .filter((field) => field[order] !== undefined).sort((a, b) => a[order]! - b[order]!)
  .map(({ path, label, section, input }) => ({ path, label, section, input }));
export const PROFILE_FIELDS = legacyView("profileOrder");
export const SUPPORTING_FIELDS = legacyView("supportingOrder");
export const WORLD_EDITOR_FIELDS = CHARACTER_FIELD_DESCRIPTORS.filter((field) => field.world);
export const WORLD_PROFILE_FIELDS = WORLD_EDITOR_FIELDS.filter((field) => field.path !== "name");
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



/** Editor-side authority class; kept in parity with the server policy. */
export function seededCharacterFieldPolicy(path: string): "identity" | "fixed" | "updating" | "observed" | "unknown" {
  if (path === "name" || path === "identity.aliases") return "identity";
  if (path === "appearance.description") return "observed";
  if (["story.goals", "state.location", "state.condition", "state.clothing"].includes(path)) return "updating";
  if (path === "unclassifiedNotes" || path.startsWith("identity.") || path.startsWith("story.") || path.startsWith("appearance.")) return "fixed";
  return "unknown";
}
