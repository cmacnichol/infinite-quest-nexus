# AI Assist Patch 1: Generation Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. Execute only this patch when requested; do not start Patch 2.

**Goal:** Make world/character AI Assist return meaningful reviewed candidates or specific safe failures, with one bounded repair for malformed or incomplete output.

**Architecture:** Keep the current synchronous endpoints and persistence boundaries. Put completion predicates and mandatory prompt contracts in the domain, reusable response execution in runtime, and typed sanitized error projections in contracts. Share character validation across standalone generation and world-seed expansion without turning the organizer into a creative generator.

**Tech Stack:** Existing TypeScript, Zod, Vitest, Fastify, PostgreSQL integration fixtures, and Playwright; no new dependency.

**Spec:** [AI Assist roadmap and design](2026-09-06-ai-assist-roadmap.md), especially shared requirements and Patch 1 decisions.

## Execution status - 2026-09-06

P1.1-P1.7 are implemented, verified and task-reviewed. Independent whole-patch review and the final scoped re-review passed; both integrity findings are resolved. The [verification record](../../review/2026-09-06-ai-assist-patch-1-verification.md) records the final audit, 398 unit tests, 46 PostgreSQL cases, two browser flows and four refreshed live checks. Changes remain uncommitted in the isolated worktree; main integration, deployment and Patch 2/3 implementation have not started.

## Global constraints

- Implement P1.1–P1.7 in order; each task is a separate reviewable checkpoint.
- Exactly one content repair per stage; at most four provider calls including transport retries.
- No database migration, new job system, source upload, or source-schema change in this patch.
- Preserve manual incomplete drafts, owner scoping, revision checks, world-version immutability, and human save.
- Preserve unrelated changes and the current legacy preview response shape.
- Keep strict evidence validation; aliases are translated only at the provider boundary.
- Update the tests associated with every changed production file.
- Code examples are target interfaces and concrete test seeds, not instructions to bypass existing package exports or test helpers. Test snippets use imports from vitest and the specified module.

## File and responsibility map

| File | Action | Responsibility |
| --- | --- | --- |
| packages/contracts/src/authoring.ts | Create | Sanitized authoring issue/failure schema |
| packages/contracts/src/authoring-error-projection.ts | Create | Shared browser-safe path, code and message policy used by domain/API/UI |
| packages/contracts/src/index.ts | Modify | Export authoring contracts |
| packages/domain/src/authoring-output.ts | Create | Generated-output normalization and completion validation |
| packages/domain/src/authoring-prompts.ts | Create | Code-owned schema/evidence prompt suffix |
| packages/domain/src/character-authoring.ts | Modify | Delegate character validation and use mandatory contract |
| packages/domain/src/generated-world.ts | Modify | Apply shared generated-character completion checks |
| packages/domain/src/world-template.ts | Modify | Mandatory world contract |
| packages/contracts/src/prompt-library.ts | Modify | Creative templates and explicit protocol descriptions |
| services/runtime/src/authoring-response-adapter.ts | Create | Bounded execution/parse/repair and error projection |
| services/runtime/src/provider-world-generation-adapter.ts | Modify | Integrate shared pipeline in both character paths and world generation |
| services/runtime/src/provider-character-organization-adapter.ts | Modify | Alias normalization and bounded structural/evidence repair |
| apps/web-next/src/authoring-errors.ts | Create | Browser-safe error presentation |
| apps/web-next/src/world-creation-api.ts / world-creation-page.ts | Modify | Preserve/display safe issues |
| apps/web-next/src/character-workspace-api.ts / character-workspace-page.ts | Modify | Preserve/display safe issues |
| services/api/src/server.ts | Modify narrowly | Preserve allowlisted authoring failures through the HTTP boundary |
| docs/nexus-guide/worlds/create.md / characters.md | Modify | User-visible repair and failure behavior |

No unrelated reshaping of the large runtime adapter. Extract only the responsibilities used by these tasks.

## P1.1 — Define generated-content completion and sanitized failures

**Size:** 1–2 hours. **Depends on:** None.
**Files:** Create the contracts/domain files above and tests/unit/authoring-output.test.ts; modify contracts exports, character-authoring.ts, generated-world.ts; review tests/unit/world-library.test.ts and generated-world.test.ts.

