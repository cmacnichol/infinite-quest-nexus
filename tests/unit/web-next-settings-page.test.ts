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
import { vi } from "vitest";
it("disposes campaign ownership state on identity change even when a late transport ignores cancellation", async () => {
  const { document, window } = parseHTML("<body><div id=app></div></body>");
  Object.defineProperty(window, "location", { configurable: true, value: new URL("https://example.test/app/settings?section=campaign") });
  let finish!: (value: Response) => void;
  vi.stubGlobal("fetch", () => new Promise<Response>(resolve => { finish = resolve; }));
  try {
    const root = document.querySelector<HTMLElement>("#app")!;
    const page = mountSettingsPage(root, { section: "campaign", campaignId: null });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    window.dispatchEvent(new window.Event("app-identity-changed"));
    expect(root.textContent).toContain("Your account changed. Reload Settings to continue.");
    const cleared = root.innerHTML;
    finish(new Response(JSON.stringify({ campaigns: [] }), { headers: { "Content-Type": "application/json" } }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(root.innerHTML).toBe(cleared);
    expect(root.querySelector("select")).toBeNull();
    page.dispose();
  } finally { vi.unstubAllGlobals(); }
});
