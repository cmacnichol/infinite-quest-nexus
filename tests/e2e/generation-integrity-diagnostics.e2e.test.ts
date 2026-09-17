import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { quietLeafApiPayloads } from "../fixtures/quiet-leaf-payloads.js";

const PRIVATE_CANARY = "PRIVATE_PROMPT_AND_PROVIDER_ERROR_CANARY";
const generationId = "55555555-5555-4555-8555-555555555555";
const legacyOrigin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const webNextOrigin = `http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? "43174"}`;

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
          code: "context_evidence_omitted",
          operation: "story_generation",
          action: "adjust_context",
          protocolIdentity: "story-v14-continuity-context|story-output-v2|current-continuity-v3",
          queryVariantCount: 4,
          reasonCodes: ["recent_gap", "context_limit"],
          policyIdentity: "story-memory-v1",
          counts: { recentTurnsTarget: 3, recentTurnsIncluded: 1, optionalEvidenceOmitted: 2, worldReferencesIncluded: 4, worldReferencesOmitted: 1, excerptsComplete: 2, excerptsPartial: 1, sourceValidationFailures: 1 },
          protectedComponents: { world_canon: 12, current_state: 4, direction: 3 },
          review: { status: "uncertain", automaticRepair: "not_consumed" }
        },
        resultTurnId: null,
        privatePromptAndProviderError: PRIVATE_CANARY
      }
    }
  };
}

