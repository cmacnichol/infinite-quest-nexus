import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { campaignApi, CampaignEditorApiError, loadCampaign } from "../../apps/web-next/src/campaign-editor-api.js";
import * as campaignEditorPageModule from "../../apps/web-next/src/campaign-editor-page.js";
import { CAMPAIGN_SECTIONS, campaignEditorPath, campaignRouteFromPath, campaignStateInspectorMarkup, escapeCampaignText, firstNarrationSentence, narrationCorrectionDialogMarkup, withCampaignActionState } from "../../apps/web-next/src/campaign-editor-model.js";

const campaignEditorPage = campaignEditorPageModule as Record<string, unknown>;

afterEach(() => vi.unstubAllGlobals());

describe("web-next campaign editor routing", () => {
  it("gives every confirmed editor section its own canonical subpage", () => {
    expect(CAMPAIGN_SECTIONS).toEqual(["overview", "character", "state", "history", "chronicle", "illustrations", "world-transfer", "data"]);
    for (const section of CAMPAIGN_SECTIONS) {
      const path = campaignEditorPath("campaign / one", section);
      expect(campaignRouteFromPath(path)).toEqual({ campaignId: "campaign / one", section });
    }
    expect(campaignRouteFromPath("/app/campaigns")).toEqual({ campaignId: null, section: "overview" });
    expect(campaignRouteFromPath("/app/worlds/example")).toBeNull();
  });

  it("escapes untrusted campaign content before it enters markup", () => {
    expect(escapeCampaignText('<img src=x onerror="alert(1)">')).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("reduces accepted narration to one readable sentence for the History ledger", () => {
    expect(firstNarrationSentence("  The gate opens. Beyond it, the road disappears!  ")).toBe("The gate opens.");
    expect(firstNarrationSentence("A single sentence without punctuation")).toBe("A single sentence without punctuation");
    expect(firstNarrationSentence("")).toBe("No narration recorded.");
  });
});

describe("web-next campaign action feedback", () => {
  it("renders historical state as labeled read-only fields instead of raw JSON", () => {
    const markup = campaignStateInspectorMarkup({
      campaignId: "campaign-1",
      activeTurnNumber: 4,
      viewedTurnNumber: 2,
      isCurrent: false,
      revision: 7,
      updatedAt: "2026-08-10T07:14:12.282Z",
      continuitySummary: "The harbor is quiet.",
      openThreads: ["Find the keeper."],
      canonicalFacts: [{ id: "fact-1", content: "The lens is moon glass." }],
      scratchpad: "Private continuity.",
      trackers: [{ id: "trust", name: "Trust", value: "Wary", rules: "Changes through dialogue." }],
      rpgStats: [{ id: "resolve", name: "Resolve", value: 61, note: "Holding steady." }],
      eventTriggers: [],
      pendingEventTriggers: []
    });

    expect(markup).toContain("Historical state after turn 2");
    expect(markup).toContain("This saved snapshot is immutable and cannot be edited.");
    expect(markup).toContain("Continuity summary");
    expect(markup).toContain("Open threads");
    expect(markup).toContain("Canonical facts");
    expect(markup).toContain("Trackers");
    expect(markup).toContain("RPG stats");
    expect(markup).toContain("readonly");
    expect(markup).not.toContain("<pre");
    expect(markup).not.toContain("Edit current state");
  });

  it("routes current-state changes to the dedicated future-generation editor", () => {
    const markup = campaignStateInspectorMarkup({
      campaignId: "campaign / one",
      activeTurnNumber: 4,
      viewedTurnNumber: 4,
      isCurrent: true,
      revision: 8,
      updatedAt: "2026-08-15T12:00:00.000Z"
    });

    expect(markup).toContain("Current state after turn 4");
    expect(markup).toContain("Changes that affect future generations belong on the Current State page.");
    expect(markup).toContain('href="/app/campaigns/campaign%20%2F%20one/state"');
    expect(markup).toContain("Edit current state");
    expect(markup).not.toContain('contenteditable="true"');
  });

  it("explains accepted-turn correction semantics in an explicit save-or-cancel modal", () => {
    const markup = narrationCorrectionDialogMarkup();

    expect(markup).toContain('<dialog id="narration-correction-dialog"');
    expect(markup).toContain('id="narration-correction-form"');
    expect(markup).toContain('id="narration-correction-title" tabindex="-1"');
    expect(markup).toContain("does not reopen or rewrite the completed turn");
    expect(markup).toContain("original accepted narration remains preserved");
    expect(markup).toContain('name="narration"');
    expect(markup).toContain('type="submit"');
    expect(markup).toContain("Save correction");
    expect(markup).toContain('data-dialog-close="narration-correction-dialog"');
    expect(markup).toContain("Cancel");
  });

  it("marks an async action busy immediately and restores the button afterward", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const attributes = new Map<string, string>();
    const button = {
      disabled: false,
      textContent: "Edit narration",
      dataset: {} as DOMStringMap,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name)
    };

    const running = withCampaignActionState(button, "Loading narration…", () => pending);
    expect(button).toMatchObject({ disabled: true, textContent: "Loading narration…", dataset: { state: "working" } });
    expect(attributes.get("aria-busy")).toBe("true");
    release();
    await running;
    expect(button).toMatchObject({ disabled: false, textContent: "Edit narration", dataset: {} });
    expect(attributes.has("aria-busy")).toBe(false);
  });
});

