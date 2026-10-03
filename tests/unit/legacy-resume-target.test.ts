import { describe, expect, it } from "vitest";
import { resolveResumeCampaign, type ResumeCampaign } from "../../packages/client-core/src/resume-campaign.js";

const campaigns: ResumeCampaign[] = [
  { id: "active-old", status: "active", updatedAt: "2026-09-01T00:00:00.000Z" },
  { id: "active-new", status: "active", updatedAt: "2026-10-01T00:00:00.000Z" },
  { id: "archived", status: "archived", updatedAt: "2026-10-02T00:00:00.000Z" }
];

describe("legacy campaign resume target", () => {
  it("falls back from an unknown remembered ID to the most recently updated active campaign", () => {
    expect(resolveResumeCampaign(campaigns, "missing", null)).toBe(campaigns[1]);
  });

  it("returns null when there are no campaigns", () => {
    expect(resolveResumeCampaign([], null, null)).toBeNull();
  });

  it("uses an explicit campaign selection before the remembered campaign", () => {
    expect(resolveResumeCampaign(campaigns, "active-old", "active-new")).toBe(campaigns[1]);
  });

  it("uses a valid remembered active campaign before the most recently updated campaign", () => {
    expect(resolveResumeCampaign(campaigns, "active-old", null)).toBe(campaigns[0]);
  });

  it("allows an archived campaign only when explicitly selected", () => {
    expect(resolveResumeCampaign(campaigns, "archived", null)).toBe(campaigns[1]);
    expect(resolveResumeCampaign(campaigns, null, "archived")).toBe(campaigns[2]);
  });

  it("ignores a remembered archived campaign and selects the most recent active campaign", () => {
    expect(resolveResumeCampaign(campaigns, "archived", null)).toBe(campaigns[1]);
  });

  it("orders variable UTC fractional seconds and treats invalid or offset timestamps as older", () => {
    const candidates: ResumeCampaign[] = [
      { id: "fraction-short", status: "active", updatedAt: "2026-10-03T12:00:00.1Z" },
      { id: "fraction-long", status: "active", updatedAt: "2026-10-03T12:00:00.11Z" },
      { id: "offset", status: "active", updatedAt: "2026-10-03T13:00:00+01:00" },
      { id: "invalid", status: "active", updatedAt: "not-a-timestamp" }
    ];

    expect(resolveResumeCampaign(candidates, null, null)).toBe(candidates[1]);
  });
});
