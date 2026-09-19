# Native OpenRouter Presets: Deferred New UI Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans only after the user requests this deferred work. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Deferred by user request. Not part of the current API and legacy UI release.

**Goal:** Add native Model/Preset selection and provider settings to the replacement UI after the backend and legacy rollout is complete.

**Architecture:** Reuse the shipped typed selection, preset discovery APIs, editor state, and runtime contracts. Add a native provider page without duplicating resolution or eligibility logic.

**Tech Stack:** Existing TypeScript DOM client, shared client packages, Vitest and Playwright.

**Spec:** [Evaluation and design](2026-09-18-native-openrouter-presets-design.md).

## Global Constraints

- Depends on completed [API and legacy implementation](2026-09-18-native-openrouter-presets.md), including its verification gate.
- Recheck the current new UI and API contracts before execution.
- Preserve credentials, profile inheritance, and nontext settings. Both selections default to Structured Outputs under the shipped API default/compatibility rules. Direct models retain capability verification; presets display trusted Structured Outputs without a capability gate. Standard-JSON fallback remains deferred unless separately implemented by then.
- This work must not block release of the API and legacy UI changes.

## Review Focus

- Native routing must mount provider settings rather than the world library or legacy editor.
- Late requests must not overwrite another profile or a disposed page.
- Existing model and preset profiles must round-trip without changing selection or overrides.
- Preset names and prompts must render as text.
- Requested preset and actual served model must remain distinct in UI diagnostics.

## Deferred Task 1: Native provider settings in the replacement UI

**Files:**
- Create `apps/web-next/src/provider-settings-{page,api}.ts`, `apps/web-next/src/provider-settings.css`, `tests/unit/web-next-provider-settings.test.ts`, `tests/e2e/web-next-provider-presets.e2e.test.ts`.
- Modify `apps/web-next/src/{bootstrap,app-shell,campaign-editor-page,story-player-tools}.ts`, related styles and navigation tests. Inspect server SPA route handling and add `/app/providers` coverage if it is not already served by the application fallback.

**Interfaces:** `mountProviderSettingsPage(root, dependencies): MountedPage` uses active plan task 6 state/API, owns AbortControllers and returns disposal behavior matching other mounted pages. Add `/app/providers` and `/app/providers/` route recognition; Setup links there.

- [ ] RED tests mount the page with injected fixture APIs and verify native list/create/edit/default/delete flows, exact typed save payload, credential keep/replace behavior, and disposal cancelling discovery. Add a route test proving it does not mount the world library or navigate to legacy Setup.
- [ ] Implement profile list and editor with the same Model/Preset behavior and details as legacy. Preserve existing new-UI visual conventions and accessibility. Include links for nontext configuration remaining in legacy; never silently change those profiles.
- [ ] Update campaign/player labels and selection inheritance. Keep actual served identity distinct from requested preset name in generation details.
- [ ] Browser test:
```ts
await page.goto("/app/providers");
await expect(page.getByRole("heading", { name: "Provider settings" })).toBeVisible();
await expect(page).toHaveURL(/\/app\/providers\/?$/);
```
Then create a text profile with candidate credentials, page/search/select a preset, inspect its standard prompt, save/reopen, switch back to Model, and verify independent drafts. Cover missing/deleted selection, failed save, malicious names and keyboard navigation with fixture APIs.
- [ ] Run new page/unit/navigation suites and `corepack pnpm exec playwright test tests/e2e/web-next-provider-presets.e2e.test.ts`; capture desktop/mobile screenshots and check console/network failures. Commit `Add native provider settings to the new UI`.
