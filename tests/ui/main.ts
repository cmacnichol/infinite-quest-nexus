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

  const dialog = element("wa-dialog", { label: "Campaign Settings" });
  dialog.append(textElement("p", "Display preferences only."));
  const openDialog = textElement("wa-button", "Campaign Settings");
  openDialog.addEventListener("click", () => {
    dialog.setAttribute("open", "");
  });

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

  root.append(action, notes, illustration, controls, readingWidth, openDialog, menu, disabled, icon, dialog, output);
}

void main();
