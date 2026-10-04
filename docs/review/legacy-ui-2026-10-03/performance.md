# Legacy UI performance evidence

**Status: matched performance gate accepted with reviewed scope exceptions; local implementation gates are verified with these exceptions.** The measurements below cover immutable baseline/candidate artifacts, a deterministic synthetic browser journey and ten read-only PostgreSQL routes. They do not represent production latency, concurrent load, a live provider, or user campaigns.

## Comparison and evidence integrity

The baseline is the fixed pre-plan product source `94853d2d859f57b8a75bb69edd532c016570dffa`, packaged in the corrected benchmark archive at `7524e48b`. The candidate is immutable final source `d3eaf34b02e4a4ba7addc88a212efcc6ee0d74bb`. The comparison comprises 12 uniquely identified reports across three valid series: the first C0 process completed its two browser reports but exited with `C0_CATALOG_EXECUTION_FAILED`; the resumed process completed the remaining ten reports with numeric exit 0. This is an accepted report union, not a single successful 12-report process. The retained raw records total 1,980: 180 browser journey samples and 1,800 PostgreSQL route samples. Every report used five warmups and 30 measured samples. Astra independently verified the report/profile hashes, report identities, release barriers, zero errors, and resource ownership. See the [accepted review](../../../.superpowers/sdd/legacy-ui-2026-10-03/Astra-T35-final-C0-performance-review.md), [raw comparison](../../../.superpowers/sdd/legacy-ui-2026-10-03/evidence/c0-resume-8e11514cb8a0491ba543f08e76437b0c/three-series-raw-comparison.json), [three-series p95 summary](../../../.superpowers/sdd/legacy-ui-2026-10-03/evidence/c0-resume-8e11514cb8a0491ba543f08e76437b0c/median-of-three-p95-comparison.json), and [prior paired browser report](../../../.superpowers/sdd/legacy-ui-2026-10-03/evidence/c0-measured-255a65c6c52b45f99dd650b7cc282e0d/series-1-baseline-browser.report.json).

Matched application containers ran Linux/amd64 with Node 26.10.0, pnpm 12.4.1, two CPU cores pinned to 0–1, 4 GiB memory/swap and 1 GiB shared memory. The browser used Google Chrome for Testing 151.0.7922.34. The PostgreSQL service was the existing gate-owned database; the application CPU/memory limits do not imply a combined database resource limit. Browser synthetic networking was isolated.

The measurement-only request overlay was identical on both sides: source hash `722FB0B86D9F517F5574900813AF1E09BC1D9ECD94A4554E44BAD71B4CA6289B`, overlay hash `0F0985AD1820B887C3E5E9D6AFCC3D88DD8501021F0D6D3DA3A812AB87439EE5`. It changes an automatic 20 ms barrier into a 10,000 ms fallback so each measured request can be explicitly released. All measured records used explicit release; this control does not claim an actual 20 ms network latency. The ephemeral Git metadata probe was unavailable inside the archive; commit/dirty values were therefore not inferred from it. The separately verified archive/image provenance supplies the source identity.

Each reported p50 and p95 is the **median of the corresponding three per-series percentile values**, not a percentile pooled across 90 records. Query counts and response payload bytes are identical between sides for every route; all ten routes recorded zero errors. Detailed per-series reports remain in the two evidence directories linked above.

## PostgreSQL read-route measurements

Each side has 90 samples per route (three series × 30). Latencies are milliseconds. “Payload” is the measured response payload size.

| Route | Baseline p50 | Candidate p50 | Baseline p95 | Candidate p95 | p95 change | Queries each | Payload bytes each |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Campaign list | 1.810 | 1.810 | 2.130 | 2.614 | +22.72% | 3 | 2,655 |
| Dashboard | 2.146 | 2.155 | 2.559 | 2.546 | −0.51% | 4 | 980 |
| Sync replace | 8.973 | 9.224 | 10.666 | 12.945 | +21.37% | 8 | 34,788 |
| Sync unchanged | 5.199 | 5.272 | 6.671 | 6.110 | −8.41% | 3 | 3,418 |
| History first page | 3.511 | 3.512 | 6.104 | 5.872 | −3.80% | 5 | 31,376 |
| History middle page | 3.517 | 3.580 | 4.744 | 4.924 | +3.79% | 5 | 31,376 |
| History last page | 3.679 | 3.880 | 4.281 | 4.577 | +6.91% | 5 | 30,586 |
| Generation poll | 1.843 | 1.960 | 2.671 | 2.365 | −11.46% | 1 | 1,126 |
| Generation result | 1.693 | 1.769 | 1.996 | 2.468 | +23.65% | 2 | 933 |
| Initial hydration | 10.392 | 10.436 | 13.091 | 12.591 | −3.82% | 11 | 37,443 |

