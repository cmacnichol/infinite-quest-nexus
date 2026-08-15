import type {
  AcceptedTurnCorrectionRequest,
  AcceptedTurnCorrectionView,
  TurnCorrectionRepositoryResult,
  TurnCorrectionScope
} from "./types.js";

export interface TurnCorrectionRepositoryPort {
  correctNarration(
    scope: TurnCorrectionScope,
    request: AcceptedTurnCorrectionRequest,
  ): Promise<TurnCorrectionRepositoryResult<AcceptedTurnCorrectionView>>;
  getEffectiveNarration(
    scope: TurnCorrectionScope,
    turnId: string,
  ): Promise<AcceptedTurnCorrectionView | null>;
}

export interface TurnCorrectionApplication {
  correctNarration(
    scope: TurnCorrectionScope,
    request: AcceptedTurnCorrectionRequest,
  ): Promise<AcceptedTurnCorrectionView>;
  getEffectiveNarration(
    scope: TurnCorrectionScope,
    turnId: string,
  ): Promise<AcceptedTurnCorrectionView | null>;
}

export type TurnCorrectionApplicationDependencies = Readonly<{
  corrections: TurnCorrectionRepositoryPort;
}>;
