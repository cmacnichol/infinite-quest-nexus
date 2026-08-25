import {
  SYSTEM_ARCHIVE_DOMAINS,
  archiveAssetRecordSchema,
  systemRecordEnvelopeSchema,
  type ArchiveAssetRecord,
  type SystemArchiveDomain,
  type SystemRecordEnvelope,
} from "@infinite-quest/contracts";
import type {
  SystemArchiveExportDependencies,
  SystemArchiveExportJob,
  SystemArchiveExportReport,
  SystemArchiveExportResult,
  SystemArchiveOriginalAssetRecord,
  SystemArchiveWrittenPayload,
} from "./ports.js";

const DOMAIN_SHARD_TARGET_BYTES = 256 * 1024 * 1024;

function blankDomainCounts(): Record<SystemArchiveDomain, number> {
  return Object.fromEntries(SYSTEM_ARCHIVE_DOMAINS.map((domain) => [domain, 0])) as Record<SystemArchiveDomain, number>;
}

function requireJob(job: SystemArchiveExportJob): void {
  if (!job.id.trim() || !job.ownerUserId.trim() || !job.leaseOwner.trim()) {
    throw Object.assign(new Error("System Archive export job scope is invalid."), {
      code: "archive-export-inconsistent",
    });
  }
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const value = String((error as { code?: unknown }).code);
    if (value.startsWith("archive-")) return value;
  }
  return "archive-export-inconsistent";
}

function recordsForDomain(
  domain: SystemArchiveDomain,
  records: AsyncIterable<SystemRecordEnvelope>,
  increment: () => void,
): AsyncIterable<SystemRecordEnvelope> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const candidate of records) {
        const record = systemRecordEnvelopeSchema.parse(candidate);
        if (record.domain !== domain) {
          throw Object.assign(new Error("System Archive snapshot returned a record in the wrong domain."), {
            code: "archive-export-inconsistent",
          });
        }
        increment();
        yield record;
      }
    },
  };
}

function requireAsset(candidate: SystemArchiveOriginalAssetRecord): SystemArchiveOriginalAssetRecord {
  const record = archiveAssetRecordSchema.parse(candidate.record);
  if (candidate.sourceAssetId !== record.sourceAssetId
    || candidate.archivePath !== record.archivePath
    || candidate.expectedSha256 !== record.contentHash
    || candidate.expectedBytes !== record.byteLength
    || candidate.expectedMimeType !== record.mimeType
    || candidate.expectedPixelWidth !== record.pixelWidth
    || candidate.expectedPixelHeight !== record.pixelHeight) {
    throw Object.assign(new Error("System Archive asset inventory metadata is inconsistent."), {
      code: "archive-export-inconsistent",
    });
  }
  return Object.freeze({ ...candidate, record });
}

function uniqueOriginals(records: readonly SystemArchiveOriginalAssetRecord[]): readonly SystemArchiveOriginalAssetRecord[] {
  const byPath = new Map<string, SystemArchiveOriginalAssetRecord>();
  for (const record of records) {
    const existing = byPath.get(record.archivePath);
    if (existing && (existing.expectedSha256 !== record.expectedSha256
      || existing.expectedBytes !== record.expectedBytes
      || existing.expectedMimeType !== record.expectedMimeType
      || existing.expectedPixelWidth !== record.expectedPixelWidth
      || existing.expectedPixelHeight !== record.expectedPixelHeight)) {
      throw Object.assign(new Error("System Archive originals sharing a path have inconsistent metadata."), {
        code: "archive-export-inconsistent",
      });
    }
    if (!existing) byPath.set(record.archivePath, record);
  }
  return [...byPath.values()].sort((left, right) => left.archivePath.localeCompare(right.archivePath));
}

async function cancelIfRequested(
  job: SystemArchiveExportJob,
  dependencies: SystemArchiveExportDependencies,
): Promise<boolean> {
  if (!(await dependencies.jobs.cancellationRequested(job))) return false;
  await dependencies.writer.abort();
  await dependencies.jobs.markCancelled(job);
  return true;
}

/**
 * Orchestrates one owner-wide export without SQL or path knowledge. The snapshot
 * callback closes before any Original Asset stream is opened.
 */
