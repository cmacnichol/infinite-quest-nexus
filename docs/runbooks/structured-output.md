# Structured-output compatibility probe

Prepare the bounded, synthetic OpenRouter compatibility batch without loading runtime configuration, opening a database connection, accessing credentials, or making HTTP requests:

```powershell
corepack pnpm probe:structured-output -- --model deepseek/deepseek-v3.2-exp --route novita/fp8 --input-usd-per-token 0.00000027 --output-usd-per-token 0.00000041 --price-observed-at 2026-09-18T18:52:22.331Z
```

The plan covers two synthetic scenarios across `story`, `choices`, and `continuity_review`, in streamed and non-streamed forms: 12 requests total. It uses the registry’s strict schema and the full `novita/fp8` route for each body. It reports hashes and sizes, never bodies, prompts, credentials, endpoint URLs, profile names, headers, or provider output.

Its conservative inference ceiling is the advertised 163,840-token context limit priced as input plus 2,048 output tokens for each request. At the recorded prices this is $0.54091776, rounded up to **$0.540918**. Prepared byte counts and any token estimate are diagnostic only; they are not a billing bound.

`--execute` is intentionally blocked unless an operator supplies the exact canonical model and full route, a UUID text profile ID, current timestamped price/context evidence, exactly 12 calls and 2,048 output tokens, an input ceiling of at least 163,840, a cost ceiling at least $0.540918, an exact `--accept-max-cost-usd 0.540918`, and a nonempty execution-authorization reference. It loads only that profile through the existing worker credential transport, verifies OpenRouter identity, endpoint identity, model, and fixed route configuration before the first request, and closes the transport and pool in all cases.

Successful execution creates only proposed `SchemaVerification` records in the optional, private, exclusive-create `--report` artifact. It does not install `TEXT_SCHEMA_VERIFICATION_FILE`, update a profile, inspect campaign data, or query provider inventory. The probe stops at the first missing terminal completion, malformed output, parser or schema failure, mismatched prepared wire, missing observed model/route, or display-name route. Review the report and install a complete record separately.
