type SourceReader = (campaign: string, turn: number) => Promise<{
  campaignId: string; sourceHash?: string | undefined; turn: { id: string; turnNumber: number; narration: string }
}>;

/** Read a single accepted turn only when asked. Keep the review and its place intact. */
export function createReviewSource(document: Document, campaign: string, source: { turnId: string; turnNumber: number; sourceHash?: string | undefined },
  quote: string, read: SourceReader | undefined, current: () => boolean, navigate: (turn: number) => void) {
  const section = document.createElement("div"), toggle = document.createElement("button"), body = document.createElement("div");
  toggle.type = "button"; toggle.textContent = `Source turn ${source.turnNumber}`; toggle.setAttribute("aria-expanded", "false");
  body.hidden = true; body.setAttribute("aria-live", "polite");
  section.append(toggle, body);
  let loading = false, loaded = false;
  toggle.addEventListener("click", async () => {
    if (!current()) return;
    if (!read) { navigate(source.turnNumber); return; }
    body.hidden = !body.hidden; toggle.setAttribute("aria-expanded", String(!body.hidden));
    if (body.hidden || loaded || loading) return;
    loading = true; body.textContent = "Loading passage…";
    try {
      const { campaignId, turn, sourceHash } = await read(campaign, source.turnNumber);
      if (!section.isConnected || !current()) return;
      const pos = turn.narration.indexOf(quote);
      if (campaignId !== campaign || turn.id !== source.turnId || turn.turnNumber !== source.turnNumber || !quote || pos < 0 || (source.sourceHash && sourceHash && source.sourceHash !== sourceHash)) {
        body.textContent = "The source has changed. Reload the review before deciding."; return;
      }
      const passage = document.createElement("blockquote"), mark = document.createElement("mark");
      const before = turn.narration.slice(0, pos), after = turn.narration.slice(pos + quote.length);
      mark.textContent = quote;
      passage.append(before.length > 500 ? "…" + before.slice(-500) : before, mark, after.length > 500 ? after.slice(0, 500) + "…" : after);
      const open = document.createElement("button"); open.type = "button"; open.textContent = "Open full turn in story";
      open.addEventListener("click", () => { if (current()) navigate(source.turnNumber); });
      body.replaceChildren(...(!source.sourceHash || !sourceHash ? [document.createTextNode("Current text may differ from the original reviewed source.")] : []), passage, open); loaded = true;
    } catch {
      if (section.isConnected && current()) body.textContent = "Could not load the passage. Close and reopen it to retry.";
    } finally { loading = false; }
  });
  return section;
}
