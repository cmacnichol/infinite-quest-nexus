# Turn validation reporting

Run the bounded, read-only report against the configured database:

```sh
corepack pnpm exec tsx scripts/report-turn-validation.ts --limit 50 --format markdown
```

Use `--since 2026-09-18T00:00:00.000Z` to set a UTC lower bound and `--format json` for machine-readable output. The command starts `BEGIN READ ONLY`, fetches only bounded job and attempt metadata, and rolls the transaction back before closing the connection. It never retrieves raw narration.

The report keeps final job status separate from the earliest primary validation observation and later repair observations. Unknown means the attempt lacks a persisted completion timestamp, nonempty output, or recorded validation result; it is not counted as a pass. A completed nonempty response remains classifiable when its provider response ID is absent or its finish reason is `length`.

For a baseline, run the command once with a stable UTC `--since` value and retain the JSON output with the deployment identity. Compare only matching prompt protocol, execution hash, context bucket, streaming contract, requested model, observed model, and observed route cohorts. The first-pass denominator is the earliest initial primary response only: repairs, explicit retries, and response-contract secondary operations never improve or inflate it. Required-mode preflight unavailability is a separate outcome, not malformed model output. An initial validation result is application validation evidence only; it does not establish provider schema enforcement or narrative quality.

The report reads at most 24 scalar response-contract ledger entries per selected job. It reports the frozen policy, effective mode, schema version/hash, concrete operation, requested and observed model/route, and the saved operation-closure version. The existing execution-protocol hash remains the execution identity; the response-contract adapter protocol is `unknown` unless it is separately persisted as a bounded scalar. Missing observations remain `unknown`; latency and cost are reported only when durable scalar values exist. It does not retrieve raw ledger entries, request bodies, prompts, narration, credentials, provider error bodies, or partial output.

Each cohort includes a human-readable `promptProtocol` and `executionProtocolHash`. For enrolled Story Memory jobs, the protocol comes only from the validated frozen policy snapshot and the hash identifies the complete composite execution identity without printing it. Legacy prompt-library identities keep their existing safe label; missing or malformed historical identity data is reported as `unknown`.

For non-enrolled Story Direction work, the report verifies any stored policy hash against the frozen `generation_policy`. New marked non-enrolled rows display the v16 fact-wire label only after the frozen `storyPromptCompatibility` proof and embedded legacy identity validate. The query reads that proof metadata alone, never prompt template content.
