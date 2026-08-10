import type { LegacyStory } from "../../contracts/src/imports.js";
import {
  canonicalizeWorldContent,
  WORLD_CONTENT_SCHEMA_VERSION,
  type WorldContent
} from "../../contracts/src/world-library.js";
import { sha256, stableStringify } from "./text.js";

function worldTitle(story: LegacyStory): string {
  return story.world.title?.trim() || "Imported adventure";
}

/** Converts legacy campaign guidance into portable, reusable world canon. */
export function legacyWorldContent(story: LegacyStory, requestedSelectedCharacterId?: string): WorldContent {
  const provenance = story.storyImportProvenance && typeof story.storyImportProvenance === "object" && !Array.isArray(story.storyImportProvenance)
    ? story.storyImportProvenance as Record<string, unknown>
    : {};
  const provenanceCharacterId = typeof provenance.selectedCharacterId === "string" ? provenance.selectedCharacterId.trim() : "";
  const characterText = String(story.world.character || "").trim();
  const characterName = (typeof provenance.selectedCharacterName === "string" && provenance.selectedCharacterName.trim()
    ? provenance.selectedCharacterName.trim()
    : characterText.split(/\r?\n/).find((line) => line.trim())?.trim() || "Default character").slice(0, 200);
  const selectedCharacterId = requestedSelectedCharacterId?.trim() || provenanceCharacterId || `legacy-import-character-${sha256(stableStringify({
    characterText,
    rpgStats: story.rpgStats ?? [],
    defaultTriggers: story.defaultTriggers ?? story.baseTrackersAtStart ?? []
  })).slice(0, 24)}`;
  const world = { ...story.world, title: worldTitle(story) };
  delete world.character;
  return canonicalizeWorldContent({
    schemaVersion: WORLD_CONTENT_SCHEMA_VERSION,
    world,
    playableCharacters: [{
      id: selectedCharacterId,
      name: characterName,
      characterText,
      rpgStats: story.rpgStats ?? [],
      defaultTriggers: story.defaultTriggers ?? story.baseTrackersAtStart ?? [],
      source: {
        type: provenanceCharacterId ? "nexus-campaign-export" : "legacy-campaign-import"
      }
    }],
    rpgStats: [],
    defaultTriggers: [],
    eventTriggers: story.eventTriggers ?? [],
    importedFromLegacyStory: true
  });
}
