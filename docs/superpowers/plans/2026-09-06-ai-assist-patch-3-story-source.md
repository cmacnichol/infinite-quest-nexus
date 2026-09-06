# AI Assist Patch 3: World from Story Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. Stop after this patch's completion record.

**Goal:** Let an author supply a short story or chapter, review supported facts and uncertainties, choose a playable roster and starting boundary, and explicitly save a reusable world with portable provenance.

**Architecture:** Extend Patch 2 authoring jobs with source extraction stages and an explicit fact-review gate before synthesis. Retain normalized source and exact citation coordinates; deterministic code performs coverage, evidence, and identity checks around bounded provider calls. Save only reviewed canon and its source appendix through Patch 2's atomic apply boundary.

**Tech Stack:** Existing TypeScript, Zod, SHA-256 from node:crypto, PostgreSQL JSONB, text-provider runtime, Vitest and Playwright. UTF-8 text intake only; no parser/OCR service or new package.

**Spec:** [AI Assist roadmap and design](2026-09-06-ai-assist-roadmap.md), especially Patch 3 limits and fidelity rules.
**Prerequisite:** [Patch 2](2026-09-06-ai-assist-patch-2-durable-authoring.md) accepted, including resume and atomic apply.

## Global constraints

- Implement P3.1–P3.9 in order, with source extraction review before synthesis.
- Faithful extraction is the default. Inferred/invented content is never silently promoted to sourced fact.
- One UTF-8 TXT/Markdown file or pasted text; maximum 1 MiB UTF-8 and 200,000 Unicode code points.
- Preserve all selected source coverage; reject impossible budgets rather than clipping user input.
- Maximum 200 extraction chunks; source roster selection is 0–20, not the concept generator's 3–4.
- Published versions and existing campaigns remain unchanged.
- Stored normalized source is retained user content, not trusted instructions. Model output, provider credentials, reasoning, and job internals never enter world content.
- Exact citation matching does not prove semantic entailment; the review UI must make that limitation operational through source inspection and acceptance.
- Extend content schema to version 6 for optional sourceMaterial; old positive versions remain readable and old snapshots are never rewritten.

## File and responsibility map

| Files | Action and responsibility |
| --- | --- |
| packages/contracts/src/source-authoring.ts | Create: intake, source, evidence, fact-review, appendix schemas |
| packages/contracts/src/authoring.ts / world-library.ts / index.ts | Extend: story_source job, source result projection, content version 6 |
| packages/contracts/src/system-archives.ts / packages/database/src/system-archive-export-repository.ts / system-archive-import-repository.ts | Extend explicit strict archive schemas/projections to retain the accepted source appendix |
| packages/domain/src/source-authoring.ts | Create: normalization, paragraph map, citations, deterministic merge |
| packages/domain/src/source-authoring-budget.ts | Create: complete source segmentation and request budget |
| packages/domain/src/source-world-proposal.ts | Create: selected-fact/roster assembly and source-specific completion |
| packages/domain/src/authoring-jobs.ts | Extend: extraction/review/synthesis dependencies |
| packages/domain/src/authoring-prompts.ts / contracts/src/prompt-library.ts | Add mandatory extraction/synthesis protocols |
| services/runtime/src/source-authoring-adapter.ts | Create: bounded extraction and synthesis calls |
| services/runtime/src/authoring-stage-adapter.ts / authoring-composition.ts | Dispatch new stage kinds |
| services/api/src/authoring-routes.ts | Add bounded source-submit and fact-review commands |
| packages/application/src/authoring/{types,ports,use-cases}.ts | Extend: source review and synthesis commands |
| packages/database/src/authoring-job-repository.ts | Persist source stages and review revision |
| database/migrations/next-number_story_source_authoring.sql | Extend kind/validation constraints only if introduced in Patch 2 |
| apps/web-next/src/source-authoring-api.ts | Create: typed source submission/review client |
| apps/web-next/src/source-authoring-panel.ts | Create: source, evidence, fact-review and roster UI |
| apps/web-next/src/world-creation-page.ts / world-creation-model.ts | Integrate third creation mode and resumable review |
| packages/application/src/system-archives/portability-registry.ts | Confirm appendix is inside portable world authority, no operational inclusion |
| docs/nexus-guide/worlds/create-from-story.md | Create user guide |
| docs/nexus-guide/worlds/create.md / import-export.md | Link and describe source workflow |
| docs/runbooks/ai-authoring.md | Extend limits, retention, source privacy, rollback |