describe("web-next campaign editor API", () => {
  it("loads a selected campaign from the owner-scoped campaign list", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ campaigns: [{ id: "c-1", title: "Glass Harbor" }] }), { status: 200, headers: { "Content-Type": "application/json" } })));
    await expect(loadCampaign("c-1")).resolves.toMatchObject({ title: "Glass Harbor" });
    expect(fetch).toHaveBeenCalledWith("/api/v1/campaigns", expect.objectContaining({ signal: undefined }));
  });

  it("encodes campaign and child identifiers and preserves API failures", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "Revision conflict", details: { revision: 4 } }), { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    await campaignApi.patch("campaign / one", "/turns/turn%20one/correction", { narration: "Corrected" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/campaigns/campaign%20%2F%20one/turns/turn%20one/correction");
    await expect(campaignApi.patch("c-1", "/state", {})).rejects.toMatchObject<Partial<CampaignEditorApiError>>({ message: "Revision conflict", status: 409 });
  });

  it("surfaces either supported API error-envelope message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Provider unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } })));
    await expect(campaignApi.general("/api/v1/providers")).rejects.toMatchObject<Partial<CampaignEditorApiError>>({ message: "Provider unavailable", status: 503 });
  });
});

describe("web-next campaign parity inventory", () => {
  const source = readFileSync("apps/web-next/src/campaign-editor-page.ts", "utf8");

  it("exposes every legacy campaign-management backend seam", () => {
    for (const seam of [
      "/character-profile", "/state", "/turns?limit=100", "/memory/metrics", "/memory/embedding-config",
      "/memory/context-preview", "/memory/reindex", "/memory/embeddings/reindex", "/illustration-config", "/illustration-backfill/preview",
      "/illustration-backfill", "/migrate-world", "/transfer-world/preview", "/transfer-world",
      "/readable-export", "/export", "/branch", "/rewind", "/correction", "/generations/retry-latest",
      "/illustration-segments"
    ]) expect(source).toContain(seam);
  });

  it("keeps destructive and history-changing actions behind confirmation", () => {
    for (const action of ["Migrate this campaign", "Transfer this campaign", "Create a separate campaign", "Rewind this campaign", "Permanently delete"])
      expect(source).toContain(action);
  });

  it("uses owner-scoped selectors instead of exposing opaque configuration identifiers", () => {
    expect(source).toContain('select name="textProviderProfileId"');
    expect(source).toContain('select name="providerProfileId"');
    expect(source).toContain('select name="targetWorldVersionId"');
    expect(source).not.toContain("Target world-version ID");
    expect(source).toContain("No other published worlds available");
  });

  it("places malformed JSON errors beside the exact editor field", () => {
    expect(source).toContain('setAttribute("aria-invalid", "true")');
    expect(source).toContain("campaign-field-error");
    expect(source).toContain("control.focus()");
  });

  it("keeps full turn content out of the visible History ledger", () => {
    expect(source).toContain("firstNarrationSentence(turn.narration)");
    expect(source).toContain("<summary>Manage turn</summary>");
    expect(source).not.toContain('${text(turn.narration)}</div><div class="turn-actions">');
  });

  it("renders the shared Semantic Retrieval controls and every health meaning", () => {
    const markup = campaignEditorPage.chronicleMarkup;
    const healthView = campaignEditorPage.semanticRetrievalHealthView;
    expect(typeof markup).toBe("function");
    expect(typeof healthView).toBe("function");
    if (typeof markup !== "function" || typeof healthView !== "function") return;

    const html = (markup as (metrics: Record<string, unknown>, config: Record<string, unknown>, providers: unknown[]) => string)(
      { turns: 4, memoryCount: 8, semanticHealth: { status: "healthy", message: "Ready.", coveragePercent: 100, indexedMemories: 8, totalMemories: 8, jobStatus: "completed", progress: {}, retrievalImplementation: "chunked_hybrid", retrievalShadowEnabled: true, fallbackCode: null, chunkProtocolVersion: "chronicle-chunk-v1" } },
      { enabled: true, providerProfileId: null, model: "embed-model", batchSize: 16, documentPrefix: null, queryPrefix: null, retrievalImplementation: "chunked_hybrid", retrievalShadowEnabled: true },
      []
    );
    expect(html).toContain("Semantic Retrieval");
    expect(html).toContain('name="retrievalImplementation"');
    expect(html).toContain('value="legacy_hybrid"');
    expect(html).toContain('value="chunked_hybrid" selected');
    expect(html).toContain('name="retrievalShadowEnabled" checked');
    expect(html).toContain("100% compatible vector coverage");
    expect(html).toContain("Production · Chunked hybrid");
    expect(html).toContain("Shadow comparison · On");
    expect(html).toContain("Chronicle local memory remains available when semantic retrieval is off.");
    expect(html).toContain('data-action="reindex-embeddings"');

    const expectedLabels = {
      chronicle_available: "Chronicle available",
      semantic_disabled: "Semantic Retrieval off",
      indexing: "Indexing",
      healthy: "Ready",
      partially_indexed: "Partially indexed",
      provider_degraded: "Provider degraded",
      provider_unavailable: "Provider unavailable",
      fallback_active: "Fallback active",
      chunk_protocol_outdated: "Chunk protocol outdated",
      rebuild_required: "Rebuild required"
    };
    for (const [status, label] of Object.entries(expectedLabels)) {
      expect((healthView as (health: Record<string, unknown>) => Record<string, string>)({ status, coveragePercent: 50, fallbackCode: null })).toMatchObject({ status, label });
    }
    expect((healthView as (health: Record<string, unknown>) => Record<string, string>)({ status: "fallback_active", coveragePercent: 50, fallbackCode: "<raw-error>" })).toMatchObject({ fallbackLabel: "Unavailable" });
  });

  it("sends the shared retrieval fields without adding UI defaults", () => {
    const payload = campaignEditorPage.chronicleEmbeddingConfigPayload;
    expect(typeof payload).toBe("function");
    if (typeof payload !== "function") return;
    expect((payload as (values: Record<string, string>) => Record<string, unknown>)({
      enabled: "true",
      providerProfileId: "provider-1",
      model: "embed-model",
      batchSize: "24",
      documentPrefix: "document: ",
      queryPrefix: "query: ",
      retrievalImplementation: "chunked_hybrid",
      retrievalShadowEnabled: "on"
    })).toEqual({
      enabled: true,
      providerProfileId: "provider-1",
      model: "embed-model",
      batchSize: 24,
      documentPrefix: "document: ",
      queryPrefix: "query: ",
      retrievalImplementation: "chunked_hybrid",
      retrievalShadowEnabled: true
    });
  });

  it("offers the effective campaign text provider when no dedicated embedding provider exists", () => {
    const markup = campaignEditorPage.chronicleMarkup;
    expect(typeof markup).toBe("function");
    if (typeof markup !== "function") return;

    const html = (markup as (
      metrics: Record<string, unknown>,
      config: Record<string, unknown>,
      providers: unknown[],
      campaignTextProviderProfileId: string | null
    ) => string)(
      { semanticHealth: {} },
      { enabled: false, providerProfileId: null, retrievalImplementation: "legacy_hybrid", retrievalShadowEnabled: false },
      [{ id: "text-1", name: "Campaign text", providerType: "openai_compatible", providerRole: "text", enabled: true }],
      "text-1"
    );

    expect(html).toContain('<option value="text-1" selected>Text fallback · Campaign text · openai_compatible</option>');
    expect(html).not.toContain("No embedding provider profiles available");
  });

  it("preserves an explicitly configured text fallback and escapes provider option markup", () => {
    const markup = campaignEditorPage.chronicleMarkup;
    expect(typeof markup).toBe("function");
    if (typeof markup !== "function") return;

    const html = (markup as (
      metrics: Record<string, unknown>,
      config: Record<string, unknown>,
      providers: unknown[],
      campaignTextProviderProfileId: string | null
    ) => string)(
      { semanticHealth: {} },
      { enabled: true, providerProfileId: "text-2", retrievalImplementation: "legacy_hybrid", retrievalShadowEnabled: false },
      [
        { id: "text-1", name: "Campaign text", providerType: "openai_compatible", providerRole: "text", enabled: true },
        { id: "text-2", name: '</option><img src=x onerror="alert(1)">', providerType: "openai_compatible", providerRole: "text", enabled: true }
      ],
      "text-1"
    );

    expect(html).toContain('<option value="text-2" selected>Text fallback · &lt;/option&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt; · openai_compatible</option>');
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
  });

  it("surfaces a configured text provider as incompatible when a dedicated provider now exists", () => {
    const markup = campaignEditorPage.chronicleMarkup;
    expect(typeof markup).toBe("function");
    if (typeof markup !== "function") return;

    const html = (markup as (
      metrics: Record<string, unknown>,
      config: Record<string, unknown>,
      providers: unknown[],
      campaignTextProviderProfileId: string | null
    ) => string)(
      { semanticHealth: {} },
      { enabled: true, providerProfileId: "text-2", retrievalImplementation: "legacy_hybrid", retrievalShadowEnabled: false },
      [
        { id: "text-2", name: "Previously selected text", providerType: "openai_compatible", providerRole: "text", enabled: true },
        { id: "embed-1", name: "Dedicated embeddings", providerType: "openai_compatible", providerRole: "embedding", enabled: true }
      ],
      "text-2"
    );

    expect(html).toContain('<option value="" selected disabled>Choose an eligible embedding provider</option>');
    expect(html).toContain('<option value="text-2" disabled>Configured text provider is no longer eligible · Previously selected text</option>');
    expect(html).toContain('<option value="embed-1">Dedicated embeddings · openai_compatible</option>');
    expect(html).not.toContain('<option value="embed-1" selected>');
  });

  it("normalizes real embed_campaign progress fields", () => {
    const view = campaignEditorPage.semanticRetrievalHealthView as (health: Record<string, unknown>) => Record<string, string>;
    expect(view({ jobStatus: "running", progress: { embedded: 7, total: 11 } }).jobLabel).toBe("Running · 7 of 11 memories");
  });

  it("refreshes Chronicle status in place without discarding unsaved fields or re-enabling busy actions", () => {
    const refresh = campaignEditorPage.refreshChronicleStatusProjection;
    const setBusy = campaignEditorPage.setChronicleOperationBusy;
    expect(typeof refresh).toBe("function");
    expect(typeof setBusy).toBe("function");
    if (typeof refresh !== "function" || typeof setBusy !== "function") return;
    const { document } = parseHTML("<div id=target></div>");
    const target = document.querySelector<HTMLElement>("#target")!;
    const markup = campaignEditorPage.chronicleMarkup as (metrics: Record<string, unknown>, config: Record<string, unknown>, providers: unknown[]) => string;
    target.innerHTML = markup(
      { memoryCount: 4, semanticHealth: { status: "healthy", message: "Ready", coveragePercent: 100 } },
      { enabled: true, providerProfileId: "embed-1", model: "saved-model", batchSize: 8, retrievalImplementation: "chunked_hybrid", retrievalShadowEnabled: false },
      [{ id: "embed-1", name: "Embeddings", providerType: "openai_compatible", providerRole: "embedding", enabled: true }]
    );
    const form = target.querySelector<HTMLFormElement>("#chronicle-form")!;
    const model = form.querySelector<HTMLInputElement>('input[name="model"]')!;
    model.value = "unsaved-model";
    (setBusy as (target: HTMLElement, busy: boolean, enabled: boolean) => void)(target, true, true);

    (refresh as (target: HTMLElement, markup: string) => void)(target, markup(
      { memoryCount: 4, semanticHealth: { status: "indexing", message: "Indexing", coveragePercent: 50, jobStatus: "running", progress: { embedded: 2, total: 4 } } },
      { enabled: true, providerProfileId: "embed-1", model: "saved-model", batchSize: 8, retrievalImplementation: "chunked_hybrid", retrievalShadowEnabled: false },
      []
    ));

    expect(target.querySelector("#chronicle-form")).toBe(form);
    expect(model.value).toBe("unsaved-model");
    expect(target.textContent).toContain("2 of 4 memories");
    expect(Array.from(form.querySelectorAll<HTMLButtonElement>('button[type="submit"], button[data-action="rebuild-memory"], button[data-action="reindex-embeddings"]')).every((button) => button.disabled)).toBe(true);
  });

  it("polls a durable Chronicle job through completion and refreshes each progress response", async () => {
    const monitor = campaignEditorPage.monitorChronicleJob;
    expect(typeof monitor).toBe("function");
    if (typeof monitor !== "function") return;
    const jobs = [{ status: "queued", progress: {} }, { status: "running", progress: { embedded: 2, total: 4 } }, { status: "completed", progress: { embedded: 4, total: 4 } }];
    const loadJob = vi.fn(async () => jobs.shift());
    const refresh = vi.fn(async () => undefined);
    const onProgress = vi.fn();
    const wait = vi.fn(async () => undefined);

    await expect((monitor as (jobId: string, dependencies: Record<string, unknown>) => Promise<unknown>)("job-1", { loadJob, refresh, onProgress, wait, maximumPolls: 4 })).resolves.toMatchObject({ status: "completed" });
    expect(loadJob).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(onProgress.mock.calls.map(([job]) => job.status)).toEqual(["queued", "running", "completed"]);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("wires every Chronicle enqueue response into durable job monitoring and metrics refresh", () => {
    expect(source).toContain('/api/v1/jobs/${encodeURIComponent(jobId)}');
    expect(source).toContain('await monitorAndRefreshChronicle(saved.jobId, "Semantic Retrieval indexing")');
    expect(source).toContain('await monitorAndRefreshChronicle(queued.jobId, "Chronicle rebuild")');
    expect(source).toContain('await monitorAndRefreshChronicle(queued.jobId, "Semantic Retrieval reindex")');
    expect(source).toContain('campaignApi.get<JsonRecord>(campaign.id,"/memory/metrics",controller.signal)');
  });
});
