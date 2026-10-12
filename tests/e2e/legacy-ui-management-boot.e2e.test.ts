import { expect, test } from "@playwright/test";
import { installLegacyUiFixture, legacyUiFixture } from "./helpers/legacy-ui-fixtures.js";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;

test("management controls wait for the canonical controller before accepting native input", async ({ page }, testInfo) => {
  await installLegacyUiFixture(page, legacyUiFixture());
  let releaseController = () => {};
  const controllerGate = new Promise<void>((resolveGate) => { releaseController = resolveGate; });
  let controllerHeld = false;
  const requestedModules: string[] = [];
  page.on("request", (request) => { requestedModules.push(request.url()); });
  await page.route((url) => url.pathname === "/nexus/nexus.js", async (route) => {
    controllerHeld = true;
    await controllerGate;
    await route.continue();
  });
  try {
    await page.goto(`${origin}/nexus/index.html#providers`);
    await expect.poll(() => controllerHeld).toBe(true);
    await expect(page.locator("#managementBootStatus")).toContainText("Loading management controls");
    await expect(page.getByRole("button", { name: "Reload page", exact: true })).toBeHidden();
    await expect(page.locator("#managementInteractiveRoot")).toHaveAttribute("inert", "");
    const setup = page.locator("#navSetup");
    const rectangle = await setup.boundingBox();
    expect(rectangle).not.toBeNull();
    if (!rectangle) throw new Error("The native Setup target must have a rectangle.");
    await page.mouse.click(rectangle.x + rectangle.width / 2, rectangle.y + rectangle.height / 2);
    await expect(page.locator("#nexusSetupMenu")).toBeHidden();
    const dashboardLink = page.locator("#navDashboard");
    const linkRectangle = await dashboardLink.boundingBox();
    expect(linkRectangle).not.toBeNull();
    if (!linkRectangle) throw new Error("The native Dashboard link must have a rectangle.");
    await page.mouse.click(linkRectangle.x + linkRectangle.width / 2, linkRectangle.y + linkRectangle.height / 2);
    await expect(page).toHaveURL(`${origin}/nexus/index.html#providers`);
    await page.keyboard.press("Tab");
    expect(await page.locator("#managementInteractiveRoot").evaluate((root) => root.contains(document.activeElement))).toBe(false);
    await page.screenshot({ path: testInfo.outputPath("management-controller-loading.png"), fullPage: false });

    releaseController();
    await expect(page.locator("#managementInteractiveRoot")).not.toHaveAttribute("inert", "");
    await expect(page.locator("#managementBootStatus")).toBeHidden();
    await dashboardLink.click();
    await expect(page).toHaveURL(`${origin}/nexus/index.html#dashboard`);
    await setup.click();
    await page.locator("#navProviders").click();
    await page.getByRole("button", { name: "New provider profile" }).click();
    await expect(page.locator("#providerDialog")).toBeVisible();
    expect(requestedModules.filter((url) => /image-library-browser\.js(?:[?#]|$)/u.test(url))).toHaveLength(0);
    await page.screenshot({ path: testInfo.outputPath("management-controller-ready-provider.png"), fullPage: false });
  } finally {
    releaseController();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("failed controller import leaves a safe reachable reload action", async ({ page }, testInfo) => {
  await installLegacyUiFixture(page, legacyUiFixture());
  let rejectController = true;
  let controllerRequests = 0;
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => { pageErrors.push(error.message); });
  await page.route((url) => url.pathname === "/nexus/nexus.js", async (route) => {
    controllerRequests += 1;
    if (rejectController) await route.abort("failed");
    else await route.continue();
  });
  try {
    await page.goto(`${origin}/nexus/index.html#providers`);
    await expect(page.locator("#managementBootStatus")).toContainText("Management controls could not load");
    await expect(page.locator("#managementInteractiveRoot")).toHaveAttribute("inert", "");
    await expect(page.locator("#managementInteractiveRoot")).toHaveAttribute("aria-busy", "false");
    const reload = page.getByRole("button", { name: "Reload page", exact: true });
    await expect(reload).toBeVisible();
    for (let step = 0; step < 3; step += 1) {
      await page.keyboard.press("Tab");
      expect(await page.locator("#managementInteractiveRoot").evaluate((root) => root.contains(document.activeElement))).toBe(false);
      if (await reload.evaluate((button) => button === document.activeElement)) break;
    }
    await expect(reload).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("management-controller-safe-failure.png"), fullPage: false });

    rejectController = false;
    await reload.press("Enter");
    await expect.poll(() => controllerRequests).toBe(2);
    await expect(page.locator("#managementInteractiveRoot")).not.toHaveAttribute("inert", "");
    await expect(page.locator("#managementBootStatus")).toBeHidden();
    await page.getByRole("button", { name: "New provider profile" }).click();
    await expect(page.locator("#providerDialog")).toBeVisible();
    expect(pageErrors).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: "wait" });
  }
});