export async function runSystemExport(
  job: SystemArchiveExportJob,
  dependencies: SystemArchiveExportDependencies,
): Promise<SystemArchiveExportResult> {
  requireJob(job);
  const now = dependencies.now ?? (() => new Date());
  let published = false;
  try {
    await dependencies.jobs.setPhase(job, "capturing", {});
    if (await cancelIfRequested(job, dependencies)) return { status: "cancelled" };

    const captured = await dependencies.snapshots.withOwnerSnapshot(
      { ownerUserId: job.ownerUserId },
      async (snapshot) => {
        const owner = await snapshot.readOwner();
        if (owner.sourceId !== job.ownerUserId) {
          throw Object.assign(new Error("System Archive snapshot owner changed."), {
            code: "archive-export-inconsistent",
          });
        }
        const payloads: SystemArchiveWrittenPayload[] = [
          await dependencies.writer.writeSystemMetadata(owner),
        ];
        const domainCounts = blankDomainCounts();
        for (const domain of SYSTEM_ARCHIVE_DOMAINS) {
          const shards = await dependencies.writer.writeDomainShards(
            domain,
            recordsForDomain(domain, snapshot.streamDomain(domain), () => {
              domainCounts[domain] += 1;
            }),
            { targetBytes: DOMAIN_SHARD_TARGET_BYTES },
          );
          payloads.push(...shards);
        }
        const assets: SystemArchiveOriginalAssetRecord[] = [];
        for await (const asset of snapshot.listOriginalAssets()) assets.push(requireAsset(asset));
        assets.sort((left, right) => left.record.sourceAssetId.localeCompare(right.record.sourceAssetId));
        const excludedOperationalWork = await snapshot.summarizeExcludedOperationalWork();
        return { owner, payloads, domainCounts, assets, excludedOperationalWork };
      },
    );

    await dependencies.jobs.setPhase(job, "writing", {
      records: Object.values(captured.domainCounts).reduce((total, count) => total + count, 0),
      originals: captured.assets.length,
    });
    if (await cancelIfRequested(job, dependencies)) return { status: "cancelled" };

    const assetRecords: ArchiveAssetRecord[] = captured.assets.map((asset) => asset.record);
    const inventoryPayload = await dependencies.writer.writeAssetInventory(assetRecords);
    const originals = uniqueOriginals(captured.assets);
    const originalPayloads: SystemArchiveWrittenPayload[] = [];
    for (const asset of originals) {
      if (await cancelIfRequested(job, dependencies)) return { status: "cancelled" };
      const stream = await dependencies.originals.openOriginal({
        owner: { ownerUserId: job.ownerUserId },
        asset,
        maximumBytes: asset.expectedBytes,
      });
      originalPayloads.push(await dependencies.writer.writeOriginal({
        archivePath: asset.archivePath,
        expectedSha256: asset.expectedSha256,
        expectedBytes: asset.expectedBytes,
        expectedMimeType: asset.expectedMimeType,
        expectedPixelWidth: asset.expectedPixelWidth,
        expectedPixelHeight: asset.expectedPixelHeight,
        stream,
      }));
    }

    const contentFingerprint = await dependencies.writer.calculateContentFingerprint({
      payloadHashes: [...captured.payloads, inventoryPayload].map((payload) => payload.sha256),
      originalAssetHashes: originalPayloads.map((payload) => payload.sha256),
    });
    await dependencies.jobs.setPhase(job, "verifying", {
      contentFingerprint,
      originals: originals.length,
    });
    if (await cancelIfRequested(job, dependencies)) return { status: "cancelled" };

    const publication = await dependencies.writer.publish({
      manifest: {
        sourceInstallationId: captured.owner.sourceInstallationId,
        sourceOwner: captured.owner,
        sourceOwnerCount: 1,
        domainCounts: captured.domainCounts,
        excludedOperationalWork: captured.excludedOperationalWork,
        assets: assetRecords,
      },
      contentFingerprint,
      cancellationRequested: () => dependencies.jobs.cancellationRequested(job),
    });
    if (publication.status === "cancelled") {
      await dependencies.jobs.markCancelled(job);
      return { status: "cancelled" };
    }
    const artifact = publication.artifact;
    published = true;
    const report: SystemArchiveExportReport = Object.freeze({
      completedAt: now().toISOString(),
      contentFingerprint,
      domainCounts: Object.freeze({ ...captured.domainCounts }),
      originalAssets: captured.assets.length,
      originalBytes: originals.reduce((total, asset) => total + asset.expectedBytes, 0),
      excludedOperationalWork: Object.freeze({ ...captured.excludedOperationalWork }),
    });
    await dependencies.jobs.markPublished(job, artifact, report);
    return { status: "published", artifact, report };
  } catch (error) {
    await dependencies.writer.abort().catch(() => undefined);
    await dependencies.jobs.markFailed(job, errorCode(error)).catch(() => undefined);
    throw Object.assign(error instanceof Error ? error : new Error("System Archive export failed."), {
      code: errorCode(error),
      published,
    });
  }
}
