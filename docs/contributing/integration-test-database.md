# Integration test database

`pnpm test:integration` automatically provisions the local PostgreSQL database
used by Infinite Quest Nexus integration tests. It is separate from both the
application Compose database and the existing application-test service in
`compose.test.yaml`.

## Local record

The first integration-test run creates the ignored file
`.env.test.local`. It is the local record of the generated test-only password
and complete `TEST_DATABASE_URL`. Do not commit or share that file.

The committed `.env.test.example` documents the
variable names without a usable password. The provisioner reuses the password
in `.env.test.local` on later runs, so existing local test data remains
available.

## Dedicated endpoint

The provisioner starts only the `integration-postgres` service:

| Setting | Value |
| --- | --- |
| Container | `infinitequest-integration-postgres` |
| Host endpoint | `127.0.0.1:55432` |
| Root database | `infinitequest_test` |
| Role | `infinitequest_test` |
| Password and connection URL | `.env.test.local` |
| Named volume | `infinitequest-test_infinitequest-integration-postgres-data` |

Every integration run first creates the container when absent, waits until it
accepts PostgreSQL connections, and recreates `infinitequest_test` if that
root database was deleted. The Vitest setup then creates a fresh temporary
database per run and removes it at the end of the run.

Run the full suite from the repository root:

```powershell
pnpm test:integration
```

Inspect only the dedicated service:

```powershell
docker.exe compose --env-file .env.test.local --project-name infinitequest-test --file compose.test.yaml ps integration-postgres
```

If Docker Engine is stopped or unavailable, integration tests fail before test
modules load with an actionable startup error. A skipped database suite is not
a successful integration run.

## Reset the integration database

The following commands delete only the dedicated integration-test container,
its dedicated volume, and its local generated credentials. They do not target
the application Compose stack, `postgres-test`, `infinitequest-app-test`, or
their volumes.

```powershell
docker.exe rm --force infinitequest-integration-postgres
docker.exe volume rm infinitequest-test_infinitequest-integration-postgres-data
Remove-Item -LiteralPath .env.test.local
```

The next `pnpm test:integration` run generates replacement credentials and
creates a new empty root database.
