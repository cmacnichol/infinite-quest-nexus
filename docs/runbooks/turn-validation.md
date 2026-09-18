# Turn validation reporting

Run the bounded, read-only report against the configured database:

```sh
corepack pnpm exec tsx scripts/report-turn-validation.ts --limit 50 --format markdown
```

Use `--since 2026-09-18T00:00:00.000Z` to set a UTC lower bound and `--format json` for machine-readable output. The command starts `BEGIN READ ONLY`, fetches only bounded job and attempt metadata, and rolls the transaction back before closing the connection. It never retrieves raw narration.

The report keeps final job status separate from the earliest primary validation observation and later repair observations. Unknown means the attempt did not contain a complete, classifiable provider response; it is not counted as a pass.
