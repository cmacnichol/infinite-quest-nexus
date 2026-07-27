import { describe, expect, it } from "vitest";
import { branchCampaignFromTurn, navigateToStoryCampaign } from "../../apps/web/public/story-routing.js";

describe("Story Player routing", () => {
  it("navigates a branch target through an encoded canonical Story URL", () => {
    const paths: string[] = [];

    navigateToStoryCampaign("Branch / #1", {
      assign: (path: string) => paths.push(path)
    });

    expect(paths).toEqual(["/story/Branch%20%2F%20%231"]);
  });

  it("branches from an earlier turn and navigates to the returned campaign", async () => {
    const requests: Array<{ path: string; options: { method: string; body: string } }> = [];
    const paths: string[] = [];
    const request = async (path: string, options: { method: string; body: string }) => {
      requests.push({ path, options });
      return { id: "branch campaign" };
    };

    await branchCampaignFromTurn("parent-campaign", 1, request, {
      assign: (path: string) => paths.push(path)
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe("/campaigns/parent-campaign/branch");
    expect(requests[0]?.options.method).toBe("POST");
    expect(JSON.parse(requests[0]?.options.body || "{}")).toEqual({ targetTurnNumber: 2 });
    expect(paths).toEqual(["/story/branch%20campaign"]);
  });
});
