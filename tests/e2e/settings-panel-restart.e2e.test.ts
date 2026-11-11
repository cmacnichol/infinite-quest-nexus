import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const phase = process.env.SETTINGS_RELEASE_PHASE;
test.skip(!phase, "Requires the isolated, seeded loopback-TLS Compose release fixture.");
test.use({ ignoreHTTPSErrors: true, trace: "off" });

test("checks the staged or restarted Settings revision through the packaged HTTPS interface", async ({ page, context }) => {
  if (phase !== "stage" && phase !== "active") throw new Error("Unknown Settings rehearsal phase");
  const origin = "https://127.0.0.1:45882";
  await page.goto(origin + "/app/settings?section=diagnostics");
  await page.getByLabel("Operator management key").fill((await readFile(process.env.SETTINGS_RELEASE_TEST_KEY_FILE!, "utf8")).trim());
  await page.getByRole("button", { name: "Unlock installation settings" }).click();
  const level = page.getByLabel("Log level", { exact: true });
  await expect(level).toBeVisible();
  const cookie = (await context.cookies()).find(c => c.name === "iq_settings_operator");
  expect([cookie?.httpOnly, cookie?.secure, cookie?.sameSite, cookie?.path]).toEqual([true, true, "Strict", "/api/v1/settings"]);
  await page.reload();
  await expect(level).toBeVisible();
  if (phase === "stage") {
    const rejected = await page.evaluate(async () => (await fetch("/api/v1/settings/instance", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRequestedRevision: "1", changes: { logLevel: "warn" }, reason: "Fixture missing CSRF" })
    })).status);
    expect(rejected).toBe(403);
    await level.selectOption("warn");
    await page.getByLabel("Reason for this change").fill("Rehearse log level restart");
    await page.getByRole("button", { name: "Save section", exact: true }).click();
    const confirm = page.getByRole("button", { name: "Confirm staged Save" });
    if (await confirm.isVisible()) await confirm.click();
    await expect(page.getByRole("status")).toHaveText("Saved — restart required");
  }
  const view = await page.evaluate(async () => (await fetch("/api/v1/settings/instance")).json());
  expect(view.requestedRevision).toBe("2");
  expect(view.activeRevision).toBe(phase === "stage" ? null : "2");
  expect(view.requested.logLevel).toBe("warn");
  expect(view.active.logLevel).toBe(phase === "stage" ? "info" : "warn");
  expect(view.fields).toHaveLength(43);
  await page.screenshot({ path: "test-results/review-assets/settings-panel/packaged-tls-" + phase + ".png", fullPage: true });
});