**Interfaces produced:**

    type AuthoringStage = "world" | "character" | "organizer";
    type AuthoringIssue = { path: string; code: string; message: string };
    type AuthoringFailure = {
      code: "invalid_authoring_output" | "authoring_output_limit"
        | "authoring_provider_unavailable" | "authoring_provider_timeout"
        | "authoring_provider_rejected" | "authoring_context_exceeded";
      stage: AuthoringStage;
      retryable: boolean;
      issues: AuthoringIssue[];
      correlationId?: string;
    };
    type CharacterCompletionMode = "creative" | "source";
    validateGeneratedCharacter(
      value: unknown, mode: CharacterCompletionMode
    ): PlayableCharacter;
    projectAuthoringIssues(error: unknown): AuthoringIssue[];

PlayableCharacter is the existing contract type. Source mode is a validator option only; there is no source workflow in this patch. It requires a nonempty name and at least one story field, with evidence enforced by Patch 3.

- [x] Write the RED cases using an application-owned ID and the existing empty-profile schema:

        const empty = {
          id: "test-character", name: "Iris", characterText: "",
          profile: characterProfileSchema.parse({})
        };
        expect(() => validateGeneratedCharacter(empty, "creative")).toThrow();
        expect(playableCharacterSchema.safeParse(empty).success).toBe(true);

- [x] Add cases for role plus background but no motivation/goal/hook; meaningful profile with unknown appearance; null/wrong object types; invalid arrays; duplicate names; and arbitrary raw error text excluded from the projected issue messages.
- [x] Run the new test file and capture the missing-validator or incorrect-completion RED result.
- [x] Implement the creative minimum from the roadmap. Keep all required checks in one pure validator. Preserve standalone characterText compatibility; use hasCharacterProfileGuidance and characterLegacyText in packages/domain/src/world-characters.ts when a legacy text projection is needed. Do not overwrite existing legacy guidance or require a second model-authored copy of profile prose.
- [x] Apply the same validator at final world completion. Preserve strict 3–4 concept-world roster semantics in this patch. Do not reject incomplete manual saves. Check generated fictional fields with the existing mechanics-leakage boundary in packages/domain/src/text.ts; reject/repair contaminated generated content rather than silently saving it. Add a synthetic dice/modifier sentinel regression and preserve legitimate diegetic numbers.
- [x] Cap error lists at 20 issues and paths at 500 characters, accepting only schema-known field paths or application-owned indexed paths; use fixed messages for each code.
- [x] Run new and associated tests GREEN; inspect fixtures affected by stronger completion and update only generation fixtures with meaningful content.
- [x] Review the diff and checkpoint only this task when commits are requested.

**Acceptance:** Empty generated profiles fail; valid sparse appearance passes; manual drafts retain their existing validity.

## P1.2 — Make prompt contracts invariant

**Size:** 1–2 hours. **Depends on:** P1.1.
**Files:** Create authoring-prompts.ts and tests/unit/authoring-prompts.test.ts; modify character-authoring.ts, world-template.ts, prompt-library.ts; extend tests/unit/prompt-library.test.ts.

**Interfaces produced:**

    type AuthoringPromptKind = "world" | "character" | "organizer";
    appendAuthoringContract(
      kind: AuthoringPromptKind, creativePrompt: string
    ): string;

Code owns complete JSON examples, required types, completion requirements, and the evidence item { path, source, quote }. Use one shared structured-profile example in both character paths. Runtime prompt snapshots must contain the effective mandatory suffix.

- [x] Write the RED test against the shipped template and an intentionally minimal custom override:

        for (const guidance of [
          PROMPT_TEMPLATE_CATALOG.character_generation.defaultContent,
          "Create a restrained, realistic character."
        ]) {
          const prompt = appendAuthoringContract("character", guidance);
          expect(prompt).toContain('"fearsAndConflicts"');
          expect(prompt).toContain('"distinguishingFeatures"');
          expect(prompt).toContain("untrusted reference");
        }

- [x] Add tests proving world-seed and standalone contracts share profile structure, organizer evidence includes exact keys, appended contract appears once, and custom text remains present.
- [x] Run the new tests RED.
- [x] Implement a unique bounded contract marker and append once at the final builder boundary. Do not trust a user-supplied marker as proof the suffix already exists: rebuild the final contract from code.
- [x] Version character generation to character-authoring-v3-validated-profile and organizer to character-profile-organizer-v3; introduce world-authoring-v2-validated-profile metadata for new world generations. Leave saved historical protocol values intact.
- [x] Update template descriptions and snapshot tests. Remove contradictory “fields supplied in input” wording; customized content still receives the suffix.
- [x] Run prompt and character/world unit tests GREEN. Check exact effective prompts, not only fallback strings.
- [x] Review and checkpoint.