async function installRecoveryApi(page: Page, options: { operation?: "append" | "replace_latest"; incompatible?: boolean; legacyDiagnostic?: boolean; diagnostic?: unknown; streamLoss?: boolean; profileConflict?: boolean } = {}) {
  const payloads = recoveryFixture();
  const requests: string[] = [];
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  const recovery = payloads.syncStatus.generationRecovery as any;
  recovery.operationKind = options.operation ?? "append";
  recovery.replacementTurnId = options.operation === "replace_latest" ? payloads.turns.turns[0]!.id : null;
  if (options.incompatible) recovery.diagnostic = { code: "prompt_protocol_upgrade_required", operation: "story_generation", action: "discard_and_reenqueue" };
  if (options.legacyDiagnostic) delete recovery.diagnostic;
  if (options.diagnostic) recovery.diagnostic = options.diagnostic;
  const snapshot = { ...recovery, campaignId: payloads.campaignId, action: "Preserve the unsent scene.", requestedInputMode: "scene", resolvedInputMode: "scene", inputModeSource: "explicit", partialNarration: "" };
  const characterProfile = {
    campaignId: payloads.campaignId,
    characterId: "mira-vale",
    revision: 4,
    name: "Mira Vale",
    profile: { story: { role: "Harbor scout", keyRelationships: "Trusts the lighthouse keeper." } },
    storedProfile: null as Record<string, unknown> | null,
    inheritedFromSnapshot: true,
    legacyCharacterText: "",
    rpgStats: [],
    defaultTriggers: []
  };
  let discarded = false;
  let profileSaveAttempts = 0;
  await page.route("**/api/v1/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requests.push(`${request.method()} ${path}`);
    const respond = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (request.method() === "GET" && path === "/api/v1/session") return respond(payloads.session);
    if (request.method() === "GET" && path === "/api/v1/campaigns") return respond(payloads.campaigns);
    if (request.method() === "GET" && path === "/api/v1/worlds") return respond(payloads.worlds);
    if (request.method() === "GET" && path === `/api/v1/campaigns/${payloads.campaignId}/sync-status`) return respond({ ...payloads.syncStatus, generationRecovery: discarded ? null : { ...recovery, attempts: snapshot.attempts } });
    if (request.method() === "GET" && path === `/api/v1/campaigns/${payloads.campaignId}/turns`) return respond(payloads.turns);
    if (path === `/api/v1/campaigns/${payloads.campaignId}/state`) {
      if (request.method() === "PATCH") {
        const body = request.postDataJSON(); writes.push({ path, body });
        if (!discarded || body.expectedRevision !== payloads.runtimeState.revision) return respond({ error: "Current state is locked or changed.", code: "invalid_transition" }, 409);
        Object.assign(payloads.runtimeState, body, { revision: payloads.runtimeState.revision + 1 });
      }
      return respond(payloads.runtimeState);
    }
    if (path === `/api/v1/campaigns/${payloads.campaignId}/character-profile`) {
      if (request.method() === "PUT") {
        const body = request.postDataJSON() as Record<string, unknown>;
        writes.push({ path, body });
        profileSaveAttempts += 1;
        if (!discarded || body.expectedRevision !== characterProfile.revision || (options.profileConflict && profileSaveAttempts === 1)) {
          return respond({ error: "Character profile is locked or changed.", code: "invalid_transition" }, 409);
        }
        characterProfile.revision += 1;
        characterProfile.name = String(body.name);
        characterProfile.profile = body.profile as typeof characterProfile.profile;
        characterProfile.storedProfile = { name: characterProfile.name, profile: characterProfile.profile };
        characterProfile.inheritedFromSnapshot = false;
        const { campaignId, revision, name, profile } = characterProfile;
        return respond({ campaignId, revision, name, profile });
      }
      return respond(characterProfile);
    }
    if (request.method() === "POST" && path === `/api/v1/campaigns/${payloads.campaignId}/generations`) {
      writes.push({ path, body: request.postDataJSON() });
      return respond({ id: "77777777-7777-4777-8777-777777777777", status: "queued", duplicate: false, operationKind: "append", replacementTurnId: null }, 202);
    }
    if (path.includes("77777777-7777-4777-8777-777777777777")) return respond({ ...snapshot, id: "77777777-7777-4777-8777-777777777777", status: "recoverable" });
    if (request.method() === "GET" && path === `/api/v1/campaigns/${payloads.campaignId}/state/inspection`) return respond(payloads.runtimeState);
    if (request.method() === "GET" && path === `/api/v1/campaigns/${payloads.campaignId}/illustration-config`) return respond(payloads.illustrationConfig);
    if (request.method() === "GET" && path === `/api/v1/campaigns/${payloads.campaignId}/illustration-segments`) return respond(payloads.illustrationSegments);
    if (request.method() === "GET" && path === `/api/v1/generation-jobs/${generationId}`) return respond(snapshot);
    if (path === `/api/v1/generation-jobs/${generationId}/stream` && options.streamLoss) return route.abort("failed");
    if (path === `/api/v1/generation-jobs/${generationId}/stream`) return route.fulfill({ status: 200, contentType: "text/event-stream", body: `data: ${JSON.stringify(snapshot)}\n\n` });
    if (request.method() === "POST" && path === `/api/v1/generation-jobs/${generationId}/retry`) {
      if (options.incompatible) return respond({ error: "conflict", reason: "retry_protocol_incompatible" }, 409);
      snapshot.attempts += 1;
      return respond({ id: generationId, operationKind: recovery.operationKind, replacementTurnId: recovery.replacementTurnId, status: recovery.operationKind === "append" ? "queued" : "replacement_queued" }, 202);
    }
    if (request.method() === "POST" && path === `/api/v1/generation-jobs/${generationId}/discard`) {
      discarded = true;
      return respond({ id: generationId, status: "discarded", operationKind: recovery.operationKind, replacementTurnId: recovery.replacementTurnId });
    }
    return respond({ error: `Unexpected fixture request: ${request.method()} ${path}` }, 404);
  });
  return { ...payloads, requests, writes };
}

