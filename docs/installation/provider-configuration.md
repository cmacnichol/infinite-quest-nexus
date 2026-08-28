# Choose and connect providers

Configure providers from **Setup → Provider Setup** after installation.

| Provider type | Common role | Notes |
| --- | --- | --- |
| LM Studio native | Story text | Loaded-instance discovery and native chat support |
| OpenRouter | Story text or illustrations | Uses role-specific APIs and credentials |
| Sogni AI | Illustrations | Dedicated asynchronous image adapter; hosted API defaults to `https://api.sogni.ai` |
| Manifest | Story text | Adapter-specific discovery and request behavior |
| OpenAI-compatible | Text, turn intent, embeddings, or images | Capability depends on the selected endpoint |

Create separate profiles for **Story text**, **Chronicle embeddings**, and **Illustrations**. Optionally add a **Turn intent classification** profile when a small model should classify Auto input instead of the campaign Story text model. Never reuse an endpoint or key across roles merely because the provider brand is the same.

## Chronicle embedding capabilities

The Chronicle embedding worker starts with the provider's runtime descriptor and applies only reviewed, bounded non-secret overrides. Campaign document/query prefixes may override model-aware defaults, but credentials stay inside the embedding-provider boundary and are never projected into retrieval configuration or telemetry.

| Safe override | Allowed value and default |
| --- | --- |
| `embeddingMaxInputTokens` | Integer from 128 through 1,000,000. Default: half the configured context window, capped at 8,192. |
| `embeddingMaxBatchItems` | Integer from 1 through 128. Default: 1 when batch support is unknown. |
| `embeddingMaxBatchTokens` | Integer from 128 through 4,000,000. Default: the effective maximum input tokens. |
| `embeddingDimensions` | Integer from 1 through 16,000. Otherwise dimensions are learned from the first complete batch and pinned for compatibility. |
| `embeddingMaxRetries` | Integer from 0 through 5. Default: 2. |

Invalid or out-of-range overrides are ignored by the safe capability projection. Provider request timeout continues to use the existing provider-profile timeout; it is not a Chronicle capability override. Changing provider, model, dimensions, prefix protocol, or other fingerprinted capability makes old chunk vectors incompatible and requires a derived rebuild. Production falls open to legacy retrieval until the new index is complete.

Disabling or deleting an embedding profile does not affect the story-text or illustration credentials and must not stop story generation. Reassign the campaign to a valid Chronicle embedding profile and rebuild. Do not delete legacy embeddings or vectors as part of provider rotation; retain them for config-only rollback until a separate cleanup is approved.

An Intent profile is used only after it is explicitly made the system default; being the sole enabled profile is insufficient. Without one, no additional provider configuration is required because Auto uses the campaign's Story text provider.

For Docker Desktop host services, `host.docker.internal` is commonly available. Linux Engine and Swarm installations need a stable address resolvable and reachable from the container or every worker node.

Saving an API key requires a non-empty, stable `CREDENTIAL_ENCRYPTION_KEY`. Provider keys are encrypted in PostgreSQL and are not returned to the browser.

For Sogni, create a bearer API key in the [Sogni account dashboard](https://dashboard.sogni.ai/api-key), then create an **Illustrations** profile. Keep the official base URL unless a trusted deployment uses a documented alternative; Nexus appends `/v1/creative-agent/workflows` for generation and `/api/v1/models/list` for the media catalog. Leave the key field blank while editing to retain the encrypted credential; Nexus never repopulates it. See [Configure Sogni](../nexus-guide/providers/sogni.md) for image, retry, polling, and artifact-handling details.

## Reconfigure providers after System Import

System Archive preserves only allowlisted, non-secret provider configuration and assignments. Imported text, image, and embedding profiles remain separate, disabled, credentialless, and at unknown health. Nexus does not copy encrypted credentials, reuse one role's key for another, or automatically match a destination profile by name.

After System Import:

1. Review the disabled-provider count in the durable Import Report.
2. Supply the destination credential for each text, image, and embedding profile independently.
3. Verify endpoint health **and model discovery** for each profile. Confirm the selected model still supports the intended role.
4. Explicitly enable the profile and review assignments before generating or rebuilding.
5. Rebuild Chronicle indexes only after the embedding profile, model, dimensions, and prefix protocol are correct.

Share links, sessions, OIDC bindings, and other external access are not provider credentials and do not transfer either; recreate those relationships separately. See [System data transfer](../nexus-guide/operations/system-data-transfer.md#import-report-and-destination-recovery).
