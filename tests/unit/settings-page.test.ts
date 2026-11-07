import { expect, it } from "vitest";
import { parseSettingsRoute } from "../../apps/web-next/src/settings/sections.js";
import { fromDisplayUnit, toDisplayUnit } from "../../apps/web-next/src/settings/instance-editor.js";
it("allowlists routes and validates campaign identity without granting writes", () => {
  expect(parseSettingsRoute(new URL("https://example.test/app/settings?section=personal"))).toEqual({ section: "providers", campaignId: null });
  expect(parseSettingsRoute(new URL("https://example.test/app/settings?section=campaign&campaignId=foreign"))).toEqual({ section: "campaign", campaignId: null });
  expect(parseSettingsRoute(new URL("https://example.test/app/story"))).toBeNull();
});
it("converts readable units exactly with no rounding or unsafe integer acceptance", () => {
  expect(toDisplayUnit(1048577, 1048576)).toBe("1.00000095367431640625");
  expect(fromDisplayUnit("1.00000095367431640625", 1048576)).toBe(1048577);
  expect(fromDisplayUnit("0.001", 1000)).toBe(1);
  expect(() => fromDisplayUnit("0.0001", 1000)).toThrow();
  expect(() => fromDisplayUnit("9007199254740992", 1)).toThrow();
  expect(() => fromDisplayUnit("1e3", 1)).toThrow();
});
import { readableRangeValue } from "../../apps/web-next/src/settings/instance-editor.js";
import type { SettingsFieldDescriptor } from "../../packages/contracts/src/instance-settings.js";
it("describes exact byte ranges in readable binary units", () => {
  const field = { unit: "bytes" } as SettingsFieldDescriptor;
  expect(readableRangeValue(field, 1)).toBe("1 byte");
  expect(readableRangeValue(field, 65536)).toBe("64 KiB");
  expect(readableRangeValue(field, 21474836480)).toBe("20 GiB");
  expect(readableRangeValue(field, 1048577)).toBe("1,048,577 bytes");
});
