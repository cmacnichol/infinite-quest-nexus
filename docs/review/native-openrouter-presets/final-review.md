# Final native OpenRouter preset review

The approved API/runtime/persistence and legacy settings/Story selection implementation is complete through executable commit `ab918be1534f3fe17705c230fa2ea2146d0e9cbc`. The new UI and plain-JSON downgrade remain deferred. Native admission remains default off. No deployment, activation, main-checkout integration, push, PR creation, or paid model call was performed in this implementation phase.

New Model selections require exact advertised capability and current operation/schema/stream/route verification. Presets use explicitly trusted admission and send each operation's complete structured-output schema. Existing explicit Model Auto/Legacy and queued historical workflows retain their compatibility rules. Preset prompts, ordered routes and ordinary settings are frozen for durable work; current execution authority still gates dispatch.

## Independent review chain

The whole-branch review read the complete 38,050-line immutable patch from `04b6b291` through `1018c88f`, checked the 33 acceptance gates and all 60 plan checkboxes, and identified nine findings. Subsequent scoped reviews read each complete correction patch and covering assertions/raw logs. They did not restart the broad audit or repeat passing suites without a concrete reason.

| Finding | Final evidence and disposition |
| --- | --- |
| F1 disabled-admission alias bypass | Closed by API/runtime admission guards and composed Story, authoring and illustration PostgreSQL assertions; historical replay remains compatible. |
| F2 operationless generic endpoint | Closed by rejecting Preset/Required Model before transport; actual HTTP tests retain concrete Legacy compatibility. |
| F3 unverified preset Save | Closed by detail validation outside the write transaction and exact authority/revision recheck; invalid create/PATCH, stale authority and historical edit tests cover persistence. |
| F4 unsafe or generic discovery errors | Closed by finite code/status/field projection and API/browser canary assertions. |
| F5 missing browser cancellation | Closed by real AbortController handling on both legacy surfaces and rendered signal/stale-callback assertions. |
| F6 OpenAI-compatible Model authority mismatch | Closed by actual frozen verified provider type; composed queue/worker positive and mismatch tests. |
| F7 lost usage and absent aggregation | Closed by durable physical accounting, campaign deduplication, owner-scoped authoring detail and direct preview success/error projections. Multi-invocation, rejected-response, partial/absent usage, mixed currencies, owner isolation and repeated-read tests cover real paths. |
| F8 clipped inherited policy | Closed by putting the policy first; rendered desktop/mobile/keyboard tests and the versioned 390px screenshot verify readability. |
| F9 accounting failures mislabeled | Closed by the separate post-response accounting event and v1/v2 assertions. |
| Follow-up summary-read failure | Closed: an optional accounting read cannot discard successful provider content or replace an original terminal error. Replay does not resend. |

The final terminal-accounting review read the complete 528-line `e856378a..ab918be1` patch and found no new actionable defect. It closed the remaining Usage/serving identity gate and plan lines 172/174. All other gate verdicts carry forward from the complete branch review and scoped corrections. There are no remaining product findings in that review chain.

## Evidence boundaries

[Verification](verification.md) records exact commands, source identities and counts. The final executable correction passed pinned static/type/syntax checks, 108 selected unit tests and 48 selected real-PostgreSQL tests with no skips. Earlier affected corrections passed their own checks. The broad full-unit run, complete Windows integration sweep, rendered browser tests/screenshots, and actual Linux integration/platform tests belong to the explicitly identified earlier source; they are not relabeled as final-commit reruns. Changes since those runs received relevant affected verification and scoped review.

One full-unit run observed an intermittent Story recovery-panel assertion; an unchanged-source focused run and full rerun passed. Its cause is not proven unrelated. Platform and opt-in skips remain skips. No live OpenRouter compatibility is claimed. The private preset's current routing/version remains unknown; the priced probe is an offline hypothetical plan, not executed inference.

Some early test-first steps have contemporaneous implementation reports but no independently inspected original RED console logs. Their current behavior was independently reviewed and tested; historical chronology is not retroactively certified. Later correction RED/GREEN raw logs, including the exact terminal fixture on its prior production source, were inspected. This is a process-provenance limitation, not an open implementation defect.

The task-owned `.superpowers/sdd/2026-09-18-native-openrouter-presets/` directory retains the complete 33-gate/60-checkbox audit, immutable review packages, four correction-review reports, raw logs, screenshots/source identities and the chronological controller-rulings index. It is retained because the branch is not merged. No private logs, credentials, test environment configuration or unrelated `scratch/` content are committed.

[Implementation decisions](implementation-decisions.md) records the product tradeoffs; [rollout](rollout.md) retains the all-workers-upgraded prerequisite, default-off gate and drain/pause rollback procedure. Completion of implementation and review does not authorize activation.
