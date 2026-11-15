import { WORLD_PROFILE_FIELDS } from "../../../packages/client-core/src/characters/profile-fields";
import { characterProfileSchema, type CharacterProfileOrganizationResult, type PlayableCharacter } from "../../../packages/contracts/src/world-library";
import { authoringFailureText, parseAuthoringFailure } from "./authoring-errors";

export function renderOrganizePanel(host: HTMLElement, options: { organize(signal: AbortSignal): Promise<CharacterProfileOrganizationResult>; current: PlayableCharacter; onApply(next: PlayableCharacter): void }): { dispose(): void } {
  const doc = host.ownerDocument;
  const controller = new AbortController();
  let disposed = false;
  const button = doc.createElement("button"); button.type = "button"; button.textContent = "Organize notes with AI";
  const status = doc.createElement("p"); status.setAttribute("role", "status");
  const results = doc.createElement("div");
  host.replaceChildren(button, status, results);
  const current = options.current.profile ?? characterProfileSchema.parse({});
  function value(profile: unknown, path: string): unknown { return path.split(".").reduce<unknown>((item, key) => item && typeof item === "object" ? (item as Record<string, unknown>)[key] : undefined, profile); }
  function display(item: unknown): string { return Array.isArray(item) ? item.join("; ") || "(empty)" : String(item || "(empty)"); }
  button.addEventListener("click", async () => {
    button.disabled = true; results.replaceChildren(); status.textContent = "Organizing retained guidance…";
    try {
      const result = await options.organize(controller.signal);
      if (disposed || controller.signal.aborted) return;
      status.textContent = "Review the proposed changes before applying them.";
      const selected: Array<{ path: string; checkbox: HTMLInputElement }> = [];
      for (const field of WORLD_PROFILE_FIELDS) {
        const proposed = value(result.candidate, field.path);
        const existing = value(current, field.path);
        if (JSON.stringify(proposed) === JSON.stringify(existing)) continue;
        const row = doc.createElement("fieldset");
        const label = doc.createElement("label");
        const checkbox = doc.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = true; checkbox.dataset.profilePath = field.path;
        label.append(checkbox, doc.createTextNode(field.world?.label ?? field.label)); row.append(label);
        for (const text of [`Current: ${display(existing)}`, `Proposed: ${display(proposed)}`, ...result.evidence.filter((item) => item.path === field.path).map((item) => `${item.source}: “${item.quote}”`)]) {
          const p = doc.createElement("p"); p.textContent = text; row.append(p);
        }
        selected.push({ path: field.path, checkbox }); results.append(row);
      }
      for (const [heading, entries] of [["Unassigned text", result.unassignedText], ["Conflicts", result.conflicts], ["Warnings", result.warnings]] as const) {
        if (!entries.length) continue;
        const title = doc.createElement("h4"); title.textContent = heading; const list = doc.createElement("ul");
        for (const entry of entries) { const item = doc.createElement("li"); item.textContent = entry; list.append(item); }
        results.append(title, list);
      }
      const apply = doc.createElement("button"); apply.type = "button"; apply.dataset.action = "apply-organize"; apply.textContent = "Apply selected";
      apply.addEventListener("click", () => {
        if (disposed) return;
        const profile = structuredClone(current);
        for (const { path, checkbox } of selected) {
          if (!checkbox.checked) continue;
          const keys = path.split("."); let target = profile as unknown as Record<string, unknown>;
          for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
          target[keys.at(-1)!] = value(result.candidate, path);
        }
        options.onApply({ ...options.current, profile });
      });
      results.append(apply);
    } catch (error) {
      if (disposed || controller.signal.aborted) return;
      const details = error && typeof error === "object" ? (error as { authoringFailure?: unknown; details?: unknown }) : {};
      const failure = parseAuthoringFailure(details.authoringFailure ?? details.details);
      status.textContent = failure ? authoringFailureText(failure) : "Character organization could not be completed. Try again.";
    } finally { if (!disposed) button.disabled = false; }
  });
  return { dispose() { disposed = true; controller.abort(); } };
}
