import { expect, test, type Page } from "@playwright/test";
import { settingsFixture } from "../fixtures/instance-settings.js";
import { INSTANCE_SETTING_FIELDS } from "../../packages/domain/src/instance-settings.js";
import { quietLeafApiPayloads } from "../fixtures/quiet-leaf-payloads.js";
import type { InstanceSettingsView } from "../../packages/contracts/src/instance-settings.js";
const base = `http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? "43174"}`;
const mode = process.env.VITE_UI_COMPONENTS === "web-awesome" ? "web-awesome" : "native";
async function api(page: Page, options: { conflict?: boolean; locked?: boolean } = {}) {
  let unlocked = !options.locked; let patches = 0; let lastChanges: unknown; const settings = settingsFixture(); settings.systemArchiveEnabled = false;
  let current: InstanceSettingsView = {
    activeRevision: "1", requestedRevision: "1", active: settings, requested: structuredClone(settings), resetDefaults: structuredClone(settings), activationStatus: "active",
    fields: INSTANCE_SETTING_FIELDS.map(field => ({ ...field, scope: "installation", effectiveValue: field.key.includes(".") ? settings[field.key.split(".")[0] as "campaignArchiveLimits"][field.key.split(".")[1] as "maxEntries"] : settings[field.key as "logLevel"], permittedRange: field.kind === "integer" ? { min: field.minimum!, max: field.maximum! } : null, source: "database", applyMode: "restart", lockReason: field.key === "systemArchiveEnabled" ? "deployment_disabled" : field.key === "castAutoMatchEnabled" ? "dependency_disabled" : null }))
  };
  const payloads = quietLeafApiPayloads();
  await page.route("**/api/v1/**", async route => {
    const path = new URL(route.request().url()).pathname; const method = route.request().method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/v1/session") return json(payloads.session);
    if (path === "/api/v1/meta") return json({ application: { name: "Infinite Quest Nexus", version: "test-build", commit: null, builtAt: null }, capabilities: { systemArchive: false } });
    if (path === "/api/v1/campaigns") return json(payloads.campaigns);
    if (path === "/api/v1/settings/operator-session") {
      if (method === "POST") { expect(route.request().postDataJSON()).toEqual({ managementKey: "fixture-key" }); unlocked = true; return json({ csrfToken: "fixture-csrf", expiresAt: "2099-01-01T00:00:00Z" }); }
      if (method === "DELETE") { expect(route.request().headers()["x-settings-csrf"]).toBe("fixture-csrf"); unlocked = false; return route.fulfill({ status: 204 }); }
      return json(unlocked ? { managementEnabled: true, unlocked: true, csrfToken: "fixture-csrf", expiresAt: "2099-01-01T00:00:00Z" } : { managementEnabled: true, unlocked: false });
    }
    if (path === "/api/v1/settings/instance") {
      if (!unlocked) return json({ code: "settings_unlock_required" }, 401);
      if (method === "PATCH") {
        patches++; expect(route.request().headers()["x-settings-csrf"]).toBe("fixture-csrf"); const patch = route.request().postDataJSON(); lastChanges = patch.changes;
        expect(patch.expectedRequestedRevision).toBe("1");
        if (options.conflict) return json({ code: "settings_conflict", currentRevision: "2" }, 409);
        current = { ...current, requested: { ...current.requested!, ...patch.changes }, requestedRevision: "2", activationStatus: "restart_required" };
      }
      return json(current);
    }
    return json({ code: "unexpected_fixture_request" }, 500);
  });
  return { patches: () => patches, lastChanges: () => lastChanges, settings };
}
for (const width of [1440, 390]) {
  test(`${mode} Settings stage-only Save, review, units and keyboard at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 }); const fixture = await api(page);
    await page.goto(`${base}/app/settings?section=performance`);
    const polling = page.getByRole("textbox", { name: "Queue polling interval", exact: true }); await expect(polling).toBeVisible();
    await polling.fill("1.5"); await polling.press("Tab");
    await expect(page.getByRole("textbox", { name: "Text provider capacity", exact: true })).toBeFocused();
    await page.getByRole("textbox", { name: "Reason for this change" }).fill("Review queue capacity");
    await page.getByRole("button", { name: "Save section", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Review staged policy changes" })).toBeVisible(); expect(fixture.patches()).toBe(0);
    await page.getByRole("button", { name: "Confirm staged Save" }).click();
    await expect(page.getByRole("status")).toHaveText("Saved — restart required");
    await expect(page.locator(".settings-field").filter({ has: polling }).locator(".settings-comparison")).toContainText("Saved: 1.5 seconds");
    await expect(page.locator(".settings-field").filter({ has: polling }).locator(".settings-comparison")).toContainText(`Active: ${fixture.settings.workerPollIntervalMs / 1000} seconds`);
    await expect(page.locator('nav[aria-label="Settings sections"] a[aria-current]')).toHaveText("Performance and Requests");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `test-results/review-assets/settings-panel/${mode}-performance-${width}.png`, fullPage: true });
    await page.reload(); await expect(polling).toHaveValue("1.5");
  });
}
test(`${mode} guards installation drafts before leaving Settings`, async ({ page }) => {
  const fixture = await api(page);
  await page.goto(`${base}/app/settings?section=performance`);
  const polling = page.getByRole("textbox", { name: "Queue polling interval", exact: true });
  await polling.fill("1.5");
  // Reload while the textbox still has focus, before its change event fires.
  const reloadDialog = page.waitForEvent("dialog");
  await page.evaluate(() => { setTimeout(() => location.reload(), 0); });
  const reload = await reloadDialog;
  expect(reload.type()).toBe("beforeunload");
  await reload.dismiss();
  const diagnostics = page.getByRole("link", { name: "Diagnostics and Deployment" });
  const sectionDialog = page.waitForEvent("dialog");
  const click = diagnostics.click({ noWaitAfter: true });
  const section = await sectionDialog;
  expect(section.type()).toBe("beforeunload");
  await section.dismiss();
  await click;
  await expect(polling).toHaveValue("1.5");
  await page.screenshot({ path: `test-results/review-assets/settings-panel/${mode}-retained-installation-draft.png` });
  await page.getByRole("button", { name: "Discard section draft" }).click();
  await diagnostics.click();
  await expect(page).toHaveURL(/section=diagnostics/);
  expect(fixture.patches()).toBe(0);
});
test(`${mode} exposes all 42 fields with dependencies and reset preview`, async ({ page }) => {
  await api(page); let count = 0;
  for (const section of ["characters", "sharing", "performance", "diagnostics"]) {
    await page.goto(`${base}/app/settings?section=${section}`); await expect(page.getByRole("button", { name: "Preview safe defaults" })).toBeVisible();
    count += await page.locator(".settings-field").count();
    if (section === "sharing") await expect(page.getByText("Permitted: 1 byte – 20 GiB.", { exact: true })).toBeVisible();
    if (section === "sharing") { await expect(page.getByRole("checkbox", { name: "System Archive", exact: true })).toBeDisabled(); await expect(page.getByText("Blocked by deployment policy.", { exact: false }).first()).toBeVisible(); await page.screenshot({ path: `test-results/review-assets/settings-panel/${mode}-sharing-desktop.png`, fullPage: true }); }
  }
  expect(count).toBe(42);
  await page.getByRole("button", { name: "Preview safe defaults" }).click(); await expect(page.getByRole("heading", { name: "Preview safe seeded defaults" })).toBeVisible();
});
test(`${mode} conflict keeps draft, operator logout clears it and key is cleared`, async ({ page }) => {
  await api(page, { locked: true, conflict: true });
  await page.goto(`${base}/app/settings?section=diagnostics`);
  await page.getByLabel("Operator management key").fill("fixture-key");
  await page.getByRole("button", { name: "Unlock installation settings" }).click();
  await expect(page.getByText("Application version: test-build")).toBeVisible();
  await page.getByLabel("Log level", { exact: true }).selectOption("debug");
  await page.getByLabel("Reason for this change").fill("Diagnostics review"); await page.getByRole("button", { name: "Save section", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Your draft is retained"); await expect(page.getByLabel("Log level", { exact: true })).toHaveValue("debug");
  await page.getByRole("button", { name: "Lock installation settings", exact: true }).click();
  await expect(page.getByLabel("Operator management key")).toHaveValue(""); await expect(page.getByLabel("Log level", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain("fixture-key");
});
test(`${mode} foreign campaign route cannot create an editor and blocked storage works`, async ({ page }) => {
  await api(page);
  await page.addInitScript(() => { Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); } }); });
  await page.goto(`${base}/app/settings?section=campaign&campaignId=99999999-9999-4999-8999-999999999999`);
  await expect(page.getByText("This campaign is unavailable to your account.", { exact: false })).toBeVisible(); await expect(page.getByRole("link", { name: "Open campaign editor" })).toHaveCount(0);
  await page.goto(`${base}/app/settings?section=providers`); await expect(page.getByRole("button", { name: "New provider profile" })).toBeVisible();
  await expect(page.locator('.settings-content input[type="password"]')).toBeHidden();
});

test(`${mode} retention accepts arbitrary whole seconds from minute-aligned saved defaults`, async ({ page }) => {
  await api(page);
  await page.goto(`${base}/app/settings?section=sharing`);
  const preview = page.getByRole("textbox", { name: "Import preview retention", exact: true });
  const download = page.getByRole("textbox", { name: "Archive download retention", exact: true });
  await expect(preview).toHaveValue("1800");
  await preview.fill("61"); await preview.press("Tab");
  await download.fill("301"); await download.press("Tab");
  await page.getByLabel("Reason for this change").fill("Exact whole-second retention");
  await page.getByRole("button", { name: "Save section", exact: true }).click();
  await page.getByRole("button", { name: "Confirm staged Save" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved — restart required");
  await expect(page.locator(".settings-field").filter({ has: preview }).locator(".settings-comparison")).toContainText("Saved: 61 seconds");
  await expect(page.locator(".settings-field").filter({ has: download }).locator(".settings-comparison")).toContainText("Saved: 301 seconds");
  await page.screenshot({ path: `test-results/review-assets/settings-panel/${mode}-retention-fix.png`, fullPage: true });
});
test(`${mode} identity change removes loaded campaign titles and editor links`, async ({ page }) => {
  await api(page);
  const campaignId = quietLeafApiPayloads().campaigns.campaigns[0]!.id;
  await page.goto(`${base}/app/settings?section=campaign&campaignId=${campaignId}`);
  await expect(page.getByRole("link", { name: "Open campaign editor" })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("app-identity-changed")));
  await expect(page.getByText("Your account changed. Reload Settings to continue.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open campaign editor" })).toHaveCount(0);
  await expect(page.getByText("Fixture Story", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: `test-results/review-assets/settings-panel/${mode}-identity-fix.png` });
});
test(`${mode} identity change ignores a late campaign response`, async ({ page }) => {
  await api(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requested!: () => void;
  const started = new Promise<void>(resolve => { requested = resolve; });
  await page.route("**/api/v1/campaigns", async route => {
    requested(); await gate;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(quietLeafApiPayloads().campaigns) }).catch(() => undefined);
  });
  await page.goto(`${base}/app/settings?section=campaign`); await started;
  await page.evaluate(() => window.dispatchEvent(new Event("app-identity-changed")));
  release();
  await expect(page.getByText("Your account changed. Reload Settings to continue.")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Campaign", exact: true })).toHaveCount(0);
  await expect(page.getByText("Fixture Story", { exact: true })).toHaveCount(0);
});

test(`${mode} save reason recovery preserves the draft and other validation`, async ({ page }) => {
  const fixture = await api(page);
  await page.goto(`${base}/app/settings?section=performance`);
  const polling = page.getByLabel("Queue polling interval", { exact: true });
  const capacity = page.getByLabel("Text provider capacity", { exact: true });
  const reason = page.getByLabel("Reason for this change");
  const save = page.getByRole("button", { name: "Save section", exact: true });
  const alert = page.getByRole("alert");

  await polling.fill("1.5");
  await polling.press("Tab");
  await save.click();
  await expect(alert).toContainText("Enter a reason before saving.");
  await reason.fill(" ");
  await expect(save).toBeDisabled();
  await reason.pressSequentially("Review polling");
  await expect(save).toBeEnabled();
  await expect(alert).toHaveCount(0);
  await expect(reason).toBeFocused();
  await expect(polling).toHaveValue("1.5");

  await page.locator(".settings-actions").screenshot({ path: `test-results/review-assets/settings-panel/${mode}-save-reason-recovery.png` });
  await capacity.fill("-1");
  await capacity.press("Tab");
  await reason.fill("Updated polling reason");
  await expect(alert).toContainText("Text provider capacity");
  await expect(save).toBeDisabled();
  await capacity.fill("3");
  await capacity.press("Tab");
  await save.click();
  await expect(page.getByRole("heading", { name: "Review staged policy changes" })).toBeVisible();
  expect(fixture.patches()).toBe(0);
  await page.getByRole("button", { name: "Confirm staged Save" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved — restart required");
  expect(fixture.patches()).toBe(1);
});

for (const lockCause of ["expiry", "rejected save"] as const) {
  test(`${mode} clears operator draft details after ${lockCause} and re-unlock`, async ({ page }) => {
    await api(page);
    await page.goto(`${base}/app/settings?section=performance`);
    const reason = page.getByLabel("Reason for this change");
    const polling = page.getByLabel("Queue polling interval", { exact: true });
    await polling.fill("1.5");
    await polling.press("Tab");
    await reason.fill("Previous operator's draft reason");
    await page.getByRole("button", { name: "Save section", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Review staged policy changes" })).toBeVisible();

    if (lockCause === "expiry") {
      await page.clock.setFixedTime(new Date("2099-01-01T00:00:01Z"));
    } else {
      await page.route("**/api/v1/settings/instance", route =>
        route.fulfill({ status: 401, json: { code: "settings_unlock_required" } }), { times: 1 });
      await page.getByRole("button", { name: "Confirm staged Save" }).click();
    }
    await expect(page.getByLabel("Operator management key")).toBeVisible();
    if (lockCause === "expiry") await page.clock.setFixedTime(new Date("2098-12-31T00:00:00Z"));
    await page.getByLabel("Operator management key").fill("fixture-key");
    await page.getByRole("button", { name: "Unlock installation settings" }).click();
    await expect(reason).toHaveValue("");
    await expect(page.getByRole("heading", { name: "Review staged policy changes" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save section", exact: true })).toBeDisabled();
  });
}

for (const width of [1440, 390]) {
  test(`${mode} stages both character controls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const fixture = await api(page);
    await page.goto(`${base}/app/settings?section=characters`);
    await page.getByRole("checkbox", { name: "Character presets", exact: true }).check();
    await page.getByRole("checkbox", { name: "Character context without discovery", exact: true }).check();
    await page.getByRole("textbox", { name: "Reason for this change" }).fill("Enable character options");
    await page.getByRole("button", { name: "Save section", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Saved — restart required");
    expect(fixture.patches()).toBe(1);
    expect(fixture.lastChanges()).toMatchObject({ castPresetsEnabled: true, castContextWithoutDiscoveryEnabled: true });
    await page.screenshot({ path: `test-results/review-assets/settings-panel/${mode}-character-options-${width}.png`, fullPage: true });
  });
}
