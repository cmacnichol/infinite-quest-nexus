# Initialize, activate and roll back installation settings

Use the following procedure on the installation selected for a maintenance change. Preserve its original deployment manifests, source environment and secrets, take an authoritative database backup, and verify restore separately. An installation UUID belongs to this installation for its lifetime. Generate one UUID, record it with the backup and use it in every API and worker policy file.

The production operator executable is `node /app/dist/services/runtime/src/settings-operator-cli.js`. Below, `operator` means that command in the candidate image. `pnpm settings:operator` is its source-checkout equivalent. Supply the intended `APP_ROLE` and the same effective container configuration as the corresponding service. Commands that change database state need operator database credentials. Use a one-shot process with the same role configuration during maintenance. The executable does not control containers.

## Local single-user installation

An orphaned physical dispatch with a cancelled parent can be reconciled offline after operator review. Stop every process using the installation and verify that its work has ended. Record the exact attempt and parent IDs, kind, cancelled parent status and UTC row fingerprint for each approved attempt. Use `scripts/recover-cancelled-dispatches.sql` with the reviewed JSON manifest and maintenance reference as psql variables. Its immutable receipts apply only while the entire original dispatch row still matches and the same owner's parent remains cancelled. Provider outcomes, costs, usage and the dispatch ledger are preserved. A reservation, an unreviewed attempt, or a changed record still blocks activation.

