import type { ThemeController } from "../theme.js";
import { mountDialog } from "../ui/dialog.js";
import type { DisplayPreferencesStore, StoryWidth } from "./display-preferences.js";
import { mountProfileEditor, type ProfilePort } from "./profile-editor.js";
import "./preferences.css";

export interface PreferencesDialog {
  open(): Promise<void>;
  close(): void;
  dispose(): void;
}

type ValueControl = HTMLElement & { value?: string | null; checked?: boolean };

function setValue(control: ValueControl, value: string): void {
  control.value = value;
  control.setAttribute("value", value);
}

function selectedValue(control: ValueControl): string {
  return typeof control.value === "string" ? control.value : control.getAttribute("value") ?? "";
}

function currentOpener(document: Document): HTMLElement | null {
  const candidate = document.activeElement;
  return candidate !== null && candidate !== undefined && candidate.nodeType === 1 && typeof (candidate as HTMLElement).focus === "function"
    ? candidate as HTMLElement
    : null;
}

function selectOption(document: Document, value: string, label: string): HTMLElement {
  const option = document.createElement("wa-option");
  option.setAttribute("value", value);
  option.textContent = label;
  return option;
}

export function mountPreferencesDialog(root: HTMLElement, options: Readonly<{
  theme: ThemeController;
  display: DisplayPreferencesStore;
  profile: ProfilePort;
  campaignId: string | null;
}>): PreferencesDialog {
  const document = root.ownerDocument;
  const dialog = mountDialog(document, { label: "Preferences" });
  root.append(dialog.element);

  const browser = document.createElement("section");
  browser.className = "preferences-browser";
  const heading = document.createElement("h2");
  heading.textContent = "On this device";

  const theme = document.createElement("wa-select") as ValueControl;
  theme.setAttribute("label", "Theme");
  theme.dataset.preference = "theme";
  theme.append(
    selectOption(document, "light", "Light"),
    selectOption(document, "dark", "Dark")
  );
  const width = document.createElement("wa-select") as ValueControl;
  width.setAttribute("label", "Story width");
  width.dataset.preference = "story-width";
  width.append(
    selectOption(document, "auto", "Automatic"),
    selectOption(document, "comfortable", "Comfortable"),
    selectOption(document, "wide", "Wide"),
    selectOption(document, "full", "Full width")
  );
  browser.append(heading, theme, width);

  let artwork: ValueControl | null = null;
  if (options.campaignId !== null) {
    artwork = document.createElement("wa-checkbox") as ValueControl;
    artwork.dataset.preference = "campaign-artwork";
    artwork.textContent = "Show artwork in this campaign";
    browser.append(artwork);
  }

  const editor = mountProfileEditor(document, options.profile);
  dialog.body.append(browser, editor.element);

  const unsubscribeTheme = options.theme.subscribe((current) => {
    setValue(theme, current);
  });
  const unsubscribeDisplay = options.display.subscribe((current) => {
    setValue(width, current.storyWidth);
    if (artwork && options.campaignId !== null) {
      artwork.checked = current.artworkByCampaign[options.campaignId] ?? true;
    }
  });

  theme.addEventListener("change", () => {
    const selected = selectedValue(theme);
    if (selected === "light" || selected === "dark") options.theme.set(selected);
  });
  width.addEventListener("change", () => {
    const selected = selectedValue(width);
    if (selected === "auto" || selected === "comfortable" || selected === "wide" || selected === "full") {
      options.display.setStoryWidth(selected as StoryWidth);
    }
  });
  artwork?.addEventListener("change", () => {
    if (options.campaignId !== null && artwork) options.display.setCampaignArtwork(options.campaignId, artwork.checked === true);
  });

  let disposed = false;
  return {
    async open(): Promise<void> {
      if (disposed) return;
      dialog.open(currentOpener(document));
      await editor.load();
    },
    close(): void {
      if (disposed) return;
      dialog.close();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribeTheme();
      unsubscribeDisplay();
      editor.dispose();
      dialog.dispose();
    }
  };
}
