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

An Intent profile is used only after it is explicitly made the system default; being the sole enabled profile is insufficient. Without one, no additional provider configuration is required because Auto uses the campaign's Story text provider.

For Docker Desktop host services, `host.docker.internal` is commonly available. Linux Engine and Swarm installations need a stable address resolvable and reachable from the container or every worker node.

Saving an API key requires a non-empty, stable `CREDENTIAL_ENCRYPTION_KEY`. Provider keys are encrypted in PostgreSQL and are not returned to the browser.

For Sogni, create a bearer API key in the [Sogni account dashboard](https://dashboard.sogni.ai/api-key), then create an **Illustrations** profile. Keep the official base URL unless a trusted deployment uses a documented alternative; Nexus appends `/v1/creative-agent/workflows` for generation and `/api/v1/models/list` for the media catalog. Leave the key field blank while editing to retain the encrypted credential; Nexus never repopulates it. See [Configure Sogni](../nexus-guide/providers/sogni.md) for image, retry, polling, and artifact-handling details.
