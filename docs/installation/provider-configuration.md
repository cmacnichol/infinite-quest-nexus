# Choose and connect providers

Configure providers from **Setup → Provider Setup** after installation.

| Provider type | Common role | Notes |
| --- | --- | --- |
| LM Studio native | Story text | Loaded-instance discovery and native chat support |
| OpenRouter | Story text or illustrations | Uses role-specific APIs and credentials |
| Sogni AI | Illustrations | Dedicated asynchronous image adapter; hosted API defaults to `https://api.sogni.ai` |
| Manifest | Story text | Adapter-specific discovery and request behavior |
| OpenAI-compatible | Text, embeddings, or images | Capability depends on the selected endpoint |

Create separate profiles for **Story text**, **Chronicle embeddings**, and
**Illustrations**. The Turn intent classification role is retired; new Story
Direction jobs do not use a classifier. Never reuse an endpoint or key across
roles merely because the provider brand is the same.

## Structured output policy for Story text

The **Structured output** control appears only on Story text profiles. It changes
the policy for new jobs; it never changes an accepted turn or rewrites a pending
job's frozen response selection.

| Policy | What a new job does |
| --- | --- |
| Legacy JSON | Uses the historical JSON path. Existing profiles that have no saved policy remain physically unchanged when saved without a policy change. |
| Use schema when verified | Uses a schema only when the server has current verification for the selected model and operation; otherwise it chooses the compatible JSON path before dispatch. |
| Require verified schema | Stops a new job before dispatch unless the server has current verification for the selected model and operation. |

The provider editor shows a server-owned advisory summary for the selected model:
**verified**, **advertised**, **unsupported**, or **unknown**. An advertised
model is not verified. Verification expires, and missing, stale, or failed
metadata is treated as unknown. The editor shows only operation coverage and
timestamps; it does not expose schemas, endpoint routing, credentials, or
operator records.

Some adapters cannot use the full schema because Story tracker objects allow
open-ended values. Nexus reports that limitation as unsupported rather than
altering tracker data. Configure a compatible profile or retain Legacy JSON.

Profile-policy edits apply to future jobs. Because the profile configuration is
part of the compatibility fingerprint, a pending job can require its prior
compatible configuration to resume; discard and explicitly re-enqueue it when
appropriate. Do not assume that a policy toggle guarantees a pending job will
continue.

## Structured response evidence limit

For new Story text requests using `auto` or `required` structured responses,
the fully serialized request body must be no more than 1,000,000 UTF-16
characters. An oversized body is rejected before the worker reserves an
invocation or calls the provider, so reduce included context or shorten the
input before retrying. This evidence limit preserves the exact request body
for recoverable provider failures; it does not change the provider context-token
limit. Historical legacy requests keep their existing request path and are
unaffected.

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

For Docker Desktop host services, `host.docker.internal` is commonly available. Linux Engine and Swarm installations need a stable address resolvable and reachable from the container or every worker node.

Saving an API key requires a non-empty, stable `CREDENTIAL_ENCRYPTION_KEY`. Provider keys are encrypted in PostgreSQL and are not returned to the browser.

For Sogni Creative Workflow or Sogni Supernet SDK, create an API key in the [Sogni account dashboard](https://dashboard.sogni.ai/api-key), then create an **Illustrations** profile. The Creative Workflow adapter appends `/v1/creative-agent/workflows` for generation and `/api/v1/models/list` for its catalog. The separate Supernet SDK adapter uses Projects and requires the `https://api.sogni.ai` origin. Its model/network controls, deadline, and submission-recovery limits differ. Leave the key field blank while editing to retain the encrypted credential; Nexus never repopulates it. See [Configure Sogni](../nexus-guide/providers/sogni.md) for image, retry, polling, and artifact-handling details.

## Reconfigure providers after System Import

System Archive preserves only allowlisted, non-secret provider configuration and assignments. Imported text, image, and embedding profiles remain separate, disabled, credentialless, and at unknown health. Nexus does not copy encrypted credentials, reuse one role's key for another, or automatically match a destination profile by name.

After System Import:

1. Review the disabled-provider count in the durable Import Report.
2. Supply the destination credential for each text, image, and embedding profile independently.
3. Verify endpoint health **and model discovery** for each profile. Confirm the selected model still supports the intended role.
4. Explicitly enable the profile and review assignments before generating or rebuilding.
5. Rebuild Chronicle indexes only after the embedding profile, model, dimensions, and prefix protocol are correct.

Share links, sessions, OIDC bindings, and other external access are not provider credentials and do not transfer either; recreate those relationships separately. See [System data transfer](../nexus-guide/operations/system-data-transfer.md#import-report-and-destination-recovery).
