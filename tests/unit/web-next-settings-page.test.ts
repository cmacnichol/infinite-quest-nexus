import { expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { mountSettingsPage } from "../../apps/web-next/src/settings/page.js";
import type { InstanceSettingsApi } from "../../packages/client-core/src/settings-session.js";
it("disposes a mounted route before late unlock status can render", async () => {
  const { document, window } = parseHTML("<body><div id=app></div></body>");
  Object.defineProperty(window, "location", { configurable: true, value: new URL("https://example.test/app/settings?section=diagnostics") });
  let finish!: (value: { managementEnabled: boolean; unlocked: false }) => void;
  const api = { status: () => new Promise(resolve => { finish = resolve; }) } as InstanceSettingsApi;
  const root = document.querySelector<HTMLElement>("#app")!;
  const page = mountSettingsPage(root, { section: "diagnostics", campaignId: null }, { api });
  page.dispose(); const afterDispose = root.innerHTML;
  finish({ managementEnabled: true, unlocked: false }); await Promise.resolve(); await Promise.resolve();
  expect(root.innerHTML).toBe(afterDispose);
  expect(root.textContent).not.toContain("Operator management key");
});
