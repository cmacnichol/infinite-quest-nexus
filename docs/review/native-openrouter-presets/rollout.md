# Native OpenRouter preset rollout and rollback

Native text execution is controlled by one runtime setting, `NATIVE_TEXT_EXECUTION_PLAN_ADMISSION`, which defaults to `false`. The API reports the same state as `capabilities.nativeTextExecutionPlans`. This branch leaves admission off and does not deploy or enable it.

## Deployment order

1. Back up the database through the normal deployment runbook and apply migrations `0097_provider_text_selection.sql`, `0098_illustration_text_execution_snapshot.sql`, `0099_worker_text_plan_protocol_fences.sql`, and `0100_prepared_text_physical_attempts.sql` in order. They add typed selection storage, private illustration snapshots, native protocol markers/worker fences, and the physical-attempt ledger. Existing rows remain compatible through nullable fields.
2. Deploy the API and every worker binary with `NATIVE_TEXT_EXECUTION_PLAN_ADMISSION=false`. Keep legacy selectors hidden because `/api/v1/meta` must still advertise `nativeTextExecutionPlans: false`.
3. Confirm every Story, authoring, illustration, and direct-consumer worker is on the upgraded binary. Historical workers cannot execute native work, and the database guard prevents their claim/reclaim updates, but they can repeatedly encounter the oldest native row and starve compatible work. Mixed-version operation is therefore a transition only, not a supported steady state.
4. Verify migrations, provider discovery, safe status projection, structured schema registry, worker protocol capability, Retry-After handling, and archive import/export diagnostics. Resolve the intended private preset version and ordered candidates before any separately approved live compatibility probe. An offline dry run is not capability evidence.
5. Enable `NATIVE_TEXT_EXECUTION_PLAN_ADMISSION=true` only after all worker pools are upgraded and the database/transport gates pass. Restart or roll the API and all workers with the same setting. Confirm `/api/v1/meta` advertises `nativeTextExecutionPlans: true` before exposing the legacy selectors.
6. Start with a bounded copied-campaign canary. Confirm the frozen selection/preset version, exact operation schema, planned-versus-dispatched body hash, physical attempt order, observed serving identity, usage/cost accounting, validated commit, next-turn replay, and no private diagnostic leakage. Keep image and embedding outcomes independent.
7. Expand gradually while watching preflight failures, schema rejections, route availability advances, deadlines, unknown serving identity, physical attempts left dispatched without outcome, duplicate idempotency keys, review/recovery checkpoints, and queue age by protocol.

Backend/contracts and worker compatibility must be present before UI admission. A selector becoming visible is a consequence of the server capability advertisement; it is not the deployment gate itself.

## Unsupported configuration response

Do not save or enqueue a preset that uses unsupported tools, transforms, stop configuration, conflicting routing order/sort, unbounded candidate arrays, or unknown context capacity without an explicit conservative cap. Preserve the saved unavailable selection for display with a finite diagnostic. Never replace it with the first model or public endpoint. A Model with missing, expired, operation-mismatched, stream-mismatched, schema-mismatched, or route-mismatched verification blocks before inference. A trusted Preset retains its configured routes and schema on every attempt; provider schema failure is terminal and visible without standard-JSON fallback.

## Rollback

1. Set `NATIVE_TEXT_EXECUTION_PLAN_ADMISSION=false` on the API and all workers, then roll them. Verify `/api/v1/meta` reports `nativeTextExecutionPlans: false`. This stops new native capture/enqueue and hides the legacy controls while leaving historical v1 and explicit Model Legacy/Auto behavior available.
2. Keep upgraded workers running long enough to drain already queued or recoverable native v2 work using its frozen plan. Settings edits, preset metadata outage, or selector removal must not reinterpret that work.
3. If draining is unsafe, stop compatible claims and explicitly pause the affected native jobs through the established operational incident process while preserving their rows, invocation records, physical attempts, prompt snapshots, and review checkpoints. Do not delete, rewrite as aliases, or blind-resend attempts whose outcome is unknown.
4. Do not reintroduce a downlevel worker while any native v2 Story, authoring, or illustration work can be claimed. The database fence prevents reinterpretation but does not guarantee fair progress in a mixed pool.
5. Roll back application binaries only after native work is drained or deliberately paused and the old binary's reader compatibility has been confirmed. Leave migrations `0097`–`0100` in place during application rollback; they are additive and contain durable authority/audit data. Destructive schema rollback requires a separate reviewed migration after retention and restore requirements are satisfied.
6. Diagnose and correct the cause with admission off. Re-enable by repeating the complete worker-upgrade, database, transport, and bounded-canary gates.

Rollback never converts a frozen native Preset to its alias, first concrete model, or plain JSON. It disables new admission and preserves durable work until a compatible worker can finish or an operator explicitly pauses it.
