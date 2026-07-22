# ADR 0008: Illustrations use an independent durable provider pipeline

Status: accepted for Phase 3

## Context

Story text and generated artwork have different availability, model, credential, latency, retry, and storage requirements. Routing illustrations through the selected text endpoint would couple story acceptance to an optional service and could expose text-provider credentials to another provider. Provider-hosted image URLs may also expire and are unsafe to fetch blindly from worker output.

## Decision

Each campaign may opt into illustrations through a `campaign_illustration_configs` record that selects an enabled `image` provider profile, model, output dimensions, aspect ratio, quality, format, and bounded attempt count. Image profiles retain their own encrypted credential and endpoint. They are never inferred from or copied from a text profile.

After a story turn and its Chronicle memory pass validation, the same commit may enqueue an `image_jobs` child record containing only the already-validated fiction-only `image_prompt`. The worker calls the image endpoint after story acceptance. Image success, retry, exhaustion, or failure cannot change generation-job completion, accepted narration, campaign state, mechanics, or Chronicle memory.

OpenRouter profiles use its dedicated `/api/v1/images` generation API and `/api/v1/images/models` inventory. Other compatible profiles use `/v1/images/generations` and the standard model inventory. Nexus requires base64 raster output (`png`, `jpeg`, or `webp`), writes it to content-addressed shared asset storage, and attaches the asset to the turn. Temporary provider URLs and SVG are rejected rather than fetched.

The durable image queue also supports owner-scoped world-cover jobs. They use the default image provider and its default model, attach the completed asset to the world, and do not require or create a campaign. World-cover failures never block world editing or publication. Because they are not campaign operations, their charges are retained on the image job but are not attributed to a campaign ledger.

OpenRouter image discovery applies a second local output-modality check even though the dedicated inventory is image-only. When OpenRouter advertises endpoint pricing, Nexus labels it as image pricing by billable unit (for example, per image or megapixel); text model token prices remain categorized as text pricing.

Image jobs are claimed with PostgreSQL row locks and expiring leases. Transient errors retry with bounded backoff up to the campaign setting, then become explicitly recoverable. A manual retry resets only the image job. Manual regeneration creates a new job and replaces the turn's current illustration only after the new asset succeeds.

## Integrity boundary

The image provider receives the fiction-only prompt and selected render options. It never receives narration history, actions, Chronicle context, rolls, stats, targets, mechanics records, scratchpads, trigger diagnostics, raw model responses, rejected output, or text-provider credentials.

## Consequences

- Swarm API and worker replicas coordinate image work through PostgreSQL without sticky sessions.
- CephFS-backed asset storage remains required on every worker node eligible to process image jobs.
- Disabling or misconfiguring illustrations cannot block story generation.
- Portable campaign exports do not include provider profiles, credentials, image jobs, or raw provider responses.
