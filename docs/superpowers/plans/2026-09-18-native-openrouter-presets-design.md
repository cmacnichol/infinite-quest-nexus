# Native OpenRouter preset selection: evaluation and design

Status: proposed design, not implemented. Source evaluation used main `04b6b291` on 2026-09-18; final plan/default-policy review completed 2026-09-19. Companion: [implementation plan](2026-09-18-native-openrouter-presets.md).

## Outcome

Current scope is the API, supporting runtime/persistence, and legacy UI at `/nexus/#providers`. Users select **Model** or **Preset** for an OpenRouter text profile. Preset selection exposes the preset name, ordered models, provider preferences, standard prompt, effective limits, and structured-output readiness. Users no longer need to know or enter `@preset/…` syntax. Existing custom IDs continue to load safely. Native `/app/providers` and all new UI changes are deferred to a [separate later plan](2026-09-18-native-openrouter-presets-new-ui-deferred.md).

Keep OpenRouter as the preset configuration source. Resolve its configuration into a private, immutable execution plan before queuing new work; send explicit resolved settings rather than a mutable alias during execution. OpenRouter continues to route among permitted providers. Nexus owns its output contracts, prompt composition, job durability, and acceptance validation.

## Current implementation evaluation

| Layer | Current implementation | Required change |
| --- | --- | --- |
| Profile contracts | `packages/contracts/src/generation.ts` accepts a string `defaultModel`; application types expose the same string. | Add a discriminated selection and backward-compatible normalization. |
| Safe settings | `packages/application/src/providers/use-cases.ts` allowlists configuration fields. | Carry only the public selection and approved overrides; keep full preset snapshots private. |
| Persistence | `packages/database/src/provider-repository.ts` stores `default_model` and configuration JSON. | Persist a typed selection without two independent sources of truth. |
| Discovery | Application inventory ports and API support saved-profile and unsaved-candidate model discovery. | Add authenticated preset list/detail discovery for both workflows. |
| Capabilities | `response-format.ts` rejects preset aliases and missing advertisements before checking verification records. | Keep verification for direct models; use explicit preset trust without a capability gate for preset selections. |
| Capability identity | `provider-capability-identity.ts` hashes streaming flags and format policy. | Version identity to cover resolved routing; separately hash prompts and preset configuration. |
| Verification | Operator records bind model, endpoint, routing hash, schema, operation, streaming, and open tracker support. | Keep direct-model verification; distinguish preset_trusted admission from verified model evidence. |
| Schema transport | `provider-request.ts` serializes schema and `provider.require_parameters` plus `only`; it has no preset-order merge. | Serialize the complete normalized policy and each operation's contract together. |
| Durability | Queued policy captures identity; worker discovery selects the whole invocation closure; frozen contracts and per-invocation audit survive recovery. | Add a versioned resolved selection snapshot, preserve existing ledger/commit integrity, and execute frozen routes. |
| Operations | Story nonstream, optional story stream, Story-only choice repair, and continuity review have distinct contracts. | Preset route readiness must cover the job's complete closure, including repairs and rewrites. |
| Prompts | Prompt library scopes are application/campaign; serialization sends Nexus's system prompt. | Add the resolved preset prompt exactly once through explicit composition, not a competing replacement prompt. |
| Legacy UI | `apps/web/public/nexus.js` owns profile editing, discovered model picker, custom-ID entry, and model override controls. | Add selection mode and preset discovery states without rewriting the monolith. |
| New UI | `apps/web-next/src/app-shell.ts` links Setup to `/nexus/#providers`; `bootstrap.ts` has no provider page. | Deferred. Keep the existing Setup link and preserve API compatibility; no new UI implementation in this release. |
| Player surfaces | Legacy `/story` and replacement `/app/story` display generation status and use profile selection. | Update legacy preset/served-model presentation and preserve shared API compatibility. New UI presentation changes are deferred. |
| Other consumers | Text execution is shared with authoring, intent, prompt refinement, imports, and text-assisted illustration work. | Resolve presets through the shared text boundary; do not send aliases to unmodified paths. |

This is an architectural gap, not evidence that OpenRouter presets cannot honor JSON schemas. Preserve the useful existing schema catalog, strict output validation, prepared-body budgeting, durable invocation ledger, and no-format-downgrade behavior.

## External API facts

