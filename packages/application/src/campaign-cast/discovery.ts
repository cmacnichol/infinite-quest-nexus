import { castDiscoveryOutputSchema, type CastDiscoveryIdentitySnapshot, type CastDiscoveryOutput, type CastDiscoverySource,
  type CastScope, type TextExecutionPlan, type TextExecutionRouteBasis, type FrozenResponseContractsV2 } from "@infinite-quest/contracts";

export type CastDiscoveryExecution = { providerProfileId: string; plan: TextExecutionPlan;
  /** Older development jobs may lack admission; runtime fails closed. */
  admission?: { routeBasis: TextExecutionRouteBasis; frozenResponseContracts: FrozenResponseContractsV2;
    providerType: "openrouter" | "openai_compatible"; configuration: Readonly<Record<string, unknown>> };
};
export type CastDiscoveryClaim = {
  id: string; scope: CastScope; source: CastDiscoverySource; chunkOrdinal: number; chunkCount: number;
  execution: CastDiscoveryExecution; attempt: number; retryGeneration?: number; leaseToken: string; output: CastDiscoveryOutput | null;
  identities: CastDiscoveryIdentitySnapshot;
};
export type CastDiscoveryDiagnostic = "provider_timeout" | "provider_failed" | "invalid_output" | "source_requires_manual_scan" | "publication_failed";
export type CastDiscoveryPublication = "disabled" | "lost_lease" | "stale_source" | "generation_active" | "complete" | "next_chunk";
export interface CastDiscoveryJobPort {
  claim(workerId: string): Promise<CastDiscoveryClaim | null>;
  checkpoint(claim: CastDiscoveryClaim, output: CastDiscoveryOutput): Promise<boolean>;
  fail(claim: CastDiscoveryClaim, diagnostic: CastDiscoveryDiagnostic): Promise<boolean>;
  publish(claim: CastDiscoveryClaim): Promise<CastDiscoveryPublication>;
}
export interface CastDiscoveryExtractorPort {
  /** Uses the frozen execution snapshot, bounded request, and lease-bound physical accounting. */
  extract(claim: CastDiscoveryClaim): Promise<unknown>;
}
export interface CastDiscoveryWorkerApplication {
  runNext(workerId: string): Promise<boolean>;
}
export class CastDiscoveryExtractionError extends Error {
  constructor(readonly diagnostic: "provider_timeout" | "provider_failed" | "source_requires_manual_scan") {
    super(diagnostic);
    this.name = "CastDiscoveryExtractionError";
  }
}

/** One durable chunk per tick. Story acceptance and its provider calls are never retried here. */
export async function runCastDiscoveryOnce(input: {
  workerId: string; repository: CastDiscoveryJobPort; extractor: CastDiscoveryExtractorPort;
}): Promise<CastDiscoveryPublication | "idle" | "failed" | "checkpoint_failed" | "publication_failed"> {
  const claim = await input.repository.claim(input.workerId);
  if (!claim) return "idle";
  if (claim.output === null) {
    let value: unknown;
    try {
      value = await input.extractor.extract(claim);
    } catch (error) {
      const diagnostic = error instanceof CastDiscoveryExtractionError ? error.diagnostic : "provider_failed";
      return await input.repository.fail(claim, diagnostic) ? "failed" : "lost_lease";
    }
    const parsed = castDiscoveryOutputSchema.safeParse(value);
    if (!parsed.success) return await input.repository.fail(claim, "invalid_output") ? "failed" : "lost_lease";
    try {
      if (!await input.repository.checkpoint(claim, parsed.data)) return "lost_lease";
    } catch {
      // Commit outcome may be unknown. Leave the lease/checkpoint for durable recovery.
      return "checkpoint_failed";
    }
  }
  try {
    return await input.repository.publish(claim);
  } catch {
    // A publication retry uses the persisted checkpoint and must not spend another extraction attempt.
    return "publication_failed";
  }
}
