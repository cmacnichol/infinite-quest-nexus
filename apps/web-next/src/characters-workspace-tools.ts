import { renderCastReview } from "../../web/src/cast-review-queue.js";
import { renderLegacyCastScan } from "./campaign-cast-scan-panel";
import type { CastEditorState } from "@infinite-quest/client-core";
import type { CampaignCastApi, CharactersWorkspaceState } from "@infinite-quest/client-web";
export type CastToolContext = { api: CampaignCastApi; campaignId: string; dialog: HTMLDialogElement; generationActive(): boolean; current(): boolean; back(): void; navigateToTurn(turn: number): void; operationKey(operation: string, payload: unknown): string; clearKeys(): void; capabilities: CharactersWorkspaceState<CastEditorState>["status"] };
export async function openCastTool(kind: "scan" | "preview" | "review", context: CastToolContext, scanId?: string): Promise<void> {
  const { api, dialog, generationActive, operationKey } = context;
  const document = dialog.ownerDocument;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => { const el = document.createElement(tag); el.textContent = text; return el; };
  const button = (text: string, action: () => void, disabled = false) => { const el = node("button", text); el.type = "button"; el.disabled = disabled; el.addEventListener("click", action); return el; };
  let scanEpoch = 0;
  async function scan(scanId?: string) {
    const scanToken = ++scanEpoch;
    const current = () => context.current() && scanToken === scanEpoch;
    const campaign = context.campaignId;
    try {
      const [latestData, authority, discovery] = await Promise.all([api.scans.latest(campaign), api.list(campaign), api.discoveryStatus(campaign)]);
      const data = scanId && scanId !== latestData.scan?.id ? { ...latestData, scan: await api.scans.get(campaign, scanId) } : latestData;
      if (!current()) return;
      dialog.replaceChildren(node("h2", "Scan earlier story"), button("Back to characters", context.back));
      renderLegacyCastScan(dialog, { api: api.scans, readDiscovery: () => api.discoveryStatus(campaign), campaignId: campaign, authority, data, discovery, current: () => current(), generationActive, refresh: (id = scanId) => scan(id) });
    } catch { if (!current()) return; dialog.replaceChildren(node("p", "Could not load scan."), button("Retry", () => { void scan(); }), button("Back to characters", context.back)); }
  }
  async function preview() {
    const campaign = context.campaignId;
    dialog.replaceChildren(node("h2", "Likely included for this input"), button("Back to characters", context.back));
    const label = node("label", "Story input"), input = node("textarea"), result = node("section"); label.append(input);
    dialog.append(label, button("Refresh estimate", async () => { try { const data = await api.contextPreview(campaign, { query: input.value }); if (!context.current()) return; result.replaceChildren(node("p", `Estimate at turn ${data.boundary.turnNumber}, cast revision ${data.castRevision}. Refresh after your story or characters change.`)); result.append(node("p", `Estimated usage: ${data.usedTokens.toLocaleString()} of ${data.budgetTokens.toLocaleString()} tokens.`));
      if (data.note) result.append(node("p", data.note)); if (data.disabledReason) result.append(node("p", data.disabledReason));
      if (!data.selected.length && !data.omitted.length && !data.disabledReason) result.append(node("p", "No characters are likely to be included for this input."));
      for (const item of data.selected) result.append(node("p", `Included: ${item.name} · ${item.reason.replaceAll("_", " ")}`));
      if (data.omitted.length) {
        const names = new Map<string, string>(); let cursor: string | undefined;
        try { do { const page = await api.list(campaign, { limit: 50, ...(cursor ? { cursor, expectedRevision: data.castRevision } : {}) }); if (page.revision !== data.castRevision) break; for (const person of page.characters) names.set(person.id, person.name); cursor = page.nextCursor ?? undefined; } while (cursor); } catch { /* The estimate is still useful if names cannot be loaded. */ }
        if (!(context.current())) return;
        for (const item of data.omitted) result.append(node("p", `Omitted: ${names.get(item.characterId) ?? "Character unavailable"} · ${item.reason.replaceAll("_", " ")}`));
      } } catch { if (context.current()) result.replaceChildren(node("p", "Estimate unavailable.")); } }), result);
  }
  async function review(_view: "matches" | "details") {
    const campaign = context.campaignId;
    renderCastReview({ document, container: dialog, api, campaign, current: () => context.current(),
      reviewReadVersion: context.capabilities?.capabilities.reviewDecisionReadVersion, reviewWrites: context.capabilities?.capabilities.reviewDecisions,
      autoMatch: context.capabilities?.capabilities.autoMatch, editing: () => context.capabilities?.capabilities.editing === true && !generationActive(), navigate: context.navigateToTurn,
      back: context.back, key: operationKey, clearKeys: context.clearKeys });
  }
  if (kind === "scan") await scan(scanId); else if (kind === "preview") await preview(); else await review("matches");
}
