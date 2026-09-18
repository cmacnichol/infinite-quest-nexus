# Structured output 05: controls and reporting implementation plan

> **For agentic workers:** Use `superpowers:subagent-driven-development`; fresh gpt-5.6-terra implementer and fresh Terra reviewers.

**Goal:** Let operators select response-format policy and see truthful capability/failure status, and measure first-pass outcomes without mixing repairs into success rates.

**Architecture:** Provider management edits policy only; capability evidence stays server-owned. Story views receive a finite safe projection. Extend the existing read-only reporting pipeline with schema cohorts.

**Tech Stack:** Existing browser clients, TypeScript, Vitest, Playwright, PostgreSQL reporting.

**Spec:** [Index](2026-09-18-structured-output.md). Depends on patches 01–04.

## Files and ownership

- Provider controls: `apps/web/public/nexus.js`, `apps/web/public/index.html` (active Nexus page, not repository-root archival `index.html`), `services/api/src/provider-application-adapter.ts`.
- Safe Story diagnostics: `packages/contracts/src/story-prompt.ts`, `packages/client-core/src/generation/projection.ts`, `services/api/src/generation-review-projection.ts`, `packages/database/src/generation-review-summary-projection.ts`; `apps/web/src/story.js`, `apps/web-next/src/story-player-generation.ts`, `story-player-page.ts`, `story-player-view.ts`.
- Reporting: `packages/application/src/generation/outcome-metrics.ts`, `scripts/report-turn-validation.ts`; runbooks `docs/runbooks/turn-validation.md`, `docs/installation/provider-configuration.md`.
- Tests: `tests/unit/legacy-provider-modal.test.ts`, `generation-review-projection.test.ts`, `generation-review-summary-projection.test.ts`, `generation-outcome-metrics.test.ts`, `report-turn-validation.test.ts`; new `tests/e2e/structured-output-settings.e2e.test.ts`; extend `tests/e2e/generation-integrity-diagnostics.e2e.test.ts` as needed.

## Task 1: settings and status

- [ ] RED browser/DOM coverage: policy absent displays Legacy; save/reload Auto and Required; discovery distinguishes advertised from verified; unknown/error never displays verified; profile/model changes invalidate the visible verification; in-flight selection does not race another profile's result into the form.
- [ ] Add policy options with plain labels: "Legacy JSON", "Use schema when verified", "Require verified schema". Describe tracker/schema incompatibility when relevant. Required remains selectable but clearly shows that generation will stop before dispatch if verification is missing; UI is not the authorization gate.
- [ ] Display discovery time and verified operation coverage without exposing raw schema, private endpoint credentials or operator-record paths. Verification requires a server result; form changes cannot submit capability proof.
- [ ] Preserve the existing web-next Setup link to `/nexus/#providers` in `apps/web-next/src/app-shell.ts:41`; do not build a duplicate settings editor. Both Story surfaces must show the effective saved mode and safe preflight failure guidance for their own job.
- [ ] UI recovery preserves existing fact-format repair versus full Retry distinction. Unsupported-schema/refusal errors do not create misleading Keep/repair buttons or automatically choose another model. Explain that settings changes apply to new jobs; do not relabel old pending work.

## Task 2: safe outcome dimensions

- [ ] RED report fixtures contain legacy, auto-JSON, strict success, strict refusal, capability preflight failure, explicit fact repair, discarded/cancelled work and missing observations. Assert only the earliest primary validation counts as first-pass outcome and preflight failure is not a malformed model response.
- [ ] Add safe cohort dimensions: policy, effective response mode, schema version/hash, operation, requested model versus returned model, verified provider route when actually returned, and build/execution protocol hash. Unavailable returned route remains unknown; never invent one from requested settings.
- [ ] Record numerator/denominator for schema-valid first responses, missing responses, refusals/transport failures, explicit repairs, final acceptance and primary-call counts. Report latency/cost only from observed durable data; missing cost is unknown rather than zero. Pair model/route/prompt/context/streaming cohorts before comparing modes.
- [ ] Bound report queries and metadata sizes. Keep `BEGIN READ ONLY` and rollback. Do not load raw narration, prompts, credentials or arbitrary provider errors for the report. If timing/cost fields are unavailable, display unknown and document the missing field instead of an estimated value.

```ts
expect(report.strict.initialValid).toBe(1);
expect(report.strict.initialInvalid).toBe(1);
expect(report.strict.preflightUnavailable).toBe(1);
expect(report.strict.jobsWithInitialResponse).toBe(2);
// A later valid repair cannot change the first response's invalid classification.
```

Use a fixed synthetic three-job cohort in `report-turn-validation.test.ts` and existing reducer helpers; define additive report types explicitly in the production module rather than relying on arbitrary JSON.

## Task 3: rendered verification and docs

- [ ] Run focused unit suites, `corepack pnpm check`, and `corepack pnpm build` for affected web bundles.
- [ ] Run `corepack pnpm exec playwright test tests/e2e/structured-output-settings.e2e.test.ts tests/e2e/generation-integrity-diagnostics.e2e.test.ts`. Verify `/story` and `/app/story` at desktop and 390×844: selected mode, missing capability, schema rejection, reload and pre-existing repair receipt. Save screenshots under `docs/review/assets/structured-output/` with no private story data.
- [ ] Update provider configuration/runbook docs with policy table, metadata expiry, operator verification setup, tracker limitation, historical-job handling and examples of report cohorts. Link the existing explicit repair workflow rather than rewriting it.
- [ ] Review source diff, links and screenshots; `git diff --check`; scoped commit and handoff with unit/DB/browser evidence separated.

## Exit gate

Operators can understand and configure the mode, both Story surfaces disclose bounded errors accurately, and reporting makes no first-pass or success-rate claim unsupported by observations.
