# Historical fact-format replay

## Scope and method

This is a read-only structural replay, not an acceptance or live-provider experiment. The pure planner is the reviewed `099d2394` implementation. Runtime application and commit behavior remain subject to phase 04 verification.

The cohort is the newest 50 jobs at or before `2026-09-18T05:05:13.987485Z`, ordered by creation time. The first response is the earliest nonempty `initial` attempt by attempt number. Queries ran within `BEGIN READ ONLY` / `ROLLBACK`. Private response and request text passed directly from PostgreSQL through an in-memory data pipe into a fixed local TypeScript script; no private content was saved or printed. The output contained counts and finite reason codes only.

For each retained primary response, the replay verified SHA-256 of the exact saved request body against its saved payload hash. It decoded the original user input, read complete fact records from the supplied `currentContinuity.canonicalFacts` and canonical-fact Chronicle records, and compared the resulting ID set with the saved `sentFactIds`. Identical duplicate references were deduplicated; differing content for the same ID was classified as unavailable unambiguous evidence. No current campaign state was substituted. A retained primary response was counted in the first-response subset only when its raw bytes exactly matched that earliest response.

## Results

| Observation | Count |
|---|---:|
| Jobs in fixed cohort | 50 |
| Jobs with a saved first response | 49 |
| Historically invalid first responses | 34 |
| First responses valid under the current parser, without explicit repair | 18 |
| Jobs retaining a primary request and response | 10 |
| Retained request hashes verified | 10 |
| Retained primary responses with unambiguous inventories matching saved sent IDs | 8 |
| Those eight already valid under current parsing | 4 |
| Those eight eligible for explicit repair and strict-valid afterward | 4 |
| Retained requests with conflicting content for the same visible fact ID | 2 |

The two conflicting inventories occur within the frozen producing request itself. The replay did not choose one version of the fact or consult current state. They must not be counted as supported repair successes.

### First-response failures only

Of the 34 historically invalid first responses, only four have an exactly matching retained primary request/response pair. Three have unambiguous visible inventories: one is already valid under the current parser, and two become strict-valid through the planner. The fourth has conflicting visible fact content. The remaining 30 lack an exactly matching retained producing request in this evidence source.

Thus **two historical first-response failures are independently demonstrated to be structurally repairable**, and **four retained invalid primary responses are repairable overall**, including later attempts. These are distinct denominators. No eligible replay produced an invalid strict-parser result.

## Interpretation and remaining gates

- The current parser accepts 18/49 saved first responses versus 15/49 historically recorded as valid. That difference includes existing parser compatibility behavior; it is not evidence of phase 02 prompt improvement.
- The four repaired retained responses show that the planner handles real observed fact-format failures. The sample is small and selected by evidence retention, so 4/4 must not be extrapolated into a live success-rate forecast.
- Missing or conflicting request evidence is not a malformed-fact rejection and is reported separately. It limits what can be proved retrospectively and what can be safely offered for those historical candidates.
- Parser validity does not prove continuity approval, current authority, successful commit, or user consent. Phase 04 must establish those through real PostgreSQL and browser tests.
- After the phase 04 adapter is complete, compare its evidence extraction and eligibility with this independent replay. Live first-pass improvement remains unmeasured without a separately authorized canary.

### Runtime extractor comparison

The coordinator compared the inventory extractor copied from immutable `0eaab2a6` with the independent replay extractor on the same fixed cohort. All 10 retained producing requests agreed: eight yielded the same complete inventory and two rejected conflicting contents for a visible fact ID. Aggregate replay outcomes were unchanged: four retained invalid primary responses were structurally repairable, including two earliest responses. The query used `BEGIN READ ONLY` and `ROLLBACK`; private request/output text stayed in memory and only aggregate counts were emitted. This validates agreement on the retained sample, not all malformed request variants or downstream acceptance. Repeat if the runtime extractor changes before the final checkpoint.

After inventory hardening, the coordinator repeated the same comparison with the extractor from `fe37fe1a`: all 10 requests still agree with independent extraction (eight usable inventories, two conflicting inventories). Structural replay counts remain unchanged. This confirms the new completeness checks do not remove the four demonstrated repairable retained responses.
