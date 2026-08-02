import { describe, expect, it } from "vitest";
import { branchCampaignFromTurn, navigateToStoryCampaign } from "../../apps/web/src/story-routing.js";

describe("Story Player routing", () => {
  it("navigates a branch target through an encoded canonical Story URL", () => {
    const paths: string[] = [];

    navigateToStoryCampaign("Branch / #1", {
      assign: (path: string) => paths.push(path)
    });

    expect(paths).toEqual(["/story/Branch%20%2F%20%231"]);
  });

  it("branches from an earlier turn and navigates to the returned campaign", async () => {
    const requests: Array<{ campaignId: string; request: { targetTurnNumber: number } }> = [];
    const paths: string[] = [];
    const branch = async (campaignId: string, request: { targetTurnNumber: number }) => {
      requests.push({ campaignId, request });
      return { id: "branch campaign" };
    };

    await branchCampaignFromTurn("parent-campaign", 1, branch, {
      assign: (path: string) => paths.push(path)
    });

    expect(requests).toEqual([{
      campaignId: "parent-campaign",
      request: { targetTurnNumber: 2 }
    }]);
    expect(paths).toEqual(["/story/branch%20campaign"]);
  });
});
