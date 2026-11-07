import type { DisplayPreferencesStore } from "@infinite-quest/client-web";

interface DeviceThemePort {
  set(theme: "light" | "dark"): unknown;
  subscribe(listener: (theme: "light" | "dark") => void): () => void;
}
export function mountDevicePreferenceFields(document: Document, theme: DeviceThemePort, display: DisplayPreferencesStore) {
    const holder = document.createElement("fieldset");
    holder.className = "native-device-preferences";
    const title = document.createElement("legend");
    title.textContent = "On this device"; holder.append(title);
    function select(labelText: string, choices: readonly string[], onChange: (value: string) => void) {
      const label = document.createElement("label");
      label.textContent = labelText;
      const input = document.createElement("select");
      for (const choice of choices) {
        const option = document.createElement("option");
        option.value = choice;
        option.textContent = choice === "auto" ? "Automatic" : choice[0]!.toUpperCase() + choice.slice(1);
        input.append(option);
      }
      input.setAttribute("aria-label", labelText);
      input.addEventListener("change", () => onChange(input.value));
      label.append(input); holder.append(label);
      return input;
    }
    const themeControl = select("Device theme", ["light", "dark"], value => theme.set(value === "dark" ? "dark" : "light"));
    const width = select("Story width", ["auto", "comfortable", "wide", "full"], value => display.setStoryWidth(value as ReturnType<typeof display.get>["storyWidth"]));
    const artLabel = document.createElement("label"); artLabel.textContent = "Show artwork in this campaign";
    const art = document.createElement("input"); art.type = "checkbox"; artLabel.append(art); holder.append(artLabel);
    artLabel.hidden = true;
    art.addEventListener("change", () => { if (preferenceCampaignId) display.setCampaignArtwork(preferenceCampaignId, art.checked); });
    function reflect(input: HTMLSelectElement, value: string) {
      for (const option of Array.from(input.querySelectorAll("option"))) option.selected = option.value === value;
    }
    let preferenceCampaignId: string | null = null;
    const syncArt = () => {
      artLabel.hidden = !preferenceCampaignId;
      art.checked = preferenceCampaignId ? display.get().artworkByCampaign[preferenceCampaignId] ?? true : true;
    };
    const untheme = theme.subscribe(value => reflect(themeControl, value));
    const undisplay = display.subscribe(value => { reflect(width, value.storyWidth); syncArt(); });
    return {element: holder, setCampaign(id: string | null) { preferenceCampaignId = id; syncArt(); },
      dispose() { untheme(); undisplay(); holder.remove(); }};
}
