# Disaster-Recovery Tooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add operator-only tooling that creates, inspects, verifies, restores, and drill-proves a coordinated PostgreSQL-and-assets Recovery Set while keeping encryption material under separate custody.

**Architecture:** A TypeScript CLI orchestrates explicit capture/restore adapters, hashes streamed components, and writes a strict machine-readable manifest and report. The first fully automated adapter targets the repository Compose topology; generic local inputs and documented Swarm procedures use the same manifest verifier without embedding cloud storage, scheduling, retention, or bespoke encryption.

**Tech Stack:** Node.js 22, TypeScript 7/tsx, Zod 4, Docker Compose CLI, container-bundled PostgreSQL 18 tools, archiver/unzipper, Vitest 4, isolated Compose projects.

**Spec:** `docs/superpowers/specs/2026-07-26-portable-campaign-and-system-archives-design.md`

## Global Constraints

- Disaster-Recovery Backup is separate from System Archive and never appears in browser Data Transfer.
- Capture requires stopped application writers/workers or an explicitly supported atomic database-and-volume snapshot.
- Recovery Sets contain no credential-encryption key or deployment secret; the manifest lists required external secrets only by name.
- Recovery data must stream to operator-selected paths or stdout-compatible sinks without logging database URLs, keys, story text, or tokens.
- Restore targets isolated empty database and asset storage and never overwrites the only production copy.
- Cross-version restore is not promised; restore first into a matching or explicitly compatible environment, verify, then migrate forward.
- External tools own encrypted storage/transport, schedules, replication, and retention.
- Automated deletion must never remove the last Drill-Proven Recovery Set.
- Apply strict TDD; a simulated manifest check is not a Restore Drill.

---

## File and interface map

### Create

- `packages/contracts/src/recovery.ts` — Recovery Set manifest/report schemas and Created/Verified/Drill-proven states.
- `scripts/recovery.ts` — CLI command parsing and safe output.
- `scripts/lib/recovery-types.ts` — adapter interfaces and commands.
- `scripts/lib/recovery-manifest.ts` — canonical JSON, component hashing, inventory validation.
- `scripts/lib/recovery-process.ts` — `spawn`-based no-shell process streaming and redaction.
- `scripts/lib/recovery-compose.ts` — standard Compose capture/restore adapter.
- `scripts/lib/recovery-local.ts` — explicit local dump/assets adapter for externally captured components.
- `tests/unit/recovery-contracts.test.ts`
- `tests/unit/recovery-cli.test.ts`
- `tests/unit/recovery-process.test.ts`
- `tests/integration/disaster-recovery.integration.test.ts`
- `docs/operations/disaster-recovery-cli.md`

### Modify

- `packages/contracts/src/index.ts` — export recovery contracts.
- `package.json` — add `recovery` script.
- `docs/operations/backup-restore.md` — route exact recovery through the CLI/runbook and retain limitations.
- `docs/operations/swarm/secrets-and-configs.md` — separate custody and Swarm capture/cutover requirements.
- `docs/.vitepress/config.ts` — navigation.
- `compose.yaml` only if the isolated drill needs an explicit non-production profile; do not rename existing services or volumes.

### Stable interfaces

```ts
export type RecoveryEvidenceState = "created" | "verified" | "drill_proven";

export type RecoveryComponent = Readonly<{
  kind: "postgresql" | "assets";
  relativePath: string;
  byteLength: number;
  sha256: string;
}>;

export interface RecoveryCaptureAdapter {
  assertWritersStopped(signal: AbortSignal): Promise<void>;
  capturePostgres(output: Writable, signal: AbortSignal): Promise<RecoveryDatabaseInventory>;
  captureAssets(output: Writable, signal: AbortSignal): Promise<RecoveryAssetInventory>;
}

export interface RecoveryRestoreAdapter {
  assertEmptyTargets(signal: AbortSignal): Promise<void>;
  restorePostgres(input: Readable, signal: AbortSignal): Promise<void>;
  restoreAssets(input: Readable, signal: AbortSignal): Promise<void>;
  verifyApplication(signal: AbortSignal): Promise<RecoveryDrillChecks>;
}
```

