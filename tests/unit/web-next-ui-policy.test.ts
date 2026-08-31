import { expect, it } from "vitest";
import { resolveUiImplementation } from "../../apps/web-next/src/ui/feature-policy.js";

it("keeps migration opt-in and recognizes explicit rollback", () => {
  expect(resolveUiImplementation(undefined)).toBe("native");
  expect(resolveUiImplementation("web-awesome")).toBe("web-awesome");
  expect(resolveUiImplementation("native")).toBe("native");
  expect(resolveUiImplementation("unexpected")).toBe("native");
});
