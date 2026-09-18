# Phase 06: Provider-enforced output schema implementation plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` when delegated. Treat support as a capability to verify, not an assumption based on JSON-mode availability.

**Goal:** Determine whether a strict provider schema improves first-pass compliance on the actual configured route, then add opt-in support if verified.

**Architecture:** Add an explicit response-format capability to canonical request serialization, frozen with job/provider identity. Keep application validation authoritative. Unsupported routes retain existing JSON-object behavior without hidden redispatch of a paid or streamed request.

**Tech Stack:** TypeScript, JSON Schema, Zod, text-provider adapters, Vitest, optional authorized live smoke tests.

**Spec:** [Index](2026-09-18-turn-validation-success.md). Dependencies: phases 01, 02, and 04. This phase can conclude “unsupported or unproven; retain JSON-object mode.”

## Ownership and files

Read/modify `packages/story-engine/src/provider-request.ts`, `providers.ts`, `provider-transport.ts`, `packages/contracts/src/story-prompt.ts`, provider-profile configuration schemas in `packages/contracts/src/generation.ts`, and existing frozen provider fingerprint construction. Create `packages/story-engine/src/story-output-json-schema.ts` and `tests/unit/story-output-json-schema.test.ts` only when implementing the capability.

Extend `tests/unit/providers.test.ts`, `tests/unit/provider-request-budget.test.ts`, `tests/integration/provider-routes.integration.test.ts`, and relevant frozen-snapshot compatibility tests. Add an operational capability matrix in `docs/runbooks/turn-validation.md` rather than hard-coding model-name guesses.

## Task 1: Verify current route capability

- [ ] Record configured model/preset separately from returned model. Check current official provider documentation for strict JSON Schema support, provider routing behavior, schema restrictions, and refusal/error representation. Capture source links and retrieval date in the handoff.
- [ ] Inspect actual outgoing mode. The baseline uses `response_format: {type:"json_object"}`; verify the current implementation has not changed since planning.
- [ ] Define a synthetic minimal schema/request and expected response. Request a bounded live test only after preparing its exact request count and budget. Never send a private story merely to probe capability.
- [ ] Unsupported, unknown, ignored, or inconsistent strict-schema behavior leaves the production default unchanged. Record the evidence and stop implementation if reliable support cannot be established.

## Task 2: Canonical strict schema and request identity

**Planned capability:** `textResponseFormat: "json_object" | "json_schema"` under validated non-secret provider configuration, default `json_object`. Preserve legacy serialization options until all callers are migrated; internal schema mode must be explicit and frozen, not inferred from provider name.

- [ ] Add a RED test that a strict-mode prepared request contains `response_format.type === "json_schema"`, a named/versioned strict schema, and all required story fields. Default/legacy serialized bodies remain unchanged.
- [ ] Define a wire schema with explicit array item types: string `canonical_facts`, structured `canonical_fact_updates`, and full replacement fields. Account for defaultable `tracker_updates`/`image_prompt`, UUID syntax, nested object constraints, maximum thread count, and the target provider's supported schema subset. Application Zod/mechanics rules remain the final validator even when wire restrictions cannot express every constraint.
- [ ] Reconcile open-ended `tracker_updates` with strict schema restrictions. If the route requires every object property to be enumerated, define a separately versioned typed wire representation and a lossless boundary adapter only after documenting its contract; otherwise mark that route unsupported. Do not silently drop trackers or weaken the application schema to satisfy a provider.
- [ ] Build contract conformance tests: accepted synthetic examples validate against both representations; object facts, absent replacements, and non-array deltas fail. Do not use regex tests that merely inspect schema text.

```ts
const body = JSON.parse(prepared.body);
expect(body.response_format.type).toBe("json_schema");
expect(body.response_format.json_schema.strict).toBe(true);
expect(body.response_format.json_schema.schema.properties.canonical_facts.items.type)
  .toBe("string");
expect(prepared.payloadHash).not.toBe(jsonObjectPrepared.payloadHash);
```

`prepared` and `jsonObjectPrepared` come from the real canonical request builder with identical input and different explicit modes.

- [ ] Include the schema in serialized-body budget accounting and request hashes. Freeze mode/schema version in provider configuration/prompt compatibility. An old job keeps its captured mode after a profile setting changes.
- [ ] Test unknown capability, provider rejects schema, refusal, `{}`, malformed successful HTTP response, output limit, timeout after dispatch, and restart. Every case has a bounded recoverable/failure outcome; none silently repeats the generation in JSON-object mode.
- [ ] Preserve separate choice/continuity/repair operation schemas. A full story schema must not be attached to an operation that expects only choices or a review result.

## Exit gate

Opt-in support is verified on the actual route; fallback semantics are explicit and no hidden second call is possible. Schema overhead fits request accounting. Historical jobs resume under their frozen mode. First-pass improvement requires the phase-07 measured canary; schema conformance alone does not prove narrative quality.
