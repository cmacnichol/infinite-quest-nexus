import { expect, test } from "@playwright/test";

test("Core runs with production CSP and no external requests", async ({ page }) => {
  const external: string[] = [];
  const consoleErrors: string[] = [];
  page.on("request", request => {
    if (!request.url().startsWith("http://127.0.0.1:43175/")) external.push(request.url());
  });
  page.on("console", message => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", event => {
      document.documentElement.dataset.cspViolation = event.violatedDirective;
    });
  });

  const response = await page.goto("/ui-test/");
  expect(response?.headers()["content-security-policy"]).toContain("style-src 'self'");

  await page.getByRole("textbox", { name: "Custom Action" }).fill("A test action");
  await expect(page.locator("wa-input")).toHaveJSProperty("value", "A test action");
  const systemIcon = page.locator("wa-icon[name='circle-question']").first();
  await expect(systemIcon).toBeVisible();
  await expect(systemIcon.locator("svg")).toBeVisible();

  await page.getByRole("button", { name: "Campaign Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Campaign Settings" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "Open activity menu" }).click();
  await page.getByText("Activity Log", { exact: true }).click();
  await expect(page.locator("output")).toHaveText("activity");
  await expect(page.locator("output")).toHaveAttribute("data-selection-count", "1");
  await page.getByRole("button", { name: "Disabled command" }).click({ force: true });
  await expect(page.locator("output")).toHaveText("activity");

  expect(await page.locator("html").getAttribute("data-csp-violation")).toBeNull();
  expect(consoleErrors).toEqual([]);
  expect(external).toEqual([]);
});
