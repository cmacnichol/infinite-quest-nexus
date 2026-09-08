# AI-assist Patch 3 verification

P3.9 adds a real PostgreSQL acceptance chain for story-source authoring. It submits five deterministic source fixtures through the public source API, a subprocess worker and a local OpenAI-compatible HTTP provider. The chain performs extraction, owner fact review, source-world synthesis, world apply, publish, campaign creation, and portable export/import.

The fixtures cover a single character, bounded multi-chunk extraction under an 8,192-token profile, separate same-name identities, inferred and invented unsupported additions requiring owner review, and a spoiler boundary. The assertions require exact citations, current validated source-stage selection, an idempotent apply replay, exact normalized selected-prefix export text and hash, and import equality. A pre-existing published world and non-empty campaign state, accepted turn ledger, and Chronicle memory are snapshotted before the chain and must remain byte-for-byte equivalent afterward.

Worker acceptance also records safe outcomes only: job/stage identifiers, generation, typed failure code and stage, provider-call delta, status, review fence, parent generations, lease state, and database timing fields. It never logs source text, provider requests, credentials, or responses. The diagnostic has a deliberate limitation: after a completed claim transaction it reports that `SKIP LOCKED` contention is not observable, rather than inferring it.

The source-job integration suite covers actual worker restart after incomplete
multi-chunk extraction, output-limited split and missing-child recovery,
provider failure recovery, and controlled character-stage invalid output. The
final composed recovery proves one job with three leaves: a retryable 503 on a
known extraction leaf, public retry followed by a fresh worker process and one
provider-call delta, two retained leaf IDs and hashes, then explicit Mara fact
review, successful synthesis, a recoverable character repair, public retry
with one provider-call delta, and retention of all current leaf outputs and
the synthesis output. The existing idempotent apply replay then creates one
world only. Initial stages remain claimable if a database clock rollback makes
their creation timestamp appear future; explicit retry generations, attempted
queued stages, and live leases remain due-gated.

Final deterministic acceptance ran `source-authoring.integration.test.ts` as
2 tests / 2 passed and `source-authoring-jobs.integration.test.ts` as 16 tests
/ 16 passed, with final source test-log SHA-256
`9016b3fc65440fdbd265df94a0da71fd0e2e9e4b7c65239ba1aad52bf5156676` and
companion source-jobs test-log SHA-256
`889c4748bef054eee7ad73ed1d51e87470a161bb688b50c1f55bad29f583e708`.
This is historical P3.9 deterministic evidence from before the later whole-branch corrections and final review.

## Whole-branch correction status

All F1–F5 corrections are reviewed and accepted. F2 covers stale extraction claims before the first request, claim loss after invalid initial output, retryable transport loss before retry, successful-response claim loss before acceptance, and durable `source:chunk` dispatcher wiring. That focused correction does not establish cancellation of an already in-flight provider request. F1 and F4 cover the shared mapping, draft-review fence, stale-review pruning, and complete-group guard.

## Current corrected-branch verification

- Focused units: `p3-publication-quote-anchor-final-units.log` passed 522 tests across 24 files; the earlier corrected-branch `p3-final-corrected-units.log` passed 480 across 22 files.
- Routed browser: `p3-final-ui-browser-2.log` passed 41 Playwright tests. It ran in a disposable Linux container with retained screenshots and no host services or database, so it is browser routing evidence rather than an actual PostgreSQL or live-provider run.
- Actual PostgreSQL: `p3-final-source-composition.log` passed 30 tests across 4 files; the final composition/portability/isolation selection passed 13 across 3 files (`SHA-256 a01557186d091229398c2b7c6506e8e8f74de7c97559216fa00fbbf43002ab48`); `root-quote-anchor-final-jobs2.log` passed 20/20 (`SHA-256 d6cf3b92aed42e5db8e2503087c06bcfdf88a1be1b37ccb241337bd7bb41d343`).
- Smoke harness helpers: 17 Node tests passed, covering safe diagnostics, exact reviewed fact variants, and readiness of the selected character stages.
- Static checks and build: `root-quote-anchor-final-check2.log` and `live_source_quote_anchor_build_green2.log` exited 0 after the quote-anchor production changes. Earlier `p3-final-check.log` and `p3-final-identity-build.log` are retained as historical checks.

## Selected-provider live evidence

The user approved the guarded bridge into the exact labeled disposable API. Earlier live runs are retained as history: the first source job closed twice at recoverable extraction with no facts; v2 reached rendered fact review and then recoverable synthesis; and a pre-quote-anchor fresh job closed with the safe `source_quote` projection. Those results drove protocol and harness corrections; no raw provider output, reasoning, or credentials were retained.

The final quote-anchor v4 run used OpenRouter / `deepseek/deepseek-v3.2-exp`, synthetic job `9393ab38-6669-49fe-a2a7-00d0c5c6ea05`, and reviewed disposable image `sha256:93fee43596c05f728e24a3cecb9032d5bd726356e2c6bebe7e05bf256a851214`. It validated planning and the sole selected chunk after the required worker restart. Rendered review showed three stated facts and canonical selected-source citations: two exact allowlisted Mara facts were accepted, the third was rejected, the two accepted facts were joined to one identity, and one roster representative was selected. The same durable job then validated `source:synthesis` and its selected character stage. A later explicit rendered adoption reconciled the finished current synthesis and character stages without resubmitting facts, regenerating synthesis, or retrying the provider.

The rendered **Create world** action received HTTP 200 and navigated to the created world. The smoke then verified the exact selected prefix and SHA-256 in the world source appendix, no excluded sentinel, guarded public API publish, one published playable character, one campaign bound to that version and character, and export with the same exact prefix and hash. This is functional live-provider, rendered review, UI-apply, publish, campaign, and export evidence. The two sanitized inspected images are [source review](../../tests/fixtures/authoring/screenshots/p3-9-live-source-review-desktop.png) and [created world](../../tests/fixtures/authoring/screenshots/p3-9-live-source-world-applied-desktop.png).

The final runner's strict browser-console assertion failed after that functional chain because it observed one console error. The original event text was not retained. A separately labeled read-only reproduction of the applied-job route observed `Failed to load resource: 404` at `/favicon.ico:0`; it is evidence of a likely asset request, not retrospective proof of the original event. There were no page errors. The runner retains the strict assertion and does not filter console errors, so this browser-console hygiene check remains failed even though the functional live chain completed.

The live scaffolding uses `compose-p3-9-source-smoke.yaml`, the server-side `bootstrap-p3-live-provider.mjs` re-encryption bridge, and `compose-source-browser-smoke.mjs`. The bridge is restricted to the exact labeled loopback destination and emits only safe selection metadata. Detailed safe history, hashes, screenshots, and cleanup evidence are retained in ignored `D/approved-live-test-report.md`.

After the evidence handoff, the exact disposable Compose project was removed with its API, worker, PostgreSQL container, labeled network, anonymous volume, and the temporary destination credential profile. The label-scoped postcheck found no remaining resources for that project. No source runtime, source profile, or unrelated Docker resource changed.

The exact labeled live-test Compose stack was removed after evidence capture. Postchecks found no containers, networks, or volumes for `infinitequest-ai-assist-p3-9-smoke`; the temporary database and its re-encrypted destination credential were removed with it. Root independently verified the container and network absence. The source runtime was detached from the temporary bridge and its helper removed; unrelated services were preserved.