**Acceptance:** No active prompt can omit the mandatory shape merely because a shipped/custom template replaces fallback text.

## P1.3 — Build bounded response execution and repair

**Size:** 2–3 hours. **Depends on:** P1.1–P1.2.
**Files:** Create services/runtime/src/authoring-response-adapter.ts and tests/unit/authoring-response-adapter.test.ts. Reuse existing provider error classifiers and JSON extraction; do not duplicate transport implementations.

**Interfaces produced:**

    type AuthoringAttempt = {
      repair: boolean;
      issues: AuthoringIssue[];
      rejectedResponse?: string;
    };
    runAuthoringResponse<T>(options: {
      stage: AuthoringStage;
      request(attempt: AuthoringAttempt): Promise<ProviderResult>;
      parse(content: string): T;
      delay(milliseconds: number): Promise<void>;
    }): Promise<T>;

ProviderResult is the existing provider response type. Domain validation produces recognized schema/semantic errors. Programming errors propagate to the API's generic sanitized failure boundary rather than being misdiagnosed as repairable model output.

- [x] Write the RED test with two deterministic responses:

        const request = vi.fn()
          .mockResolvedValueOnce({ content: "{", outputLimited: false })
          .mockResolvedValueOnce({ content: '{"value":1}', outputLimited: false });
        const result = await runAuthoringResponse({
          stage: "character", request,
          parse: (text) => JSON.parse(text), delay: async () => {}
        });
        expect(result).toEqual({ value: 1 });
        expect(request).toHaveBeenCalledTimes(2);
        expect(request.mock.calls[1][0].repair).toBe(true);

- [x] Add RED cases for wrong schema, missing creative minimum, reasoning-only/empty output, truncated response, invalid repaired response, and a valid response marked outputLimited. Define the latter as acceptable only when full parse and semantic completion pass.
- [x] Add typed transport cases: 401 and network-policy errors make one call; 429 then success retries once; two timeouts fail; malformed initial output followed by two repair transport failures stops at the configured bound; assert total calls never exceed four. Use fake timers/injected delay, not wall-clock sleeps.
- [x] Implement parse → validation → one full-replacement repair. Feed actual sanitized issue paths/codes, original task context, and bounded rejected output into repair. Do not append arbitrary syntax fragments or fabricate facts locally.
- [x] Bound rejectedResponse to 16,000 Unicode code points and label any diagnostic truncation. This bound applies to rejected provider output, never the user's source. If a response chain is missing/incompatible, rebuild the repair request statelessly within the same call budget.
- [x] Implement typed retry classification and delay policy from the roadmap. Preserve existing network policy and response-size safeguards.
- [x] Run the new suite GREEN and confirm final failures contain only AuthoringFailure plus application-authored messages.
- [x] Review and checkpoint.

**Acceptance:** Syntax, shape, and semantic failures share one bounded loop; permanent failures are not retried.

## P1.4 — Wire world and character generation through the shared pipeline

**Size:** 2–3 hours. **Depends on:** P1.1–P1.3.
**Files:** Modify provider-world-generation-adapter.ts and character-authoring.ts; extend tests/unit/world-generator-service.test.ts and world-library.test.ts; create tests/unit/character-generator-service.test.ts.

**Consumes:** runAuthoringResponse, appendAuthoringContract, validateGeneratedCharacter.
**Produces:** Existing exported preview functions and existing response shapes, with corrected validation/repair.

- [x] Add a runtime preview RED test using the existing collaborator harness pattern:

        const execute = vi.fn()
          .mockResolvedValueOnce(providerResult('{"name":"Iris","profile":{"story":"wrong"}}'))
          .mockResolvedValueOnce(providerResult(JSON.stringify(validCharacterResponse())));
        const result = await generatePlayableCharacterPreviewForOwner(
          pool, ownerId, request, providersWithExecute(execute), progressDependencies
        );
        expect(result.character.name).toBe("Iris");
        expect(execute).toHaveBeenCalledTimes(2);

