import "../../apps/web-next/src/theme/tokens.css";
import { applyTheme } from "../../apps/web-next/src/theme.js";
import { mountDialog } from "../../apps/web-next/src/ui/dialog.js";
import { ensureWebAwesome } from "../../apps/web-next/src/ui/web-awesome.js";

function element(name: string, attributes: Record<string, string> = {}): HTMLElement {
  const result = document.createElement(name);
  for (const [attribute, value] of Object.entries(attributes)) result.setAttribute(attribute, value);
  return result;
}

function textElement(name: string, text: string, attributes: Record<string, string> = {}): HTMLElement {
  const result = element(name, attributes);
  result.textContent = text;
  return result;
}

async function main(): Promise<void> {
  applyTheme(document.documentElement, "light");
  await ensureWebAwesome();

  const root = document.querySelector<HTMLElement>("#fixture");
  if (!root) throw new Error("Fixture root is missing.");

  const output = document.createElement("output");
  output.textContent = "ready";
  output.dataset.selectionCount = "0";

  const action = element("wa-input", { label: "Custom Action" });
  const notes = element("wa-textarea", { label: "Notes" });
  const illustration = textElement("wa-checkbox", "Show artwork");
  const controls = element("wa-select", { label: "Turn controls", value: "guided" });
  controls.append(
    textElement("wa-option", "Guided", { value: "guided" }),
    textElement("wa-option", "Compact", { value: "compact" })
  );
  const readingWidth = element("wa-radio-group", { label: "Reading width", value: "comfortable" });
  readingWidth.append(
    textElement("wa-radio", "Comfortable", { value: "comfortable" }),
    textElement("wa-radio", "Wide", { value: "wide" })
  );

  const dialog = mountDialog(document, { label: "Campaign Settings" });
  dialog.body.append(textElement("p", "Display preferences only."));
  const openDialog = textElement("wa-button", "Campaign Settings");
  openDialog.addEventListener("click", () => {
    dialog.open(openDialog);
  });

  const lightTheme = textElement("button", "Use light theme", { type: "button" });
  lightTheme.addEventListener("click", () => applyTheme(document.documentElement, "light"));
  const darkTheme = textElement("button", "Use dark theme", { type: "button" });
  darkTheme.addEventListener("click", () => applyTheme(document.documentElement, "dark"));

  const menu = document.createElement("wa-dropdown");
  const menuButton = textElement("wa-button", "Open activity menu", { slot: "trigger", "aria-label": "Open activity menu" });
  const activity = textElement("wa-dropdown-item", "Activity Log", { value: "activity" });
  menu.append(menuButton, activity);
  menu.addEventListener("wa-select", () => {
    output.textContent = "activity";
    output.dataset.selectionCount = String(Number(output.dataset.selectionCount ?? "0") + 1);
  });

  const disabled = textElement("wa-button", "Disabled command", { disabled: "" });
  disabled.addEventListener("click", () => {
    output.textContent = "disabled";
  });

  const icon = element("wa-icon", {
    library: "system",
    variant: "regular",
    name: "circle-question",
    label: "Help"
  });

  root.append(
    action, notes, illustration, controls, readingWidth, lightTheme, darkTheme, openDialog,
    menu, disabled, icon, dialog.element, output
  );
}

void main();
