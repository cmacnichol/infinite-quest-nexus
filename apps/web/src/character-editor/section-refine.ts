import { playableCharacterSchema, type PlayableCharacter } from "../../../../packages/contracts/src/world-library.js";
import { applyRefinedSection, refinedSectionDiff, type RefineSection } from "../../../../packages/client-core/src/characters/section-refine.js";

type Options = { section: RefineSection; current(): PlayableCharacter; generate(current: PlayableCharacter, instruction: string, signal: AbortSignal): Promise<PlayableCharacter>; onApply(next: PlayableCharacter): void; available: boolean; unavailableText: string };

function fingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical) : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : item;
  return JSON.stringify(canonical(value));
}

export function mountSectionRefine(host: HTMLElement, options: Options): { dispose(): void } {
  const doc = host.ownerDocument;
  const section = options.section[0]!.toUpperCase() + options.section.slice(1);
  let epoch = 0; let disposed = false; let controller: AbortController | null = null;
  const open = doc.createElement("button"); open.type = "button"; open.dataset.refineOpen = ""; open.textContent = "Refine with AI";
  const panel = doc.createElement("div"); panel.hidden = true;
  const label = doc.createElement("label"); label.className = "character-field"; label.textContent = `What should change in ${section}?`;
  const instruction = doc.createElement("textarea"); instruction.setAttribute("aria-label", label.textContent); instruction.rows = 3; label.append(instruction);
  const generate = doc.createElement("button"); generate.type = "button"; generate.dataset.refineGenerate = ""; generate.textContent = "Generate"; generate.disabled = true;
  const cancel = doc.createElement("button"); cancel.type = "button"; cancel.dataset.refineCancel = ""; cancel.textContent = "Cancel";
  const status = doc.createElement("p"); status.setAttribute("role", "status");
  const results = doc.createElement("div");
  panel.append(label, generate, cancel, status, results);
  host.replaceChildren(open, panel);
  if (!options.available) { open.disabled = true; const reason = doc.createElement("p"); reason.textContent = options.unavailableText; host.append(reason); }
  // Compare the same validated (trimmed) form that was captured, so ordinary whitespace never looks like an edit.
  function currentFingerprint(): string {
    const parsed = playableCharacterSchema.safeParse(structuredClone(options.current()));
    return parsed.success ? fingerprint(parsed.data) : "invalid";
  }
  function invalidate(): void { epoch++; controller?.abort(); controller = null; results.replaceChildren(); }
  function stale(): void { invalidate(); status.textContent = "This character changed. Generate a new section proposal."; generate.disabled = !instruction.value.trim(); }
  open.addEventListener("click", () => { if (!disposed && options.available) panel.hidden = false; });
  instruction.addEventListener("input", () => { generate.disabled = controller !== null || !instruction.value.trim(); });
  cancel.addEventListener("click", () => { invalidate(); panel.hidden = true; status.textContent = ""; generate.disabled = !instruction.value.trim(); });
  generate.addEventListener("click", async () => {
    if (disposed || controller || !instruction.value.trim()) return;
    invalidate(); const requestEpoch = epoch; controller = new AbortController(); const signal = controller.signal;
    generate.disabled = true; status.textContent = "Refining…";
    try {
      const captured = playableCharacterSchema.parse(structuredClone(options.current()));
      const capturedFingerprint = fingerprint(captured);
      const proposal = playableCharacterSchema.parse(await options.generate(structuredClone(captured), instruction.value.trim(), signal));
      if (disposed || signal.aborted || requestEpoch !== epoch) return;
      if (currentFingerprint() !== capturedFingerprint) { stale(); return; }
      controller = null; generate.disabled = !instruction.value.trim(); status.textContent = "Review the proposed changes before applying them.";
      const changes = refinedSectionDiff(captured, proposal, options.section);
      if (!changes.length) { const empty = doc.createElement("p"); empty.textContent = "No changes proposed for this section."; results.append(empty); }
      for (const change of changes) {
        const row = doc.createElement("div"); const heading = doc.createElement("strong"); heading.textContent = change.label; row.append(heading);
        for (const [title, value] of [["Current", change.current], ["Proposed", change.proposed]] as const) { const line = doc.createElement("p"); line.textContent = `${title}: ${Array.isArray(value) ? value.join("; ") || "(empty)" : value || "(empty)"}`; row.append(line); }
        results.append(row);
      }
      const apply = doc.createElement("button"); apply.type = "button"; apply.dataset.refineApply = ""; apply.textContent = "Apply";
      apply.addEventListener("click", () => { if (disposed || requestEpoch !== epoch) return; if (currentFingerprint() !== capturedFingerprint) { stale(); return; } invalidate(); options.onApply(applyRefinedSection(captured, proposal, options.section)); });
      results.append(apply);
    } catch {
      if (disposed || signal.aborted || requestEpoch !== epoch) return;
      controller = null; generate.disabled = !instruction.value.trim(); status.textContent = "Character refinement could not be completed. Try again.";
    }
  });
  return { dispose() { disposed = true; invalidate(); } };
}
