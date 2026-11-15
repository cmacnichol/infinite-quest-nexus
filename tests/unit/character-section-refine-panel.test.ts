import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { playableCharacterSchema } from "../../packages/contracts/src/world-library";
import { mountSectionRefine } from "../../apps/web/src/character-editor/section-refine";

const character = () => playableCharacterSchema.parse({ id: "hero", name: "Hero", profile: { story: { role: "Guide" }, appearance: { eyes: "Silver" } }, rpgStats: [{ name: "Strength" }] });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function setup(generate: any, available = true) {
  const { document, window } = parseHTML('<html><body><div id="host"></div></body></html>');
  const host = document.querySelector<HTMLElement>("#host")!;
  let current = character(); const applied = vi.fn((next) => { current = next; });
  const panel = mountSectionRefine(host, { section: "story", current: () => current, generate, onApply: applied, available, unavailableText: "Unavailable" });
  const click = (selector: string) => host.querySelector<HTMLButtonElement>(selector)!.click();
  const instruction = () => { click('[data-refine-open]'); const input = host.querySelector<HTMLTextAreaElement>('textarea')!; input.value = "Make bolder"; input.dispatchEvent(new window.Event('input', { bubbles: true })); };
  return { host, panel, click, instruction, applied, current: () => current };
}

describe("section refine panel", () => {
  it("captures unsaved candidate, reviews section differences and applies only that section", async () => {
    const generate = vi.fn(async (current) => { const result = structuredClone(current); result.name = "Changed"; result.profile.story.role = "Sailor"; result.profile.appearance.eyes = "Red"; result.rpgStats = []; return result; });
    const t = setup(generate); t.current().profile!.story.role = "Unsaved";
    t.click('[data-refine-open]'); expect(t.host.querySelector('textarea')!.getAttribute('aria-label')).toBe('What should change in Story?');
    expect(t.host.querySelector<HTMLButtonElement>('[data-refine-generate]')!.disabled).toBe(true);
    const input = t.host.querySelector<HTMLTextAreaElement>('textarea')!; input.value = 'Make bolder'; input.dispatchEvent(new input.ownerDocument.defaultView!.Event('input'));
    t.click('[data-refine-generate]'); await flush();
    expect(generate.mock.calls[0]![0].profile.story.role).toBe('Unsaved'); expect(t.host.textContent).toContain('Current: Unsaved'); expect(t.host.textContent).toContain('Proposed: Sailor');
    t.click('[data-refine-apply]'); expect(t.current().name).toBe('Hero'); expect(t.current().profile!.story.role).toBe('Sailor'); expect(t.current().profile!.appearance.eyes).toBe('Silver'); expect(t.current().rpgStats).toHaveLength(1);
  });
  it('rejects stale results and invalidates ignored aborts', async () => {
    let resolve!: (value: ReturnType<typeof character>) => void; const t = setup(() => new Promise(done => { resolve = done; }));
    t.instruction(); t.click('[data-refine-generate]'); expect(t.host.textContent).toContain('Refining…'); t.current().name = 'Edited'; resolve(character()); await flush();
    expect(t.host.textContent).toContain('This character changed. Generate a new section proposal.'); expect(t.applied).not.toHaveBeenCalled();
    t.click('[data-refine-generate]'); t.click('[data-refine-cancel]'); resolve(character()); await flush(); expect(t.applied).not.toHaveBeenCalled(); expect(t.host.querySelector('[data-refine-apply]')).toBeNull();
  });
  it('rejects a candidate edited after preview and handles empty, unavailable and failure states', async () => {
    const t = setup(async () => character()); t.instruction(); t.click('[data-refine-generate]'); await flush(); expect(t.host.textContent).toContain('No changes proposed for this section.');
    t.current().name = 'Edited'; t.click('[data-refine-apply]'); expect(t.host.textContent).toContain('This character changed. Generate a new section proposal.'); expect(t.applied).not.toHaveBeenCalled();
    expect(setup(async () => character(), false).host.textContent).toContain('Unavailable');
    const failed = setup(async () => { throw new Error('offline'); }); failed.instruction(); failed.click('[data-refine-generate]'); await flush(); expect(failed.host.textContent).toContain('could not be'); expect(failed.applied).not.toHaveBeenCalled();
  });
  it('discards a response after disposal even when the provider ignores abort', async () => {
    let resolve!: (value: ReturnType<typeof character>) => void; let signal!: AbortSignal;
    const t = setup((_candidate: unknown, _instruction: string, requestSignal: AbortSignal) => { signal = requestSignal; return new Promise(done => { resolve = done; }); });
    t.instruction(); t.click('[data-refine-generate]'); t.panel.dispose(); expect(signal.aborted).toBe(true);
    resolve(character()); await flush(); expect(t.host.querySelector('[data-refine-apply]')).toBeNull(); expect(t.applied).not.toHaveBeenCalled();
  });

});
