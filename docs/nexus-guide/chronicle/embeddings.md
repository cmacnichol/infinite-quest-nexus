# Configure semantic Chronicle retrieval

1. Create an enabled provider profile with the **Chronicle embeddings** role.
2. Select the campaign and open **Memory and context**.
3. Select **Enable hybrid semantic memory for this campaign**.
4. Choose the **Embedding provider** and **Embedding model**.
5. Optionally set **Document prefix** and **Query prefix**.
6. Set a bounded **Batch size**.
7. Select **Save & index**.

Indexing reports durable progress. Leave prefixes blank to use model-aware defaults when available; override them only when the embedding model documents another instruction format.

If semantic retrieval is disabled, incomplete, or unavailable, Chronicle falls back visibly to lexical retrieval and story generation continues. The text profile may appear as **Text fallback**, but its credentials are not copied into an independent embedding profile.
