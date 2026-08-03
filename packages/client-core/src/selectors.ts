import type { TurnInputSelection, TurnSummary } from "@infinite-quest/contracts";
import type { CampaignProjection, GenerationJobProjection } from "./campaign-projection.js";
import type { Immutable } from "./store.js";

export function selectLatestAcceptedTurn(state: Immutable<CampaignProjection>): Immutable<TurnSummary> | null {
  return state.turns[state.turns.length - 1] ?? null;
}

export function selectLatestAcceptedTurnNumber(state: Immutable<CampaignProjection>): number | null {
  return selectLatestAcceptedTurn(state)?.turnNumber ?? null;
}

export function selectGeneration(state: Immutable<CampaignProjection>): Immutable<GenerationJobProjection> | null {
  return state.generation;
}

export function selectIsGenerationInFlight(state: Immutable<CampaignProjection>): boolean {
  const generation = state.generation;
  if (generation === null || generation.result.state !== "pending") return false;
  const status = generation.snapshot?.status;
  return status === undefined
    || !["completed", "recoverable", "failed", "cancelled", "discarded"].includes(status);
}

export function selectRequestedTurnInputMode(state: Immutable<CampaignProjection>): TurnInputSelection {
  return state.requestedTurnInputMode;
}

export function selectRuntimeState(state: Immutable<CampaignProjection>): Immutable<CampaignProjection["runtimeState"]> {
  return state.runtimeState;
}

export function selectHistorySyncRequired(state: Immutable<CampaignProjection>): boolean {
  return state.historySyncRequired;
}
