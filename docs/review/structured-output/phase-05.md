# Structured output phase 05 handoff

The provider editor now offers Legacy JSON, Use schema when verified, and Require
verified schema. Existing profiles without a policy retain their original
configuration shape on a no-op save. Discovery supplies advisory operation
coverage and timestamps; unsaved configuration changes, cached picker choices
and late responses cannot create verification for a different profile.

Saved generation status exposes a bounded response-format projection. Both
Story interfaces show the saved policy, operation/mode and finite recovery
explanation. Metadata-only status changes propagate through reconciliation.
Keep, explicit Retry and local fact-format repair retain their existing
server-side authority checks. Changing a profile does not rewrite a job's
frozen selection or guarantee it can resume under the new configuration.

The read-only validation report separates initial application validation from
repairs and final acceptance. New dimensions include policy, mode, schema,
streaming, operation and observed model/route. Missing observations remain
unknown. Current durable data cannot establish per-invocation transport failure,
latency or cost; the report says so and provides a separate validated job-level
transport/timeout count. Required preflight failure is not malformed output.

## Verification checkpoints

- `bde35b85ab419015a434763d721af0458c185b4a`: 135/135 integration tests across
  eight files passed against a fresh isolated PostgreSQL database. This includes
  actual SQL projection tests and the earlier durable generation workflows.
- `d1c6af87ab2d0f20d88c6d1868036353caf9bee1`: complete repository checks and
  builds passed in the pinned Linux environment. Build reports its existing
  nonfatal bundle-size warning.
- The same candidate passed 112 paired/settings/recovery browser tests; one
  existing Web Awesome opt-in assertion was skipped because that explicit
  server mode was not selected. Desktop and 390x844 fixtures contain synthetic
  content only. This is rendered fixture evidence, not live backend/provider
  evidence.
- The initial combined browser harness lacked Corepack and stopped before
  tests. A guarded wrapper uses the image's existing pnpm 12.4.1; the unchanged
  candidate then passed. No application change concealed the harness failure.
- Root independently passed 16 focused reporting tests at `7bec5b66`. Later
  review identified two additional metrics corrections and required explicit
  stale-capability regression coverage; final correction evidence follows.

Source review confirmed the SQL boolean-cast correction and both settings
capability fences. The paired Story review found no recovery-authority change.
Root screenshot review found desktop Settings captures obscured by the model
picker; corrected captures must show the actual controls before this phase is
accepted.

No paid model calls, production queries, deployment, push or main integration
were performed. Phase 06 remains responsible for the offline compatibility
probe, complete release checks and final independent reviews.

Final correction candidate: `6ab6247f33ed637899a2be89577b142df21504b4`.
Root independently passed 17/17 focused reporting tests and the full TypeScript
check. Its immutable browser suite passed **113 tests with one existing opt-in
skip**, exit 0. The added scenario proves both saved-profile refresh and cached
model selection remain unknown after capability-relevant edits. Required
unsupported-adapter failures now count as preflight failures, and job-level
transport/timeout counts require a validated diagnostic. Scoped independent
rereview found both reporting findings addressed and no new fix breakage.

The two final desktop Settings screenshots were copied from that exact immutable
browser run and visually inspected. Current UI console collection excludes a
generic fixture 404 message; assertions still fail on other console/page errors.
This limits what the console check proves and does not imply live asset-server
verification. All primary interactions and rendered controls passed.
