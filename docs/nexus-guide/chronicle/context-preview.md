# Build a context preview

1. Open a campaign's **Memory and context**.
2. Enter a **Context budget**.
3. Select a **Compression** mode.
4. Optionally enter **Current action or retrieval query**.
5. Select **Build context preview**.
6. Select **View context preview**.

The preview shows the controlled context selected for story generation. It can include immutable world canon, campaign living canon, selected Chronicle memories, and the current scene.

It excludes rolls, private mechanics records, scratchpads, rejected output, parser diagnostics, credentials, and raw provider responses. Treat the remaining fiction as private campaign content when sharing diagnostics.

## Interpret retrieval diagnostics

The preview's `retrieval` summary describes only the production path. It can report the effective implementation and mode, semantic availability, a fixed fallback reason, the count of scope-eligible candidates, embedded and ranked counts when applicable, query expansion, query-cache hit/request counters, and chunked diversity diagnostics. The selected `scopes.chronicle` entries expose the parent memory ID, turn and ordinal, kind, selection reason, bounded relevance values, entities, rendered fiction, and estimated tokens used by that preview.

The preview does not return shadow candidate lists, comparisons, or internal `selectedForProduction` flags. Those flags exist only in safe retained telemetry, where exactly one implementation is marked as production. Shadow lexical, legacy-hybrid, and chunked ranks cannot add, remove, or reorder the preview's production memories.

Safe retained diagnostics may include hashes, scoped IDs, ranks, fixed reasons and fallback codes, protocol/profile versions, latency and token estimates, provider fingerprints, selection flags, and cost identifiers. They do not store the raw retrieval query, current action, narration, prompt, response, credential, endpoint, or raw provider error. Cache hit/request counters describe the independently owned query-embedding cache and do not change ranking behavior.

When a preview falls back, compare the health state with the production implementation. An incomplete chunk index uses the complete legacy path, so production output never mixes partial chunk results with legacy candidates. There is no reranking stage; the chunked implementation uses weighted rank fusion and deterministic diversity controls.