---

### Task 1: Define strict Recovery Set contracts and safe process execution

**Files:**
- Create: `packages/contracts/src/recovery.ts`
- Create: `scripts/lib/recovery-types.ts`
- Create: `scripts/lib/recovery-process.ts`
- Create: `tests/unit/recovery-contracts.test.ts`
- Create: `tests/unit/recovery-process.test.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**
- Consumes: canonical JSON conventions and structured logging redaction.
- Produces: `recoveryManifestSchema`, `recoveryReportSchema`, capture/restore adapter interfaces, `spawnStreamed`.

- [ ] **Step 1: Write failing manifest and redaction tests**

```ts
expect(recoveryManifestSchema.parse(manifest).evidenceState).toBe("created");
expect(() => recoveryManifestSchema.parse({ ...manifest, secrets: { credentialKey: "value" } })).toThrow();
expect(redactProcessError(new Error("postgres://user:password@db/app"))).not.toContain("password");
```

- [ ] **Step 2: Run RED**

```powershell
pnpm exec vitest run tests/unit/recovery-contracts.test.ts tests/unit/recovery-process.test.ts
```

- [ ] **Step 3: Implement strict manifest/report contracts**

```ts
export const recoveryManifestSchema = z.object({
  format: z.literal("infinite-quest-recovery-set"),
  formatVersion: z.literal(1),
  evidenceState: z.enum(["created", "verified", "drill_proven"]),
  createdAt: z.string().datetime(),
  application: z.object({ version: z.string(), migration: z.string() }).strict(),
  database: recoveryDatabaseInventorySchema,
  assets: recoveryAssetInventorySchema,
  components: z.array(recoveryComponentSchema).length(2),
  requiredExternalSecrets: z.array(z.enum(["CREDENTIAL_ENCRYPTION_KEY", "DATABASE_URL"])),
  captureMode: z.enum(["maintenance", "atomic_snapshot"])
}).strict();
```

No schema accepts secret values, password hashes outside the database dump, arbitrary commands, or absolute source paths.

- [ ] **Step 4: Implement no-shell streamed process execution**

```ts
export async function spawnStreamed(input: Readonly<{
  executable: string;
  args: readonly string[];
  stdin?: Readable;
  stdout?: Writable;
  safeLabel: string;
  signal: AbortSignal;
}>): Promise<void>;
```

Use `spawn(executable, args, { shell: false, windowsHide: true })`, bounded stderr capture, abort termination, and redacted safe labels. Never log argument arrays containing connection material.

- [ ] **Step 5: Run GREEN**

```powershell
pnpm exec vitest run tests/unit/recovery-contracts.test.ts tests/unit/recovery-process.test.ts
pnpm check
```

- [ ] **Step 6: Commit**

```powershell
git add packages/contracts/src/recovery.ts packages/contracts/src/index.ts scripts/lib/recovery-types.ts scripts/lib/recovery-process.ts tests/unit/recovery-contracts.test.ts tests/unit/recovery-process.test.ts
git commit -m "Define disaster recovery contracts"
```

### Task 2: Create, inspect, and verify Recovery Sets

**Files:**
- Create: `scripts/lib/recovery-manifest.ts`
- Create: `scripts/lib/recovery-compose.ts`
- Create: `scripts/lib/recovery-local.ts`
- Create: `scripts/recovery.ts`
- Create: `tests/unit/recovery-cli.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 1 contracts/process runner, repository `compose.yaml` service names.
- Produces: `pnpm recovery -- create|inspect|verify`, canonical manifest and hashed components.

- [ ] **Step 1: Write failing CLI tests**

Assert unknown commands fail, existing output is never overwritten without `--replace`, `create` refuses an unconfirmed maintenance state, partial component failure removes only the new temporary directory, inspect is read-only, and verify detects truncation/hash mismatch/tool unreadability.

- [ ] **Step 2: Run RED**

```powershell
pnpm exec vitest run tests/unit/recovery-cli.test.ts
```

- [ ] **Step 3: Implement canonical manifest and atomic directory publication**

