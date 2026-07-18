# Phase 3 checkpoint

Phase 3 adds the optional independent illustration pipeline while preserving the authoritative Story Engine, Chronicle, World Library, and campaign-version boundaries.

## Delivered

- Independent encrypted image-provider profiles and model discovery.
- OpenRouter dedicated image API support and generic OpenAI-compatible image generation support.
- Per-campaign illustration opt-in, model, size, aspect ratio, quality, output format, and bounded retry settings.
- Durable PostgreSQL image child jobs with replica-safe claims, expiring leases, retry backoff, recoverable exhaustion, and manual retry.
- Automatic job creation only after validated story acceptance.
- Manual generation and regeneration for an accepted turn.
- Base64-only raster validation and content-addressed shared asset persistence.
- Turn illustration attachment through owner-scoped asset references.
- Nexus controls for configuration, job progress, retry, regeneration, and rendered artwork.

## Isolation rules verified

- Text and image profiles use separate roles, endpoints, models, and encrypted credentials.
- An image endpoint receives only the validated fiction-only image prompt and render options.
- It does not receive story history, narration, actions, rolls, mechanics, private state, provider chains, or rejected output.
- Image endpoint failure does not roll back, duplicate, or rerun the accepted story turn.
- Retrying an image does not rerun text generation.
- Provider-only URLs and unsupported media are not fetched or persisted.
- Image jobs, profiles, credentials, and operational responses are absent from portable campaign exports.

## Verification

- TypeScript and browser-module syntax checks passed.
- 30 unit tests passed.
- 23 PostgreSQL 18 and pgvector integration tests passed.
- The integration suite covered successful asset persistence and unavailable-image-endpoint isolation.
- The production image built successfully, and an isolated PostgreSQL 18.4/pgvector application reported ready after applying migration `0009`.
- Interactive browser verification covered campaign opt-in, endpoint health display, render settings, save behavior, recoverable retry messaging, accepted-turn preservation, and the player bridge.
- Nexus and the player page rendered without horizontal overflow at the tested browser viewport.

Runtime images, generated content, provider responses, credentials, test databases, and local assets remain outside the repository.
