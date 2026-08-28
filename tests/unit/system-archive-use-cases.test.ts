import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { SYSTEM_ARCHIVE_DOMAINS, type SystemRecordEnvelope } from "@infinite-quest/contracts";
import {
  runSystemExport,
  type SystemArchiveExportDependencies,
  type SystemArchiveExportJob,
  type SystemArchiveOriginalAssetRecord,
  type SystemArchiveSnapshot,
  type SystemArchiveWrittenPayload,
} from "../../packages/application/src/system-archives/index.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const job: SystemArchiveExportJob = Object.freeze({
  id: "22222222-2222-4222-8222-222222222222",
  ownerUserId,
  leaseOwner: "system-archive-test-worker",
});
const hash = (digit: string) => digit.repeat(64);

const world: SystemRecordEnvelope = {
  domain: "worlds",
  formatVersion: 1,
  sourceId: "33333333-3333-4333-8333-333333333333",
  record: {
    sourceId: "33333333-3333-4333-8333-333333333333",
    title: "Test world",
    status: "active",
    forkedFromWorldId: null,
    forkedFromWorldVersionId: null,
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
  },
};

const original = Object.freeze({
  sourceAssetId: "44444444-4444-4444-8444-444444444444",
  archivePath: `assets/sha256/aa/${hash("a")}.png`,
  expectedSha256: hash("a"),
  expectedBytes: 3,
  expectedMimeType: "image/png",
  expectedPixelWidth: 1,
  expectedPixelHeight: 1,
  record: {
    sourceAssetId: "44444444-4444-4444-8444-444444444444",
    contentHash: hash("a"),
    archivePath: `assets/sha256/aa/${hash("a")}.png`,
    mimeType: "image/png",
    byteLength: 3,
    pixelWidth: 1,
    pixelHeight: 1,
    technicalMetadata: {},
    library: {
      title: "Original",
      caption: "",
      notes: "",
      tags: [],
      origin: "uploaded",
      reviewStatus: "eligible",
      reuseScope: "owner_library",
      automaticReuseEnabled: false,
      contentCategories: [],
      favorite: false,
      archivedAt: null,
    },
    createdAt: "2026-08-25T00:00:00.000Z",
    bindings: [],
  },
} satisfies SystemArchiveOriginalAssetRecord);

function payload(path: string, digit: string): SystemArchiveWrittenPayload {
  return Object.freeze({ path, byteLength: 1, sha256: hash(digit) });
}

function dependencies(input: Readonly<{
  cancellationChecks?: readonly boolean[];
  checkCancellationInsidePublish?: boolean;
  publishedCleanupError?: Error;
  abortError?: Error;
  originalReader?: SystemArchiveExportDependencies["originals"];
}> = {}) {
  let snapshotOpen = false;
  const events: string[] = [];
  const published = {
    artifactId: "55555555-5555-4555-8555-555555555555",
    relativePath: "exports/system.zip",
    byteLength: 101,
    sha256: hash("f"),
    contentFingerprint: hash("e"),
  } as const;
  const snapshot: SystemArchiveSnapshot = {
    async readOwner() {
      expect(snapshotOpen).toBe(true);
      return {
        sourceId: ownerUserId,
        sourceInstallationId: ownerUserId,
        displayName: "Current owner",
      };
    },
    async readCompatibility() {
      expect(snapshotOpen).toBe(true);
      return {
        sourceApplication: "0.1.0",
        sourceMigration: "0079_resumable_system_archive_uploads",
      };
    },
    async *streamDomain(domain) {
      expect(snapshotOpen).toBe(true);
      if (domain === "worlds") yield world;
    },
    async *listOriginalAssets() {
      expect(snapshotOpen).toBe(true);
      yield original;
    },
    async summarizeExcludedOperationalWork() {
      expect(snapshotOpen).toBe(true);
      return { generation: 2, chronicle: 1 };
    },
  };
  const cancellationChecks = [...(input.cancellationChecks ?? [])];
  const writer: SystemArchiveExportDependencies["writer"] = {
    async writeSystemMetadata() {
      events.push("write-system");
      return payload("system.json", "1");
    },
    async writeDomainShards(domain, records, options) {
      expect(options.targetBytes).toBe(256 * 1024 * 1024);
      const values: SystemRecordEnvelope[] = [];
      for await (const record of records) values.push(record);
      events.push(`write-domain:${domain}:${values.length}`);
      return values.length === 0 ? [] : [payload(`records/${domain}/000001.ndjson`, "2")];
    },
    async writeAssetInventory(records) {
      events.push(`write-inventory:${records.length}`);
      return payload("assets/assets.json", "3");
    },
    async writeOriginal(inputValue) {
      expect(snapshotOpen).toBe(false);
      const chunks: Uint8Array[] = [];
      for await (const chunk of inputValue.stream) chunks.push(chunk);
      events.push(`write-original:${chunks.reduce((total, chunk) => total + chunk.byteLength, 0)}`);
      return payload(inputValue.archivePath, "4");
    },
    async calculateContentFingerprint() {
      return hash("e");
    },
    async publish(inputValue) {
      expect(inputValue.contentFingerprint).toMatch(/^[a-f0-9]{64}$/u);
      expect(inputValue.manifest).toMatchObject({
        sourceApplication: "0.1.0",
        sourceMigration: "0079_resumable_system_archive_uploads",
      });
      events.push("publish");
      if (input.checkCancellationInsidePublish && await inputValue.cancellationRequested()) {
        events.push("publish-cancelled-before-finalization");
        return { status: "cancelled" as const };
      }
      return {
        status: "published" as const,
        artifact: { ...published, contentFingerprint: inputValue.contentFingerprint },
      };
    },
    async cleanupPublishedStaging() {
      events.push("cleanup-published-staging");
      if (input.publishedCleanupError) throw input.publishedCleanupError;
    },
    abort: vi.fn(async () => {
      events.push("abort");
      if (input.abortError) throw input.abortError;
    }),
  };
  const jobs: SystemArchiveExportDependencies["jobs"] = {
    setPhase: vi.fn(async (_job, phase) => {
      events.push(`phase:${phase}`);
    }),
    cancellationRequested: vi.fn(async () => cancellationChecks.shift() ?? false),
    markPublished: vi.fn(async () => {
      events.push("mark-published");
    }),
    markCancelled: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
  };
  const originals = input.originalReader ?? {
    async openOriginal() {
      expect(snapshotOpen).toBe(false);
      return Readable.from([Buffer.from([1, 2, 3])]);
    },
  };
  const value: SystemArchiveExportDependencies = {
    snapshots: {
      async withOwnerSnapshot(owner, consume) {
        expect(owner).toEqual({ ownerUserId });
        snapshotOpen = true;
        try {
          return await consume(snapshot);
        } finally {
          snapshotOpen = false;
        }
      },
    },
    originals,
    writer,
    jobs,
  };
  return { value, events, jobs, writer };
}

