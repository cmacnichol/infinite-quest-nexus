import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  if (mode === "protected") assert.equal(await page.getByRole("button", { name: "Apply saved settings and restart" }).count(), 0);
  if (mode === "local") {
    const project = process.env.SETTINGS_PROOF_PROJECT;
    assert.ok(project);
    const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
    const db = sql => docker("exec", `${project}-postgres-1`, "psql", "-U", "infinitequest", "-d", "infinitequest", "-At", "-c", sql);
    const provider = endpoint => JSON.parse(docker("exec", `${project}-provider`, "node", "-e", `fetch('http://127.0.0.1:9090/${endpoint}').then(r=>r.text()).then(t=>process.stdout.write(t))`));
    const until = async (predicate, label) => {
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) { try { const result = await predicate(); if (result) return result; } catch {} await new Promise(done => setTimeout(done, 300)); }
      throw new Error(`Timed out: ${label}`);
    };
    const input = { name: "Disposable proof", providerType: "openai_compatible", providerRole: "text", baseUrl: "http://proof-provider:9090/v1", defaultModel: "proof-model", requestTimeoutMs: 180000 };
    await page.evaluate(input => { window.proofRequest = fetch('/api/v1/providers/discover-models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }).then(async r => ({ status: r.status, body: await r.json() })).catch(e => ({ error: String(e) })); }, input);
    await until(() => provider("status").held && db("select count(*) from api_admission_leases where operation='provider' and request_running") === "1", "held provider with persisted lease");
    const app = `${project}-infinitequest-app-1`;
    const restartCount = Number(docker("inspect", "--format", "{{.RestartCount}}", app));
    const accepted = page.waitForResponse(response => response.url().endsWith("/api/v1/settings/instance/restart") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Apply saved settings and restart" }).click();
    assert.ok((await accepted).ok(), "restart request accepted");
    await until(async () => {
      const response = await fetch(`${base}/api/v1/providers/discover-models`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      const body = await response.json();
      if (response.status === 503 && /drain|restart/i.test(JSON.stringify(body))) return body;
      if (response.status === 429) throw new Error("New request hit a rate limit rather than drain");
      return false;
    }, "new work rejected during drain");
    assert.equal(db("select active_revision from instance_settings_state"), before.activeRevision);
    assert.equal(db("select count(*) from api_admission_leases where operation='provider' and request_running"), "1");
    assert.equal(provider("status").cancelled, false);
    await page.getByText(/Waiting for active work to finish/).waitFor();
    await page.screenshot({ path: resolve(output, "local-settings-draining.png"), fullPage: true });
    docker("exec", `${project}-provider`, "node", "-e", "fetch('http://127.0.0.1:9090/release').then(r=>r.text()).then(t=>process.stdout.write(t))");
    const held = await page.evaluate(() => window.proofRequest);
    assert.equal(held.status, 200, JSON.stringify(held));
    assert.equal(provider("status").cancelled, false);
    await until(() => Number(docker("inspect", "--format", "{{.RestartCount}}", app)) > restartCount, "container restarted");
    await until(async () => { const response = await fetch(`${base}/health/ready`); return response.ok; }, "restarted readiness");
    await until(async () => { try { return await page.evaluate(async revision => { const r = await fetch('/api/v1/settings/instance'); return r.ok && (await r.json()).activeRevision === revision; }, after.requestedRevision); } catch { return false; } }, "same browser sees exact revision");
    await page.getByText(`Saved revision ${after.requestedRevision} is active and ready.`).waitFor({ timeout: 120000 });
    await page.screenshot({ path: resolve(output, "local-settings-reconnected.png"), fullPage: true });
    process.stdout.write(`${JSON.stringify({ mode: "local-drain-restart", oldRevision: before.activeRevision, activeRevision: after.requestedRevision, heldStatus: held.status, restartCountBefore: restartCount, restartCountAfter: Number(docker("inspect", "--format", "{{.RestartCount}}", app)) })}\n`);
  }
  assert.deepEqual(errors, []);
  process.stdout.write(`${JSON.stringify({ mode, beforeRevision: before.requestedRevision, requestedRevision: after.requestedRevision, desired, crossOriginStatus: crossOrigin.status(), pageErrors: errors })}\n`);
} finally {
  await browser.close();
}