```ts
const layout = {
  manifest: "manifest.json",
  database: "components/postgresql.dump",
  assets: "components/assets.tar"
} as const;
```

Write beneath a new sibling temporary directory, stream and hash each component, validate the completed manifest, then atomically rename to the requested output. Never follow symlinked output ancestors.

- [ ] **Step 4: Implement the standard Compose capture adapter**

For `compose.yaml`, require the operator to stop `infinitequest-app` first and prove it is not running. Keep `postgres` running for the dump.

```powershell
docker compose exec -T postgres pg_dump -U infinitequest -d infinitequest -Fc
docker compose run --rm --no-deps --entrypoint tar infinitequest-app -C /var/lib/infinitequest -cf - assets
```

Invoke these as argument arrays, not shell strings. Record PostgreSQL and pgvector versions, migration watermark, initial-owner UUID/counts, asset inventory, and source image/container identifiers.

- [ ] **Step 5: Implement inspect and verify**

Verify canonical manifest schema, component hashes/lengths, `pg_restore -l` readability, tar entry safety, inventory agreement, and required external-secret names. Upgrade report state from Created to Verified in a separate report file; never rewrite component bytes.

- [ ] **Step 6: Add CLI script and run GREEN**

```json
"recovery": "tsx scripts/recovery.ts"
```

```powershell
pnpm exec vitest run tests/unit/recovery-cli.test.ts tests/unit/recovery-contracts.test.ts tests/unit/recovery-process.test.ts
pnpm check
```

- [ ] **Step 7: Commit**

```powershell
git add scripts/recovery.ts scripts/lib/recovery-manifest.ts scripts/lib/recovery-compose.ts scripts/lib/recovery-local.ts tests/unit/recovery-cli.test.ts package.json
git commit -m "Create verifiable recovery sets"
```

### Task 3: Restore only into isolated empty targets

**Files:**
- Modify: `scripts/lib/recovery-compose.ts`
- Modify: `scripts/recovery.ts`
- Modify: `tests/unit/recovery-cli.test.ts`
- Create: `tests/integration/disaster-recovery.integration.test.ts`

**Interfaces:**
- Consumes: Verified Recovery Set, separately supplied secret files, isolated Compose project name.
- Produces: `pnpm recovery -- restore`, restore report, unchanged source set.

- [ ] **Step 1: Add failing destructive-safety and restore tests**

Assert restore refuses the default/source Compose project, running application writers, non-empty database, non-empty asset volume, missing external key, incompatible PostgreSQL/pgvector versions, and any set without Verified evidence.

- [ ] **Step 2: Run RED**

```powershell
pnpm exec vitest run tests/unit/recovery-cli.test.ts tests/integration/disaster-recovery.integration.test.ts
```

- [ ] **Step 3: Implement exact isolated restore**

```powershell
pnpm recovery -- restore --set .\recovery-set --compose-project infinitequest-drill-20260824 --credential-key-file C:\secure\credential-key
```

Create fresh project-scoped volumes, restore with container-bundled matching tools using `pg_restore --clean --if-exists --no-owner --exit-on-error`, extract only safe relative asset tar entries, mount the separately supplied credential key, then start the isolated application.

- [ ] **Step 4: Preserve the Recovery Set and emit a separate report**

Hash the components before and after restore and assert equality. Write the restore report outside the set or under a dedicated append-only reports directory without changing manifest/components.

- [ ] **Step 5: Run GREEN**

```powershell
pnpm exec vitest run tests/unit/recovery-cli.test.ts tests/integration/disaster-recovery.integration.test.ts
```

- [ ] **Step 6: Commit**

```powershell
git add scripts/lib/recovery-compose.ts scripts/recovery.ts tests/unit/recovery-cli.test.ts tests/integration/disaster-recovery.integration.test.ts
git commit -m "Restore recovery sets safely"
```

### Task 4: Prove application recovery with an isolated drill

**Files:**
- Modify: `scripts/lib/recovery-compose.ts`
- Modify: `scripts/recovery.ts`
- Modify: `tests/integration/disaster-recovery.integration.test.ts`

