# ADR 0039: Implicit Prompt Override Acknowledgement

## Status

Accepted 2026-09-26. Revises the explicit-acknowledgement rule in the 2026-09-05 prompt-memory remediation spec (§ overrides) and ADR 0024's override handling.

## Context

Writer (`story_system`) and event-extension overrides were gated by an operator acknowledgement bound to the exact content hash *and* the prompt-protocol identity. Every protocol bump (v13 → v16) invalidated correct overrides and blocked generation with HTTP 409, which led to per-campaign copies that froze old prompt text. Output shape is now enforced independently of creative text: strict provider JSON schemas, application-owned contracts appended after every override, and local schema validation.

## Decision

Saving an override records its acknowledgement automatically against the current local output schema (`STORY_PROMPT_SCHEMA_VERSION`). Compatibility at enqueue requires only that the stored shape version equals the current one and that the stored content hash matches the content. Prompt-protocol changes no longer invalidate saved overrides. Frozen job snapshots and their hash proofs are unchanged.

## Consequences

An override saved against an earlier output schema, edited outside the Prompt Library, or saved before acknowledgements existed still returns 409 until re-saved. Routes without strict provider schemas (for example LM Studio or JSON-object mode) rely on the appended contracts and local validation; a creative override that describes an obsolete shape there yields rejected turns rather than a pre-dispatch block.