Use new files for source-specific behavior; do not turn existing page/runtime files into another monolith.

## P3.1 — Define source intake and stable provenance contracts

**Size:** 1–2 hours. **Depends on:** Accepted Patch 2.
**Files:** Create contracts/source-authoring.ts and domain/source-authoring.ts; extend authoring contract and exports; create tests/unit/source-authoring.test.ts.

**Interfaces produced:**

    type SourceDocument = {
      id: string; name: string; text: string; sha256: string;
      paragraphs: { id: string; start: number; end: number }[];
    };
    type SourceCitation = {
      sourceId: string; paragraphId: string;
      start: number; end: number; quote: string;
    };
    type SourceFact = {
      id: string;
      kind: "character" | "location" | "faction" | "relationship" | "rule" | "event" | "tone";
      subject: string; predicate: string; value: string;
      provenance: "stated" | "inferred" | "invented" | "manual";
      citations: SourceCitation[];
    };
    type SourceAuthoringInput = {
      kind: "story_source"; idempotencyKey: string; target: { kind: "new_world" };
      name: string; text: string; mode: "faithful" | "expand";
      boundaryParagraphId: string; instructions: string;
    };
    normalizeSourceDocument(name: string, text: string, id: string): SourceDocument;
    validateSourceCitation(source: SourceDocument, citation: SourceCitation): boolean;

Extend AuthoringKind with story_source, AuthoringStage with source, and the job input discriminated union. Offsets are Unicode code points in normalized text, end-exclusive; use Array.from(text) for indexing. Store normalized source once in job input; chunk stage inputs reference spans.

Extend the safe failure code allowlist with source_requires_larger_context, source_coverage_incomplete, source_evidence_invalid, choose_source_facts, and source_review_conflict. Define a strict SourceAuthoringView with source: SourceDocument, boundaryParagraphId: string, mode: "faithful" | "expand", facts: SourceFact[], extractionComplete: boolean, acceptedFactIds: string[], rejectedFactIds: string[], selectedCharacterFactIds: string[], and expansionCandidates: SourceFact[]. Add optional source: SourceAuthoringView to the owner-scoped AuthoringJobView detail projection; omit it from lists. Extension of AuthoringSubmit must be in one canonical exported union, not a competing frontend type.

- [ ] Write RED normalization/citation tests:

        const source = normalizeSourceDocument("chapter.txt", "\uFEFFA\r\n\r\nBlue coat.", "source-1");
        expect(source.text).toBe("A\n\nBlue coat.");
        const paragraph = source.paragraphs[1];
        expect(validateSourceCitation(source, {
          sourceId: source.id, paragraphId: paragraph.id,
          start: paragraph.start, end: paragraph.end, quote: "Blue coat."
        })).toBe(true);

- [ ] Test Unicode surrogate pairs, BOM, CRLF, blank separators, empty text, NULs, over-limit UTF-8 bytes/code points, cross-paragraph citations, modified quote, wrong source ID/hash, and deterministic paragraph IDs.
- [ ] Run RED; implement normalization that changes only one leading BOM and CRLF/CR to LF. Preserve other whitespace and paragraph offsets.
- [ ] Assign source/fact IDs in code. Do not trust model or imported owner IDs. Display names are capped at 200 characters; instructions retain the existing 20,000-character prompt limit.
- [ ] Validate citation quote equals the exact normalized source span and the span lies entirely within its referenced paragraph and selected boundary.
- [ ] Run source/contracts tests GREEN; review and checkpoint.

**Acceptance:** Source coordinates remain stable and verifiable through all later stages.

## P3.2 — Build provider-aware complete-source segmentation