**Interfaces:**
- Consumes: restored isolated environment from Task 3.
- Produces: Drill-proven report with application-level checks and timestamps.

- [ ] **Step 1: Add failing drill assertions**

Require readiness, migration inventory, initial-owner UUID/ownership, world/campaign/accepted-turn counts, representative narration continuity, Original Asset hashes and HTTP delivery, provider credential decryption through a safe model-discovery check, Chronicle memory presence, and derived rebuild eligibility.

- [ ] **Step 2: Run RED**

```powershell
pnpm exec vitest run tests/integration/disaster-recovery.integration.test.ts
```

- [ ] **Step 3: Implement drill checks and cleanup ownership**

```ts
export type RecoveryDrillChecks = Readonly<{
  readiness: "passed";
  migrations: "passed";
  ownership: "passed";
  stories: "passed";
  assets: "passed";
  credentials: "passed";
  chronicle: "passed";
}>;
```

Mark Drill proven only when every check passes. Keep the failed isolated target for operator diagnosis unless `--cleanup-on-failure` is explicitly supplied; cleanup may remove only the unique drill project created by the command.

- [ ] **Step 4: Add last-drill-proven retention metadata**

Emit a machine-readable `drill-proven.json` referencing component hashes. Do not implement deletion; document that external retention must preserve at least this referenced set.

- [ ] **Step 5: Run GREEN**

```powershell
pnpm exec vitest run tests/integration/disaster-recovery.integration.test.ts
pnpm check
```

- [ ] **Step 6: Commit**

```powershell
git add scripts/lib/recovery-compose.ts scripts/recovery.ts tests/integration/disaster-recovery.integration.test.ts
git commit -m "Prove isolated recovery drills"
```

### Task 5: Document operations and verify platforms

**Files:**
- Create: `docs/operations/disaster-recovery-cli.md`
- Modify: `docs/operations/backup-restore.md`
- Modify: `docs/operations/swarm/secrets-and-configs.md`
- Modify: `docs/.vitepress/config.ts`
- Modify: `docs/superpowers/specs/2026-07-26-portable-campaign-and-system-archives-design.md` only if verified behavior requires clarification.

**Interfaces:**
- Consumes: verified CLI flags, reports, Compose commands, and known Swarm limitations.
- Produces: exact create/verify/restore/drill runbook and honest platform support statement.

- [ ] **Step 1: Document Compose maintenance capture**

Provide exact stop, create, inspect, verify, restore, drill, cutover, and restart commands. State where the key must be supplied and that it never belongs in the Recovery Set.

- [ ] **Step 2: Document Swarm integration boundaries**

Describe stopping API/worker writers, using an operator-approved PostgreSQL and volume snapshot/export process, feeding externally captured components through the local adapter, verifying secrets/configs separately, and restoring to a new stack. Do not claim automated Swarm proof unless a live drill was run.

- [ ] **Step 3: Document encrypted storage and retention ownership**

Show streaming/path integration points for operator-approved encrypted tooling without recommending a vendor. State that Nexus neither schedules nor deletes sets and that external retention must preserve the last Drill-Proven set.

- [ ] **Step 4: Run full verification**

```powershell
pnpm exec vitest run tests/unit/recovery-contracts.test.ts tests/unit/recovery-process.test.ts tests/unit/recovery-cli.test.ts
pnpm exec vitest run tests/integration/disaster-recovery.integration.test.ts
pnpm --dir docs build
pnpm check
pnpm build
git diff --check
```

- [ ] **Step 5: Record platform evidence honestly**

List Compose/PostgreSQL/pgvector/Windows/Linux versions actually exercised. Mark unrun Swarm, platform, Docker, database, or credential checks unverified.

- [ ] **Step 6: Commit**

```powershell
git add docs/operations docs/.vitepress/config.ts
git commit -m "Document disaster recovery operations"
```

## Completion checkpoint

This plan is complete only when a Recovery Set reaches Drill proven in an isolated environment, its components remain byte-identical, the credential key stayed separately supplied, the source environment and its only backup were never mutated, and every unexercised deployment/platform remains explicitly unverified.
