# Diagnose provider health and errors

## Check the profile

- Confirm **Profile enabled** is selected.
- Confirm the role matches the intended story text, turn intent, embedding, or image use.
- Confirm the base URL is reachable from the application or worker container, not merely from the host browser.
- Confirm the selected model is available at that endpoint.
- Confirm the role-specific API key has not been revoked.
- Review **Request timeout (minutes)** for slow local models.

For Sogni, the request timeout applies separately to workflow submission and polling calls, while the generation deadline bounds the complete asynchronous workflow. A successful inventory request, submission, or poll marks the profile healthy. Repeated failures move it through degraded to unavailable; that health summary does not replace the durable status and error recorded on each image job.

## Interpret isolation

- Text failure can fail or make a story generation recoverable.
- Embedding failure degrades Chronicle to lexical retrieval.
- Image failure leaves the accepted story complete and can be retried independently.
- Intent failure retries once through the campaign Story text provider, then uses the campaign mode fallback without blocking story generation.

The Intent health state covers classification only. It never indicates the health of story narration, and disabling or deleting the default Intent profile returns future Auto decisions to Story text.

Safe diagnostics can include provider type, endpoint origin, model, phase, timeout, status class, correlation ID, and job ID. They must exclude credentials, prompt bodies, private reasoning, and unnecessary story content.

Sogni authentication failures, invalid requests, unsupported filter or output settings, and rejected artifacts are deterministic and require configuration changes. Rate limits, provider conflicts, request timeouts, and provider outages may be retried. When Sogni returns `Retry-After`, Nexus uses it within bounded retry limits.

Docker Desktop may reach a host LM Studio endpoint through `host.docker.internal`. Swarm workers require stable private-network DNS reachable from every eligible node.