**Size:** 2–3 hours. **Depends on:** P3.1.
**Files:** Create domain/source-authoring-budget.ts and tests/unit/source-authoring-budget.test.ts; extend provider runtime through a narrow safe limits projection if current collaborators cannot expose limits.

**Interfaces produced:**

    type AuthoringBudget = {
      contextWindowTokens: number; maxOutputTokens: number;
      countTokens(text: string): number;
    };
    type SourceChunk = {
      id: string; sourceId: string;
      spans: { paragraphId: string; start: number; end: number }[];
    };
    planSourceChunks(input: {
      source: SourceDocument; boundaryParagraphId: string;
      systemPrompt: string; instructions: string; budget: AuthoringBudget;
    }): SourceChunk[];
    assertSourceCoverage(source: SourceDocument, chunks: SourceChunk[], boundaryParagraphId: string): void;

Count the entire serialized request, including mandatory schema and instructions. Use floor(contextWindowTokens * 0.8) minus output reservation; reserve the same budget for repair requests. If no verified tokenizer is available, count UTF-8 bytes, including JSON escaping, as the conservative bound.

Use RuntimeTextExecution.contextWindowTokens and maxOutputTokens from the existing provider-credential-transport-adapter.ts descriptor; do not create a parallel provider configuration store. Clamp against a smaller verified model context limit when available. If no positive effective context limit can be established, fail preflight rather than assume an unlimited model.

- [ ] Write RED budget tests with a small deterministic byte counter and a multi-paragraph source. Assert each request fits and all selected paragraph character ranges are covered.
- [ ] Include this failure seed:

        expect(() => planSourceChunks({
          source, boundaryParagraphId: source.paragraphs[0].id,
          systemPrompt: "A contract larger than the model context",
          instructions: "", budget: {
            contextWindowTokens: 16, maxOutputTokens: 12,
            countTokens: (text) => new TextEncoder().encode(text).length
          }
        })).toThrow();

- [ ] Run RED; implement paragraph packing, optional single-paragraph overlap when it fits, and code-point splitting of oversized paragraphs. Preserve separator coverage as explicit spans/gaps in assertSourceCoverage.
- [ ] Ensure no source text after boundaryParagraphId enters serialized requests, summaries, repair context, or chunk hashes. Report selected/excluded source length before execution.
- [ ] Cap at 200 chunks and return source_requires_larger_context with computed count when exceeded. Pin the budget/model projection in the job snapshot.
- [ ] Add repair-budget tests. Drop optional rejected-response diagnostics before reducing source; if the fixed source request still cannot fit, return authoring_context_exceeded. Never silently slice a chapter.
- [ ] Run unit tests GREEN; review and checkpoint.

**Acceptance:** Long chapters are processed completely within limits, or rejected before provider execution with a useful reason.

## P3.3 — Extract source facts with verified evidence

**Size:** 2–3 hours. **Depends on:** P3.2 and Patch 1 pipeline.
**Files:** Create runtime/source-authoring-adapter.ts; extend prompt-library/authoring-prompts; create tests/unit/source-authoring-adapter.test.ts and tests/fixtures/authoring/source-chapter.txt.

**Interfaces produced:**

    extractSourceChunk(input: {
      source: SourceDocument; chunk: SourceChunk; mode: "faithful" | "expand";
      instructions: string;
    }): Promise<SourceFact[]>;

Use protocol source-extraction-v1. Raw provider facts contain subject/predicate/value/category and evidence coordinates; runtime assigns stable application IDs after validation. Bound each chunk to 200 facts and each fact value to 4,000 characters. If a chunk exceeds output/fact limits after repair, split and retry smaller spans rather than accepting a prefix. Count resulting subchunks against the 200-chunk job maximum.

- [ ] Write RED tests with a fixture describing Iris in a blue coat but giving no age. Assert clothing is extracted with an exact citation and no age is invented.
- [ ] Add malformed JSON, wrong quote, foreign paragraph, instruction injection inside fiction, conflicting facts, missing citations, and output-limit cases.
- [ ] Assert unsupported claims are rejected:

        const proposed = { ...statedFact, value: "Forty years old", citations: [] };
        expect(() => validateExtractedSourceFacts(source, chunk, [proposed])).toThrow();