The helper providerResult returns all ProviderResult fields using the shape in world-generator-service.test.ts. Create validCharacterResponse with role "Cartographer", background "Raised in a harbor", goals "Map the inland roads", and empty unknown appearance. providersWithExecute, pool, ownerId, request, and progressDependencies follow that existing test's in-memory collaborator fixture, with no real database connection.

- [x] Add equivalent world-child tests; verify supplied seed association and application-owned IDs survive repair. Keep mismatched seed rejection; do not trust model IDs as application identity.
- [x] Run RED; capture the currently single-call failure and empty-profile acceptance regression.
- [x] Adapt old snake_case world child fields once at the provider boundary, then call the shared character validator. Preserve existing metadata and imported extension fields during revision.
- [x] Replace separate catch/recovery implementations with the P1.3 pipeline. Preserve progress updates and standalone/world provider selection.
- [x] Verify failures make no world/draft writes and no campaign/Chronicle calls in the in-memory collaborators.
- [x] Run world-generator-service, generated-world, world-library, and character-generator-service tests GREEN.
- [x] Review and checkpoint.

**Acceptance:** Both character entry points have the same semantic minimum and retry policy without changing API payloads.

## P1.5 — Repair organizer structural and evidence failures

**Size:** 2–3 hours. **Depends on:** P1.1–P1.3.
**Files:** Modify provider-character-organization-adapter.ts; extend tests/unit/character-profiles.test.ts and prompt-library.test.ts; extend world-library.integration.test.ts for world and campaign organizer paths.

**Interfaces:** Preserve validateOrganizerResult for direct validation. Change validateOrganizerResultWithRepair to accept syntax/structural/semantic issues rather than only one unsupported quote; both production organization entry points use runAuthoringResponse so JSON extraction is inside the bounded loop. Make the old repair helper a compatibility wrapper or remove its production use; never nest two repair loops and accidentally permit a second repair.

- [x] Write the RED test using a complete organizer object:

        const value = {
          candidate: characterProfileSchema.parse({ appearance: { clothing: "Blue coat" } }),
          evidence: [{ field: "appearance.clothing", source: "legacyGuidance", content: "Blue coat" }],
          unassignedText: [], conflicts: [], warnings: [],
          protocolVersion: "character-profile-organizer-v3"
        };
        const result = validateOrganizerResult(value, { legacyGuidance: "Blue coat" });
        expect(result.evidence).toEqual([
          { path: "appearance.clothing", source: "legacyGuidance", quote: "Blue coat" }
        ]);

- [x] Add tests for field→path, content→quote, sourceKey→source, and verbatim→quote. If canonical and alias values conflict, produce a validation failure rather than silently selecting one. Remove translated alias keys before strict parsing.
- [x] Add RED cases for invalid JSON, malformed evidence arrays, unknown source keys, missing evidence paths, unsupported quotes, and malformed repaired output. Assert exactly one content repair and safe terminal failure.
- [x] Run RED and implement normalization plus the shared loop. Preserve exact-quote/whitespace matching policy; do not weaken the strict public result schema or turn source text into prompt instructions.
- [x] Ensure evidence path refers to a populated candidate field and every populated field has evidence. Keep unrelated world lore out of character facts; flag unsupported content rather than inventing.
- [x] Include both owner-scoped world and campaign endpoint tests, including foreign-owner inputs and failed-output non-persistence.
- [x] Run unit tests GREEN and the dedicated integration cases when configured.
- [x] Review against the earlier organizer plan, record covered requirements, and checkpoint.

**Acceptance:** Structural and semantic failures have bounded recovery; unsupported claims cannot become saved character facts.

## P1.6 — Expose useful errors in both creation interfaces

**Size:** 2–3 hours. **Depends on:** P1.4–P1.5.
**Files:** Create authoring-errors.ts and tests/unit/web-next-authoring-errors.test.ts; modify the four world/character API/page files, server.ts error projection if needed; extend their unit tests and tests/unit/server-security.test.ts; create tests/e2e/ai-assist-errors.e2e.test.ts. Update create.md and characters.md.

**Interfaces produced:**

    parseAuthoringFailure(value: unknown): AuthoringFailure | null;
    authoringFailureText(failure: AuthoringFailure): string;

Legacy raw/unknown errors retain a generic fallback. Public envelopes retain existing HTTP compatibility and add sanitized details; do not expose arbitrary 5xx exceptions globally.

