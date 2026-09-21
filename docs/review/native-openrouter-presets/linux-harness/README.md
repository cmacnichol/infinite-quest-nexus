# Linux platform verification harness

This versioned harness runs the 13 affected integration files on Linux, with a real isolated PostgreSQL/pgvector test database and the repository's per-file database setup. The Dockerfile builds the application and installs the Playwright Chromium version pinned by the repository. The explicit configuration refuses a non-Linux host or a missing `TEST_DATABASE_URL`. No production native admission or paid inference is needed.

From the repository root:

```sh
docker build -f docs/review/native-openrouter-presets/linux-harness/Dockerfile -t infinitequest-native-presets-linux:verification .
docker run --rm --network <isolated-test-network> --env-file <private-test-env-file> -e LOG_LEVEL=silent infinitequest-native-presets-linux:verification
```

Provision the isolated database before running. The private env file must provide `TEST_DATABASE_URL` using the test container's hostname on that isolated Docker network and an explicitly named disposable test database; keep it outside version control. The repository's `tests/integration/setup-isolated-database.ts` provisions separate per-file databases. Never point this lane at a shared or production database. The image's `Dockerfile.dockerignore` allows only the listed source/build inputs and the nonsecret installation doc needed by compiled e2e tests; it excludes private SDD state, environment files, logs, scratch and runtime outputs. Check the image contents before reuse.

To rerun the separately affected platform-unit lane against the same final image:

```sh
docker run --rm --network <isolated-test-network> --env-file <private-test-env-file> -e LOG_LEVEL=silent infinitequest-native-presets-linux:verification node node_modules/vitest/vitest.mjs run tests/unit/asset-archive-service.test.ts tests/unit/ensure-local-credential-encryption-key.test.ts tests/unit/archive-io.test.ts tests/unit/portable-archive-filesystem-adapter.test.ts tests/unit/task-14e2ar-persisted-filesystem.test.ts tests/unit/task-14e3b4-secure-filesystem-adapter.test.ts tests/unit/task-14e3d-preview-session.test.ts
```

The recorded Task8 image and exact source/harness hashes are in [verification](../verification.md). That final run passed 13 files/211 integration tests with no skips and seven unit files/181 passes with one intentional inverse-platform skip. This does not imply all platform-skipped tests elsewhere in the repository ran.
