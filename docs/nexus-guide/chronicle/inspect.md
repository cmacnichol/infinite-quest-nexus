# Inspect Chronicle health

Select a campaign, then select **Chronicle** in the settings rail.

The Chronicle badge can report **Chronicle available**, **Semantic Retrieval off**, **Indexing**, **Ready**, **Partially indexed**, **Provider degraded**, **Provider unavailable**, **Fallback active**, **Chunk protocol outdated**, or **Rebuild required**. Metrics summarize accepted history, derived records, embedding progress, and effective retrieval configuration.

Chronicle is campaign-scoped. A campaign's records must never appear in another campaign's prompt, even when both use the same world or provider.

Embeddings and summaries are derived. The accepted-turn ledger and campaign state remain authoritative.
