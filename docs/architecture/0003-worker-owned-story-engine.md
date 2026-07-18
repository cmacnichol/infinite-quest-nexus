# ADR 0003: The worker owns text generation and every turn bootstraps from Chronicle

Status: accepted

## Context

Browser-owned LLM state caused story loss when models changed, LM Studio response chains expired, JSON was truncated, or a provider returned mechanics language in narration. LM Studio's native response chain is useful, but it is neither portable nor authoritative. Passing a load-time `context_length` while addressing a loaded LM Studio model can also cause a duplicate instance to load.

## Decision

The API creates an idempotent PostgreSQL generation job. A worker claims it with a renewable lease, builds a controlled prompt from the campaign's immutable world version and fiction-only Chronicle scopes, calls the selected text provider, validates the response, and commits the new turn and Chronicle memory in one database transaction.

Every generation includes an authoritative database snapshot, including after a model change. A compatible LM Studio `previous_response_id` may be used only to recover the immediately preceding incomplete response. Stored model chains are scoped and diagnostic; they never replace database bootstrap.

Provider profiles are owned by the internal user. User-supplied API keys are encrypted with AES-256-GCM under a deployment master key and are never returned to the browser. Text providers and future image providers use separate profiles and credentials.

LM Studio model discovery records loaded instance IDs and context lengths. Requests target the selected instance ID and omit `context_length`; the advertised loaded length instead controls the application's prompt budget. OpenRouter, Manifest, and generic compatible providers use OpenAI-style model and chat routes.

The narrative model receives only fiction scopes and the current player action. Output must be a complete typed JSON object. Validation scans narration, choices, custom action, scratchpad, trackers, and image prompt for rolls or mechanics. Invalid, contaminated, and output-limited responses receive one compact recovery attempt. If recovery is still incomplete, the job becomes recoverable and the accepted-turn ledger remains unchanged.

## Consequences

- A browser close, API restart, worker restart, model switch, or expired LM Studio chain cannot erase accepted story state.
- Increasing only the output window is no longer the sole recovery mechanism; prompt budgeting and compact regeneration provide bounded recovery.
- Rejected raw output can be audited in private attempt records but is excluded from turns, Chronicle, embeddings, and illustration prompts.
- Worker replicas require a lease heartbeat for long local-model requests.
- The player-facing legacy UI can move to this API without changing the authoritative persistence model.