Astra accepted three **explicit p95 exceptions** for this legacy-focused scope: Campaign list rises by 0.484 ms, Sync replace by 2.279 ms, and Generation result by 0.472 ms. The precise low-level cause remains unresolved; the evidence does not establish environment noise as the cause. The accepted source comparison found the existing read repositories, application handlers, and SQL implementation unchanged. New History routes and encapsulated static transport were added, but no query-count or payload increase explains these tails. This is source equivalence, not proof that executed SQL statement hashes matched; C0 did not capture those hashes.

The observed p95 values for the exception routes show why the report retains three separate series:

| Route | Baseline series 1 / 2 / 3 p95 ms | Candidate series 1 / 2 / 3 p95 ms |
| --- | --- | --- |
| Campaign list | 2.031 / 2.130 / 3.710 | 2.649 / 2.038 / 2.614 |
| Sync replace | 11.215 / 10.666 / 10.000 | 12.945 / 11.104 / 15.970 |
| Generation result | 1.825 / 2.191 / 1.996 | 2.860 / 2.072 / 2.468 |

Acceptance is limited to the low absolute warm-route costs, unchanged read work and payloads, zero errors, and the reviewed usability/state-safety improvements. It is an explicit risk exception, not a no-regression finding or diagnosed performance fix. A speculative product optimization is not justified without a demonstrated causal defect. Production concurrency and cold-cache behavior remain unmeasured.

## Synthetic rendered-browser comparison

These values summarize the three matched 30-sample series. The journey uses Vite and mocked API routes. It is not production HTTP or PostgreSQL latency.

| Metric | Baseline | Candidate |
| --- | ---: | ---: |
| History open p50 | 141.05 ms | 91.71 ms |
| History open p95 | 158.40 ms | 108.03 ms |
| History navigation p50 | 100.38 ms | 88.43 ms |
| History navigation p95 | 128.31 ms | 114.25 ms |
| Requests per complete journey | 27 | 20 |
| API response bytes per journey | 201,321 | 190,516 |
| History DOM nodes | 6,190 | 1,619 |
| Dashboard DOM nodes | 1,487 | 1,489 |
| Story DOM nodes | 462 | 569 |
| Cold Vite response-body bytes | 6,787,224 | 10,056,201 |
| Warm-reload Vite response-body bytes | 3,683,080 | 4,597,671 |

The baseline opens all 317 History cards; the candidate initially renders a bounded 50-card window and fetches older pages only on explicit traversal. Those openings perform different work, so their timing ratio is not an equivalent-operation speedup. The response-body increase is real in this Vite workload: cold bytes rise 48.16%, and warm-reload bytes rise 24.83%. The accepted attribution is added Vite-transformed module-graph/source-map work, including the transformed Nexus entry, Vite client, shared runtime modules, and new History, draft-storage, and continuous-reader modules. These are development response-body bytes, not wire bytes, a cache-hit measure, or a production transfer claim. The final emitted-file inventory and Vite development requested graph were reviewed; a production runtime request graph was not measured.

T29’s deterministic cases show coalesced image polling, terminal stop and unchanged rendering; T30’s synthetic 100-cumulative-snapshot stream changes narration DOM replacement count from 100 to 1. These are controlled behavior/counter observations, not provider speed, real SSE throughput, or production latency.

## Immutable artifact inventory and report-only budget

The final candidate emitted inventory was collected from verified immutable build image `f2d854774ec8b64eb3a7a4a9cdef941c20015dfa8ee1583551c6d530d229069f` in an owned network-isolated inspection, numeric exit 0, with cleanup confirmed. Inventory SHA256 is `48C1437AC2CC2932F3BF1DF1B28D210E4815B01A201CF28863E04757A8897D2A`. The emitted inventory and Vite development requested graph were reviewed. Baseline/candidate web and replacement manifests match the accepted inventories; the four manifest files are linked below. The manifest-extraction wrapper returned 1 only after producing the validated result and completing cleanup due to final console formatting. That wrapper is retained as a nonzero diagnostic, not reported as a passing outer process. The measurements below are individual files and measured entry/dependency closures; they are not a claim that every emitted file is requested on every route or a measured production-runtime request total.

