import { containsMechanicsLanguage, sha256, stableStringify } from "./text.js";

export type CanonicalFactUpdateSnapshot = {
  content: string;
  supersedesFactIds: string[];
};

/** The fiction-derived portion of an accepted turn snapshot. */
export type ChronicleFictionSnapshot = {
  continuitySummary: string;
  canonicalFacts: string[];
  supersededFacts: string[];
  canonicalFactUpdates: CanonicalFactUpdateSnapshot[];
  openThreads: string[];
};

export type ChronicleCheckpointFact = {
  id: string;
  sourceTurnId: string;
  sourceTurnNumber: number;
  sourceFactIndex: number;
  content: string;
  normalizedContent: string;
  entities: string[];
  entityIds: string[];
  validFromTurn: number;
  validUntilTurn: number | null;
  supersededByFactId: string | null;
  metadata: Record<string, unknown>;
};

export type ChronicleCheckpointV2 = {
  schemaVersion: 2;
  throughTurn: number;
  sourceSnapshotHash: string;
  continuitySummary: string;
  openThreads: string[];
  factProjection: ChronicleCheckpointFact[];
};

/** Normalized representation of the former `{ summary }` checkpoint body. */
export type ChronicleCheckpointV1 = {
  schemaVersion: 1;
  throughTurn: number;
  sourceSnapshotHash: null;
  continuitySummary: string;
  openThreads: [];
  factProjection: [];
};

export type ParsedChronicleCheckpoint = ChronicleCheckpointV1 | ChronicleCheckpointV2;

export type BuildChronicleCheckpointInput = {
  throughTurn: number;
  sourceSnapshot: unknown;
  continuitySummary: string;
  openThreads?: readonly string[];
  factProjection?: readonly ChronicleCheckpointFact[];
};

