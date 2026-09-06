import { installSystemIcons } from "./system-icons.js";

let webAwesomePromise: Promise<void> | undefined;

export function ensureWebAwesome(): Promise<void> {
  if (!webAwesomePromise) {
    webAwesomePromise = (async () => {
      await import("./web-awesome-theme.css");
      await installSystemIcons(import.meta.env.BASE_URL);
      await import("@awesome.me/webawesome/dist/components/button/button.js");
      await import("@awesome.me/webawesome/dist/components/dropdown/dropdown.js");
      await import("@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js");
      await import("@awesome.me/webawesome/dist/components/input/input.js");
      await import("@awesome.me/webawesome/dist/components/textarea/textarea.js");
      await import("@awesome.me/webawesome/dist/components/checkbox/checkbox.js");
      await import("@awesome.me/webawesome/dist/components/select/select.js");
      await import("@awesome.me/webawesome/dist/components/option/option.js");
      await import("@awesome.me/webawesome/dist/components/radio-group/radio-group.js");
      await import("@awesome.me/webawesome/dist/components/radio/radio.js");
    })();
    webAwesomePromise.catch(() => {
      webAwesomePromise = undefined;
    });
  }
  return webAwesomePromise;
}
