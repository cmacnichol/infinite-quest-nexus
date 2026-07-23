# ADR 0024: Central Prompt Library

## Decision

Application-owned instructions for text and image models are defined by a shared prompt catalog and managed from Setup → Prompt Library. Users can save application defaults and campaign overrides for runtime templates. The effective order is campaign override, application default, then shipped default.

## Consequences

Dynamic world, campaign, and player content remains structured provider input rather than prompt-template interpolation. A limited, documented placeholder set is used only for engine-generated values; saves reject unknown placeholders or the removal of required placeholders. The server builds previews from safe sample data and the same structured-input builders used by campaign runtime prompts without calling a provider.

Prompt changes apply to newly queued work: durable story and illustration-refinement jobs retain a prompt snapshot and hash so retries are reproducible. Story-provider chain identity hashes the complete campaign-runtime instruction set rather than only the story-writer prompt.

Database ownership is enforced both in service queries and by a composite `(campaign_id, owner_user_id)` foreign key, preventing campaign overrides from crossing user boundaries.

Unsafe model output remains subject to existing schema, fiction-boundary, and ownership validation. The legacy campaign illustration refinement column remains for a compatibility period; its values are migrated to campaign prompt overrides and are no longer the source used by new refinement jobs.