const FORBIDDEN_PRIVATE_KEYS = /(?:^|_)(?:scratchpad|mechanics|trackers?|rpg_stats?|rolls?|parser_diagnostics?|private_reasoning)(?:$|_)/i;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative integer.`);
  return Number(value);
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`${label} must be a positive integer.`);
  return Number(value);
}

function fictionString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (!allowEmpty && !normalized) throw new Error(`${label} must not be empty.`);
  if (containsMechanicsLanguage(normalized)) throw new Error(`${label} contains mechanics or engine-only language.`);
  return normalized;
}

function fictionStrings(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((entry, index) => fictionString(entry, `${label}[${index}]`));
}

function strings(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) throw new Error(`${label}[${index}] must be a non-empty string.`);
    return entry.trim();
  });
}

function fictionSnapshot(value: unknown): ChronicleFictionSnapshot {
  const source = record(value, "sourceSnapshot");
  const updatesValue = source.canonicalFactUpdates ?? [];
  if (!Array.isArray(updatesValue)) throw new Error("sourceSnapshot.canonicalFactUpdates must be an array.");
  const canonicalFactUpdates = updatesValue.map((entry, index) => {
    const update = record(entry, `sourceSnapshot.canonicalFactUpdates[${index}]`);
    return {
      content: fictionString(update.content, `sourceSnapshot.canonicalFactUpdates[${index}].content`),
      supersedesFactIds: strings(update.supersedesFactIds, `sourceSnapshot.canonicalFactUpdates[${index}].supersedesFactIds`)
    };
  });
  return {
    continuitySummary: fictionString(source.continuitySummary ?? "", "sourceSnapshot.continuitySummary", true),
    canonicalFacts: fictionStrings(source.canonicalFacts, "sourceSnapshot.canonicalFacts"),
    supersededFacts: fictionStrings(source.supersededFacts, "sourceSnapshot.supersededFacts"),
    canonicalFactUpdates,
    openThreads: fictionStrings(source.openThreads, "sourceSnapshot.openThreads")
  };
}

function assertSafeMetadata(value: unknown, path = "metadata"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafeMetadata(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_PRIVATE_KEYS.test(key)) throw new Error(`${path}.${key} is private campaign state and cannot enter a checkpoint.`);
    assertSafeMetadata(entry, `${path}.${key}`);
  }
}

function checkpointFact(value: unknown, index: number): ChronicleCheckpointFact {
  const source = record(value, `factProjection[${index}]`);
  const nullableTurn = source.validUntilTurn === null ? null : positiveInteger(source.validUntilTurn, `factProjection[${index}].validUntilTurn`);
  const metadata = record(source.metadata ?? {}, `factProjection[${index}].metadata`);
  assertSafeMetadata(metadata, `factProjection[${index}].metadata`);
  const validFromTurn = positiveInteger(source.validFromTurn, `factProjection[${index}].validFromTurn`);
  if (nullableTurn !== null && nullableTurn <= validFromTurn) {
    throw new Error(`factProjection[${index}].validUntilTurn must be after validFromTurn.`);
  }
  return {
    id: fictionString(source.id, `factProjection[${index}].id`),
    sourceTurnId: fictionString(source.sourceTurnId, `factProjection[${index}].sourceTurnId`),
    sourceTurnNumber: positiveInteger(source.sourceTurnNumber, `factProjection[${index}].sourceTurnNumber`),
    sourceFactIndex: nonNegativeInteger(source.sourceFactIndex, `factProjection[${index}].sourceFactIndex`),
    content: fictionString(source.content, `factProjection[${index}].content`),
    normalizedContent: fictionString(source.normalizedContent, `factProjection[${index}].normalizedContent`),
    entities: strings(source.entities, `factProjection[${index}].entities`),
    entityIds: strings(source.entityIds, `factProjection[${index}].entityIds`),
    validFromTurn,
    validUntilTurn: nullableTurn,
    supersededByFactId: source.supersededByFactId === null
      ? null
      : fictionString(source.supersededByFactId, `factProjection[${index}].supersededByFactId`),
    metadata: structuredClone(metadata)
  };
}

/** Hashes only the accepted turn number and explicitly allowlisted fiction fields. */
export function chronicleCheckpointSourceHash(throughTurn: number, sourceSnapshot: unknown): string {
  return sha256(stableStringify({
    throughTurn: nonNegativeInteger(throughTurn, "throughTurn"),
    ...fictionSnapshot(sourceSnapshot)
  }));
}

export function buildChronicleCheckpoint(input: BuildChronicleCheckpointInput): ChronicleCheckpointV2 {
  const throughTurn = nonNegativeInteger(input.throughTurn, "throughTurn");
  const snapshot = fictionSnapshot(input.sourceSnapshot);
  const continuitySummary = fictionString(input.continuitySummary, "continuitySummary", true);
  const openThreads = fictionStrings(input.openThreads, "openThreads");
  if (continuitySummary !== snapshot.continuitySummary || stableStringify(openThreads) !== stableStringify(snapshot.openThreads)) {
    throw new Error("Checkpoint summary and open threads must match the accepted fiction snapshot.");
  }
  return {
    schemaVersion: 2,
    throughTurn,
    sourceSnapshotHash: chronicleCheckpointSourceHash(throughTurn, input.sourceSnapshot),
    continuitySummary,
    openThreads,
    factProjection: (input.factProjection ?? []).map(checkpointFact)
  };
}

/** Reads v2 bodies and normalizes the historical unversioned `{ summary }` v1 body. */
export function parseChronicleCheckpoint(value: unknown, legacyThroughTurn?: number): ParsedChronicleCheckpoint {
  const source = record(value, "checkpoint");
  if (source.schemaVersion === 2) {
    const factProjection = source.factProjection;
    if (!Array.isArray(factProjection)) throw new Error("checkpoint.factProjection must be an array.");
    const hash = source.sourceSnapshotHash;
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/u.test(hash)) throw new Error("checkpoint.sourceSnapshotHash must be a SHA-256 digest.");
    return {
      schemaVersion: 2,
      throughTurn: nonNegativeInteger(source.throughTurn, "checkpoint.throughTurn"),
      sourceSnapshotHash: hash,
      continuitySummary: fictionString(source.continuitySummary, "checkpoint.continuitySummary", true),
      openThreads: fictionStrings(source.openThreads, "checkpoint.openThreads"),
      factProjection: factProjection.map(checkpointFact)
    };
  }

  if (source.schemaVersion !== undefined && source.schemaVersion !== 1) {
    throw new Error(`Unsupported Chronicle checkpoint schema version: ${String(source.schemaVersion)}.`);
  }
  const throughTurn = source.throughTurn ?? legacyThroughTurn;
  return {
    schemaVersion: 1,
    throughTurn: nonNegativeInteger(throughTurn, "legacy checkpoint throughTurn"),
    sourceSnapshotHash: null,
    continuitySummary: fictionString(source.summary ?? source.continuitySummary ?? "", "legacy checkpoint summary", true),
    openThreads: [],
    factProjection: []
  };
}

export function validateChronicleCheckpoint(
  checkpoint: unknown,
  throughTurn: number,
  sourceSnapshot: unknown
): boolean {
  try {
    const parsed = parseChronicleCheckpoint(checkpoint, throughTurn);
    if (parsed.throughTurn !== throughTurn) return false;
    if (parsed.schemaVersion === 1) {
      return parsed.continuitySummary === fictionSnapshot(sourceSnapshot).continuitySummary;
    }
    const snapshot = fictionSnapshot(sourceSnapshot);
    return parsed.sourceSnapshotHash === chronicleCheckpointSourceHash(throughTurn, sourceSnapshot)
      && parsed.continuitySummary === snapshot.continuitySummary
      && stableStringify(parsed.openThreads) === stableStringify(snapshot.openThreads);
  } catch {
    return false;
  }
}