Create validateExtractedSourceFacts in domain/source-authoring.ts as part of this task. It consumes source, chunk, and unknown provider facts, returns validated SourceFact[], and enforces cited spans are in the supplied chunk/boundary. statedFact is the complete typed clothing fixture defined in the new test file.

- [ ] Run RED; implement mandatory JSON contract and instructions that quoted story content is data. Feed Patch 1 repair the actual citation/schema issues.
- [ ] Faithful mode accepts stated candidates only; unknown facts remain absent. Expansion may propose inferred candidates, but invented world-building happens only after explicit review/synthesis.
- [ ] Reject unverifiable “stated” facts; retain contradictory stated facts separately for review rather than resolving them. Do not claim quote validation proves the interpretation.
- [ ] Run extraction and prompt tests GREEN; review and checkpoint.

**Acceptance:** Every purported source fact has verifiable coordinates; malformed or unsupported extraction cannot become canon.

## P3.4 — Checkpoint extraction and reconcile fact review

**Size:** 2–3 hours. **Depends on:** P3.3.
**Files:** Extend authoring jobs/domain/application/repository and stage adapter; create tests/unit/source-fact-review.test.ts and tests/integration/source-authoring-jobs.integration.test.ts; add the constraint migration if needed.

**Interfaces produced:**

    type SourceFactReview = {
      expectedRevision: number;
      acceptedFactIds: string[]; rejectedFactIds: string[];
      selectedCharacterFactIds: string[];
      manualFacts: SourceFact[];
    };
    mergeSourceFacts(facts: SourceFact[]): SourceFact[];
    reviewSourceFacts(scope: OwnerScope, jobId: string, review: SourceFactReview): Promise<AuthoringJobView>;
    startSourceSynthesis(scope: OwnerScope, jobId: string, expectedRevision: number): Promise<AuthoringJobView>;

Manual facts must have provenance manual and cannot claim supplied citations as proof of changed wording. IDs in review requests must belong to the exact extraction generation; foreign/stale IDs return 409.

- [ ] Write RED tests for overlap deduplication, same-name different people, alias ambiguity, contradictory dates, stale review, and foreign job facts.
- [ ] Assert conflict preservation rather than name-only merging:

        const merged = mergeSourceFacts([northIris, southIris]);
        expect(merged).toHaveLength(2);

The fixture uses the same subject string but distinct cited identities and incompatible locations. Automatic deduplication is restricted to identical normalized subject/predicate/value/provenance with compatible identity and unioned exact citations; fuzzy name merging is not permitted.

- [ ] Run RED; create one stage per planned source chunk and checkpoint each extraction independently. Failed chunks block “extraction complete” and synthesis, while successful results remain inspectable.
- [ ] Persist accepted/rejected selections separately from immutable extraction output. An empty accepted set cannot synthesize a world; return a fixed choose_source_facts error.
- [ ] Add awaiting_review → queued transition only through explicit startSourceSynthesis with reviewed fact revision. No automatic extraction-to-synthesis transition.
- [ ] Bound selected roster to 0–20 distinct source characters. Conflicts must be explicitly excluded, retained as uncertainty, or resolved by a manual fact; do not silently choose one.
- [ ] Run unit and real-PostgreSQL cases GREEN, including API/worker restart mid-extraction and retry of only the missing chunk.
- [ ] Review migration compatibility and checkpoint.

**Acceptance:** Review is durable, complete-source coverage is visible, and no ambiguous extraction silently becomes canon.

## P3.5 — Synthesize a world from accepted facts and selected characters

**Size:** 2–3 hours. **Depends on:** P3.4.
**Files:** Create domain/source-world-proposal.ts; extend source adapter, prompt library, and stage dispatcher; create tests/unit/source-world-proposal.test.ts and source-world-generation.test.ts.

**Interfaces produced:**

    type SourceWorldSelection = {
      source: SourceDocument; boundaryParagraphId: string;
      acceptedFacts: SourceFact[]; selectedCharacterFactIds: string[];
      mode: "faithful" | "expand";
    };
    assembleSourceWorldProposal(
      selection: SourceWorldSelection,
      generated: unknown
    ): WorldContent;
    validateSourceWorldProposal(content: WorldContent): WorldContent;

