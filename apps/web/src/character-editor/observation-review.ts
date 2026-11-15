import type { CastDetail, ObservationDecisionRequest, ObservationDecisionPreview, ObservationDecisionResult } from "@infinite-quest/contracts";

type Options = {
  document: Document; container: HTMLElement; detail: CastDetail; supported: boolean;
  editing(): boolean; current(): boolean; lock?(): Promise<boolean>;
  preview(id: string, request: ObservationDecisionRequest): Promise<ObservationDecisionPreview>;
  apply(id: string, request: ObservationDecisionRequest): Promise<ObservationDecisionResult>;
  refresh(): Promise<void>; navigate(turn: number): void;
};

/** Render only server-classified actions; evidence and model values are always text. */
export function renderObservationReview(options: Options) {
  const { document, container, detail } = options;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => { const el = document.createElement(tag); el.textContent = text; return el; };
  const button = (label: string, run: () => void) => { const el = node("button", label); el.type = "button"; el.addEventListener("click", run); return el; };
  const observations = new Map([...detail.observations, ...(detail.retractedObservationHistory ?? [])].map(item => [item.id, item]));
  for (const observation of observations.values()) {
    const row = node("section"), description = node("p", `${observation.mode === "claim" ? "Claim" : "Observation"}: ${observation.field} — ${observation.value}`);
    if (observation.evidence.kind === "turn") {
      const evidence = observation.evidence;
      description.append(node("span", ` — “${evidence.quote}” `));
      const source = button(`Turn ${evidence.turnNumber}${evidence.invalidated ? " (replaced)" : ""}`, () => options.navigate(evidence.turnNumber)); source.disabled = evidence.invalidated === true; description.append(source);
    } else description.append(node("span", observation.evidence.kind === "user" ? " — Your edit" : " — World source"));
    row.append(description); container.append(row);
    const status = detail.observationDecisionStatus?.find(item => item.observationId === observation.id);
    if (!status) continue;
    if (status.state === "retracted" || status.retractionEventId) row.append(node("p", "Retracted fact"));
    if (status.reason === "source_invalid") row.append(node("p", "This source is no longer eligible for restoration."));
    else if (status.state === "read_only") row.append(node("p", "This source cannot be changed here."));
    if (!options.supported || !detail.observationDecisionStatus || status.state === "read_only") continue;
    const action = status.state === "retracted" ? "restore" : "retract";
    if (action === "restore" && !status.retractionEventId) continue;
    let busy = false;
    const trigger = button(action === "restore" ? "Restore fact" : "Retract fact", () => { void open(); });
    trigger.disabled = !options.editing(); row.append(trigger);
    async function open() {
      if (busy || !options.editing() || !options.current()) return;
      busy = true; trigger.disabled = true;
      const area = node("section"), message = node("p", "Loading preview…"); area.setAttribute("role", "region"); area.setAttribute("aria-label", `${action === "restore" ? "Restore" : "Retract"} fact confirmation`); area.append(message); row.append(area);
      const request: ObservationDecisionRequest = { action, expectedCastRevision: detail.revision, expectedCharacterRevision: detail.character.revision, expectedBoundary: detail.boundary, idempotencyKey: crypto.randomUUID(), ...(action === "restore" ? { retractionEventId: status!.retractionEventId! } : {}) } as ObservationDecisionRequest;
      const cancel = button("Cancel", () => { if (busy) return; area.remove(); trigger.disabled = !options.editing(); trigger.focus(); });
      try {
        const preview = await options.preview(observation.id, request);
        if (!options.current() || !area.isConnected) return;
        const value = (v: string | null, conflict: boolean) => conflict ? "Conflicting observations" : v ?? "Unknown";
        message.textContent = `${action === "restore" ? "Restore" : "Retract"} this fact?`;
        area.append(node("p", `Before: ${value(preview.currentValue, preview.currentConflict)}`), node("p", `After: ${value(preview.projectedValue, preview.projectedConflict)}`));
        if (preview.currentValue === preview.projectedValue && preview.currentConflict === preview.projectedConflict) area.append(node("p", "The displayed value will remain unchanged, for example because an override takes precedence."));
        const feedback = node("p"); feedback.setAttribute("role", "status");
        const confirm = button(action === "restore" ? "Confirm restore" : "Confirm retraction", () => { void submit(); });
        area.append(confirm, cancel, feedback); busy = false; confirm.focus();
        async function submit() {
          if (busy || !options.current() || !options.editing()) return;
          busy = true; confirm.disabled = true; cancel.disabled = true;
          try {
            if (options.lock && !await options.lock()) { feedback.textContent = "Finish generation before changing this fact."; confirm.disabled = !options.editing(); return; }
            await options.apply(observation.id, request);
            if (options.current()) await options.refresh();
          } catch (error) {
            if (!options.current()) return;
            const stale = (error as { statusCode?: number }).statusCode === 409;
            feedback.textContent = stale ? "The story or character changed. Refresh before trying again." : "Could not confirm the change. Retry to check the same request.";
            confirm.disabled = stale || !options.editing();
          } finally { busy = false; cancel.disabled = false; }
        }
      } catch (error) {
        if (!options.current()) return;
        message.textContent = (error as { statusCode?: number }).statusCode === 409 ? "The story or character changed. Refresh before trying again." : "Preview unavailable. Cancel and try again.";
        area.append(cancel); busy = false; cancel.focus();
      }
    }
  }
}