- Authenticated `GET /api/v1/presets` returns summary rows and `total_count`, most recently updated first. Pagination uses `offset` and `limit` (default 50, maximum 100). Summary rows do not contain the complete configuration. [List presets](https://openrouter.ai/docs/api/api-reference/presets/list-presets)
- `GET /api/v1/presets/{slug}` returns the selected version, configuration, and system prompt. Use the server's existing transport and credentials. [Get a preset](https://openrouter.ai/docs/api/api-reference/presets/get-a-preset)
- Alias execution uses the latest version; request settings shallow-override preset fields. Consequently, recording a version while continuing to send the alias does not freeze execution, and replacing `provider` can discard ordering. [Preset behavior](https://openrouter.ai/docs/guides/features/presets)
- Structured-output support is endpoint-specific. Send `response_format.type=json_schema` and `provider.require_parameters=true`; keep local validation because schema enforcement and accepted schema features vary. [Structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs), [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)

No authenticated preset retrieval or inference was performed for this evaluation. Confirm access with the configured credential during implementation using metadata-only requests; never assume a management key is necessary or put one in a browser.

## Selection and UI behavior

The visible label is **Text source**, with mutually exclusive **Model** and **Preset** choices. Show Preset only for OpenRouter text/intent profiles. Image and embedding profiles retain their existing controls; text-profile embedding fallback must never interpret a preset as an embedding model.

| State | Model mode | Preset mode |
| --- | --- | --- |
| Picker | Existing model search and custom-model escape hatch | Searchable preset names, slug secondary, pagination and Refresh |
| Detail | Model/context/parameter information | Selected version, ordered models, provider order/restrictions, read-only standard prompt |
| Missing selection | Require a model selection under current rules | Require a selected active preset and successful detail validation |
| Context | Existing model/profile limit behavior | Effective conservative limit across eligible candidates, plus Nexus story-budget cap |
| Output/temperature | Existing editable fields | Inherit from preset by default; explicit per-field Override controls |
| Format | Structured Outputs on by default; verify model capabilities before dispatch | Structured Outputs enabled by preset trust; standard-JSON fallback deferred |
| Discovery failure | Preserve typed/custom selection | Preserve saved preset visibly as unavailable; Retry, never switch to Model automatically |
| Switching modes | Restore unsaved model draft | Restore unsaved preset draft; save only the active branch |

Only explicit save changes the profile. Loading, Refresh, mode switches, or late network responses must not overwrite unrelated edits, keys, or the currently selected profile. Abort requests when closing/switching and discard replies with stale request identities. Changing credential, URL, provider type, or role clears the corresponding discovery evidence. Keep a selected unavailable preset visible even when it is absent from the current list page.

The legacy editor retains profile list, create, edit, enable, delete, default selection, and existing image/embedding controls. Legacy campaign/player labels show `Preset · <name>` or `Model · <model>`; profile inheritance must remain distinguishable from a per-request override. Existing legacy per-request model pickers must accept the same typed selection or offer **Use profile selection**, never replace a preset with its first model silently. Preserve compatibility for unchanged new UI clients through the API's derived legacy fields. Native provider-page creation, new UI navigation, and new UI campaign/player presentation remain deferred.

Read-only preset prompt disclosure is available only to the owner in provider settings. Do not include its contents in list summaries, public job projections, logs, or telemetry. Render all names/descriptions/prompts as text.

## Data and compatibility decisions

Public selection:

```ts
type TextModelSelection =
  | { kind: "model"; modelId: string }
  | { kind: "openrouter_preset"; slug: string };
```

Add optional `textSelection` to profile input/update/view and applicable text generation overrides. Persist it in an additive nullable `text_selection` JSONB column with a shape constraint. Existing rows read through normalization. Keep `defaultModel` as a derived compatibility projection (`modelId` or `@preset/${slug}`), atomically synchronized on writes; reject contradictory new and old fields. PATCH omission preserves selection. An old client's explicit `defaultModel` update normalizes into selection. Empty model remains possible for an unconfigured profile under existing rules.

Recognize only exact valid legacy `@preset/<slug>` values for OpenRouter text/intent profiles; retain them without remote calls during migration. Do not auto-reinterpret arbitrary custom strings or combined `model@preset` forms: show an actionable unsupported-combination message and preserve the stored value. Resolving inactive, missing, inaccessible, or malformed presets blocks new preset execution with finite diagnostics. It never silently substitutes a default model.

Store private execution plans separately from safe profile configuration. Include preset slug/version/hash, ordered candidates, complete supported provider policy, composed prompt snapshot/hash, explicit overrides, effective limits, endpoint/credential revision references, and plan protocol version. Keys themselves stay in the existing credential boundary. Portable archives include selection/overrides, never remote credentials or cached private job evidence; destination previews mark unresolved presets and require revalidation. Preserve older archive/profile readers where supported.

## Resolution, timing, and parameter precedence

1. Discover list/detail when requested in settings. Cache summaries briefly (60 seconds), scoped to owner, endpoint, credential revision, and profile or transient candidate identity. Never reuse an unsaved credential's results for another editor. Cap response bytes, nesting, pages, and array lengths; support incremental pages rather than loading every preset.
2. On save, validate selected detail; persist the reference and overrides, not a permanently pinned remote version.
3. Before enqueue, perform a fresh detail resolution outside the database transaction. Resolve operation closure, concrete candidates, budget limits, prompt and schema admission basis (verified model or trusted preset); then atomically enqueue with that exact plan after checking the profile revision. A revision race returns a refresh/retry diagnostic, without inference. Check existing idempotency results before remote discovery so repeated submissions return the original job even if OpenRouter is unavailable.
4. New jobs follow the current selected preset version. Queued/recovering jobs use their saved plan. Resume must not fetch a newer preset or rebuild a different prompt. Changed/revoked endpoint or credential authority may block dispatch; it must not silently bind a different profile.
5. Priority: Nexus operation/schema/streaming/recovery requirements and hard budget caps; explicit saved user overrides; preset values; existing application defaults. Show inherited versus overridden values. Version prompt composition and hash the final serialized payload. Do not let preset `messages`, `tools`, arbitrary transport fields, or response-format settings replace the application protocol.

Support ordinary generation parameters through an explicit typed allowlist and validation, including temperature, top_p, top_k, frequency/presence/repetition penalties, min_p, top_a, seed, and output limit where the provider accepts them. Inspect current documented fields at implementation time and test each accepted value. Reject unsupported configured fields with field names and an explanation; never silently drop them. Reject preset tools/transforms/stop sequences that alter this generation protocol in the initial release. This limitation must be visible before save and must not be hidden as generic discovery failure.

Compose the preset's style/behavior prompt with Nexus's required operation instructions; the latter retain application authority. Include preset prompt in all text invocations that inherit the selection, including repair/reviewer operations, with their own operation instructions and output contracts. No double injection: execution uses explicit settings, not the preset alias. All fallback candidates must fit the complete prepared prompt and output reservation; use a conservative shared budget or exclude incompatible candidates before sending, with visible reasons.

## Structured outputs and fallback

The user-selected source determines the admission policy. This supersedes the earlier proposal to verify every preset route.

| Selection | Structured-output admission | Metadata absent | Schema request rejected |
| --- | --- | --- | --- |
| Model | Default to required schema mode; preserve model capability and exact schema verification checks | Block default schema execution with an actionable capability diagnostic; never silently select standard JSON | Surface the failure; no standard-JSON retry |
| Preset | Trust preset support by default and request `json_schema` for every operation in the job closure | Do not block or downgrade because alias or underlying model/provider capability metadata or verification records are missing | Surface the failure; do not retry using standard JSON |

For direct models, retain advertisement checks (`response_format`, and `structured_outputs` for OpenRouter), current exact verification records, expiry, operation/streaming matching, and open-tracker compatibility. The capability verification algorithm is retained, but the default policy changes to Required. Legacy/Auto remain explicit compatibility settings only, not defaults for new selections. This phase adds no new format-fallback behavior to either selection path.

For native presets, bypass the model capability/verification gate, including underlying-route evidence checks. Build complete operation-specific schema contracts from the application's schema catalog. Record a distinct admission basis `preset_trusted`; do not fabricate a verification record or present trust as experimentally verified support. The legacy UI shows **Structured Outputs · Trusted preset** and explains that support is assumed from the selected preset. Model-only format policy controls are hidden in preset mode, retained in the model draft, and restored on switching back. New native preset selections always request schemas, even if the profile previously used model Legacy or Auto. Already queued v1 jobs are not reinterpreted.

Do not filter or reorder preset candidates based on missing or negative advertised schema capabilities. Preserve preset routing settings and add `provider.require_parameters=true` to the complete resolved provider policy together with `response_format.type=json_schema`. This delegates parameter compatibility to OpenRouter at request time; if no endpoint can satisfy it, report the provider error without dropping the schema. Trust does not bypass preset/config validation, authentication, budget checks, durable job identity, or validation of returned content.

Ordered model/provider fallback remains distinct from response-format fallback. Existing planned bounded availability fallback may advance before output while retaining the exact schema on every attempt. Authentication, malformed schema/request, refusal, cancellation, ambiguous transport timeout, and post-output failures remain terminal. A completed invalid draft uses existing review/recovery semantics, not a standard-JSON retry. Preserve preset provider order/restrictions per candidate; do not add routes outside its configured policy.

Fallback from structured output to requesting standard JSON is explicitly deferred. Add no automatic `json_object` retry, no schema-stripping retry, and no preset Auto path that silently selects standard JSON. A later plan can define that behavior separately.

### Default policy and compatibility

Both **Model** and **Preset** default to Structured Outputs in the legacy editor and server API. A UI-only default is insufficient. Apply these rules at profile creation, selection updates, per-request selection overrides, and queue capture:

| Input/state | Effective behavior for new work |
| --- | --- |
| New Model selection, no explicit format policy | `required`; verify advertised support and current schema evidence, then request `json_schema` |
| New Preset selection | `json_schema` with `preset_trusted`; no model capability gate |
| Existing profile with no stored policy | Resolve to `required` for new direct-model work; existing queued jobs keep their original snapshot |
| Existing profile explicitly saved as Legacy/Auto | Preserve as an explicit compatibility override until the user changes selection/policy; label it clearly as nondefault |
| User selects a different model or changes Model/Preset mode | Initialize Structured Outputs on; do not carry an implicit Legacy/Auto setting from the previous selection |
| API PATCH with no selection/policy change | Preserve saved explicit policy; never reset it as a side effect of renaming or credential maintenance |
| New selection sent by an old API client without policy | Apply the server Structured Outputs default, including when selection is supplied as `defaultModel` |

Unsaved explicit compatibility choices can be preserved when revisiting the same model draft, but cannot become the default of a different model. Require an explicit user action to select Legacy/Auto in advanced compatibility controls; those controls are not the planned automatic format-fallback feature. Preset mode has no standard-JSON choice in this release. An explicit old model policy must never override preset-trusted admission.

Retain existing v1 job readers and historical replay behavior. Do not globally change the low-level undefined-policy behavior used to read historical jobs; normalize new-work policy before queue capture and record the explicit effective value. Show Structured Outputs unavailable for unsupported adapters or unverified direct models rather than silently sending standard JSON. Selecting or saving such a model may remain possible, but generation must block with a useful explanation. This does not claim every provider adapter currently supports schema transport.

## Old fallback PR

PR [#132](https://github.com/cmacnichol/infinite-quest-nexus/pull/132), head `9818891b`, is draft and conflicting against reviewed main (558 main-only commits, 23 branch-only commits). Reuse reviewed ideas and bounded parsing code selectively. Its preset reader rejects any nonempty standard prompt and accepts only model/models/provider configuration. Its fallback reason allowlist is broader than the policy proposed here. Its old migrations, generation changes, UI, and incomplete verification cannot be merged wholesale. Do not close or modify that PR as part of planning.

## Acceptance and scope

- The legacy UI creates/edits/saves/reopens a preset without custom-ID entry; pagination, inaccessible selection, first-time credentials, switching modes, and stale response races have rendered tests and screenshots. New UI implementation and feature-specific screenshots are not release gates; existing API compatibility remains required.
- Selecting a preset with a standard prompt preserves it exactly once in the measured outgoing request; user profile credentials never appear in returned JSON or rendered markup.
- Both selection types default to Structured Outputs in UI and API, including omitted-policy new requests. Direct-model schema capability/verification checks remain unchanged. Presets request schemas for all operations without a local capability/verification gate; failures never trigger standard-JSON fallback in this release.
- Deterministic PostgreSQL workflows prove queued-plan stability across preset edits, restart/resume, append/replacement, duplicate submission, review Keep, and rejection isolation. Partial output cannot trigger transparent model replacement.
- All text consumers receive a resolved plan or an explicit unsupported-operation diagnostic; image/embedding calls remain independent.
- No paid probe runs automatically. A separately approved synthetic probe is needed to claim live compatibility of the user's preset/model/provider routes.
- No broad UI redesign, general prompt-library model scope, remote preset editing, or standalone cross-provider fallback editor is included.