Use protocol source-world-v1. Reuse Patch 1 character normalization with source completion mode and Patch 2 stage checkpoints. One synthesis stage builds overview; selected character stages add profiles. Source facts populate typed lore entities/relationships through deterministic assembly, not only summary prose.

- [ ] Write RED tests for a one-character chapter, zero selected characters, unselected characters retained as lore, unknown rules/appearance left blank, and a selected boundary excluding a later revelation.
- [ ] Assert faithful behavior:

        expect(proposal.playableCharacters).toHaveLength(1);
        expect(proposal.playableCharacters[0].profile?.appearance.apparentAge).toBe("");
        expect(proposal.world.rules).not.toContain("invented magic system");

Build proposal by calling the real assembler with a source-selection fixture and controlled synthesis response, including a response attempting to introduce the unsupported magic system. Require that attempted addition be rejected or separated as unaccepted expansion, never silently retained.

- [ ] Run RED; ask the model to return authored field values plus supporting accepted-fact IDs. Validate every cited fact ID belongs to this reviewed generation and selected boundary. Reject unsupported faithful additions; do not merely check that a supplied citation exists.
- [ ] In expansion mode keep generated additions in a separately labeled review list with provenance invented; they enter the final candidate only after explicit selection. Preserve accepted sourced facts without contradictory overwrites.
- [ ] If the complete accepted fact set cannot fit synthesis context, return a safe request to reduce the selected facts or choose a larger-context model. All extracted facts remain in the job for review; never silently drop the tail of the set.
- [ ] Do not use parseCompleteGeneratedWorld's concept-specific 3–4 roster/full-field rule. Source proposals require a title, valid source references, meaningful selected character guidance, and canonical storage validity; missing world fields remain visible incomplete draft fields.
- [ ] Preserve source-derived narrative and mechanics separation. Faithful mode does not invent stats or tracker rules; user-supplied mechanics remain in typed mechanics fields only.
- [ ] Run tests GREEN; review and checkpoint.

**Acceptance:** A chapter produces a faithful reusable draft with a chosen roster, without forced invented details or mandatory extra characters.

## P3.6 — Persist and round-trip accepted source provenance

**Size:** 2–3 hours. **Depends on:** P3.5.
**Files:** Extend world-library.ts, source-authoring.ts contracts, canonicalization and authoring apply adapter; modify packages/contracts/src/system-archives.ts and explicit source projection/restoration in packages/database/src/system-archive-export-repository.ts and system-archive-import-repository.ts; review world/campaign archive projections and portability registry; create tests/integration/source-world-portability.integration.test.ts; extend world-library.test.ts and archive contract tests.

**Interfaces produced:**

    type WorldSourceMaterial = {
      version: 1;
      documents: SourceDocument[];
      boundary: { sourceId: string; paragraphId: string };
      acceptedFacts: SourceFact[];
      fieldEvidence: { path: string; factIds: string[] }[];
    };

Add optional sourceMaterial: WorldSourceMaterial to WorldContent and set WORLD_CONTENT_SCHEMA_VERSION to 6 for newly canonicalized writes. Limit documents to one for this patch. The stored source appendix uses selected normalized source through the boundary; do not retain excluded later paragraphs in the world. Recompute its hash/map and rebase citations deterministically if necessary, while retaining original job hash only in operational state.

- [ ] Write RED tests for schema-5 read compatibility, schema-6 writes, unchanged old published hashes, and source appendix preservation through world export/import, campaign archive, and System Archive.
- [ ] Assert export content integrity:

        expect(importedWorld.sourceMaterial?.documents[0].sha256).toBe(savedSourceHash);
        expect(importedWorld.sourceMaterial?.acceptedFacts).toEqual(savedAcceptedFacts);

Use actual portable export/import services in the isolated database, not JSON.stringify/parse as a stand-in for the archive path.

