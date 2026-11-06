import { PROFILE_FIELDS, createProfileDraft, setProfileDraftField, buildProfileUpdate } from "@infinite-quest/client-core";
import type { CampaignCharacterProfile } from "@infinite-quest/contracts";

/** Render a campaign-local profile without exposing its storage representation. */
export function createCharacterProfileForm(root: HTMLElement, profile: CampaignCharacterProfile & { revision: number }) {
  let draft = createProfileDraft({ name: profile.name, profile: profile.profile });
  const sections = new Map<string, HTMLElement>();
  for (const field of PROFILE_FIELDS) {
    let section = sections.get(field.section);
    if (!section) {
      section = document.createElement("section");
      const title = document.createElement("h3"); title.textContent = field.section;
      section.append(title); sections.set(field.section, section); root.append(section);
    }
    const label = document.createElement("label"); label.className = "character-profile-field";
    const caption = document.createElement("span"); caption.textContent = field.label;
    const control = field.input === "text" ? document.createElement("input") : document.createElement("textarea");
    control.name = `profile.${field.path}`;
    const [part, key] = field.path.split(".");
    const value = key ? (profile.profile as unknown as Record<string, Record<string, unknown>>)[part!]?.[key]
      : part === "name" ? profile.name : (profile.profile as unknown as Record<string, unknown>)[part!];
    control.value = Array.isArray(value) ? value.join("\n") : typeof value === "string" ? value : "";
    control.addEventListener("input", () => {
      draft = setProfileDraftField(draft, field.path, field.input === "list"
        ? control.value.split("\n").map((item) => item.trim()).filter(Boolean) : control.value);
    });
    label.append(caption, control); section.append(label);
  }
  return { update: () => buildProfileUpdate(draft, profile.revision), get dirty() { return Object.keys(draft.values).length > 0; } };
}
