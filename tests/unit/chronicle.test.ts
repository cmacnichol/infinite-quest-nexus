import { describe, expect, it } from "vitest";
import { buildTurnFictionMemory, compressTurnMemory, formatLegacySummary } from "../../packages/story-engine/src/chronicle.js";
import { campaignEmbeddingConfigSchema, DEFAULT_EMBEDDING_MODEL, MAX_MEMORY_CONTEXT_BUDGET_TOKENS, memoryContextQuerySchema } from "../../packages/contracts/src/memory.js";

describe("Chronicle memory construction", () => {
  it("defaults campaign embeddings to the standard Nomic model", () => {
    const config = campaignEmbeddingConfigSchema.parse({ enabled: false });
    expect(config.model).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(config.model).toBe("text-embedding-nomic-embed-text-v1.5");
  });

  it("allows the API to resolve an enabled campaign's provider fallback", () => {
    const config = campaignEmbeddingConfigSchema.parse({ enabled: true });
    expect(config.providerProfileId).toBeNull();
    expect(config.model).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(config.documentPrefix).toBeNull();
    expect(config.queryPrefix).toBeNull();
  });

  it("clamps oversized provider-derived context budgets at the API boundary", () => {
    const query = memoryContextQuerySchema.parse({ budgetTokens: 2_048_000 });
    expect(query.budgetTokens).toBe(MAX_MEMORY_CONTEXT_BUDGET_TOKENS);
  });

  it("indexes only action and fiction narration", () => {
    const memory = buildTurnFictionMemory({
      action: "Open Location Alpha.",
      narration: "Object Beta opens. The skill check rolled 31. Marker One becomes visible.",
      roll: { result: 31 },
      scratchpadSnapshot: "Never expose this secret."
    }, 3);
    expect(memory.content).toContain("Open Location Alpha");
    expect(memory.content).toContain("Marker One becomes visible");
    expect(memory.content).not.toContain("skill check");
    expect(memory.content).not.toContain("Never expose");
    expect(memory.sanitized).toBe(true);
  });

  it("provides progressively smaller compression levels", () => {
    const content = `Turn 1\nPlayer action: Inspect Object Beta.\nNarration: ${"Location Alpha contains a carefully described marker. ".repeat(80)}`;
    const full = compressTurnMemory(content, "full");
    const balanced = compressTurnMemory(content, "balanced");
    const compact = compressTurnMemory(content, "compact");
    expect(full.length).toBeGreaterThan(balanced.length);
    expect(balanced.length).toBeGreaterThan(compact.length);
  });

  it("normalizes legacy fullHistory into a readable checkpoint", () => {
    const summary = formatLegacySummary({
      characters: "Test Character seeks Object Beta.",
      plotDetails: "Marker One revealed Object Beta."
    });
    expect(summary).toContain("Characters:");
    expect(summary).toContain("Plot:");
  });
});
