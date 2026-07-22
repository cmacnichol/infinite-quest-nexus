# Diagnose provider health and errors

## Check the profile

- Confirm **Profile enabled** is selected.
- Confirm the role matches the intended story text, turn intent, embedding, or image use.
- Confirm the base URL is reachable from the application or worker container, not merely from the host browser.
- Confirm the selected model is available at that endpoint.
- Confirm the role-specific API key has not been revoked.
- Review **Request timeout (minutes)** for slow local models.

## Interpret isolation

- Text failure can fail or make a story generation recoverable.
- Embedding failure degrades Chronicle to lexical retrieval.
- Image failure leaves the accepted story complete and can be retried independently.
- Intent failure retries once through the campaign Story text provider, then uses the campaign mode fallback without blocking story generation.

The Intent health state covers classification only. It never indicates the health of story narration, and disabling or deleting the default Intent profile returns future Auto decisions to Story text.

Safe diagnostics can include provider type, endpoint origin, model, phase, timeout, status class, correlation ID, and job ID. They must exclude credentials, prompt bodies, private reasoning, and unnecessary story content.

Docker Desktop may reach a host LM Studio endpoint through `host.docker.internal`. Swarm workers require stable private-network DNS reachable from every eligible node.
