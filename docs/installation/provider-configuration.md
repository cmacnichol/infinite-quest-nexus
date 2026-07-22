# Choose and connect providers

Configure providers from Nexus **Providers** after installation.

| Provider type | Common role | Notes |
| --- | --- | --- |
| LM Studio native | Story text | Loaded-instance discovery and native chat support |
| OpenRouter | Story text or illustrations | Uses role-specific APIs and credentials |
| Manifest | Story text | Adapter-specific discovery and request behavior |
| OpenAI-compatible | Text, turn intent, embeddings, or images | Capability depends on the selected endpoint |

Create separate profiles for **Story text**, **Chronicle embeddings**, and **Illustrations**. Optionally add a **Turn intent classification** profile when a small model should classify Auto input instead of the campaign Story text model. Never reuse an endpoint or key across roles merely because the provider brand is the same.

An Intent profile is used only after it is explicitly made the system default; being the sole enabled profile is insufficient. Without one, no additional provider configuration is required because Auto uses the campaign's Story text provider.

For Docker Desktop host services, `host.docker.internal` is commonly available. Linux Engine and Swarm installations need a stable address resolvable and reachable from the container or every worker node.

Saving an API key requires a non-empty, stable `CREDENTIAL_ENCRYPTION_KEY`. Provider keys are encrypted in PostgreSQL and are not returned to the browser.
