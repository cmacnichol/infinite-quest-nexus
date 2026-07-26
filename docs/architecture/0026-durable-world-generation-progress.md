# Durable world-generation progress

World preview generation remains a synchronous API request, while its optional UI progress snapshots are stored in PostgreSQL. The browser supplies an opaque progress key; the API resolves the current owner on the server and reads or updates progress only when both the key and owner match.

Progress snapshots are temporary operational state. Processing records expire after 30 minutes, and completed or failed records expire after 5 minutes. Expired records are ignored on reads and removed opportunistically by the polling route. The snapshot contains only phase, percentage, status, and user-facing messages; it does not contain prompts, model output, credentials, or owner identifiers.

The database-backed service keeps API replicas stateless. A request may be handled by a different replica for every poll without losing progress visibility. Missing or expired progress is reported as an `unknown` snapshot and does not affect whether world generation succeeds or fails.

Generation logs retain operational metadata such as source kind, title, prompt length, provider identity, response identifiers, recovery state, and validation results. Full generation inputs, imported lore, raw model output, private reasoning, and credentials are intentionally excluded.
