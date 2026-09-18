# Phase 06 probe handoff

RED evidence:

```powershell
corepack pnpm vitest run tests/unit/probe-structured-output.test.ts
```

Initially failed because `scripts/lib/structured-output-probe.js` did not exist. The later regression RED run failed for the missing complete synthetic prompt and missing current-price guard.

GREEN evidence:

```powershell
corepack pnpm vitest run tests/unit/probe-structured-output.test.ts
corepack pnpm exec tsc -p tsconfig.json --noEmit
git diff --check
```

The focused suite passes 7 tests and direct TypeScript validation passes. `corepack pnpm check` remains blocked in its nested `pnpm check:repository` invocation because that child resolves pnpm 11.15.1 while the repository requires 12.4.1, even though `corepack pnpm --version` reports 12.4.1.

Safe dry run:

```powershell
corepack pnpm probe:structured-output -- --model deepseek/deepseek-v3.2-exp --route novita/fp8 --input-usd-per-token 0.00000027 --output-usd-per-token 0.00000041 --price-observed-at 2026-09-18T18:52:22.331Z
```

It prepares 12 shapes and reports the endpoint hash, one fixed route-config hash, strict schema metadata, individual body byte/payload hashes, a largest body of 3,088 bytes, application input estimate 1,030 (not a billing bound), context ceiling 163,840, output ceiling 2,048, and cost ceiling $0.540918. It does not load runtime configuration, connect to a database, access credentials, or send HTTP.

Concerns retained: no profile UUID or live provider observation is available; execution was not run. The optional verification records remain proposed report content only and are not installed. The runtime can only qualify an exact returned full route slug, never a provider display name.