- [ ] Run RED; validate citations/hash/review generation at apply time, not only at extraction. If a human edits a sourced field, require reviewed mapping or mark it manual; do not leave a stale “source-supported” label.
- [ ] Extend the strict System Archive world-content schema and its explicit exporters/importers; current archive schemas do not automatically preserve arbitrary WorldContent passthrough fields. Keep the existing archive format compatible through an optional typed sourceMaterial field and unchanged historical records. If the format's compatibility contract disallows that additive field, introduce a versioned compatibility adapter in this task and test both versions before claiming round-trip support.
- [ ] Ensure all final fields and source appendix fit existing world/API/archive byte limits. Reject oversize application atomically; never save a world while dropping its provenance.
- [ ] Preserve portable source IDs as provenance only; remap owner/world identity through existing imports. Reject tampered source hash, out-of-range references, and sourceMaterial containing operational/raw-provider fields.
- [ ] Audit canonical prompt projections and add sentinel tests proving sourceMaterial text is not serialized wholesale to generation, organizer, image prompts, or embeddings. Approved extracted canon still flows through normal canon fields.
- [ ] Run schema/world/archive unit and PostgreSQL round-trip tests GREEN.
- [ ] Review and checkpoint.

**Acceptance:** Source provenance survives portable transfers, while raw source cannot accidentally become model instructions or unsupported starting canon.

## P3.7 — Build the story-source creation and evidence-review UI

**Size:** 2–3 hours. **Depends on:** P3.4–P3.6.
**Files:** Create source-authoring-api.ts, source-authoring-panel.ts, tests/unit/web-next-source-authoring.test.ts; modify world-creation-page/model and existing API resume integration; create tests/e2e/ai-assist-source.e2e.test.ts.

**Public application/API additions:**
- POST /api/v1/authoring/source-jobs accepts SourceAuthoringInput, enforced server byte/code-point limits.
- PUT /api/v1/authoring/jobs/:id/source-review accepts SourceFactReview.
- POST /api/v1/authoring/jobs/:id/source-synthesis accepts expectedRevision.
- Existing job read/retry/cancel/apply endpoints carry source job projections without exposing private runtime snapshots.

**Client interfaces produced:**

    submitSourceAuthoring(input: SourceAuthoringInput): Promise<AuthoringJobView>;
    saveSourceFactReview(jobId: string, input: SourceFactReview): Promise<AuthoringJobView>;
    beginSourceSynthesis(jobId: string, expectedRevision: number): Promise<AuthoringJobView>;

- [ ] Write RED UI tests for the third “From story or chapter” mode, paste/file input, faithful default, source boundary selector, known size limit, chunk progress, fact acceptance, conflict handling, selected roster, and final review.
- [ ] Use TextDecoder("utf-8", { fatal: true }) for local file bytes; reject wrong extension/binary content and show server-authoritative validation errors. Display file name, source length, included boundary, and mode before submission.
- [ ] Run RED; implement the panel as a focused module embedded in world creation. Keep the concept workflow unchanged.
- [ ] Render source and model values using safe text nodes. Clicking a fact displays its exact source passage, including paragraph label. Do not render raw Markdown/HTML from the story.
- [ ] Show stated/inferred/invented/manual provenance separately. Inferred/invented candidates are unselected by default; conflicts require explicit review. Synthesis cannot start while extraction coverage is incomplete.
- [ ] Add “Use selected facts,” optional roster selection, “Generate world draft,” per-stage retry, resume, and final apply through Patch 2. No generation button saves canon automatically.
- [ ] Preserve local edits on job refresh/review conflicts and make unknown fields visibly editable without inserting placeholder fiction.
- [ ] Run unit and Playwright tests GREEN; save desktop and narrow-width screenshots for intake, evidence review, failure/retry, and final draft.
- [ ] Review and checkpoint.

**Acceptance:** The user can inspect what was extracted, choose what to keep, and save only after review.

## P3.8 — Verify source isolation, limits, and operating guidance

**Size:** 1–2 hours. **Depends on:** P3.7.
**Files:** Create tests/integration/source-authoring-security.integration.test.ts; extend source budgets and server admission tests; write create-from-story.md and update create.md, import-export.md, ai-authoring.md.

