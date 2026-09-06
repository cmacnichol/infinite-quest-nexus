import type {
  SystemArchiveAssetRecord,
  SystemArchiveDomain,
  SystemRecordEnvelope,
} from "@infinite-quest/contracts";
import type { OwnerScope } from "../generation/types.js";

export type SystemArchiveOwnerRecord = Readonly<{
  sourceId: string;
  sourceInstallationId: string;
  displayName: string;
  status?: "active" | "disabled";
  settings?: Readonly<Record<string, unknown>>;
  createdAt?: string;
  updatedAt?: string;
}>;

export type SystemArchiveSourceCompatibility = Readonly<{
  sourceApplication: string;
  sourceMigration: string;
}>;

export type SystemArchiveOriginalAssetRecord = Readonly<{
  sourceAssetId: string;
  archivePath: string;
  expectedSha256: string;
  expectedBytes: number;
  expectedMimeType: SystemArchiveAssetRecord["mimeType"];
  expectedPixelWidth: number;
  expectedPixelHeight: number;
  record: SystemArchiveAssetRecord;
}>;

export interface SystemArchiveSnapshot {
  readOwner(): Promise<SystemArchiveOwnerRecord>;
  readCompatibility(): Promise<SystemArchiveSourceCompatibility>;
  streamDomain(domain: SystemArchiveDomain, afterId?: string): AsyncIterable<SystemRecordEnvelope>;
  listOriginalAssets(): AsyncIterable<SystemArchiveOriginalAssetRecord>;
  summarizeExcludedOperationalWork(): Promise<Readonly<Record<string, number>>>;
}

export interface SystemArchiveSnapshotPort {
  withOwnerSnapshot<T>(
    owner: OwnerScope,
    consume: (snapshot: SystemArchiveSnapshot) => Promise<T>,
  ): Promise<T>;
}

export interface SystemArchiveOriginalAssetReaderPort {
  openOriginal(input: Readonly<{
    owner: OwnerScope;
    asset: SystemArchiveOriginalAssetRecord;
    maximumBytes: number;
  }>): Promise<AsyncIterable<Uint8Array>>;
}

export type SystemArchiveWrittenPayload = Readonly<{
  path: string;
  byteLength: number;
  sha256: string;
}>;

export type SystemArchivePublishedArtifact = Readonly<{
  artifactId?: string;
  relativePath: string;
  absolutePath?: string;
  byteLength: number;
  sha256: string;
  contentFingerprint: string;
}>;

export type SystemArchivePublicationResult =
  | Readonly<{ status: "cancelled" }>
  | Readonly<{ status: "published"; artifact: SystemArchivePublishedArtifact }>;

export type SystemArchiveManifestDescriptor = Readonly<{
  sourceApplication: string;
  sourceMigration: string;
  sourceInstallationId: string;
  sourceOwner: SystemArchiveOwnerRecord;
  sourceOwnerCount: 1;
  domainCounts: Readonly<Record<SystemArchiveDomain, number>>;
  excludedOperationalWork: Readonly<Record<string, number>>;
  assets: readonly SystemArchiveAssetRecord[];
}>;

export interface SystemArchiveWriterPort {
  writeSystemMetadata(owner: SystemArchiveOwnerRecord): Promise<SystemArchiveWrittenPayload>;
  writeDomainShards(
    domain: SystemArchiveDomain,
    records: AsyncIterable<SystemRecordEnvelope>,
    options: Readonly<{ targetBytes: number }>,
  ): Promise<readonly SystemArchiveWrittenPayload[]>;
  writeAssetInventory(records: readonly SystemArchiveAssetRecord[]): Promise<SystemArchiveWrittenPayload>;
  writeOriginal(input: Readonly<{
    archivePath: string;
    expectedSha256: string;
    expectedBytes: number;
    expectedMimeType: SystemArchiveAssetRecord["mimeType"];
    expectedPixelWidth: number;
    expectedPixelHeight: number;
    stream: AsyncIterable<Uint8Array>;
  }>): Promise<SystemArchiveWrittenPayload>;
  calculateContentFingerprint(input: Readonly<{
    payloadHashes: readonly string[];
    originalAssetHashes: readonly string[];
  }>): Promise<string>;
  publish(input: Readonly<{
    manifest: SystemArchiveManifestDescriptor;
    contentFingerprint: string;
    cancellationRequested(): Promise<boolean>;
  }>): Promise<SystemArchivePublicationResult>;
  /** Best-effort release after the durable artifact has been linked to its job. */
  cleanupPublishedStaging(): Promise<void>;
  abort(): Promise<void>;
}

export type SystemArchiveExportJob = Readonly<{
  id: string;
  ownerUserId: string;
  leaseOwner: string;
}>;

export type SystemArchiveExportPhase = "capturing" | "writing" | "verifying";

export type SystemArchiveExportReport = Readonly<{
  completedAt: string;
  contentFingerprint: string;
  domainCounts: Readonly<Record<SystemArchiveDomain, number>>;
  originalAssets: number;
  originalBytes: number;
  excludedOperationalWork: Readonly<Record<string, number>>;
}>;

export interface SystemArchiveExportJobPort {
  setPhase(
    job: SystemArchiveExportJob,
    phase: SystemArchiveExportPhase,
    progress: Readonly<Record<string, unknown>>,
  ): Promise<void>;
  cancellationRequested(job: SystemArchiveExportJob): Promise<boolean>;
  markPublished(
    job: SystemArchiveExportJob,
    artifact: SystemArchivePublishedArtifact,
    report: SystemArchiveExportReport,
  ): Promise<void>;
  markCancelled(job: SystemArchiveExportJob): Promise<void>;
  markFailed(job: SystemArchiveExportJob, errorCode: string): Promise<void>;
}

export type SystemArchiveExportDependencies = Readonly<{
  snapshots: SystemArchiveSnapshotPort;
  originals: SystemArchiveOriginalAssetReaderPort;
  writer: SystemArchiveWriterPort;
  jobs: SystemArchiveExportJobPort;
  now?: () => Date;
}>;

export type SystemArchiveExportResult =
  | Readonly<{ status: "cancelled" }>
  | Readonly<{
    status: "published";
    artifact: SystemArchivePublishedArtifact;
    report: SystemArchiveExportReport;
  }>;
