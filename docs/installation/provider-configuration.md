# Choose and connect providers

Configure providers from Nexus **Providers** after installation.

| Provider type | Common role | Notes |
| --- | --- | --- |
| LM Studio native | Story text | Loaded-instance discovery and native chat support |
| OpenRouter | Story text or illustrations | Uses role-specific APIs and credentials |
| Manifest | Story text | Adapter-specific discovery and request behavior |
| OpenAI-compatible | Text, embeddings, or images | Capability depends on the selected endpoint |

Create separate profiles for **Story text**, **Chronicle embeddings**, and **Illustrations**. Never reuse an endpoint or key across roles merely because the provider brand is the same.

For Docker Desktop host services, `host.docker.internal` is commonly available. Linux Engine and Swarm installations need a stable address resolvable and reachable from the container or every worker node.

Saving an API key requires a non-empty, stable `CREDENTIAL_ENCRYPTION_KEY`. Provider keys are encrypted in PostgreSQL and are not returned to the browser.
