# Story Memory rollout and rollback

Use this procedure only after the release evidence and operator approval are recorded.
See [deployment](deployment.md) for the surrounding platform procedure.

## Capability default and configuration boundary

Story Memory is disabled unless an operator enables a capability. The runtime
configuration parser treats an omitted `STORY_MEMORY_CAPABILITY` value and the
literal `off` as no installed capability. It also defaults
`STORY_MEMORY_ENFORCE_ENABLED` to `false`.

```text
STORY_MEMORY_CAPABILITY=off|r1|r2|r3
STORY_MEMORY_ENFORCE_ENABLED=false|true
```

These settings control API-side enrollment and enqueue admission. Do not treat
the setting as campaign authority and do not set a browser-supplied owner ID.
The API resolves the server-side initial owner for the enrollment operation.
Worker safety comes from deploying a binary that can read each frozen policy
and prompt protocol it may claim; a worker must discard and require
re-enqueue for an incompatible frozen job. A worker deployment must never
silently interpret a frozen Story Memory job as legacy.

The operator must first deploy compatible API and worker binaries with intake
stopped and no old worker process or unexpired old-worker lease. Only then may
the API capability be enabled. Installation alone does not enroll any campaign,
and archive import never enrolls its destination campaign.

## Campaign enrollment and frozen jobs

After compatible binaries are present, an operator may use the trusted API
surface to enroll a single campaign:

```bash
curl --fail-with-body --request PUT \
  "${NEXUS_API_BASE}/api/v1/campaigns/${CAMPAIGN_ID}/story-memory-enrollment" \
  --header 'content-type: application/json' \
  --data '{"capability":"r1","reviewMode":"off"}'
```

Allowed bodies are exactly:

```json
{"capability":"r1","reviewMode":"off"}
{"capability":"r2","reviewMode":"off"}
{"capability":"r3","reviewMode":"off"}
{"capability":"r3","reviewMode":"observe"}
{"capability":"r3","reviewMode":"enforce"}
```

`r1` and `r2` reject `observe` and `enforce`. R3 `enforce` also rejects unless
the API has the explicit `STORY_MEMORY_ENFORCE_ENABLED=true` operator gate.
Enforcement remains disabled by default. Use R3 observe before considering
enforce; observation is not a promotion result.

To stop future enrollment-derived policies for one campaign:

```bash
curl --fail-with-body --request DELETE \
  "${NEXUS_API_BASE}/api/v1/campaigns/${CAMPAIGN_ID}/story-memory-enrollment"
```

The DELETE changes only future enqueue resolution. It does **not** alter a
queued, claimed, recoverable, or completed job: each queued Story Memory job
retains its frozen policy hash, prompt snapshot, provider configuration
fingerprint, protocol, and authority identity. Re-enabling enrollment also
applies only to jobs subsequently enqueued.

When changing capability/configuration or rolling back, inspect frozen jobs
before restarting any worker. This read-only PostgreSQL inventory has no prompt
or provider secret output:

```sql
SELECT id,
       campaign_id,
       status,
       prompt_protocol_version,
       context_options -> 'storyMemoryPolicy' -> 'policy' ->> 'capability' AS capability,
       context_options -> 'storyMemoryPolicy' -> 'policy' ->> 'continuityReview' AS review_mode,
       lease_owner,
       lease_expires_at
  FROM generation_jobs
 WHERE context_options ? 'storyMemoryPolicy'
 ORDER BY created_at;

SELECT status, count(*) AS jobs
  FROM generation_jobs
 WHERE context_options ? 'storyMemoryPolicy'
 GROUP BY status
 ORDER BY status;

SELECT id, status, lease_owner, lease_expires_at
  FROM generation_jobs
 WHERE lease_owner IS NOT NULL
   AND lease_expires_at > now()
 ORDER BY lease_expires_at;
```

Use the existing recovery flow to deliberately finish, discard, or re-enqueue
an incompatible job. Do not change `context_options`, prompt snapshots,
orchestration checkpoints, or job status directly in SQL. Both active Story
interfaces must show the same discard-and-reenqueue recovery action before
this is used as a release procedure.

## Controlled rollout procedure

1. Back up authoritative PostgreSQL data and verify the normal restoration
   procedure. Inventory campaign settings and prompt overrides without copying
   credentials into the release report. Create only authorized copied campaign
   destinations for canaries.
2. Stop new-generation intake using the deployment platform's existing ingress
   or API-service procedure. The application has no Story Memory-specific
   intake environment flag; record the exact platform command in the release
   report. Let current jobs complete or resolve them deliberately.
3. Record zero old worker processes from the deployment platform and zero
   unexpired old-worker leases using the final query above. Do not use a rolling
   overlap when an old worker could claim a new frozen policy/protocol.
4. Apply only additive migrations, including
   `0095_story_memory_capability_enrollment.sql`, and deploy compatible API,
   runtime, worker, and both Story-interface builds.
5. Keep capability off until the applicable R1/R2/R3 release gate passes. For
   a limited approved cohort, set the API capability to the target release and
   enroll campaigns one at a time. R3 begins with `reviewMode: "observe"` and
   `STORY_MEMORY_ENFORCE_ENABLED=false`.