- [ ] Write RED integration cases for foreign-owned source job access, malicious prompt text in a chapter, oversized JSON, invalid source boundary, stale extracted-fact IDs, tampered citation coordinates, and duplicate apply.
- [ ] Assert the provider never sees excluded source text:

        expect(capturedProviderRequests.every((request) =>
          !JSON.stringify(request).includes("EXCLUDED_REVELATION_SENTINEL")
        )).toBe(true);

Place the sentinel after the chosen paragraph boundary in the synthetic chapter; capture real mock-HTTP provider payloads for extraction, repair, and synthesis.

- [ ] Run RED; close any missing boundary checks without widening source authority or exposing internal diagnostics.
- [ ] Verify failed source/extraction jobs do not mutate world/campaign/Chronicle tables; explicit source discard removes operational payloads while applied source appendix remains.
- [ ] Document supported input, limits, normalization, default fidelity, fact review, start boundary, incomplete drafts, retry/resume, source retention and portable exports.
- [ ] Document rollback: disable source capability while keeping Patch 2 jobs and schema-6 reads intact. Do not deploy an old writer that strips sourceMaterial. Reverting UI alone is safe; code rollback requires the schema-preserving compatibility path.
- [ ] Run security/integration tests GREEN and check documentation links.
- [ ] Review and checkpoint.

**Acceptance:** Source boundaries and owner isolation are enforced server-side, and operating limits match the product UI.

## P3.9 — End-to-end acceptance and patch handoff

**Size:** 2–3 hours. **Depends on:** P3.1–P3.8.
**Files:** Create tests/integration/source-authoring.integration.test.ts, tests/fixtures/authoring/source-scenarios.json, and docs/review/2026-09-06-ai-assist-patch-3-verification.md during execution.

- [ ] Build five synthetic scenarios: one-character chapter, multi-chunk chapter, ambiguous same-name characters, unsupported model additions, and later-spoiler boundary. Include known fact/evidence expectations and accepted/rejected selections.
- [ ] Add RED cases across submission → extraction checkpoint → explicit fact review → synthesis → explicit world apply → publish → new campaign. Assert no existing campaign/version changes; make only scoped fixes and rerun the new cases GREEN.
- [ ] Add failure/restart scenario with one extraction chunk and one character failure; verify retained completed stages, bounded retries, and idempotent apply.
- [ ] Run:

        node node_modules/vitest/vitest.mjs run tests/unit/source-authoring.test.ts tests/unit/source-authoring-budget.test.ts tests/unit/source-authoring-adapter.test.ts tests/unit/source-fact-review.test.ts tests/unit/source-world-proposal.test.ts tests/unit/source-world-generation.test.ts tests/unit/web-next-source-authoring.test.ts tests/unit/world-library.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
        node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/source-authoring-jobs.integration.test.ts tests/integration/source-world-portability.integration.test.ts tests/integration/source-authoring-security.integration.test.ts tests/integration/source-authoring.integration.test.ts
        pnpm exec playwright test tests/e2e/ai-assist-source.e2e.test.ts tests/e2e/ai-assist-resume.e2e.test.ts tests/e2e/ai-assist-errors.e2e.test.ts
        pnpm check
        pnpm build
        git diff --check

- [ ] Run prior-patch affected regressions and current archive/import contract suites. Use the full documented integration runner if the new schema changes shared import/bootstrap behavior beyond focused suites.
- [ ] In a disposable environment, run one supplied synthetic chapter through the selected live text provider and visually inspect extracted facts, citations, roster, and source boundary. Report this separately from deterministic evidence and record any unsupported outputs caught by review/repair.
- [ ] Inspect screenshots, source/export hashes, no-write assertions, and final diff. Confirm docs describe exact implemented limits.
- [ ] Produce the patch completion record and stop. Do not add PDF/DOCX, multi-document retrieval, or automatic publication.

**Patch 3 gate:** A bounded chapter can become a source-linked reviewed world, survive restart/export/import, and preserve ownership and campaign isolation. Unsupported or oversized input fails clearly without partial authoritative writes.
