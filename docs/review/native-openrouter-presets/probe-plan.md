# Offline native preset probe plan

This is an **unverified, no-inference planning artifact**. It does not qualify `@preset/nexus-nsfw`, DeepSeek V3.2 Exp, or any provider route. No authenticated preset metadata was fetched and no provider request was sent.

The target preset is `@preset/nexus-nsfw` and the target model is `deepseek/deepseek-v3.2-exp`. The private preset version, configured model order, provider order, exclusions, and routing policy are unavailable. A runnable exact-preset plan therefore remains deferred until an operator supplies the resolved private preset settings. Public endpoint order must never substitute for that private order.

The generated [17-operation dry run](probe-plan-2026-09-20.json) uses a single, explicit hypothetical candidate set containing `novita/fp8`. This candidate came from command input, not preset discovery. Its `$0.766301` ceiling assumes all 17 calls consume the conservative 163,840-token input ceiling plus 2,048 output tokens at the observed public Novita rates. It is a worst-case bound for that configured case only, not the price of the target preset.

The separate [public metadata observation](probe-metadata-2026-09-20.md) records all three public routes and prices: `siliconflow/fp8`, `atlas-cloud/fp8`, and `novita/fp8`. Their advertised `structured_outputs` and `response_format` capabilities do not prove the application's exact operation schemas, stream modes, or preset routing.

The offline manifest covers Story in streaming and nonstreaming modes plus every active v2 nonstreaming operation: choices, continuity review, RPG assessment, before/after event triggers, scene coverage, event coverage, world outline, world seed character, standalone character, character organizer, source extraction, source synthesis, source character, and illustration prompt refinement. Each entry carries the production schema identity, canonical prepared payload hash, body size, and a synthetic response that is checked by the production parser or domain schema. The verification-file loader round-trip is covered by the probe unit suite.

Any later execution must resolve and pin the preset's actual version and ordered candidate/provider policies, recompute candidate-specific prices and request hashes, use the CLI's explicit cost/identity/authorization guards, and record each candidate separately. A dry run must never be installed as capability evidence. One candidate's success must never be generalized to the preset or another candidate.
