import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { quietLeafApiPayloads } from "../fixtures/quiet-leaf-payloads.js";

const PRIVATE_CANARY = "PRIVATE_PROMPT_AND_PROVIDER_ERROR_CANARY";
const generationId = "55555555-5555-4555-8555-555555555555";

function recoveryFixture() {
  const payloads = quietLeafApiPayloads();
  return {
    ...payloads,
    syncStatus: {
      ...payloads.syncStatus,
      pendingGeneration: null,
      generationRecovery: {
        id: generationId,
        status: "recoverable",
        operationKind: "append",
        replacementTurnId: null,
        expectedTurnNumber: 2,
        attempts: 2,
        errorCode: "generation_failed",
        errorMessage: "Generation could not be completed.",
        diagnostic: {
          code: "prompt_override_incompatible",
          operation: "story_generation",
          action: "update_prompt",
          field: "rules",
          scope: "campaign_context"
        },
        resultTurnId: null,
        privatePromptAndProviderError: PRIVATE_CANARY
      }
    }
  };
}

async function installRecoveryApi(page: Page) {
  const payloads = recoveryFixture();
  await page.route("**/api/v1/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const respond = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (request.method() === "GET" && path === "/api/v1/session") return respond(payloads.session);
    if (request.method() === "GET" && path === "/api/v1/campaigns") return respond(payloads.campaigns);
    if (request.method() === "GET" && path === "/api/v1/worlds") return respond(payloads.worlds);
    if (request.method() === "GET" && path === `/api/v1/campaigns/${payloads.campaignId}/sync-status`) return respond(payloads.syncStatus);
    if (request.method() === "GET" && path === `/api/v1/campaigns/${payloads.campaignId}/turns`) return respond(payloads.turns);
    if (request.method() === "GET" && path === `/api/v1/campaigns/${payloads.campaignId}/state`) return respond(payloads.runtimeState);
    if (request.method() === "GET" && path === `/api/v1/campaigns/${payloads.campaignId}/state/inspection`) return respond(payloads.runtimeState);
    if (request.method() === "GET" && path === `/api/v1/campaigns/${payloads.campaignId}/illustration-config`) return respond(payloads.illustrationConfig);
    if (request.method() === "GET" && path === `/api/v1/campaigns/${payloads.campaignId}/illustration-segments`) return respond(payloads.illustrationSegments);
    if (path === `/api/v1/generations/${generationId}/events`) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Unavailable" }) });
    return respond({ error: `Unexpected fixture request: ${request.method()} ${path}` }, 404);
  });
  return payloads;
}

test("web-next Story renders only safe recovery guidance and recovery actions", async ({ page }) => {
  const payloads = await installRecoveryApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`http://127.0.0.1:43174/app/story/${payloads.campaignId}`);

  const recovery = page.locator("[data-story-recovery]");
  await expect(recovery).toBeVisible();
  await expect(recovery).toContainText("Story generation needs attention");
  await expect(recovery).toContainText("Update the compatible prompt override and try again.");
  await expect(recovery.getByRole("button", { name: "Retry generation", exact: true })).toBeVisible();
  await expect(recovery.getByRole("button", { name: "Discard generation job", exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(PRIVATE_CANARY);
  await page.screenshot({ path: "docs/review/assets/generation-integrity-diagnostics/web-next-recovery-desktop.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "docs/review/assets/generation-integrity-diagnostics/web-next-recovery-mobile.png", fullPage: true });
});

test("legacy Story renders safe recovery guidance without private diagnostic data", async ({ page }) => {
  const payloads = await installRecoveryApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
  await page.route(`**/story/${payloads.campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`http://127.0.0.1:43173/story/${payloads.campaignId}`);

  const recovery = page.locator("#generationRecoveryPanel");
  await expect(recovery).toBeVisible();
  await expect(recovery).toContainText("Review the active prompt override, then retry the generation.");
  await expect(recovery.getByRole("button", { name: "Resume monitoring", exact: true })).toBeVisible();
  await expect(recovery.getByRole("button", { name: "Retry generation job", exact: true })).toBeVisible();
  await expect(recovery.getByRole("button", { name: "Discard generation job", exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(PRIVATE_CANARY);
  await page.screenshot({ path: "docs/review/assets/generation-integrity-diagnostics/legacy-recovery-desktop.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "docs/review/assets/generation-integrity-diagnostics/legacy-recovery-mobile.png", fullPage: true });
});

test("Prompt Library requires acknowledgement before saving a protected override", async ({ page }) => {
  let savedOverride: Record<string, unknown> | null = null;
  const template = {
    key: "story_system",
    title: "Story system",
    category: "Story Engine",
    description: "Creates safe story output.",
    effectiveSource: "shipped",
    effectiveContent: "Keep the established creative voice.",
    variables: [],
    maxLength: 16000,
    compatibility: {
      requiredShapeVersion: "story-output-v2",
      protocolIdentity: "story-protocol-fixture",
      requiredShapePreview: "{ narration, choices, currentContinuity }"
    }
  };
  await page.route("**/api/v1/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const respond = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (request.method() === "GET" && path === "/api/v1/session") return respond({ user: { id: "66666666-6666-4666-8666-666666666666", displayName: "Fixture", settings: {} }, authentication: "deferred" });
    if (request.method() === "GET" && path === "/api/v1/providers") return respond({ providers: [] });
    if (request.method() === "GET" && path === "/api/v1/worlds") return respond({ worlds: [] });
    if (request.method() === "GET" && path === "/api/v1/campaigns") return respond({ campaigns: [] });
    if (request.method() === "GET" && path === "/api/v1/prompt-library") return respond({ templates: [template] });
    if (request.method() === "PUT" && path === "/api/v1/prompt-library/overrides") {
      savedOverride = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
      return respond({ library: { templates: [{ ...template, effectiveSource: "application" }] } });
    }
    return respond({});
  });

  await page.goto("http://127.0.0.1:43173/nexus/index.html#prompt-library");
  await expect(page.getByRole("heading", { name: "Story system", exact: true })).toBeVisible();
  await expect(page.getByText("Required output shape version story-output-v2.")).toBeVisible();
  await expect(page.locator("#promptLibraryRequiredShape")).toHaveText("{ narration, choices, currentContinuity }");
  await page.getByRole("button", { name: "Save prompt", exact: true }).click();
  await expect(page.locator("#promptLibraryStatus")).toContainText("Acknowledge the required output shape");
  expect(savedOverride).toBeNull();

  await page.locator("#promptLibraryCompatibilityAcknowledgement").check();
  await page.getByRole("button", { name: "Save prompt", exact: true }).click();
  await expect.poll(() => savedOverride).not.toBeNull();
  expect(savedOverride).toMatchObject({
    key: "story_system",
    scope: "application",
    content: "Keep the established creative voice.",
    compatibilityAcknowledgement: {
      requiredShapeVersion: "story-output-v2",
      protocolIdentity: "story-protocol-fixture"
    }
  });
});
