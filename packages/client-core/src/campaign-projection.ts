import type {
  CampaignRuntimeStateResponse,
  CampaignSyncStatus,
  GenerationStreamSnapshot,
  TurnInputModeSource,
  TurnInputSelection,
  TurnSummary
} from "@infinite-quest/contracts";
import type { Immutable } from "./store.js";

export type GenerationTransportHealth =
  | { readonly state: "unobserved" }
  | { readonly state: "healthy" }
  | { readonly state: "degraded"; readonly reason: "stream_lost" | "poll_failed"; readonly consecutiveFailures: number };

export type GenerationResultState =
  | { readonly state: "pending" }
  | { readonly state: "unavailable"; readonly message: string; readonly correlationId: string | null }
  | { readonly state: "failed"; readonly outcome: "failed" | "unrecoverable"; readonly message: string };

export type GenerationOperationProjection =
  | { readonly operationKind: "append"; readonly replacementTurnId: null }
  | { readonly operationKind: "replace_latest"; readonly replacementTurnId: string };

export interface HydratedGenerationProjection {
  readonly source: "pending" | "recovery";
  readonly id: string;
  readonly status: string;
  readonly action: string | null;
  readonly expectedTurnNumber: number;
  readonly attempts: number | null;
  readonly resultTurnId: string | null;
  readonly operation: GenerationOperationProjection;
}

export interface GenerationJobProjection {
  readonly campaignId: string;
  readonly jobId: string;
  readonly origin: "live" | "hydrated_pending" | "hydrated_recovery";
  readonly operation: GenerationOperationProjection;
  readonly monitoring: "attached" | "detached";
  readonly hydratedGeneration: Immutable<HydratedGenerationProjection> | null;
  readonly snapshot: Immutable<GenerationStreamSnapshot> | null;
  readonly narration: string;
  readonly transport: GenerationTransportHealth;
  readonly result: GenerationResultState;
}

export interface CampaignProjection {
  readonly campaign: Immutable<CampaignSyncStatus["campaign"]> | null;
  readonly world: Immutable<CampaignSyncStatus["world"]> | null;
  readonly playerConfig: Immutable<CampaignSyncStatus["playerConfig"]> | null;
  readonly turns: readonly Immutable<TurnSummary>[];
  readonly nextTurnsCursor: string | null;
  readonly syncToken: string | null;
  readonly historySyncRequired: boolean;
  readonly runtimeState: Immutable<CampaignRuntimeStateResponse> | null;
  readonly latestStateSnapshot: Immutable<Record<string, unknown>> | null;
  readonly requestedTurnInputMode: TurnInputSelection;
  readonly nextTurnInputModeSource: TurnInputModeSource | null;
  readonly generation: GenerationJobProjection | null;
}
