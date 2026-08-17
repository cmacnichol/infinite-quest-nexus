import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHRONICLE_CHUNK_SKIP_REASONS } from "../../packages/domain/src/chronicle-chunking.js";

const inventoryUrl = new URL("../../docs/review/2026-08-05-task-14b-memory-inventory.md", import.meta.url);
const retrievalAuditUrl = new URL("../../docs/review/chronicle-retrieval-audit-future-enhancement.md", import.meta.url);
const chronicleDocumentationUrls = {
  concept: new URL("../../docs/concepts/chronicle-memory.md", import.meta.url),
  embeddings: new URL("../../docs/nexus-guide/chronicle/embeddings.md", import.meta.url),
  retrievalModes: new URL("../../docs/nexus-guide/chronicle/retrieval-modes.md", import.meta.url),
  contextPreview: new URL("../../docs/nexus-guide/chronicle/context-preview.md", import.meta.url),
  recovery: new URL("../../docs/operations/recovery/chronicle-indexing.md", import.meta.url),
  providerConfiguration: new URL("../../docs/installation/provider-configuration.md", import.meta.url),
  deployment: new URL("../../docs/runbooks/deployment.md", import.meta.url),
  decision: new URL("../../docs/architecture/0028-chunked-chronicle-retrieval.md", import.meta.url),
  retrievalAudit: new URL("../../docs/review/chronicle-retrieval-audit-future-enhancement.md", import.meta.url),
  architectureIndex: new URL("../../docs/architecture/index.md", import.meta.url)
} as const;

const rollbackSql = `UPDATE campaign_memory_configs
   SET retrieval_implementation = 'legacy_hybrid',
       retrieval_shadow_enabled = false,
       updated_at = now()
 WHERE retrieval_implementation <> 'legacy_hybrid' OR retrieval_shadow_enabled;`;

async function chronicleDocumentation() {
  return Object.fromEntries(await Promise.all(Object.entries(chronicleDocumentationUrls).map(async ([name, url]) => (
    [name, await readFile(fileURLToPath(url), "utf8")]
  )))) as Record<keyof typeof chronicleDocumentationUrls, string>;
}

async function linkedMarkdownDocument(sourceUrl: URL, label: string): Promise<string> {
  const source = await readFile(fileURLToPath(sourceUrl), "utf8");
  const link = [...source.matchAll(/\[([^\]]+)\]\(([^)]+)\)/gu)]
    .find((match) => match[1] === label)?.[2];
  if (!link) throw new Error(`Missing ${label} link in ${fileURLToPath(sourceUrl)}.`);
  return readFile(fileURLToPath(new URL(link, sourceUrl)), "utf8");
}