test("web-next Story renders only safe recovery guidance and recovery actions", async ({ page }) => {
  const payloads = await installRecoveryApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${webNextOrigin}/app/story/${payloads.campaignId}`);

  const recovery = page.locator("[data-story-recovery]");
  await expect(recovery).toBeVisible();
  await expect(recovery).toContainText("Story generation needs attention");
  await expect(recovery).toContainText("Some optional story evidence was omitted to fit the current context.");
  await expect(recovery).toContainText("Recent turns: 1 of 3 included.");
  await expect(recovery).toContainText("World references: 4 included, 1 omitted.");
  await expect(recovery).toContainText("Historical excerpts: 2 complete, 1 limited.");
  await expect(recovery).toContainText("Protected context estimates: world canon 12, current state 4, direction 3.");
  await expect(recovery).toContainText("Continuity review is uncertain; it was not a full-history pass.");
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
  await page.goto(`${legacyOrigin}/story/${payloads.campaignId}`);

  const recovery = page.locator("#generationRecoveryPanel");
  await expect(recovery).toBeVisible();
  await expect(recovery).toContainText("Review the campaign context settings, then retry the generation.");
  await expect(recovery).toContainText("Recent turns: 1 of 3 included.");
  await expect(recovery).toContainText("World references: 4 included, 1 omitted.");
  await expect(recovery).toContainText("Protected context estimates: world canon 12, current state 4, direction 3.");
  await expect(recovery).toContainText("Continuity review is uncertain; it was not a full-history pass.");
  await expect(recovery.getByRole("button", { name: "Keep this turn", exact: true })).toBeHidden();
  await expect(recovery.getByRole("button", { name: "Resume monitoring", exact: true })).toBeVisible();
  await expect(recovery.getByRole("button", { name: "Retry generation job", exact: true })).toBeVisible();
  await expect(recovery.getByRole("button", { name: "Discard generation job", exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(PRIVATE_CANARY);
  await page.screenshot({ path: "docs/review/assets/generation-integrity-diagnostics/legacy-recovery-desktop.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "docs/review/assets/generation-integrity-diagnostics/legacy-recovery-mobile.png", fullPage: true });
});

for (const scope of ["application", "campaign"] as const) test(`Prompt Library requires ${scope} acknowledgement before saving a protected override`, async ({ page }) => {
  const campaign = quietLeafApiPayloads();
  const enrolledProtocol = "story-v14-continuity-context|story-output-v2|current-continuity-v3";
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
    if (request.method() === "GET" && path === "/api/v1/campaigns") return respond(campaign.campaigns);
    if (request.method() === "GET" && path === "/api/v1/prompt-library") return respond({ templates: [{ ...template, compatibility: { ...template.compatibility, protocolIdentity: new URL(request.url()).searchParams.has("campaignId") ? enrolledProtocol : template.compatibility.protocolIdentity } }] });
    if (request.method() === "PUT" && path === "/api/v1/prompt-library/overrides") {
      savedOverride = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
      return respond({ library: { templates: [{ ...template, effectiveSource: "application" }] } });
    }
    return respond({});
  });

  await page.goto(`${legacyOrigin}/nexus/index.html#prompt-library`);
  await expect(page.getByRole("heading", { name: "Story system", exact: true })).toBeVisible();
  await expect(page.getByText("Required output shape version story-output-v2.")).toBeVisible();
  await expect(page.locator("#promptLibraryRequiredShape")).toHaveText("{ narration, choices, currentContinuity }");
  if (scope === "campaign") {
    await page.locator("#promptLibraryCompatibilityAcknowledgement").check();
    await page.locator("#promptLibraryScope").selectOption("campaign");
    await page.locator("#promptLibraryCampaign").selectOption(campaign.campaignId);
    await expect(page.locator("#promptLibraryCompatibilityAcknowledgement")).not.toBeChecked();
  }
  await page.getByRole("button", { name: "Save prompt", exact: true }).click();
  await expect(page.locator("#promptLibraryStatus")).toContainText("Acknowledge the required output shape");
  expect(savedOverride).toBeNull();

  await page.locator("#promptLibraryCompatibilityAcknowledgement").check();
  await page.getByRole("button", { name: "Save prompt", exact: true }).click();
  await expect.poll(() => savedOverride).not.toBeNull();
  expect(savedOverride).toMatchObject({
    key: "story_system",
    scope,
    ...(scope === "campaign" ? { campaignId: campaign.campaignId } : {}),
    content: "Keep the established creative voice.",
    compatibilityAcknowledgement: {
      requiredShapeVersion: "story-output-v2",
      protocolIdentity: scope === "campaign" ? enrolledProtocol : "story-protocol-fixture"
    }
  });
});

