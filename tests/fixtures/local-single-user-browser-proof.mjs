import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

// Exercise the built image and real database. Supply a disposable instance only.
const base = process.env.SETTINGS_PROOF_BASE;
const output = process.env.SETTINGS_PROOF_SCREENSHOTS;
const mode = process.env.SETTINGS_PROOF_MODE;
assert.ok(base && output && ["local", "protected"].includes(mode));
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto(`${base}/app/settings?section=diagnostics`);
  if (mode === "protected") {
    assert.ok(process.env.SETTINGS_PROOF_KEY);
    await page.getByLabel("Operator management key").fill(process.env.SETTINGS_PROOF_KEY);
    const unlock = page.waitForResponse(response => response.url().endsWith("/api/v1/settings/operator-session") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Unlock installation settings" }).click();
    const cookie = (await (await unlock).allHeaders())["set-cookie"];
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /Secure/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.ok(process.env.SETTINGS_PROOF_DIRECT_HTTP);
    assert.equal((await context.request.get(`${process.env.SETTINGS_PROOF_DIRECT_HTTP}/api/v1/settings/operator-session`)).status(), 403);
  }
  const level = page.getByLabel("Log level", { exact: true });
  await level.waitFor();
  const before = await page.evaluate(async () => (await fetch('/api/v1/settings/instance')).json());
  const desired = before.requested.logLevel === "debug" ? "info" : "debug";
  await level.selectOption(desired);
  await page.getByLabel("Reason for this change").fill("Disposable Docker verification");
  await page.getByRole("button", { name: "Save section", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Saved — restart required" }).waitFor();
  const after = await page.evaluate(async () => (await fetch('/api/v1/settings/instance')).json());
  assert.equal(after.requested.logLevel, desired);
  assert.ok(BigInt(after.requestedRevision) > BigInt(before.requestedRevision));
  await page.reload();
  await level.waitFor();
  assert.equal(await level.inputValue(), desired);
  const crossOrigin = await context.request.patch(`${base}/api/v1/settings/instance`, {
    headers: { origin: "https://attacker.invalid", "x-settings-csrf": "invalid" }, data: {}
  });
  assert.equal(crossOrigin.status(), 403);
  await page.screenshot({ path: resolve(output, `${mode}-settings-saved.png`), fullPage: true });
  assert.deepEqual(errors, []);
  process.stdout.write(`${JSON.stringify({ mode, beforeRevision: before.requestedRevision, requestedRevision: after.requestedRevision, desired, crossOriginStatus: crossOrigin.status(), pageErrors: errors })}\n`);
} finally {
  await browser.close();
}
