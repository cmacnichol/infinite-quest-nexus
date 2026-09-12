# Task 7H synthetic-provider final review

## Result

Approved. The event-coverage response shape, live-template recognition, queue handling, and no-retention boundary are correct.

The provider reads a bounded completion request body, recognizes the `scene_coverage` JSON schema or a system prompt, and returns structured coverage only for that path. It derives `event_results` from producer-shaped `required_events`, preserving each exact event ID. Normal and malformed completion requests retain the narrative fallback. Request bodies are cleared before response completion and are not included in the summary endpoint.

Queued scenarios still take precedence at completion time. The updated end handler consumes `queued.shift()` immediately before selecting its fallback, so a scenario enqueued while a request is open wins. The overlap test also establishes that the first request to finish consumes the one queued response and the later request receives its own appropriate fallback.

The guard normalizes whitespace and recognizes only a system message that starts with the known scene-coverage prompt base. This accepts the catalog default, which appends its documented coverage constraints, while avoiding a user-message match. The regression uses `PROMPT_TEMPLATE_CATALOG.scene_coverage.defaultContent` and producer-shaped `buildEventCoveragePrompt` data.

## Verification

`node_modules/.bin/vitest.cmd run tests/unit/story-only-runtime-harness.test.ts` passed: 1 file, 26 tests, 1.68 s.

The focused tests cover normal narration, catalog-default system coverage detection, JSON-schema detection, producer-shaped event IDs, queued precedence, overlapping completion endings, and an enqueue during an open request.

## Evidence boundary

This review establishes helper/unit correctness. Subsequent disposable-runtime checks used the verified helper overlay: the retained Scene job completed through its existing UI retry, and both desktop/mobile explicit Action-to-Story-Direction cases passed. Broader browser acceptance and fresh-image verification remain separate gates in the Task 7B handoff.
