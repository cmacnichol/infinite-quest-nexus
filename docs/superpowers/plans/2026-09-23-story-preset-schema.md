# Story preset JSON Schema dispatch

**Goal:** Send new Story turn requests to OpenRouter with model `@preset/<slug>` and the existing required JSON Schema, leaving routing and fallback with OpenRouter.

**Authority:** User clarification on 2026-09-23 supersedes the local concrete-candidate dispatch decision in the native preset design. No deployment or main-checkout integration is included.

**Architecture:** Freeze one preset-reference route for new Story jobs, retaining conservative resolved capacity and preset provenance. Do not send provider routing overrides or locally advance concrete model candidates. Keep historical route snapshots unchanged. Preserve schema binding, budgeting, durable attempts, credential fences, parsing, and campaign isolation. Other operations keep their existing route resolution.

- [x] RED: Resolver retains preset target; canonical serializer sends schema without provider block; executor accepts OpenRouter-selected model/provider and cannot locally fall back.
- [x] GREEN: Update Story enqueue profile, route resolution, serialization and returned identity handling narrowly.
- [x] Verify focused unit, type checks and composed PostgreSQL Story integrity coverage. No paid provider request or browser change is required.
- [x] Review diff and document historical retry behavior and remote preset mutability.