for (const surface of ["legacy", "web-next"] as const) {
  for (const operation of ["append", "replace_latest"] as const) {
    test(`${surface} ${operation} recovery retries and discards without losing the local draft`, async ({ page }) => {
      const payloads = await installRecoveryApi(page, { operation });
      if (surface === "legacy") {
        const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
        await page.route(`**/story/${payloads.campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
      }
      await page.goto(surface === "legacy" ? `${legacyOrigin}/story/${payloads.campaignId}` : `${webNextOrigin}/app/story/${payloads.campaignId}`);
      const recovery = page.locator(surface === "legacy" ? "#generationRecoveryPanel" : "[data-story-recovery]");
      await expect(recovery).toBeVisible();
      const draft = page.locator(surface === "legacy" ? "#freeAction" : "[data-story-draft]");
      await draft.fill("Keep this unsent scene while I repair the profile.");
      await expect(draft).toHaveValue("Keep this unsent scene while I repair the profile.");
      const retry = recovery.getByRole("button", { name: surface === "legacy" ? "Retry generation job" : "Retry generation", exact: true });
      await expect(retry).toBeEnabled();
      await retry.click();
      await expect.poll(() => payloads.requests.filter((request) => request.endsWith(`/${generationId}/retry`)).length).toBe(1);
      await expect(recovery).toBeVisible();
      await expect(draft).toHaveValue("Keep this unsent scene while I repair the profile.");
      await recovery.getByRole("button", { name: "Discard generation job", exact: true }).click();
      await expect.poll(() => payloads.requests.filter((request) => request.endsWith(`/${generationId}/discard`)).length).toBe(1);
      await expect(draft).toHaveValue("Keep this unsent scene while I repair the profile.");
      await expect(recovery).toBeHidden();
      await page.reload();
      await expect(recovery).toBeHidden();
    });
  }
  test(`${surface} incompatible saved protocol exposes discard and never retry`, async ({ page }) => {
    const payloads = await installRecoveryApi(page, { incompatible: true });
    if (surface === "legacy") {
      const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
      await page.route(`**/story/${payloads.campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
    }
    await page.goto(surface === "legacy" ? `${legacyOrigin}/story/${payloads.campaignId}` : `${webNextOrigin}/app/story/${payloads.campaignId}`);
    const recovery = page.locator(surface === "legacy" ? "#generationRecoveryPanel" : "[data-story-recovery]");
    await expect(recovery).toContainText("Discard this generation and submit the turn again.");
    await expect(recovery.getByRole("button", { name: /^Retry generation/ })).toBeHidden();
    await recovery.getByRole("button", { name: "Discard generation job", exact: true }).click();
    await expect.poll(() => payloads.requests.some((request) => request.endsWith(`/${generationId}/discard`))).toBe(true);
    expect(payloads.requests.some((request) => request.endsWith(`/${generationId}/retry`))).toBe(false);
  });
}

for (const surface of ["legacy", "web-next"] as const) {
  for (const status of ["off", "observed", "passed", "conflict", "uncertain", "unavailable", "old", "unknown", "profile_changed"] as const) {
    test(`${surface} recovery safely presents ${status} and preserves discard`, async ({ page }) => {
      const messages = { off: "Continuity review was off.", observed: "Continuity review was observed; it did not block this generation.", passed: "Continuity review passed for the supplied scope only.", conflict: "Continuity review found a conflict in the supplied scope.", uncertain: "Continuity review is uncertain; it was not a full-history pass.", unavailable: "Continuity review was unavailable; no pass was recorded." };
      const diagnostic = status === "unknown" ? { code: "future_unknown_code", action: "retry", private: PRIVATE_CANARY }
        : status === "profile_changed" ? { code: "authoritative_context_invalid", operation: "story_generation", action: "repair_authority" }
        : status === "old" ? undefined : { code: "context_evidence_omitted", operation: "story_generation", action: "adjust_context", review: { status, automaticRepair: status === "conflict" ? "consumed" : "not_consumed" } };
      const payloads = await installRecoveryApi(page, { legacyDiagnostic: status === "old", diagnostic });
      const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
      if (surface === "legacy") {
        const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
        await page.route(`**/story/${payloads.campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
      }
      await page.goto(surface === "legacy" ? `${legacyOrigin}/story/${payloads.campaignId}` : `${webNextOrigin}/app/story/${payloads.campaignId}`);
      const recovery = page.locator(surface === "legacy" ? "#generationRecoveryPanel" : "[data-story-recovery]");
      await expect(recovery).toBeVisible();
      if (status in messages) await expect(recovery).toContainText(messages[status as keyof typeof messages]);
      if (status === "conflict") await expect(recovery).toContainText("The one automatic repair attempt was already used.");
      if (status === "profile_changed") { await expect(recovery).toContainText("correct the campaign state or character profile"); await expect(recovery.getByRole("button", { name: /^Retry generation/ })).toBeHidden(); }
      await expect(page.locator("body")).not.toContainText(PRIVATE_CANARY);
      await expect(page.locator("vite-error-overlay")).toHaveCount(0);
      const discard = recovery.getByRole("button", { name: "Discard generation job", exact: true });
      await discard.focus(); await expect(discard).toBeFocused();
      for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport);
        await page.screenshot({ path: `docs/review/assets/generation-integrity-diagnostics/${surface}-${status}-${viewport.width}.png`, fullPage: true });
      }
      await discard.click();
      await expect.poll(() => payloads.requests.some((request) => request.endsWith(`/${generationId}/discard`))).toBe(true);
      await expect(recovery).toBeHidden(); expect(errors).toEqual([]);
    });
  }
}

for (const surface of ["legacy", "web-next"] as const) for (const operation of ["append", "replace_latest"] as const) {
  test(`${surface} ${operation} discards stale authority, saves revision-checked state, and submits retained intent`, async ({ page }) => {
    const api = await installRecoveryApi(page, { operation, diagnostic: { code: "authoritative_context_invalid", operation: "story_generation", action: "repair_authority" } });
    if (surface === "legacy") {
      const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
      await page.route(`${legacyOrigin}/story/${api.campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
    }
    await page.goto(surface === "legacy" ? `${legacyOrigin}/story/${api.campaignId}` : `${webNextOrigin}/app/story/${api.campaignId}`);
    const recovery = page.locator(surface === "legacy" ? "#generationRecoveryPanel" : "[data-story-recovery]");
    await expect(recovery).toBeVisible();
    if (surface === "web-next") await expect(page.locator("[data-page=story-player]")).toHaveAttribute("aria-busy", "false");
    const draft = page.locator(surface === "legacy" ? "#freeAction" : "[data-story-draft]");
    await draft.fill("Remember the corrected harbor before continuing.");
    await expect(draft).toHaveValue("Remember the corrected harbor before continuing.");
    if (surface === "legacy") await page.getByRole("button", { name: "Setup", exact: true }).click();
    else await page.getByText("Campaign Tools", { exact: true }).click();
    const edit = page.locator(surface === "legacy" ? "#btnOpenEditState" : "[data-tool-action=edit-campaign-state]");
    await expect(edit).toBeDisabled();
    await recovery.getByRole("button", { name: "Discard generation job", exact: true }).click();
    await expect(recovery).toBeHidden();
    await expect(draft).toHaveValue("Remember the corrected harbor before continuing.");
    await expect(edit).toBeEnabled();
    if (!await edit.isVisible()) {
      if (surface === "legacy") await page.getByRole("button", { name: "Setup", exact: true }).click();
      else await page.locator("[data-campaign-tools] summary").click();
    }
    await edit.click();
    await expect(draft).toHaveValue("Remember the corrected harbor before continuing.");
    await page.locator(surface === "legacy" ? "#editStateContinuitySummary" : "[data-continuity-summary]").fill("The harbor authority is corrected.");
    await expect(draft).toHaveValue("Remember the corrected harbor before continuing.");
    await page.locator(surface === "legacy" ? "#btnSaveEditState" : "[data-action=save-current-state]").click();
    await expect.poll(() => api.writes.filter(write => write.path.endsWith("/state")).length).toBe(1);
    expect(api.writes[0]!.body).toMatchObject({ expectedTurnNumber: 1, expectedRevision: 1, effectiveTurnNumber: 1, continuitySummary: "The harbor authority is corrected." });
    await expect(draft).toHaveValue("Remember the corrected harbor before continuing.");
    await page.locator(surface === "legacy" ? "#btnTakeAction" : "[data-action=continue-story]").click();
    await expect.poll(() => api.writes.filter(write => write.path.endsWith("/generations")).length).toBe(1);
    expect(api.writes.at(-1)!.body).toMatchObject({ action: "Remember the corrected harbor before continuing." });
  });
}

for (const surface of ["legacy", "web-next"] as const) for (const operation of ["append", "replace_latest"] as const) {
  test(`${surface} ${operation} discards stale authority, saves the revision-checked character profile, and submits retained intent`, async ({ page }) => {
    const api = await installRecoveryApi(page, { operation, diagnostic: { code: "authoritative_context_invalid", operation: "story_generation", action: "repair_authority" } });
    if (surface === "legacy") {
      const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
      await page.route(`${legacyOrigin}/story/${api.campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
    }
    await page.goto(surface === "legacy" ? `${legacyOrigin}/story/${api.campaignId}` : `${webNextOrigin}/app/story/${api.campaignId}`);
    const recovery = page.locator(surface === "legacy" ? "#generationRecoveryPanel" : "[data-story-recovery]");
    await expect(recovery).toBeVisible();
    const draft = page.locator(surface === "legacy" ? "#freeAction" : "[data-story-draft]");
    await draft.fill("Keep this harbor profile repair with the new turn.");
    if (surface === "legacy") await page.getByRole("button", { name: "Setup", exact: true }).click();
    else await page.getByText("Campaign Tools", { exact: true }).click();
    const edit = page.locator(surface === "legacy" ? "#btnOpenEditCharacterProfile" : "[data-tool-action=edit-character-profile]");
    await expect(edit).toBeDisabled();
    await recovery.getByRole("button", { name: "Discard generation job", exact: true }).click();
    await expect(recovery).toBeHidden();
    await expect(draft).toHaveValue("Keep this harbor profile repair with the new turn.");
    await expect(edit).toBeEnabled();
    if (!await edit.isVisible()) {
      if (surface === "legacy") await page.getByRole("button", { name: "Setup", exact: true }).click();
      else await page.locator("[data-campaign-tools] summary").click();
    }
    await edit.click();
    const name = page.locator(surface === "legacy" ? "#editCharacterProfileName" : "[data-story-tool-dialog] [data-character-profile-name]");
    const profile = page.locator(surface === "legacy" ? "#editCharacterProfileJson" : "[data-story-tool-dialog] [data-character-profile-json]");
    await expect(name).toHaveValue("Mira Vale");
    if (operation === "append") {
      for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport);
        await page.screenshot({ path: `docs/review/assets/generation-integrity-diagnostics/${surface}-profile-recovery-editor-${viewport.width}.png`, fullPage: true });
      }
    }
    await expect(draft).toHaveValue("Keep this harbor profile repair with the new turn.");
    await name.fill("Mira Vale, Harbor Warden");
    await profile.fill(JSON.stringify({ story: { role: "Harbor warden", keyRelationships: "Trusts the lighthouse keeper with the signal key." } }));
    await page.locator(surface === "legacy" ? "#btnSaveEditCharacterProfile" : "[data-action=save-character-profile]").click();
    await expect.poll(() => api.writes.filter(write => write.path.endsWith("/character-profile")).length).toBe(1);
    expect(api.writes.find(write => write.path.endsWith("/character-profile"))!.body).toMatchObject({
      expectedRevision: 4,
      name: "Mira Vale, Harbor Warden",
      profile: { story: { role: "Harbor warden", keyRelationships: "Trusts the lighthouse keeper with the signal key." } },
      editSource: "manual"
    });
    await expect(draft).toHaveValue("Keep this harbor profile repair with the new turn.");
    await page.locator(surface === "legacy" ? "#btnTakeAction" : "[data-action=continue-story]").click();
    await expect.poll(() => api.writes.filter(write => write.path.endsWith("/generations")).length).toBe(1);
    expect(api.writes.at(-1)!.body).toMatchObject({ action: "Keep this harbor profile repair with the new turn." });
  });
}

for (const surface of ["legacy", "web-next"] as const) {
  test(`${surface} preserves the character profile form and story draft through a revision conflict retry`, async ({ page }) => {
    const api = await installRecoveryApi(page, {
      diagnostic: { code: "authoritative_context_invalid", operation: "story_generation", action: "repair_authority" },
      profileConflict: true
    });
    if (surface === "legacy") {
      const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
      await page.route(`${legacyOrigin}/story/${api.campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
    }
    await page.goto(surface === "legacy" ? `${legacyOrigin}/story/${api.campaignId}` : `${webNextOrigin}/app/story/${api.campaignId}`);
    const recovery = page.locator(surface === "legacy" ? "#generationRecoveryPanel" : "[data-story-recovery]");
    await expect(recovery).toBeVisible();
    const draft = page.locator(surface === "legacy" ? "#freeAction" : "[data-story-draft]");
    await draft.fill("Keep this draft while the profile conflict is repaired.");
    await recovery.getByRole("button", { name: "Discard generation job", exact: true }).click();
    if (surface === "legacy") await page.getByRole("button", { name: "Setup", exact: true }).click();
    else await page.getByText("Campaign Tools", { exact: true }).click();
    await page.locator(surface === "legacy" ? "#btnOpenEditCharacterProfile" : "[data-tool-action=edit-character-profile]").click();
    const name = page.locator(surface === "legacy" ? "#editCharacterProfileName" : "[data-story-tool-dialog] [data-character-profile-name]");
    const profile = page.locator(surface === "legacy" ? "#editCharacterProfileJson" : "[data-story-tool-dialog] [data-character-profile-json]");
    await expect(name).toHaveValue("Mira Vale");
    await name.fill("Mira Vale, Signal Keeper");
    const revisedProfile = { story: { role: "Signal keeper", keyRelationships: "Keeps the beacon ledger with Nia." } };
    await profile.fill(JSON.stringify(revisedProfile));
    const save = page.locator(surface === "legacy" ? "#btnSaveEditCharacterProfile" : "[data-action=save-character-profile]");
    await save.click();
    await expect.poll(() => api.writes.filter(write => write.path.endsWith("/character-profile")).length).toBe(1);
    const status = page.locator(surface === "legacy" ? "#editCharacterProfileStatus" : "[data-story-tool-dialog] p.story-status[data-story-status]:not([role])");
    await expect(status).toContainText(surface === "legacy" ? "changed" : "changed elsewhere");
    await expect(name).toHaveValue("Mira Vale, Signal Keeper");
    await expect(profile).toHaveValue(JSON.stringify(revisedProfile));
    await expect(draft).toHaveValue("Keep this draft while the profile conflict is repaired.");
    await save.click();
    await expect.poll(() => api.writes.filter(write => write.path.endsWith("/character-profile")).length).toBe(2);
    for (const write of api.writes.filter(write => write.path.endsWith("/character-profile"))) {
      expect(write.body).toMatchObject({ expectedRevision: 4, name: "Mira Vale, Signal Keeper", profile: revisedProfile, editSource: "manual" });
    }
    await expect(draft).toHaveValue("Keep this draft while the profile conflict is repaired.");
  });
}

test("stream loss falls back to polling and the same recovery survives an interface handoff", async ({ page }) => {
  const api = await installRecoveryApi(page, { streamLoss: true });
  const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
  await page.route(`${legacyOrigin}/story/${api.campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`${webNextOrigin}/app/story/${api.campaignId}`);
  await expect(page.locator("[data-page=story-player]")).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => api.requests.some(request => request.endsWith(`/${generationId}/stream`))).toBe(true);
  await expect.poll(() => api.requests.some(request => request === `GET /api/v1/generation-jobs/${generationId}`)).toBe(true);
  await expect(page.locator("[data-story-recovery]")).toContainText("Continuity review is uncertain");
  await page.goto(`${legacyOrigin}/story/${api.campaignId}`);
  await expect(page.locator("#generationRecoveryPanel")).toContainText("Continuity review is uncertain");
  await expect(page.locator("#freeAction")).toBeEnabled();
  await page.locator("#freeAction").fill("Keep the handoff draft.");
  await page.locator("#generationRecoveryPanel").getByRole("button", { name: "Discard generation job", exact: true }).click();
  await expect.poll(() => api.requests.some((request) => request.endsWith(`/${generationId}/discard`))).toBe(true);
  await expect(page.locator("#freeAction")).toHaveValue("Keep the handoff draft.");
  await page.goto(`${webNextOrigin}/app/story/${api.campaignId}`);
  await expect(page.locator("[data-story-recovery]")).toBeHidden();
});
