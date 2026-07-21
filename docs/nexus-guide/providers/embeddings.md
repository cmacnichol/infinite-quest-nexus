# Configure an embedding provider

Create a separate profile with the **Chronicle embeddings** role. Select an endpoint and model that supports compatible embedding requests.

Embedding settings include independent credentials, health, model discovery, batch size, and task prefixes. LM Studio exposes compatible embeddings through `/v1/embeddings`; other compatible providers may require their own base URL conventions.

Do not assume a story text model also supports embeddings. Semantic failure degrades to lexical Chronicle retrieval and does not prevent story generation.

After saving the profile, enable it on each intended campaign under **Memory and context** and select **Save & index**.
