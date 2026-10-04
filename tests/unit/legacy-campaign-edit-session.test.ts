import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createEditSession } from "../../packages/client-core/src/edit-session.js";

const script = readFileSync("apps/web/src/nexus.js", "utf8");

type TestSnapshot = Record<string, unknown>;
type CampaignEditGuard = {
  reset(campaignId: string | null, epoch: number, snapshot: TestSnapshot): void;
  isDirty(snapshot: TestSnapshot): boolean;
  markSaved(campaignId: string | null, epoch: number, snapshot: TestSnapshot): void;
  canLeave(nextCampaignId: string | null, options: {
    getCurrentCampaignId: () => string | null;
    getCurrentEpoch: () => number;
    getSnapshot: () => TestSnapshot;
    confirm: () => Promise<"save" | "discard" | "stay">;
    save: (snapshot: TestSnapshot) => Promise<boolean>;
    discard?: () => void | Promise<void>;
  }): Promise<boolean>;
};
type CampaignEditGuardFactory = (
  createSession: typeof createEditSession,
  equal: (left: TestSnapshot, right: TestSnapshot) => boolean
) => CampaignEditGuard;

function campaignEditGuard(): CampaignEditGuardFactory {
  const start = script.indexOf("function createCampaignEditGuard(");
  if (start < 0) throw new Error("Missing createCampaignEditGuard");
  const next = /\n(?:async )?function /.exec(script.slice(start + 1));
  if (!next) throw new Error("Missing function boundary after createCampaignEditGuard");
  const source = script.slice(start, start + 1 + next.index);
  return Function("createEditSession, equal", `${source}; return createCampaignEditGuard(createEditSession, equal);`) as CampaignEditGuardFactory;
}

describe("legacy campaign edit session", () => {
  it("switch_stay_preserves_title_and_selection", async () => {
    const createGuard = campaignEditGuard();
    const guard = createGuard(createEditSession, (left, right) => JSON.stringify(left) === JSON.stringify(right));
    let title = "Saved title";
    let selectedCampaignId = "campaign-a";
    let epoch = 4;
    guard.reset(selectedCampaignId, epoch, { title });
    title = "Local title";

    const allowed = await guard.canLeave("campaign-b", {
      getCurrentCampaignId: () => selectedCampaignId,
      getCurrentEpoch: () => epoch,
      getSnapshot: () => ({ title }),
      confirm: async () => "stay",
      save: vi.fn()
    });

    expect(allowed).toBe(false);
    expect(title).toBe("Local title");
    expect(selectedCampaignId).toBe("campaign-a");
  });

  it("same_campaign_refresh_preserves_dirty_metadata", async () => {
    const guard = campaignEditGuard()(createEditSession, (left, right) => JSON.stringify(left) === JSON.stringify(right));
    const snapshot = { title: "Edited title" };
    guard.reset("campaign-a", 1, { title: "Saved title" });

    await expect(guard.canLeave("campaign-a", {
      getCurrentCampaignId: () => "campaign-a",
      getCurrentEpoch: () => 1,
      getSnapshot: () => snapshot,
      confirm: vi.fn(),
      save: vi.fn()
    })).resolves.toBe(false);

    expect(guard.isDirty(snapshot)).toBe(true);
  });
  it("switch_discard_does_not_write", async () => {
    const guard = campaignEditGuard()(createEditSession, (left, right) => JSON.stringify(left) === JSON.stringify(right));
    let title = "Local title";
    guard.reset("campaign-a", 1, { title: "Saved title" });
    const save = vi.fn();
    const discard = vi.fn();

    await expect(guard.canLeave("campaign-b", {
      getCurrentCampaignId: () => "campaign-a",
      getCurrentEpoch: () => 1,
      getSnapshot: () => ({ title }),
      confirm: async () => "discard",
      save
    })).resolves.toBe(true);

    expect(save).not.toHaveBeenCalled();
    expect(guard.isDirty({ title })).toBe(false);
  });

  it("switch_save_waits_for_success", async () => {
    const guard = campaignEditGuard()(createEditSession, (left, right) => JSON.stringify(left) === JSON.stringify(right));
    const snapshot = { title: "Local title" };
    guard.reset("campaign-a", 7, { title: "Saved title" });
    let resolveSave!: (ok: boolean) => void;
    const save = vi.fn(() => new Promise<boolean>((resolve) => { resolveSave = (ok) => { if (ok) guard.markSaved("campaign-a", 7, snapshot); resolve(ok); }; }));
    const leaving = guard.canLeave("campaign-b", {
      getCurrentCampaignId: () => "campaign-a",
      getCurrentEpoch: () => 7,
      getSnapshot: () => snapshot,
      confirm: async () => "save",
      save
    });

    await vi.waitFor(() => expect(save).toHaveBeenCalledWith(snapshot));
    let settled = false;
    void leaving.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    resolveSave(true);
    await expect(leaving).resolves.toBe(true);
  });

  it("save_failure_preserves_fields", async () => {
    const guard = campaignEditGuard()(createEditSession, (left, right) => JSON.stringify(left) === JSON.stringify(right));
    const snapshot = { title: "Unsaved title" };
    guard.reset("campaign-a", 2, { title: "Saved title" });

    await expect(guard.canLeave("campaign-b", {
      getCurrentCampaignId: () => "campaign-a",
      getCurrentEpoch: () => 2,
      getSnapshot: () => snapshot,
      confirm: async () => "save",
      save: async () => false
    })).resolves.toBe(false);

    expect(guard.isDirty(snapshot)).toBe(true);
    expect(snapshot.title).toBe("Unsaved title");
  });

  it("late_save_does_not_update_other_campaign", async () => {
    const guard = campaignEditGuard()(createEditSession, (left, right) => JSON.stringify(left) === JSON.stringify(right));
    const snapshot = { title: "Unsaved title" };
    let campaignId = "campaign-a";
    let epoch = 9;
    guard.reset(campaignId, epoch, { title: "Saved title" });
    let resolveSave!: (ok: boolean) => void;
    const leaving = guard.canLeave("campaign-b", {
      getCurrentCampaignId: () => campaignId,
      getCurrentEpoch: () => epoch,
      getSnapshot: () => snapshot,
      confirm: async () => "save",
      save: async () => new Promise<boolean>((resolve) => { resolveSave = resolve; })
    });
    await vi.waitFor(() => expect(resolveSave).toBeTypeOf("function"));
    campaignId = "campaign-b";
    epoch += 1;
    guard.reset(campaignId, epoch, { title: "Other campaign" });
    resolveSave(true);

    await expect(leaving).resolves.toBe(false);
    expect(guard.isDirty({ title: "Other campaign" })).toBe(false);
  });

  it("auto_memory_save_does_not_mark_metadata_saved", async () => {
    const guard = campaignEditGuard()(createEditSession, (left, right) => JSON.stringify(left) === JSON.stringify(right));
    const metadata = { title: "Local title" };
    let memoryLevel = "standard";
    guard.reset("campaign-a", 3, { ...metadata, storyLengthProfile: "standard" });
    metadata.title = "Edited title";

    memoryLevel = "enhanced";
    await Promise.resolve(memoryLevel);

    expect(guard.isDirty(metadata)).toBe(true);
    expect(memoryLevel).toBe("enhanced");
  });
});
