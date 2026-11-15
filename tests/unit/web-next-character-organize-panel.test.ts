import { parseHTML } from "linkedom";
import { expect, it, vi } from "vitest";
import { playableCharacterSchema, characterProfileSchema } from "../../packages/contracts/src/world-library.js";
import { renderOrganizePanel } from "../../apps/web-next/src/character-organize-panel.js";

it("reviews evidence and applies only selected profile fields", async () => {
  const { document } = parseHTML('<div id="host"></div>');
  const host = document.querySelector<HTMLElement>("#host")!;
  const current = playableCharacterSchema.parse({ id: "hero", name: "Hero", characterText: "A guide" });
  const candidate = characterProfileSchema.parse({ story: { role: "Guide", personality: "Patient" } });
  const onApply = vi.fn();
  renderOrganizePanel(host, { current, onApply, organize: async () => ({ candidate, evidence: [{ path: "story.role", source: "notes", quote: "<guide>" }], unassignedText: ["left"], conflicts: ["conflict"], warnings: ["warning"], protocolVersion: "v3" }) });
  host.querySelector<HTMLButtonElement>('button')!.click();
  await Promise.resolve(); await Promise.resolve();
  expect(host.textContent).toContain("<guide>");
  expect(host.querySelector("guide")).toBeNull();
  for (const value of ["Role", "Current:", "Proposed:", "left", "conflict", "warning"]) expect(host.textContent).toContain(value);
  host.querySelector<HTMLInputElement>('[data-profile-path="story.personality"]')!.checked = false;
  host.querySelector<HTMLButtonElement>('[data-action="apply-organize"]')!.click();
  expect(onApply.mock.calls[0]![0].profile.story.role).toBe("Guide");
  expect(onApply.mock.calls[0]![0].profile.story.personality).toBe("");
});


it("reports authoring failures and aborts pending work on disposal", async () => {
  const { document } = parseHTML('<div id="host"></div>');
  const host = document.querySelector<HTMLElement>("#host")!;
  const current = playableCharacterSchema.parse({ id: "hero", name: "Hero", characterText: "A guide" });
  const onApply = vi.fn();
  let signal: AbortSignal | undefined;
  const panel = renderOrganizePanel(host, { current, onApply, organize: async (s) => { signal = s; throw { details: { stage: "organizer", code: "authoring_provider_unavailable", retryable: true, issues: [] } }; } });
  host.querySelector<HTMLButtonElement>("button")!.click();
  await Promise.resolve(); await Promise.resolve();
  expect(host.textContent).toContain("text provider is unavailable");
  expect(onApply).not.toHaveBeenCalled();
  panel.dispose();
  expect(signal?.aborted).toBe(true);
});


it("ignores a response that arrives after disposal even if the provider ignores abort", async () => {
  const { document } = parseHTML('<div id="host"></div>'); const host = document.querySelector<HTMLElement>("#host")!;
  const current = playableCharacterSchema.parse({ id: "hero", name: "Hero" }); const onApply = vi.fn();
  let resolve!: (value: any) => void;
  const panel = renderOrganizePanel(host, { current, onApply, organize: () => new Promise(done => { resolve = done; }) });
  host.querySelector<HTMLButtonElement>("button")!.click(); panel.dispose();
  resolve({ candidate: characterProfileSchema.parse({ story: { role: "Guide" } }), evidence: [], unassignedText: [], conflicts: [], warnings: [], protocolVersion: "v3" });
  await Promise.resolve(); await Promise.resolve();
  expect(host.querySelector('[data-action="apply-organize"]')).toBeNull(); expect(onApply).not.toHaveBeenCalled();
});
