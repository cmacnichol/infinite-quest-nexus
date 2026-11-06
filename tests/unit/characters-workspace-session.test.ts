import { describe, expect, it, vi } from "vitest";
import { createCharactersWorkspaceSession } from "../../packages/client-web/src/characters-workspace-session.js";

describe("characters workspace refresh", () => {
  it("ignores an old campaign and preserves a dirty draft across refresh", async () => {
    vi.useFakeTimers();
    let release!: (value: never) => void;
    const pending = new Promise<never>(resolve => { release = resolve; });
    const boundary = { turnNumber: 0, timelineRevision: 0 };
    const tracking = { enabled: false, activeTurnNumber: 0, coverageStartTurn: null, trackedThroughTurn: null, state: "disabled" as const, unresolvedCount: 0, firstGap: null };
    let revision = 1;
    const status = () => ({ revision, boundary, capabilities: { editing: true, discovery: false, autoMatch: null, backfill: false, context: false }, contextDisabledReason: null, counts: { identities: 0, details: 0, conflicts: 0 }, tracking });
    const person = { id: "11111111-1111-4111-8111-111111111111", name: "Mara", aliases: [], origin: { kind: "manual" as const }, profile: {}, pinned: false, ignored: false, revision: 1, firstObservedTurn: 0, lastObservedTurn: 0, lastMentionedTurn: null };
    const states: any[] = [];
    const session = createCharactersWorkspaceSession({ api: {
      workspaceStatus: async id => id === "old" ? pending : status(),
      list: async () => ({ revision, boundary, characters: [person], nextCursor: null }),
      detail: async () => ({ revision, boundary, character: { ...person, revision }, observations: [], overrides: [], identityEvents: [], unresolvedCandidateIds: [], autoMatches: [], editorDestination: null })
    }, onChange: state => states.push(state) });
    session.open("old"); session.open("new"); await vi.waitFor(() => expect(states.at(-1)?.status?.revision).toBe(1));
    release(status() as never); await Promise.resolve();
    expect(states.at(-1).campaignId).toBe("new");
    session.select(person.id); await vi.waitFor(() => expect(states.at(-1)?.detail).not.toBeNull());
    session.setDraft({ name: "Draft" }); revision = 2; await session.refresh();
    expect(states.at(-1).draft).toEqual({ name: "Draft" });
    expect(states.at(-1).draftBaseDetail.revision).toBe(1);
    expect(states.at(-1).changedWhileEditing).toBe(true);
    const notifications = states.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(states).toHaveLength(notifications);
    session.dispose(); vi.useRealTimers();
  });
});
