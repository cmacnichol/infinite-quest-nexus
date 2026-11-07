import { describe, expect, it } from "vitest";
import * as api from "../../apps/web-next/src/campaign-editor-api.js";
import * as routes from "../../apps/web-next/src/settings/sections.js";

const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
describe("Campaign settings ownership", () => {
  it("invalidates old loads and saves on switch or disposal and binds each new editor to one owned campaign", () => {
    expect(api.createCampaignSettingsScope).toBeTypeOf("function");
    const scope = api.createCampaignSettingsScope([{ id: a }, { id: b }]);
    const first = scope.select(a)!;
    const second = scope.select(b)!;
    expect(first.signal.aborted).toBe(true);
    expect(first.current()).toBe(false);
    expect(second.campaignId).toBe(b);
    expect(second.epoch).toBeGreaterThan(first.epoch);
    expect(scope.select("foreign")).toBeNull();
    expect(second.current()).toBe(false);
    expect(scope.select("33333333-3333-4333-8333-333333333333")).toBeNull();
    const third = scope.select(a)!;
    scope.dispose();
    expect(third.current()).toBe(false);
    expect(scope.select(b)).toBeNull();
  });
  it("accepts a relative return to either Story client and rejects external or ambiguous URLs", () => {
    expect(routes.safeSettingsReturn).toBeTypeOf("function");
    for (const url of ["/story/"+a, "/app/story/"+b+"?turn=4", "/nexus/#campaigns"]) {
      expect(routes.safeSettingsReturn(url)).toBe(url);
    }
    for (const url of ["https://elsewhere.example/story","//elsewhere.example","/\\elsewhere.example","/story/../api/v1","/api/v1/session","/story/%2f%2fevil"]) {
      expect(routes.safeSettingsReturn(url)).toBeNull();
    }
  });
});