- [x] Write RED API/page tests showing an invalid character response identifies character stage and profile.story.background while retaining correlation ID:

        const message = authoringFailureText({
          code: "invalid_authoring_output", stage: "character", retryable: true,
          issues: [{ path: "profile.story.background", code: "missing", message: "Character background is required." }],
          correlationId: "fixture-correlation"
        });
        expect(message).toContain("background");
        expect(message).toContain("fixture-correlation");

- [x] Add tests excluding HTML, provider URLs, credentials, raw JSON, and quotes from error UI; assert textContent rendering, accessible status/error announcements, and preserved input after failure/cancel.
- [x] Run RED and implement allowlisted server projection with expose: true only for known sanitized authoring errors.
- [x] Preserve details through API parsing; display stage, concise issue list, retry action, and provider-setup link only for provider availability failures.
- [x] Ensure a failed progress poll cannot overwrite the more useful POST error or erase current form fields. Handle delayed completion and stale responses using existing generation sequence checks.
- [x] Add a Playwright test routing the new error envelope through each rendered creation flow; assert prompt preservation and capture screenshots with page.screenshot({ path: ... }) under the test output directory.
- [x] Run unit and browser tests GREEN; update the two user guides with actual behavior and no claims of guaranteed model compliance.
- [x] Review and checkpoint.

**Acceptance:** Users can distinguish invalid output from unavailable provider without receiving raw provider internals.

## P1.7 — End-to-end verification and patch handoff

**Size:** 1–3 hours. **Depends on:** P1.1–P1.6.
**Files:** Extend tests/integration/world-generation.integration.test.ts and world-library.integration.test.ts; create tests/integration/authoring-reliability.integration.test.ts and tests/fixtures/authoring/reliability.json. Create docs/review/2026-09-06-ai-assist-patch-1-verification.md during execution.

**Deliverable:** Reviewable evidence for the entire synchronous request → provider → repair → validated preview → explicit save path.

- [x] Add integration test seeds with actual assertions: malformed initial response followed by valid repair returns 200; malformed repair returns a sanitized 502; query world/draft/profile revisions before and after failed previews and assert equality.
- [x] Include one server fixture response with a secret-shaped sentinel; assert the sentinel is absent from public response and safe logs. Fixtures contain synthetic content only.
- [x] Run new cases before remaining fixes and rerun GREEN. Shared projection: five expected RED failures then GREEN. API harness/contract corrections are documented separately and not claimed as product-defect RED evidence.
- [x] Run:

        node node_modules/vitest/vitest.mjs run tests/unit/authoring-output.test.ts tests/unit/authoring-prompts.test.ts tests/unit/authoring-response-adapter.test.ts tests/unit/character-generator-service.test.ts tests/unit/world-generator-service.test.ts tests/unit/generated-world.test.ts tests/unit/world-library.test.ts tests/unit/character-profiles.test.ts tests/unit/prompt-library.test.ts tests/unit/web-next-authoring-errors.test.ts tests/unit/web-next-world-creation-api.test.ts tests/unit/web-next-world-creation-page.test.ts tests/unit/web-next-character-workspace-api.test.ts tests/unit/web-next-character-workspace-page.test.ts tests/unit/server-security.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
        node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/authoring-reliability.integration.test.ts tests/integration/world-generation.integration.test.ts tests/integration/world-library.integration.test.ts
        pnpm exec playwright test tests/e2e/ai-assist-errors.e2e.test.ts
        pnpm check
        pnpm build
        git diff --check

- [x] Exercise one world generation, one standalone character, and world/campaign organization against the selected live text provider only in an explicitly selected disposable test world. Record model, protocol, attempt counts, duration, and outcome without raw responses. If unavailable, mark live-provider verification skipped and explain the remaining release risk.
- [x] Verify screenshots and explicit save; inspect the complete diff for unrelated changes. Record any unrelated baseline check failures distinctly.
- [x] Document rollback: revert Patch 1 code/templates together; no database rollback. Preserve historical prompt snapshots and existing saved worlds.
- [x] Produce the patch completion record and stop. Do not begin durable jobs.

**Patch 1 gate:** All deterministic regression, database, browser, build, and boundary checks pass, or a concrete blocker is reported without declaring completion. Live-provider evidence is separately classified; do not substitute unit results for it.
