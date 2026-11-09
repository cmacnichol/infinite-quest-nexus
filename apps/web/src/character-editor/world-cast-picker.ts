import type { CampaignCastApi } from "@infinite-quest/client-web";
import type { CastFromWorldPreview } from "@infinite-quest/contracts";
import { presetFields } from "@infinite-quest/client-core";

export async function renderWorldCastPicker(host: HTMLElement, api: Pick<CampaignCastApi, "worldChoices" | "fromWorldPreview" | "fromWorld">,
  campaign: string, canWrite: () => Promise<boolean>, done: (id: string) => void) {
  const doc = host.ownerDocument, results = doc.createElement("section"), detail = doc.createElement("section");
  const selection = doc.createElement("select"); const label = doc.createElement("label"); label.textContent = "World character"; label.append(selection);
  const status = doc.createElement("p"); status.setAttribute("role", "status"); results.append(status); host.append(results, detail);
  let epoch = 0;
  const button = (text: string, action: () => void) => {
    const el = doc.createElement("button"); el.type = "button"; el.textContent = text; el.addEventListener("click", action); return el;
  };
  const fieldLabel = (path: string) => presetFields.find(field => field.path === path)?.label ?? path;
  const line = (s: string) => { const p = doc.createElement("p"); p.textContent = s; detail.append(p); };
  function showChanges(preview: CastFromWorldPreview) {
    for (const change of preview.changes) {
      if (change.path === "identity") line("Campaign identity: " + change.proposed.name + (change.proposed.aliases.length ? " · " + change.proposed.aliases.join(", ") : ""));
      else if (change.path === "overrides") for (const item of change.proposed) line(fieldLabel(item.field) + ": keep campaign override “" + item.value + "”");
      else if (change.path === "authoredProfile") {
        for (const field of presetFields) {
          const [part, key] = field.path.split(".");
          const get = (profile: typeof change.proposed | null) => {
            const val = profile && (key ? (profile[part!] as Record<string, unknown>)?.[key] : profile[part!]);
            return Array.isArray(val) ? val.join(", ") : typeof val === "string" ? val : "";
          };
          if (get(change.proposed) && !preview.changes.some(item => item.path === field.path)) line(field.label + ": " + (get(change.old) || "Blank") + " → " + get(change.proposed));
        }
      } else line(fieldLabel(change.path) + ": " + (change.old || "Blank") + " → " + (change.proposed || "Blank") + " · " + ({ world: "World value", preserve_edit: "Keep campaign edit", discoverable: "May be filled by the story" })[change.effect]);
    }
  }
  async function preview(characterId: string, pinned: boolean, targetCastCharacterId?: string) {
    const token = ++epoch; detail.replaceChildren(); status.textContent = "Loading preview…";
    try {
      const value = await api.fromWorldPreview(campaign, { characterId, ...(targetCastCharacterId ? { targetCastCharacterId } : {}) });
      if (!host.isConnected || token !== epoch) return;
      status.textContent = "";
      if (value.eligibleTargets.length && !value.targetCastCharacterId) {
        line("Select the campaign character to receive this world profile.");
        for (const candidate of value.eligibleTargets) detail.append(button(candidate.name + " · " + candidate.id, () => void preview(characterId, pinned, candidate.id)));
        return;
      }
      showChanges(value);
      const pin = doc.createElement("input"); pin.type = "checkbox"; pin.checked = pinned;
      const pinLabel = doc.createElement("label"); pinLabel.className = "cast-world-pin"; pinLabel.append(pin, " Always include in context");
      if (!targetCastCharacterId) detail.append(pinLabel);
      const target = value.eligibleTargets.find(item => item.id === targetCastCharacterId);
      const apply = button(target ? "Apply world profile to " + target.name : "Add to campaign", async () => {
        apply.disabled = true; selection.disabled = true; pin.disabled = true;
        try {
          if (!await canWrite()) throw new Error("Finish or resolve generation before editing characters.");
          if (!host.isConnected || token !== epoch) return;
          const result = await api.fromWorld(campaign, { characterId, expectedWorldVersionId: value.worldVersionId, expectedCastRevision: value.castRevision,
            expectedBoundary: value.boundary, previewFingerprint: value.previewFingerprint, idempotencyKey: key,
            ...(targetCastCharacterId && value.characterRevision !== undefined ? { targetCastCharacterId, expectedCharacterRevision: value.characterRevision } : { alwaysInContext: pin.checked }) });
          if (host.isConnected && token === epoch) done(result.character.id);
        } catch (err) {
          if (!host.isConnected || token !== epoch) return;
          const stale = (err as {statusCode?: number}).statusCode === 409;
          status.textContent = stale ? "The campaign or world changed. Review a fresh preview before applying." : err instanceof Error ? err.message : "Could not apply this profile.";
          if (stale) detail.replaceChildren(button("Refresh preview", () => void preview(characterId, pinned)));
          else apply.disabled = false;
        } finally { selection.disabled = false; }
      });
      const key = crypto.randomUUID(); detail.append(apply);
    } catch (err) {
      if (token !== epoch || !host.isConnected) return;
      const fields = (err as { details?: { fields?: { path: string }[] } }).details?.fields;
      status.textContent = fields?.length ? "Check the world character’s " + fields.map(item => fieldLabel(item.path)).join(", ") + " before adding this profile."
        : err instanceof Error ? err.message : "Could not load this preview.";
    }
  }
  async function load() {
    status.textContent = "Loading world characters…";
    try {
      const { characters } = await api.worldChoices(campaign);
      if (!host.isConnected) return;
      selection.replaceChildren(new Option("Choose a character", ""), ...characters.map(person => new Option(person.name, person.characterId)));
      status.textContent = characters.length ? "" : "No world characters are available to add.";
      if (!characters.length) return;
      results.prepend(label);
      selection.onchange = () => { const person = characters.find(item => item.characterId === selection.value); if (person) void preview(person.characterId, person.alwaysInContext); else { ++epoch; detail.replaceChildren(); } };
    } catch { status.textContent = "Could not load world characters."; results.append(button("Retry", () => void load())); }
  }
  await load();
}
