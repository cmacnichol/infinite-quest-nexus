# Structured output rollout and rollback

This is an operator handoff. No deployment, compatibility-record installation,
paid generation, production baseline or live A/B experiment has been performed.
Leave every existing profile on its current Legacy behavior until the gates
below are complete.

## Compatibility qualification

The user-selected preset is `@preset/nexus-nsfw`, with the supplied underlying
model **DeepSeek: DeepSeek V3.2 Exp** (`deepseek/deepseek-v3.2-exp`). The proposed
single route for review is `novita/fp8`; it is not a claim about the preset's
current provider selection. The preset can change models, routing and fallback
preferences, so verification of a concrete model does not qualify that alias.

The [public endpoint inventory](https://openrouter.ai/api/v1/models/deepseek/deepseek-v3.2-exp/endpoints)
observed on 2026-09-18 advertises structured outputs and response format on that
route, a 163,840-token context and 65,536 maximum completion tokens, at $0.27 per
million input tokens and $0.41 per million output tokens. These are metadata
advertisements, not evidence that the complete Story schema is supported.
Refresh prices and constraints before a separately authorized execution.

The prepared compatibility batch uses two synthetic scenarios, three operation
schemas and streaming/nonstreaming transport: at most 12 requests, each capped
at 2,048 output tokens. Exact body sizes and hashes come from the production
serializer. Token estimates are not billing guarantees. Pricing the entire
163,840-token context as input plus the output ceiling for all 12 requests gives
a conservative inference ceiling of **$0.54091776**, rounded upward to
**$0.540918**. This deliberately overcounts context overlap and excludes account
fees/taxes. It is a prepared price, not spending approval.

Before executing, review the offline report, supply a concrete matching profile
ID, confirm the route and endpoint identity, and explicitly approve the bounded
batch. Do not infer route identity from the requested route. Missing, unexpected
or ambiguous returned identity produces no verification record. A provider
returning only a display name may therefore remain unqualified. Each successful
operation/mode requires all its scenarios to pass strict wire and application
validation, including native nested tracker preservation for Story. A rejected
schema must not trigger a rewritten schema or another model request.

Review proposed records before installing the operator file described in
[Provider configuration](../../installation/provider-configuration.md#operator-verification-records).
Distribute the same immutable file to API and worker roles, then restart and
check their configuration digests. Discovery status remains advisory; the
worker verifies eligibility again before any new job's first dispatch.

## Deployment and measured rollout

1. Finish the deterministic release verification and record the exact release
   commit and built image digest. No release image has been selected by this
   implementation task. Follow the [deployment runbook](../../runbooks/deployment.md).
2. Inventory existing generation jobs and their saved envelopes/reviews. Keep
   compatible readers and workers available for all pending work.
3. Capture a fixed post-deployment v16 baseline with the bounded read-only report:

   ```sh
   corepack pnpm exec tsx scripts/report-turn-validation.ts --since 2026-09-18T00:00:00.000Z --limit 1000 --format json
   ```

   Replace the example timestamp with the actual fixed deployment boundary.
   Save the build identity and window. Check truncation before interpreting
   counts. Baseline collection remains unperformed; the older 15/49 historical
   cohort is not a valid comparison for a different model or prompt protocol.
4. After the independently approved compatibility probe and workflow checks
   pass, enable Auto on one compatible profile. Required remains an explicit
   operator choice. Confirm the frozen effective operation modes on each job.
5. If authorized and affordable, compare disposable campaign copies with the
   same model, pinned route, prompt protocol, context, token limits and streaming
   mode. Randomize mode ordering. Start with 20 turns per mode as a smoke check;
   target at least 50 eligible primary responses per mode for the next stage.
   Do not reuse production accepted turns as mutable test fixtures.
6. Report first-pass application validity, fact-shape errors, repair rate,
   accepted-turn rate and primary calls per accepted turn, with their explicit
   denominators. Include missing, cancelled, refused and unavailable-preflight
   outcomes. Count continuity/choice calls separately from primary calls.
   Compare p50/p95 latency and cost only when observed durable measurements
   exist; current reporting emits unknown for those fields. Show uncertainty
   and matched cohort sizes. Narrative continuity and mechanics isolation remain
   separate acceptance gates; schema compliance does not establish truth.

Stop intake/dispatch and preserve evidence on duplicate acceptance, cross-owner
or cross-campaign leakage, tracker/supersession loss, unauthorized provider
calls, lost producing provenance or misleading repair consent. Never weaken
acceptance checks to make the canary pass. A small favorable canary supports a
directional claim only for its measured matching cohort.

## Rollback by saved-job state

| Saved state | Safe handling |
| --- | --- |
| Historical job without new marker | Preserve its original serializer, configuration fingerprint and review meanings. |
| New queued/preflight-only job | Keep a compatible worker; explicitly cancel/re-enqueue if the saved identity cannot be satisfied. Do not rewrite its policy marker. |
| Dispatched structured invocation | Preserve exact request/response evidence and its ledger. Do not redispatch an uncertain or completed invocation merely because the browser disconnected. |
| Pending v2 repair/review | Keep compatible readers and workers; retain producing hashes, receipt and explicit user decision. No implicit replacement call. |
| Committed turn | Remains append-only authoritative history. No rollback rewrite or database restore to disable structured output. |

Selecting Legacy affects new jobs. It does not reinterpret frozen pending
contracts, and the changed profile fingerprint can block their resume. Inventory
those jobs before changing configuration; retaining/reinstating their compatible
profile or explicit re-enqueue is an operator decision. Never run an older
worker against new envelopes. If compatible workers cannot remain available,
pause intake and dispatch under the deployment runbook until compatible code is
restored. Do not use a down migration or database restoration over accepted
turns as a feature toggle.
