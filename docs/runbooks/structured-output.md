# Structured-output compatibility probe

Prepare the bounded, synthetic native v2 compatibility batch without loading runtime configuration, opening a database connection, accessing credentials, or making HTTP requests:

```powershell
corepack pnpm probe:structured-output -- --model deepseek/deepseek-v3.2-exp --route novita/fp8 --input-usd-per-token 0.00000027 --output-usd-per-token 0.00000041 --price-observed-at 2026-09-20T23:44:13.000Z --context-tokens 163840 --max-calls 17 --max-output-tokens 2048
```

`--route` is an explicit configured-candidate input. It must come from the resolved private preset settings selected for a later probe. Public endpoint order is not preset order. The example's `novita/fp8` route does not assert that `@preset/nexus-nsfw` currently selects Novita, and an offline plan is never capability evidence.

The v2 plan covers Story in streaming and nonstreaming modes plus every active nonstreaming operation: choices, continuity review, RPG assessment, before/after event triggers, scene coverage, event coverage, world outline, world seed character, standalone character, character organizer, source extraction, source synthesis, source character, and illustration prompt refinement. Each of the 17 requests carries the production operation schema and a complete synthetic response checked by the production parser or domain schema. The report includes schema, payload, endpoint and route-configuration hashes and body sizes; it excludes bodies, prompts, credentials, endpoint URLs, profile names, headers, and provider output.

The example's conservative inference ceiling prices 163,840 input tokens plus 2,048 output tokens for each of 17 calls at the recorded Novita rates. The rounded-up ceiling is **$0.766301**. This is a hypothetical configured-case bound, not an expected bill or a price for the target preset. Prepared byte counts and the application token estimate are diagnostics, not billing bounds. The [native preset probe notes](../review/native-openrouter-presets/probe-plan.md) retain all current public route observations and identify the missing private preset version and order.

Before any separately authorized execution, resolve the target preset with the intended account and pin its version, ordered model candidates, provider order/filters, and supported parameters. Rebuild the manifest and price every explicit candidate. Do not append a public route, select the first public endpoint, or generalize one candidate's result to another candidate or the preset.

`--execute` is blocked unless an operator supplies the exact canonical model and full configured route, a UUID text profile ID, timestamped price/context evidence, exactly 17 calls and 2,048 output tokens, an input ceiling of at least 163,840, a cost ceiling at least the freshly prepared bound, the exact accepted bound, and a nonempty execution-authorization reference. The selected profile must match the prepared OpenRouter endpoint, model, route policy, Required policy, and streaming support before the first request. The CLI closes its transport and database pool in all cases.

Execution reserves a private exclusive-create report outside the repository before loading runtime credentials. Successful observations yield proposed v2 verification records only; the CLI does not install a verification file, update a profile, inspect campaign data, or query provider inventory. It stops at the first incomplete output, refusal, timeout, identity mismatch, prepared-wire mismatch, or schema/application-parser failure. An operator must review candidate-level results and install a complete record separately.
