# Recover Chronicle indexing

Chronicle rebuilds and embedding indexing are durable worker jobs. Story generation can use lexical fallback while vectors are unavailable or incomplete.

For a degraded campaign:

1. Inspect **Memory and context** health and progress.
2. Confirm the embedding profile, model, prefixes, and batch size.
3. Confirm endpoint reachability from the worker.
4. Select **Rebuild memory** when derived text records are inconsistent.
5. Select **Save & index** after correcting semantic configuration.

Never repair Chronicle by editing accepted-turn narration. Derived summaries, facts, threads, and vectors must be rebuilt from authoritative campaign data.