| Asset | Baseline raw / gzip-9 / Brotli-11 bytes | Candidate raw / gzip-9 / Brotli-11 bytes |
| --- | --- | --- |
| Legacy Nexus `nexus.js` | 363,036 / 74,612 / 59,183 | 272,496 / 74,520 / 61,656 |
| Legacy `legacy-client.js` | 158,581 / 47,166 / 40,810 | 238,454 / 69,739 / 59,537 |
| Management bridge | 4,622 / 1,426 / 1,254 | 2,226 / 1,011 / 803 |
| Shared frontend module | `campaign-cast-api`: 300,544 / 78,110 / 64,982 | `reader-positions`: 312,752 / 81,697 / 68,026 |
| Candidate split modules | — | `legacy-section-loader`: 12,337 / 4,152 / 3,712; `legacy-tabs`: 1,441 / 750 / 657 |
| Replacement main module | 791,800 / 220,112 / 177,074 | 794,530 / 220,854 / 177,854 |
| Replacement theme bootstrap | 676 / 342 / 284 | 676 / 342 / 284 |

Static JavaScript closure gzip totals from the immutable manifests are 125,276 → 152,186 bytes for Story (+21.48%) and 154,148 → 162,130 bytes for management (+5.18%). These figures qualify the added built dependency cost; they are not a claim of an overall transfer reduction or an actual page-request total. The manifest links are [baseline web](../../../.superpowers/sdd/legacy-ui-2026-10-03/evidence/C0-manifest-extract-03759ff0201d486fb02ff796a147b17a/baseline-web-manifest.json), [candidate web](../../../.superpowers/sdd/legacy-ui-2026-10-03/evidence/C0-manifest-extract-03759ff0201d486fb02ff796a147b17a/candidate-web-manifest.json), [baseline replacement](../../../.superpowers/sdd/legacy-ui-2026-10-03/evidence/C0-manifest-extract-03759ff0201d486fb02ff796a147b17a/baseline-web-next-manifest.json), and [candidate replacement](../../../.superpowers/sdd/legacy-ui-2026-10-03/evidence/C0-manifest-extract-03759ff0201d486fb02ff796a147b17a/candidate-web-next-manifest.json). The manifest hashes match the accepted inventory hashes. Astra accepted the supplemental dependency-closure extraction and the explicit Story +21.48% and management +5.18% artifact-growth exceptions; these do not imply improved production transfer or latency.

The replacement gzip entry including theme is 220,454 bytes at baseline and 221,196 bytes on the candidate: an increase of 742 bytes (0.337%). The report-only 200 KiB budget is **not met** on either side; the candidate is 16,396 bytes above it. Astra accepted this narrow budget exception for the legacy-focused scope because it inherits the baseline excess with small incremental growth. Do not report budget compliance, a universal bundle reduction, or equality between compressed file size and actual route transfer. The separate final packaged transport checks pass for both renderers, including decoded bytes, MIME/security/cache headers, revalidation, GET/HEAD, ranges, real-socket SSE, and shared-volume ZIP behavior; they used no live provider.

## T28 decision and scope limits

T28 remains deferred. Initial hydration p95 is 13.091 ms baseline and 12.591 ms candidate with the same 11 queries and 37,443 response bytes. These measurements do not demonstrate enough benefit for another bootstrap endpoint to justify its added contract and consistency cost. Revisit the proposal only if runtime evidence identifies a remaining startup bottleneck; this does not establish that such an optimization can never help. The separate reader-readiness and optional-image-isolation browser checks remain accepted.

No deployment, live-provider request, or live-campaign mutation was part of this work. The results do not certify user-perceived performance on production networks or devices. See the [reader-bootstrap decision](reader-bootstrap-decision.md), [verification ledger](verification.md), and [rollout/rollback record](rollout.md) for adjacent gates and operational limits.
The public benchmark subsequently received the opt-in manual-release control and ENOENT-only Git metadata fallback. Its focused regression passes 2/2 and an actual Git-absent, TSX-loaded zero-warmup/one-sample smoke passes with all six delayed requests explicitly released. That smoke is preparation verification only; it adds no samples to the 12-report matched comparison and does not change its archives, images, timing boundaries or accepted exceptions.
