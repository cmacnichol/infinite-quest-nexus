import { createHash } from "node:crypto";
import type { ChronicleChunkKind, ChronicleMemoryKind } from "./chronicle-chunking.js";

export type ChronicleParentCandidate = Readonly<{
  candidateId: string;
  parentMemoryId: string;
  parentTurnId: string | null;
  ordinal: number;
  memoryKind: ChronicleMemoryKind;
  parentContent: string;
  parentMetadata: Readonly<Record<string, unknown>>;
  entities: readonly string[];
  entityIds: readonly string[];
  chunkOrdinal: number;
  chunkKind: ChronicleChunkKind;
  chunkContent: string;
  embedding: readonly number[] | null;
  fusedRank: number;
}>;

export type ChronicleParentSelectionPolicy = Readonly<{
  maximumParents: number;
  maximumParentsPerTurn?: number;
  includeAdjacentNarration?: boolean;
  semanticSimilarityPenalty?: number;
  kindDiversityBonus?: number;
  entityDiversityBonus?: number;
  latestSceneParentMemoryId?: string | null;
}>;

export type SelectedChronicleParent = Readonly<{
  parentMemoryId: string;
  parentTurnId: string | null;
  ordinal: number;
  memoryKind: ChronicleMemoryKind;
  content: string;
  entities: readonly string[];
  entityIds: readonly string[];
}>;

export type ChronicleParentSelectionDiagnostics = Readonly<{
  candidateChunks: number;
  candidateParents: number;
  collapsedChunks: number;
  canonicalLineagesCollapsed: number;
  normalizedDuplicatesRemoved: number;
  latestSceneParentsProtected: number;
  semanticPenaltiesApplied: number;
  selectedKinds: number;
  selectedEntityIds: number;
  turnLimitParentsRemoved: number;
  selectedParents: number;
}>;

export type ChronicleParentSelection = Readonly<{
  parents: readonly SelectedChronicleParent[];
  diagnostics: ChronicleParentSelectionDiagnostics;
}>;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCandidates(left: ChronicleParentCandidate, right: ChronicleParentCandidate): number {
  return left.fusedRank - right.fusedRank
    || left.ordinal - right.ordinal
    || compareText(left.parentMemoryId, right.parentMemoryId)
    || compareText(left.candidateId, right.candidateId);
}

function normalizedContentHash(content: string): string {
  const normalized = content.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
  return createHash("sha256").update(normalized).digest("hex");
}

function canonicalFactIds(candidate: ChronicleParentCandidate): readonly string[] {
  const value = candidate.parentMetadata?.structuredFactIds;
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0))]
    .sort(compareText);
}

function finiteNonNegative(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : Number.isFinite(value) && value >= 0 ? value : 0;
}

function cosineSimilarity(left: readonly number[] | null, right: readonly number[] | null): number {
  if (!left?.length || !right?.length || left.length !== right.length) return 0;
  let dotProduct = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) return 0;
    dotProduct += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return Math.max(0, Math.min(1, dotProduct / Math.sqrt(leftMagnitude * rightMagnitude)));
}

function maximumSelectedSimilarity(
  candidate: ChronicleParentCandidate,
  selected: readonly ChronicleParentCandidate[]
): number {
  return selected.reduce((maximum, existing) => (
    Math.max(maximum, cosineSimilarity(candidate.embedding, existing.embedding))
  ), 0);
}

function selectedContent(
  candidate: ChronicleParentCandidate,
  siblings: readonly ChronicleParentCandidate[],
  includeAdjacentNarration: boolean
): string {
  if (candidate.chunkKind === "canonical_fact" || candidate.chunkKind === "open_thread") {
    return candidate.parentContent;
  }
  if (candidate.chunkKind === "campaign_summary" || candidate.chunkKind === "legacy_summary") {
    return candidate.chunkContent;
  }
  const action = candidate.chunkKind === "turn_action"
    ? candidate
    : siblings.find((chunk) => chunk.chunkKind === "turn_action");
  const narration = candidate.chunkKind === "turn_narration"
    ? candidate
    : includeAdjacentNarration
      ? siblings.find((chunk) => (
        chunk.chunkKind === "turn_narration" && chunk.chunkOrdinal === candidate.chunkOrdinal + 1
      ))
      : undefined;
  if (action && narration) {
    return `Player action: ${action.chunkContent}\nNarration: ${narration.chunkContent}`;
  }
  if (candidate.chunkKind === "turn_action") return `Player action: ${candidate.chunkContent}`;
  return `Narration: ${candidate.chunkContent}`;
}