6. Run copied-campaign canaries at 32k and at one larger window actually
   supported by the selected provider. A configured 2m or 4m campaign budget
   is not proof that a provider supports that request size. Inspect exact
   request budgeting, accepted commit, replay/next turn, recovery state, safe
   usage/cost telemetry, and latency.
7. Resume intake only after the corresponding release report records passing
   applicable gates. Maintain a small explicit cohort; never mass-enroll all
   campaigns by default.

Use the canary inventory below. Each item must be a copied destination,
preserve its source authorization, and have a recorded destination ID:

| Required copied campaign scenario | Required checks |
| --- | --- |
| short and long history | exact budget, commit, replay, next turn |
| corrected current state | intentional empty values and correction precedence |
| character-edited | revision/fingerprint fence and next turn |
| event-heavy | final extension/coverage, no duplicate fulfillment |
| imported and branched | remapped identity, policy provenance, no source IDs in destination supersession links |
| multilingual | serialization, evidence offsets, and safe recovery |
| R3 observe | safe outcome/diagnostic, no accidental enforce behavior, accepted-artwork rule |
| R3 enforce | only after approval; conflict/repair/artwork, bounded calls, and recovery |

## Budget terminology

Use the following terms consistently in release material:

- **Campaign story context budget:** persisted `campaigns.story_context_budget_tokens`.
  Its supported values are exported by `STORY_CONTEXT_BUDGET_TOKEN_VALUES`:
  32k, 64k, 128k, 256k, 1m, 2m, and 4m. Enqueue replaces the browser/request
  `context.budgetTokens` with this campaign value before persisting the job.
- **Memory context-preview query budget:** the GET
  `/api/v1/campaigns/:campaignId/memory/context-preview` query is parsed by
  `memoryContextQuerySchema`, which caps this preview-only `budgetTokens` at
  `MAX_MEMORY_CONTEXT_BUDGET_TOKENS` (1m). It is not the generation job budget.
- **Effective provider request limit:** the planner still applies the frozen
  provider window, output reserve, and safety allowance to the measured final
  request. The campaign setting is an upper target, never a claim of provider
  support.


## Rollback and downgrade

1. Stop intake and inventory every frozen Story Memory job plus every active
   lease. Drain or deliberately resolve these jobs before changing binaries.
2. Disable future admission by returning the API capability to `off` and, when
   applicable, `STORY_MEMORY_ENFORCE_ENABLED=false`. Clear campaign enrollment
   only when the operator intends future jobs to be legacy; clearing does not
   rewrite queued jobs.
3. Do not permit an old worker to claim a frozen Story Memory job. If it cannot
   read the job, retain a compatible reader while generation remains disabled,
   or use the explicit discard-and-reenqueue flow after restoring compatible
   intake.
4. Keep additive schema, `campaign_story_memory_enrollments`, operational job
   checkpoints, accepted turns, corrections, and accepted image identity. Do
   not down-migrate, bulk-reset campaigns, delete checkpoints, or truncate
   accepted state to make an old binary start.
5. Re-enable legacy intake only after no incompatible frozen job remains
   claimable. Any later reintroduction of Story Memory is a new, explicit
   capability/enrollment rollout.

## Private evidence and cleanup

Raw copied-campaign outputs, prompts, review quotes, and repair proposals must
be written only beneath an operator-selected private directory outside source
control and public-serving roots. Store a manifest containing source
authorization, copied destination, artifact paths, access policy, and expiry.
The default expiry is 30 days after the report unless the operator records a
different retention decision. Aggregate sanitized metrics may be retained
longer. Never write credentials or endpoints to the artifact manifest.

Before an authorized cleanup, run this PowerShell **dry run**. It lists only
candidate artifacts; it does not delete anything. Set both variables to paths
dedicated to the approved disposable evaluation run, never to a source campaign
or a shared asset root.

```powershell
$evaluationRoot = [IO.Path]::GetFullPath($env:T20_EVALUATION_ROOT)
$privateArtifactRoot = [IO.Path]::GetFullPath($env:T20_PRIVATE_ARTIFACT_ROOT)
if (-not (Test-Path -LiteralPath $evaluationRoot -PathType Container)) {
  throw 'The approved disposable evaluation root does not exist.'
}
if (-not (Test-Path -LiteralPath $privateArtifactRoot -PathType Container)) {
  throw 'The private artifact root does not exist.'
}
if (-not $privateArtifactRoot.StartsWith($evaluationRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Refusing a private artifact root outside the approved evaluation root.'
}
Get-ChildItem -LiteralPath $privateArtifactRoot -Force -Recurse |
  Select-Object FullName, Length, LastWriteTime
```

The release report must name the reviewed inventory, the planned targets, the
operator authorizing cleanup, and either completion or a retained-until date.
There is no deletion command in this runbook; deletion requires separate
operator authorization after review of this dry run.


## Release decisions and evaluator

Use the versioned [September 16 release-readiness record](../review/story-memory-release-readiness-2026-09-16.md) for separate R1, R2, R3 observe and R3 enforce decisions. Local deterministic verification does not approve live enrollment. Follow the [continuity evaluator runbook](story-continuity-evaluation.md) for reproducible local runs and separately authorized copied-campaign evaluation.
