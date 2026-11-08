import type { CastDraftEvidenceFence, CastDraftPreviewResponse } from "@infinite-quest/contracts";

export function createStoryDraftReview() {
  let preview: CastDraftPreviewResponse | undefined, direction = "", notice = "", busy = false, epoch = 0;
  const selected = new Set<string>(), staged = new Map<string, CastDraftEvidenceFence>();
  function reset() { ++epoch; preview = undefined; direction = notice = ""; busy = false; selected.clear(); staged.clear(); }
  function render(container: HTMLElement, options: {
    eligible: boolean; locked: boolean; value(path: string): string | undefined; label(path: string): string;
    fetch(direction: string): Promise<CastDraftPreviewResponse>; apply(path: string, value: string): void;
    turn(number: number): void; refresh(): void;
  }) {
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => { const node = document.createElement(tag); node.textContent = text; return node; };
    const btn = (label: string, fn: () => void, disabled = false) => {
      const node = el("button", label); node.type = "button"; node.disabled = disabled; node.onclick = fn; return node;
    };
    const group = el("section"), input = el("textarea"), label = el("label", "Direction (optional)");
    input.value = direction; input.maxLength = 2000; input.disabled = busy || options.locked; input.oninput = () => { direction = input.value; };
    const canFill = (path: string) => {
      const value = options.value(path);
      return value !== undefined && (!value.trim() || staged.get(path)?.value === value);
    };
    group.className = "story-draft-review";
    group.append(el("h3", "Draft from story")); label.append(input);
    if (options.eligible) group.append(label);
    const fetch = btn("Draft from story", async () => {
      if (busy || options.locked) return;
      busy = true; notice = "Reading eligible story evidence…"; const token = ++epoch; options.refresh();
      try {
        const response = await options.fetch(direction.trim());
        if (token !== epoch) return;
        preview = response; selected.clear();
        for (const proposal of response.proposals) if (canFill(proposal.path)) selected.add(proposal.path);
        notice = response.proposals.length ? "Review suggestions before applying them." : "No supported suggestions are available.";
      } catch (error) {
        if (token === epoch) notice = error instanceof Error && error.message === "Review the latest character before retrying" ? error.message : "Story drafting is unavailable. Check the campaign text provider or retry. Your edits are kept.";
      } finally { if (token === epoch) { busy = false; options.refresh(); } }
    }, !options.eligible || options.locked || busy);
    group.append(fetch);
    if (!options.eligible) group.append(el("p", "An eligible story citation is required."));
    const status = el("p", notice); status.setAttribute("role", "status"); group.append(status);
    if (preview) {
      for (const proposal of preview.proposals) {
        const row = el("fieldset"), check = el("input"), caption = el("label", options.label(proposal.path)), value = options.value(proposal.path);
        check.type = "checkbox"; check.checked = selected.has(proposal.path) && canFill(proposal.path); check.disabled = !canFill(proposal.path) || options.locked;
        check.onchange = () => { if (check.checked) selected.add(proposal.path); else selected.delete(proposal.path); };
        caption.className = "cast-choice"; caption.prepend(check); row.append(caption, el("p", "Current: " + (value || "Blank")), el("p", (proposal.path === "story.otherGuidance" && !proposal.evidenceIds.length ? "Creative guidance: " : "Suggestion: ") + proposal.value));
        for (const id of proposal.evidenceIds) {
          const span = preview.evidence.find(item => item.evidenceId === id);
          if (span) row.append(el("blockquote", span.quote), btn("Turn " + span.turnNumber, () => options.turn(span.turnNumber)));
        }
        group.append(row);
      }
      for (const item of preview.omitted) group.append(el("p", options.label(item.path) + " omitted: " + item.reason.replaceAll("_", " ")));
      if (preview.proposals.length) group.append(btn("Apply selected suggestions", () => {
        for (const item of preview!.proposals) {
          if (!selected.has(item.path) || !canFill(item.path) || (!item.draftEvidenceFence && item.path !== "story.otherGuidance")) continue;
          options.apply(item.path, item.value); if (item.draftEvidenceFence) staged.set(item.path, item.draftEvidenceFence);
        }
        preview = undefined; selected.clear(); notice = "Selected suggestions applied to your draft. Save character to keep them."; options.refresh();
      }, options.locked || busy));
    }
    container.append(group);
  }
  return { render, reset, fences: () => [...staged.values()] };
}