export function selectDiverseChronicleParents(
  candidates: readonly ChronicleParentCandidate[],
  policy: ChronicleParentSelectionPolicy
): ChronicleParentSelection {
  const strongestByParent = new Map<string, ChronicleParentCandidate>();
  const chunksByParent = new Map<string, ChronicleParentCandidate[]>();
  for (const candidate of [...candidates].sort(compareCandidates)) {
    const chunks = chunksByParent.get(candidate.parentMemoryId) ?? [];
    chunks.push(candidate);
    chunksByParent.set(candidate.parentMemoryId, chunks);
    if (!strongestByParent.has(candidate.parentMemoryId)) {
      strongestByParent.set(candidate.parentMemoryId, candidate);
    }
  }
  const maximumParents = Number.isFinite(policy.maximumParents)
    ? Math.max(0, Math.floor(policy.maximumParents))
    : 0;
  const maximumParentsPerTurn = policy.maximumParentsPerTurn === undefined
    ? 2
    : Number.isFinite(policy.maximumParentsPerTurn)
      ? Math.max(0, Math.floor(policy.maximumParentsPerTurn))
      : 0;
  const semanticSimilarityPenalty = finiteNonNegative(policy.semanticSimilarityPenalty, 4);
  const kindDiversityBonus = finiteNonNegative(policy.kindDiversityBonus, 1);
  const entityDiversityBonus = finiteNonNegative(policy.entityDiversityBonus, 0.5);
  const selectedCandidates: ChronicleParentCandidate[] = [];
  const parentsByTurn = new Map<string, number>();
  const selectedCanonicalFactIds = new Set<string>();
  const selectedContentHashes = new Set<string>();
  const selectedKinds = new Set<ChronicleMemoryKind>();
  const selectedEntityIds = new Set<string>();
  let canonicalLineagesCollapsed = 0;
  let normalizedDuplicatesRemoved = 0;
  const latestSceneParentsProtected = policy.latestSceneParentMemoryId !== null
    && policy.latestSceneParentMemoryId !== undefined
    && strongestByParent.has(policy.latestSceneParentMemoryId) ? 1 : 0;
  let semanticPenaltiesApplied = 0;
  let turnLimitParentsRemoved = 0;
  let remaining = maximumParents > 0 ? [...strongestByParent.values()].filter((candidate) => (
    candidate.parentMemoryId !== policy.latestSceneParentMemoryId
  )) : [];
  while (remaining.length > 0 && selectedCandidates.length < maximumParents) {
    const eligible: ChronicleParentCandidate[] = [];
    for (const candidate of remaining) {
      if (selectedContentHashes.has(normalizedContentHash(candidate.parentContent))) {
        normalizedDuplicatesRemoved += 1;
        continue;
      }
      if (canonicalFactIds(candidate).some((factId) => selectedCanonicalFactIds.has(factId))) {
        canonicalLineagesCollapsed += 1;
        continue;
      }
      if (candidate.parentTurnId !== null
        && (parentsByTurn.get(candidate.parentTurnId) ?? 0) >= maximumParentsPerTurn) {
        turnLimitParentsRemoved += 1;
        continue;
      }
      eligible.push(candidate);
    }
    if (eligible.length === 0) break;
    eligible.sort((left, right) => {
      const leftKindBonus = selectedCandidates.length > 0 && !selectedKinds.has(left.memoryKind)
        ? kindDiversityBonus
        : 0;
      const rightKindBonus = selectedCandidates.length > 0 && !selectedKinds.has(right.memoryKind)
        ? kindDiversityBonus
        : 0;
      const leftEntityBonus = selectedCandidates.length > 0
        && left.entityIds.some((entityId) => !selectedEntityIds.has(entityId))
        ? entityDiversityBonus
        : 0;
      const rightEntityBonus = selectedCandidates.length > 0
        && right.entityIds.some((entityId) => !selectedEntityIds.has(entityId))
        ? entityDiversityBonus
        : 0;
      const leftAdjustedRank = left.fusedRank
        + maximumSelectedSimilarity(left, selectedCandidates) * semanticSimilarityPenalty
        - leftKindBonus
        - leftEntityBonus;
      const rightAdjustedRank = right.fusedRank
        + maximumSelectedSimilarity(right, selectedCandidates) * semanticSimilarityPenalty
        - rightKindBonus
        - rightEntityBonus;
      return leftAdjustedRank - rightAdjustedRank || compareCandidates(left, right);
    });
    const candidate = eligible[0]!;
    const similarity = maximumSelectedSimilarity(candidate, selectedCandidates);
    if (similarity > 0 && semanticSimilarityPenalty > 0) semanticPenaltiesApplied += 1;
    const contentHash = normalizedContentHash(candidate.parentContent);
    const factIds = canonicalFactIds(candidate);
    if (candidate.parentTurnId !== null) {
      parentsByTurn.set(candidate.parentTurnId, (parentsByTurn.get(candidate.parentTurnId) ?? 0) + 1);
    }
    selectedContentHashes.add(contentHash);
    factIds.forEach((factId) => selectedCanonicalFactIds.add(factId));
    selectedKinds.add(candidate.memoryKind);
    candidate.entityIds.forEach((entityId) => selectedEntityIds.add(entityId));
    selectedCandidates.push(candidate);
    remaining = eligible.filter((value) => value.parentMemoryId !== candidate.parentMemoryId);
  }
  const parents = selectedCandidates.map((candidate) => {
    const content = selectedContent(
      candidate,
      chunksByParent.get(candidate.parentMemoryId) ?? [],
      policy.includeAdjacentNarration === true
    );
    return {
      parentMemoryId: candidate.parentMemoryId,
      parentTurnId: candidate.parentTurnId,
      ordinal: candidate.ordinal,
      memoryKind: candidate.memoryKind,
      content,
      entities: [...candidate.entities],
      entityIds: [...candidate.entityIds]
    };
  });
  return {
    parents,
    diagnostics: {
      candidateChunks: candidates.length,
      candidateParents: strongestByParent.size,
      collapsedChunks: candidates.length - strongestByParent.size,
      canonicalLineagesCollapsed,
      normalizedDuplicatesRemoved,
      latestSceneParentsProtected,
      semanticPenaltiesApplied,
      selectedKinds: selectedKinds.size,
      selectedEntityIds: selectedEntityIds.size,
      turnLimitParentsRemoved,
      selectedParents: parents.length
    }
  };
}
