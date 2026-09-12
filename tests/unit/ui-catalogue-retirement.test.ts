import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps the Quiet Leaf visual catalogue free of retired Auto classification state", () => {
  const source = readFileSync("tests/ui/catalogue.ts", "utf8");
  expect(source).toContain('label: "Action / artwork"');
  expect(source).not.toContain("flexible_auto");
  expect(source).not.toContain("requestedInputMode: \"auto\"");
  expect(source).not.toContain("nextTurnInputModeSource: \"auto\"");
  expect(source).not.toContain("intentConfirmation");
});
