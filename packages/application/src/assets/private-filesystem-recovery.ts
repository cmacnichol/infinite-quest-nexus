import type { AssetFilesystemDiagnosticCode } from "./types.js";

/** Runtime-only maintenance request. It identifies a worker lease, never a tenant or filesystem target. */
export type PrivateFilesystemRecoveryExecutionRequest = Readonly<{
  workerId: string;
  leaseSeconds: number;
  limit: number;
}>;

/** Safe progress projection for a single durable operation. */
export type PrivateFilesystemRecoveryOutcome = Readonly<{
  outcome: "finalized" | "cleaned" | "quarantined" | "recoverable" | "stale" | "lease_lost";
  diagnosticCode?: AssetFilesystemDiagnosticCode;
}>;