describe("Task 14b Chronicle inventory", () => {
  it("assigns every direct memory persistence and callback consumer before adapter cutover", async () => {
    const inventory = await readFile(fileURLToPath(inventoryUrl), "utf8");
    for (const expected of [
      "memory-service.ts",
      "generation-worker-composition.ts",
      "generation-executor-adapter.ts",
      "generation-execution-repository.ts",
      "generation-service.ts",
      "campaign-state-service.ts",
      "campaign-transfer-service.ts",
      "import-service.ts",
      "world-service.ts",
      "provider-service.ts",
      "campaign-archive-service.ts",
      "asset-archive-service.ts",
      "illustration-resolution-job-adapter.ts",
      "autoEnableCampaignEmbeddingIfAvailable",
      "buildContextPreview",
      "enqueueEmbeddingReindex",
      "rebuildCampaignMemories",
      "storeDerivedTurnMemories",
      "accepted-turn fiction write"
    ]) {
      expect(inventory).toContain(expected);
    }
    expect(inventory).toContain("14b2");
    expect(inventory).toContain("14b3");
    expect(inventory).not.toContain("TBD");
  });

  it("enumerates the exact six memory handlers, generic Chronicle job read, and six generation callbacks", async () => {
    const inventory = await readFile(fileURLToPath(inventoryUrl), "utf8");
    const memoryRoutes = [
      "GET /api/v1/campaigns/:campaignId/memory/metrics",
      "GET /api/v1/campaigns/:campaignId/memory/context-preview",
      "POST /api/v1/campaigns/:campaignId/memory/reindex",
      "GET /api/v1/campaigns/:campaignId/memory/embedding-config",
      "PUT /api/v1/campaigns/:campaignId/memory/embedding-config",
      "POST /api/v1/campaigns/:campaignId/memory/embeddings/reindex"
    ];
    const callbacks = [
      "autoEnableCampaignEmbeddingIfAvailable",
      "buildContextPreview",
      "enqueueEmbeddingReindex",
      "rebuildCampaignMemories",
      "storeDerivedTurnMemories",
      "accepted-turn fiction write"
    ];

    expect(memoryRoutes).toHaveLength(6);
    expect(callbacks).toHaveLength(6);
    for (const route of memoryRoutes) expect(inventory).toContain("`" + route + "`");
    for (const callback of callbacks) expect(inventory).toContain("`" + callback + "`");
    expect(inventory).toContain("`GET /api/v1/jobs/:jobId`");
  });

  it("pins the staged chunked-retrieval rollout and rollback contract across operator documentation", async () => {
    const docs = await chronicleDocumentation();
    expect(docs.concept).toContain("**Semantic Retrieval**");
    expect(docs.concept).toContain("100% terminal coverage");
    expect(docs.concept).toContain("There is no reranking stage");
    expect(docs.embeddings).toContain("`index_memory_chunks_v2`");
    for (const status of [
      "chronicle_available", "semantic_disabled", "indexing", "healthy", "partially_indexed",
      "provider_degraded", "provider_unavailable", "fallback_active", "chunk_protocol_outdated",
      "rebuild_required"
    ]) {
      expect(docs.embeddings).toContain("`" + status + "`");
    }
    for (const override of [
      "embeddingMaxInputTokens", "embeddingMaxBatchItems", "embeddingMaxBatchTokens",
      "embeddingDimensions", "embeddingMaxRetries"
    ]) {
      expect(docs.providerConfiguration).toContain("`" + override + "`");
    }
    expect(docs.retrievalModes).toContain("Shadow comparison never changes production selection.");
    expect(docs.contextPreview).toContain("`selectedForProduction`");
    expect(docs.recovery).toContain(rollbackSql);
    expect(docs.deployment).toContain(rollbackSql);
    expect(docs.deployment).toContain("7 days");
    expect(docs.deployment).toContain("256 entries per campaign");
    expect(docs.deployment).toContain("30 days");
    expect(docs.deployment).toContain("5,000 runs per campaign");
    expect(docs.deployment).toContain("pnpm evaluate:chronicle -- --implementation legacy_hybrid --output tmp/chronicle-evaluation/legacy-baseline.json");
    expect(docs.deployment).toContain("pnpm evaluate:chronicle -- --calibrate --baseline tmp/chronicle-evaluation/legacy-baseline.json --write-profile packages/domain/src/generated/chronicle-retrieval-profile-v2.ts");
    expect(docs.decision).toContain("`index_memory_chunks_v2`");
    expect(docs.decision).toContain("There is no reranking stage");
    for (const document of [docs.concept, docs.embeddings, docs.retrievalModes, docs.recovery, docs.deployment, docs.decision]) {
      const normalized = document.replace(/\s+/gu, " ");
      expect(normalized).toContain("at least one current chunk is embedded");
      expect(normalized).toContain("fully sanitized-skipped index uses the complete legacy path");
    }
    for (const document of [docs.embeddings, docs.decision]) {
      for (const reason of CHRONICLE_CHUNK_SKIP_REASONS) {
        expect(document).toContain("`" + reason + "`");
      }
    }
    expect(docs.decision).toContain("`0076_chronicle_chunk_skip_reasons.sql`");
  });

  it("never instructs operators to mutate accepted turns or delete legacy embeddings", async () => {
    const docs = await chronicleDocumentation();
    const operatorGuides = [
      docs.embeddings,
      docs.retrievalModes,
      docs.contextPreview,
      docs.recovery,
      docs.providerConfiguration,
      docs.deployment
    ];
    const unsafeAcceptedTurnInstruction = /^\s*(?:(?:\d+[.)]|[-*])\s*)?(?:(?:edit|rewrite|modify|remove|delete|drop)\s+(?:the\s+)?accepted(?:-turn)?\s+(?:rows|turns|narration)|(?:update|delete\s+from|drop\s+table)\s+(?:public\.)?turns\b)/imu;
    const unsafeLegacyEmbeddingInstruction = /^\s*(?:(?:\d+[.)]|[-*])\s*)?(?:delete|remove|drop)\s+(?:the\s+)?legacy\s+(?:embeddings|vectors)/imu;
    for (const guide of operatorGuides) {
      expect(guide).not.toMatch(unsafeAcceptedTurnInstruction);
      expect(guide).not.toMatch(unsafeLegacyEmbeddingInstruction);
    }
    const combined = operatorGuides.join("\n");
    expect(combined).toContain("Do not edit accepted turns");
    expect(combined).toContain("Do not delete legacy embeddings or vectors");
  });

  it("documents Chronicle retrieval audit lifecycle, privacy, and unknown-history semantics", async () => {
    const docs = await chronicleDocumentation();
    expect(docs.retrievalModes).toContain("## Turn retrieval audit");
    expect(docs.retrievalModes).toContain("`chronicleRetrieval: null`");
    expect(docs.retrievalModes).toContain("Dedicated embedding provider contributed semantic ranking");
    expect(docs.retrievalModes).toContain("Text-role provider was explicitly used through the embedding interface");
    expect(docs.retrievalModes).toContain("Complete legacy fallback supplied the accepted prompt context");
    expect(docs.retrievalModes).toContain("No semantic rank contributed; inspect sanitized `fallbackCode`");
    expect(docs.retrievalModes).toContain("Semantic rank used cached query vectors; no live embedding call occurred");
    expect(docs.embeddings).toContain("Turn-history retrieval audit");
    expect(docs.embeddings).toContain("do not infer or backfill");
    expect(docs.retrievalAudit).toContain("Implemented and verified");
    expect(docs.retrievalAudit).toContain("[ADR 0029](../architecture/0029-chronicle-turn-retrieval-audit.md)");
    expect(docs.retrievalAudit).toContain("[implementation plan](../superpowers/plans/2026-08-16-chronicle-turn-retrieval-audit.md)");
    expect(docs.retrievalAudit).toContain("Operational telemetry retention is not turn-history retention.");
    expect(docs.retrievalAudit).toContain("## Approved implementation");
    expect(docs.retrievalAudit).toContain("Historical research below is superseded where it conflicts with ADR 0029.");
    expect(docs.retrievalAudit).toContain("The accepted-turn audit contains only the approved safe provider labels and");
    expect(docs.retrievalAudit).toContain("never a provider account identifier, endpoint, credential, or raw retrieval");
    const approvedContract = docs.retrievalAudit.match(/```ts([\s\S]*?)```/u)?.[1] ?? "";
    expect(approvedContract).not.toContain("providerProfileId");
    expect(approvedContract).not.toContain("providerFingerprint");
    expect(docs.retrievalAudit).not.toContain("## Recommended audit contract");
    expect(docs.retrievalAudit).not.toContain("## Proposed implementation sequence");
    expect(docs.architectureIndex).toContain("[ADR 0029: Chronicle turn retrieval audits are versioned, atomic provenance](./0029-chronicle-turn-retrieval-audit.md)");
  });

  it("resolves the retrieval-audit implementation plan from its review link", async () => {
    await expect(linkedMarkdownDocument(retrievalAuditUrl, "implementation plan"))
      .resolves.toContain("# Chronicle Turn Retrieval Audit Implementation Plan");
  });
});