Use the [local Compose override](../installation/docker-compose.md#local-single-user-settings) on the computer where the browser runs. It sets `INSTANCE_SETTINGS_ACCESS_MODE=local-single-user` on the combined service. This mode requires `APP_ROLE=all` and zero trusted proxy hops. Browser writes must originate from the same local HTTP origin. Operator Unlock remains the default for HTTPS ingress.

For a fresh or previously unseeded installation, first startup migrates the database, captures its effective configuration, creates a stable installation ID and activates revision 1 under the normal drain guards. Subsequent starts preserve the active revision, requested revision and initial owner. Keep the existing database, asset, archive and encryption-key volumes. If the database was seeded using an operator-supplied policy, retain the matching policy mount when switching access modes. An absent or mismatched policy stops startup so the process cannot silently replace the installation's authority.

The generated local policy retains the initial feature gates and request-rate tuple. It permits a slower queue polling interval and a reduction in generation concurrency. Most numeric bounds are pinned to their seed values. For example, changing Log level in Diagnostics stages a new revision immediately. A restart alone preserves that pending revision.

In the local installation Settings editor, select **Apply saved settings and restart** beside the revision numbers. The app stops accepting new work, lets admitted work finish, and runs the activation checks against the selected revision. Docker restarts the combined service when the process exits. The browser reconnects and checks readiness and the active revision. If the revision changes or the activation guard reports a blocker, check the reported status before retrying. This procedure relies on the local Compose restart policy.

To activate from the command line, follow the drain checks in [Stage, activate and observe](#stage-activate-and-observe). For the combined local service, these PowerShell commands show the one-shot invocation. Substitute the revisions and epoch reported by `status`, and your maintenance reference:

```powershell
$stack = @('-f', 'compose.yaml', '-f', 'compose.local-single-user.yaml')
$operator = '/app/dist/services/runtime/src/settings-operator-cli.js'
docker compose @stack exec -T infinitequest-app node $operator status
docker compose @stack exec -T infinitequest-app node $operator validate
docker compose @stack stop infinitequest-app
docker compose @stack run --rm --no-deps --entrypoint node infinitequest-app $operator activate --expected-active 1 --expected-requested 2 --expected-epoch 1 --maintenance local/change-001
docker compose @stack up -d
```

To return to protected management on a locally initialized database, export the current policy **before** removing the local override. Run `docker compose @stack exec -T infinitequest-app node $operator export-policy` and save its JSON output to a UTF-8 file. Mount it using `INSTANCE_SETTINGS_POLICY_FILE` and follow [Mount the files](#mount-the-files) for the key and TLS proxy. Recreate the app with protected access and the same volumes. The saved revisions and actor history stay in the database.

## Capture the installation and review policy

1. Upgrade compatible binaries in **environment mode** with existing deployment inputs. Migration creates an empty Settings singleton. Keep the management toggle off during initial inspection. An unset optional policy leaves this mode available. An explicitly configured unreadable or malformed policy path fails startup. Database-mode startup also requires the matching active policy, installation ID and implementation protocol.
2. Run `operator export-seed` once inside **each** intended API, worker or combined replica. It reads the role's actual runtime configuration without connecting to a database or provider. Save the nonsecret JSON objects and combine them into a JSON array called `role-seeds.json`. For example, `jq -s . api1.json api2.json worker1.json worker2.json > role-seeds.json`. Shared settings must agree. Reconcile role differences explicitly in the deployment before import. Only values that actually reached the process can be seeded.
3. Run `operator create-policy --input role-seeds.json --installation-id YOUR-STABLE-UUID > policy.json`. It needs neither credentials nor an existing policy. The generated policy freezes numeric limits at the observed values, carries observed feature gates, approves the exact rate tuple, counts actual role pools and disables the System Archive limit exception. Review this file. To allow a value to change, expand only that field's range within its reviewed ceiling. Rate changes also require the full window/provider/generation/import tuple. If the previous installation already exercised an explicitly approved archive-limit exception, author a reviewed policy using the [contract bounds](../../packages/contracts/src/instance-settings.ts), retain the separate deployment gate, and validate the complete seed. The conservative generator rejects out-of-range input.
4. In the base Swarm topology keep System Archive disabled on both roles. For two APIs with start-first parallelism one, add `"maximumReplicas": 3` to the API role while keeping `"replicas": 2`. Leave the two stop-first workers at two unless a separately reviewed overlap is needed. The maximum includes stopping pools. Reserve database headroom for the sum of maximum replicas times the configured pool in each role, plus migrations and administrative connections. Worker pools need at least generation slots + 4 and combined pools need slots + 8. A missing maximum limits the role to its steady count. An unapproved overlap will block readiness.

## Mount the files

Mount the reviewed nonsecret policy read-only at `INSTANCE_SETTINGS_POLICY_FILE` on **every** intended role. For browser management, mount a separately generated secret of at least 32 UTF-8 bytes at `SETTINGS_MANAGEMENT_KEY_FILE` on API/combined services and set `SETTINGS_MANAGEMENT_ENABLED=true`. Restrict key access to operators. A missing or insufficient management key disables unlock. Workers need only the policy. Provider tokens and database credentials retain their existing separate sources.

For Swarm, create a versioned external config and external secret under operator control, set `INSTANCE_SETTINGS_SWARM_CONFIG` and `INSTANCE_SETTINGS_SWARM_SECRET` to their respective names, and render the base stack with the [optional override](../../deploy/swarm/instance-settings.override.yaml). Compose installations can supply these explicit mounts with a local override, for example:

```yaml
services:
  infinitequest-app:
    environment:
      INSTANCE_SETTINGS_POLICY_FILE: /run/configs/installation-settings.json
      SETTINGS_MANAGEMENT_ENABLED: "true"
      SETTINGS_MANAGEMENT_KEY_FILE: /run/secrets/installation-settings-key
    volumes:
      - ./operator/policy.json:/run/configs/installation-settings.json:ro
    secrets:
      - installation-settings-key
secrets:
  installation-settings-key:
    file: ./operator/management-key
```

Supply a private exact HTTPS origin and correctly scoped trusted proxy when using a TLS terminator. Ensure only the trusted proxy can reach the API in a proxy-trusting topology, and size `TRUST_PROXY_HOPS` for that topology. Retain the deployment's CORS and provider network policy. A policy-only deployment can use the operator CLI while leaving browser management disabled.

## Stage, activate and observe

1. With the input file mounted, run `operator seed --input role-seeds.json`. The first seed becomes requested revision 1. The same seed and installation ID may be imported again. Later environment changes never overwrite it. In Settings, unlock the installation, edit one section, review it and save. A pending revision and the process's currently active values remain visible. A concurrent editor must refresh after a conflict.
2. Run `operator validate` and `operator status`. Record requested and active revision, epoch, policy digest and external image inventory. Stop ingress, drain work and stop **all** API, worker and combined processes. Verify absence of uninstrumented processes externally. Record the verification in the maintenance reference. Keep the ten-minute worker grace. Follow the [admission recovery procedure](deployment.md#http-admission-leases-and-selective-offline-recovery) for orphaned reservations. Review queued or recoverable jobs for binary compatibility and preserve frozen job inputs.
3. Run `operator activate --expected-active null --expected-requested 2 --expected-epoch 0 --maintenance maintenance/change-123`, substituting the recorded revisions/epoch. The operation checks them under lock, rejects fresh runtime reports, unexpired leases, pinned HTTP reservations and unresolved physical invocations, and advances the epoch. A stale heartbeat cannot establish safe shutdown.
4. Restart every intended role with identical policy and compatible images. API `/health/ready` and `operator status` must confirm the active revision and all expected roles healthy before restoring ingress. Review any unknown or mismatched role, digest, protocol or epoch. A staged policy change uses a new policy-digest revision even if values stay the same.
5. To restore an older Settings snapshot using the current binary, run `operator propose-rollback --revision 1 --expected-requested 2`. Validate the new revision under the current policy, drain, activate and restart as above. Historical revisions and audit records survive.

## Return to a pre-Settings binary

1. Freeze changes. From the active installation run `operator export-rollback > active-export.json`. The `environment` object contains exactly the 43 effective allowlisted assignments. Remaining fields bind the export to the installation, active/requested revisions, epoch, policy and effective digest. Keep a separate override for each service so original environment sources remain intact. For example, `jq '{services:{"infinitequest-app":{environment:.environment}}}' active-export.json > rollback.compose.json` for the combined Compose service. Apply the same values to both intended roles on a split deployment without weakening any deployment gate.
2. Run the old image offline, once per intended replica, with its planned config, role pool and the override. Mount the [compatibility probe](../../scripts/settings-compatibility-probe.mjs) read-only at `/app/scripts/settings-compatibility-probe.mjs`. Override its normal command with `node /app/scripts/settings-compatibility-probe.mjs`. This exercises that binary's actual configuration loader and prints only candidate settings. It needs no network; supply the prior role settings and any required file mounts. Collect the outputs. Combine them with the unchanged export using `jq -n --slurpfile x active-export.json --slurpfile s old-role-seeds.json '{exported:$x[0],seeds:$s[0]}' > verified.json`, where `old-role-seeds.json` is the JSON array of all those probe outputs. The candidate's `operator verify-rollback --input verified.json` reads the current policy and verifies equality offline.
3. Old versions lacked admission on several provider, generation and portable import endpoints, used the older portable preview TTL behavior, and lacked the new admission-time optional auto-match semantics. Keep affected traffic drained unless independently verified equivalent enforcement and job compatibility are in place. A matching settings digest proves configuration interpretation only. Confirm compatibility of queued/recoverable jobs, especially frozen character-discovery and transfer work, before an older worker claims them.
4. Drain and verify shutdown of every process and upstream handler. Resolve pinned reservations through the selective recovery procedure. Wait for newly tracked admission windows to expire (up to the approved one-hour maximum). In the candidate one-shot process run `operator return-to-environment --input verified.json --maintenance maintenance/change-123`. It repeats parity and revision/epoch checks, locks all affected lanes, refuses active leases/attempts/windows, clears the active pointer, increments the epoch, and writes the maintenance rollback audit event atomically. It retains all revisions, the requested pointer, the source configuration and additive schema.
5. Start the verified old image with the override, inspect its exact build, check readiness, and run a permitted owner-scoped and admitted operation before reopening any approved traffic. To re-upgrade, stop/verify the old processes again, deploy the compatible image and policy, validate the requested revision and pass the **current epoch** on the new activation. An obsolete pre-rollback activation command is rejected.


### Character merging

**Characters and AI Authoring → Character merging** requires **Character editing** and uses the same save and restart workflow. It permits merge, undo merge, remove, restore, and promotion to a world draft. Verify the [cast lifecycle reader rollout](deployment.md#cast-lifecycle-reader-rollout-and-rollback) before enabling it.

Migration `0133_cast_lifecycle_settings_key` admits the new key in the settings audit log. Existing revisions and policy digests are preserved. An older revision without this preference inherits `CAST_LIFECYCLE_ENABLED` until a new settings revision records an explicit value. Generated v3 policies include the lifecycle permission. Older implicit local policies allow the panel to manage it, while older managed policies without that key retain the deployment environment gate. Upgrade settings readers before writing a new revision. A rollback image must support the stored settings fields as well as any accepted cast lifecycle events.
