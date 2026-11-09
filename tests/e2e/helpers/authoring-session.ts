import { type BrowserContext } from "@playwright/test";
import { quietLeafApiPayloads } from "../../fixtures/quiet-leaf-payloads.js";

export async function mockAuthoringSession({ context }: { context: BrowserContext }): Promise<void> {
  const { session } = quietLeafApiPayloads();
  await context.route("**/api/v1/session", route =>
    route.request().method() === "GET" ? route.fulfill({ json: session }) : route.fallback()
  );
}
