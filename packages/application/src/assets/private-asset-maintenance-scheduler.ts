import type { AssetFilesystemDiagnosticCode } from "./types.js";

export const PRIVATE_ASSET_MAINTENANCE_PROBES = Object.freeze([
  "metadata_backfill",
  "asset_filesystem_recovery",
  "portable_expiry_recovery",
] as const);

export type PrivateAssetMaintenanceProbe = typeof PRIVATE_ASSET_MAINTENANCE_PROBES[number];

/** Minimal cancellation shape without coupling the framework-free application package to DOM lib types. */
export type PrivateAssetMaintenanceAbortSignal = Readonly<{
  aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: Readonly<{ once?: boolean }>): void;
  removeEventListener(type: "abort", listener: () => void): void;
}>;

/** A private executor reports only bounded work state, never its durable claim or target. */
export type PrivateAssetMaintenanceProbeResult = Readonly<{
  outcome: "idle" | "completed" | "recoverable" | "failed" | "quarantined" | "lease_lost";
  diagnosticCodes?: readonly AssetFilesystemDiagnosticCode[];
}>;

export type PrivateAssetMaintenanceExecutionRequest = Readonly<{
  workerId: string;
  leaseSeconds: number;
  signal?: PrivateAssetMaintenanceAbortSignal;
}>;

export type PrivateAssetMaintenanceTickOutcome = Readonly<{
  probe: PrivateAssetMaintenanceProbe | "none";
  status?: "busy" | "aborted";
  attempted: 0 | 1;
  idle: number;
  completed: number;
  recoverable: number;
  failed: number;
  quarantined: number;
  leaseLost: number;
  diagnosticCodes: readonly AssetFilesystemDiagnosticCode[];
}>;

type PrivateAssetMaintenanceProbeExecutor = (
  request: PrivateAssetMaintenanceExecutionRequest,
) => Promise<PrivateAssetMaintenanceProbeResult>;

export type PrivateAssetMaintenanceSchedulerDependencies = Readonly<{
  metadataBackfill: PrivateAssetMaintenanceProbeExecutor;
  assetFilesystemRecovery: PrivateAssetMaintenanceProbeExecutor;
  portableExpiryRecovery: PrivateAssetMaintenanceProbeExecutor;
}>;

export type PrivateAssetMaintenanceScheduler = Readonly<{
  tick(request: PrivateAssetMaintenanceExecutionRequest): Promise<PrivateAssetMaintenanceTickOutcome>;
  abort(): void;
  drain(): Promise<void>;
}>;

const SAFE_DIAGNOSTIC_CODES = new Set<AssetFilesystemDiagnosticCode>([
  "asset_content_invalid",
  "asset_hash_mismatch",
  "asset_metadata_unavailable",
  "asset_storage_unavailable",
  "asset_unsupported_media",
  "asset_too_large",
  "filesystem_containment_denied",
  "filesystem_link_denied",
  "filesystem_path_invalid",
  "filesystem_race_detected",
]);

function safeEmptyOutcome(status?: "busy" | "aborted"): PrivateAssetMaintenanceTickOutcome {
  return Object.freeze({
    probe: "none",
    ...(status ? { status } : {}),
    attempted: 0,
    idle: 0,
    completed: 0,
    recoverable: 0,
    failed: 0,
    quarantined: 0,
    leaseLost: 0,
    diagnosticCodes: Object.freeze([]),
  });
}

function validateRequest(request: PrivateAssetMaintenanceExecutionRequest): void {
  if (!request.workerId.trim() || request.workerId.length > 512
    || !Number.isInteger(request.leaseSeconds) || request.leaseSeconds < 1 || request.leaseSeconds > 300) {
    throw new Error("asset_maintenance_execution_request_invalid");
  }
}

function safeDiagnosticCodes(
  diagnosticCodes: readonly AssetFilesystemDiagnosticCode[] | undefined,
): readonly AssetFilesystemDiagnosticCode[] {
  const safe: AssetFilesystemDiagnosticCode[] = [];
  for (const candidate of diagnosticCodes ?? []) {
    if (SAFE_DIAGNOSTIC_CODES.has(candidate) && !safe.includes(candidate)) safe.push(candidate);
    if (safe.length === 3) break;
  }
  if (safe.length === 0 && diagnosticCodes && diagnosticCodes.length > 0) {
    safe.push("asset_metadata_unavailable");
  }
  return Object.freeze(safe);
}

function outcomeFor(
  probe: PrivateAssetMaintenanceProbe,
  result: PrivateAssetMaintenanceProbeResult,
): PrivateAssetMaintenanceTickOutcome {
  return Object.freeze({
    probe,
    attempted: 1,
    idle: result.outcome === "idle" ? 1 : 0,
    completed: result.outcome === "completed" ? 1 : 0,
    recoverable: result.outcome === "recoverable" ? 1 : 0,
    failed: result.outcome === "failed" ? 1 : 0,
    quarantined: result.outcome === "quarantined" ? 1 : 0,
    leaseLost: result.outcome === "lease_lost" ? 1 : 0,
    diagnosticCodes: safeDiagnosticCodes(result.diagnosticCodes),
  });
}

/**
 * Private e7 scheduler. It owns only the round-robin cursor and capacity-one
 * lifecycle. Every probe obtains all durable target, owner, and lease details
 * from its own database claim.
 */
export function createPrivateAssetMaintenanceScheduler(
  dependencies: PrivateAssetMaintenanceSchedulerDependencies,
): PrivateAssetMaintenanceScheduler {
  const executors: readonly PrivateAssetMaintenanceProbeExecutor[] = Object.freeze([
    dependencies.metadataBackfill,
    dependencies.assetFilesystemRecovery,
    dependencies.portableExpiryRecovery,
  ]);
  let cursor = 0;
  let stopped = false;
  let active: Promise<PrivateAssetMaintenanceTickOutcome> | undefined;

  const abort = (): void => { stopped = true; };

  const tick = async (request: PrivateAssetMaintenanceExecutionRequest): Promise<PrivateAssetMaintenanceTickOutcome> => {
    validateRequest(request);
    if (request.signal?.aborted) abort();
    if (stopped) return safeEmptyOutcome("aborted");
    if (active) return safeEmptyOutcome("busy");

    const probeIndex = cursor;
    cursor = (cursor + 1) % PRIVATE_ASSET_MAINTENANCE_PROBES.length;
    const probe = PRIVATE_ASSET_MAINTENANCE_PROBES[probeIndex]!;
    const executor = executors[probeIndex]!;
    const onAbort = (): void => { abort(); };
    request.signal?.addEventListener("abort", onAbort, { once: true });

    const run = (async (): Promise<PrivateAssetMaintenanceTickOutcome> => {
      try {
        return outcomeFor(probe, await executor(request));
      } catch {
        return outcomeFor(probe, Object.freeze({
          outcome: "failed",
          diagnosticCodes: Object.freeze(["asset_metadata_unavailable"] as const),
        }));
      } finally {
        request.signal?.removeEventListener("abort", onAbort);
      }
    })();
    active = run;
    void run.finally(() => {
      if (active === run) active = undefined;
    });
    return run;
  };

  return Object.freeze({
    tick,
    abort,
    async drain(): Promise<void> {
      await active;
    },
  });
}