describe("System Archive export use case", () => {
  it("streams every deterministic domain inside the snapshot and originals only after it closes", async () => {
    const fixture = dependencies();

    const result = await runSystemExport(job, fixture.value);

    if (result.status !== "published") throw new Error("Expected a published System Archive.");
    expect(result.report.domainCounts.worlds).toBe(1);
    expect(result.report.originalAssets).toBe(1);
    expect(result.report.excludedOperationalWork).toEqual({ generation: 2, chronicle: 1 });
    expect(fixture.events.filter((event) => event.startsWith("write-domain:")).map((event) => event.split(":")[1]))
      .toEqual([...SYSTEM_ARCHIVE_DOMAINS]);
    expect(fixture.events.indexOf("write-original:3"))
      .toBeGreaterThan(fixture.events.indexOf("write-domain:activity-events:0"));
    expect(fixture.events.slice(-3)).toEqual([
      "publish", "mark-published", "cleanup-published-staging"
    ]);
    expect(fixture.jobs.markPublished).toHaveBeenCalledOnce();
    expect(fixture.writer.abort).not.toHaveBeenCalled();
  });

  it("cancels before publication and aborts only unpublished writer state", async () => {
    const fixture = dependencies({ cancellationChecks: [true] });

    const result = await runSystemExport(job, fixture.value);

    expect(result).toEqual({ status: "cancelled" });
    expect(fixture.writer.abort).toHaveBeenCalledOnce();
    expect(fixture.jobs.markCancelled).toHaveBeenCalledWith(job);
    expect(fixture.jobs.markPublished).not.toHaveBeenCalled();
    expect(fixture.events).not.toContain("publish");
  });

  it("lets cancellation win at the writer's pre-publication commit boundary", async () => {
    const fixture = dependencies({
      cancellationChecks: [false, false, false, false, true],
      checkCancellationInsidePublish: true,
    });

    const result = await runSystemExport(job, fixture.value);

    expect(result).toEqual({ status: "cancelled" });
    expect(fixture.events).toContain("publish-cancelled-before-finalization");
    expect(fixture.jobs.markCancelled).toHaveBeenCalledWith(job);
    expect(fixture.jobs.markPublished).not.toHaveBeenCalled();
    expect(fixture.jobs.markFailed).not.toHaveBeenCalled();
  });

  it("keeps accepted cancellation cancelled when durable scratch cleanup must retry", async () => {
    const fixture = dependencies({
      cancellationChecks: [true],
      abortError: new Error("durable cleanup retry pending"),
    });

    await expect(runSystemExport(job, fixture.value)).resolves.toEqual({ status: "cancelled" });

    expect(fixture.writer.abort).toHaveBeenCalledOnce();
    expect(fixture.jobs.markCancelled).toHaveBeenCalledOnce();
    expect(fixture.jobs.markFailed).not.toHaveBeenCalled();
  });

  it("keeps a finalized publication linked when post-finalization cleanup must retry", async () => {
    const fixture = dependencies({
      publishedCleanupError: new Error("durable cleanup retry pending"),
    });

    const result = await runSystemExport(job, fixture.value);

    expect(result.status).toBe("published");
    expect(fixture.events.slice(-3)).toEqual([
      "publish", "mark-published", "cleanup-published-staging"
    ]);
    expect(fixture.jobs.markPublished).toHaveBeenCalledOnce();
    expect(fixture.jobs.markFailed).not.toHaveBeenCalled();
    expect(fixture.writer.abort).not.toHaveBeenCalled();
  });

  it("aborts and marks the durable job failed when an original is missing", async () => {
    const fixture = dependencies({
      originalReader: {
        async openOriginal() {
          throw Object.assign(new Error("missing"), { code: "archive-asset-missing" });
        },
      },
    });

    await expect(runSystemExport(job, fixture.value)).rejects.toMatchObject({ code: "archive-asset-missing" });

    expect(fixture.writer.abort).toHaveBeenCalledOnce();
    expect(fixture.jobs.markFailed).toHaveBeenCalledWith(job, "archive-asset-missing");
    expect(fixture.jobs.markPublished).not.toHaveBeenCalled();
  });
});
