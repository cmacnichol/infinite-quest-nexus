import type { Page, Route } from "@playwright/test";
import { turnInputClassificationRequestSchema, userProfileResponseSchema, userProfileUpdateSchema } from "../../packages/contracts/src/index.js";
import { quietLeafApiPayloads, type QuietLeafFixtureOptions } from "./quiet-leaf-payloads.js";

export interface InstalledStoryApi {
  readonly campaignId: string;
  assertNoUnexpectedRequests(): void;
}

function requestLabel(route: Route): string {
  const request = route.request();
  return `${request.method()} ${new URL(request.url()).pathname}`;
}

/**
 * Installs a sanitized, schema-checked API boundary for browser Story tests.
 * It deliberately does not stand up a server or permit arbitrary writes.
 */
export async function installStoryApi(page: Page, options: QuietLeafFixtureOptions = {}): Promise<InstalledStoryApi> {
  const payloads = quietLeafApiPayloads(options);
  const unexpected: string[] = [];
  let user = payloads.session.user;
  let profileUpdates = 0;
  let classificationCalls = 0;

  page.on("request", request => {
    const url = new URL(request.url());
    if (url.protocol.startsWith("http") && url.origin !== "http://127.0.0.1:43175") {
      unexpected.push(`external request: ${request.method()} ${url.href}`);
    }
  });

  await page.route("**/api/v1/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const respond = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

    if (request.method() === "GET" && path === "/api/v1/campaigns") return respond(payloads.campaigns);
    if (request.method() === "GET" && path === "/api/v1/worlds") return respond(payloads.worlds);
    if (request.method() === "GET" && path === `/api/v1/campaigns/${payloads.campaignId}/sync-status`) return respond(payloads.syncStatus);
    if (request.method() === "GET" && path === `/api/v1/campaigns/${payloads.campaignId}/turns`) return respond(payloads.turns);
    if (request.method() === "GET" && path === `/api/v1/campaigns/${payloads.campaignId}/state`) return respond(payloads.runtimeState);
    if (request.method() === "GET" && path === `/api/v1/campaigns/${payloads.campaignId}/state/inspection`) return respond(payloads.runtimeState);
    if (request.method() === "GET" && path === "/api/v1/session") return respond({ ...payloads.session, user });
    if (request.method() === "POST" && path === `/api/v1/campaigns/${payloads.campaignId}/turn-input/classify`) {
      const expectedClassificationCalls = options.expectedClassificationCalls ?? 0;
      if (classificationCalls >= expectedClassificationCalls) {
        unexpected.push(`unexpected classification request: ${requestLabel(route)}`);
        await route.abort("blockedbyclient");
        return;
      }
      turnInputClassificationRequestSchema.parse(JSON.parse(request.postData() ?? "{}"));
      classificationCalls += 1;
      return respond(payloads.classification);
    }
    if (request.method() === "GET" && path === `/api/v1/campaigns/${payloads.campaignId}/illustration-config`) {
      if (options.illustration === "error") return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify(payloads.illustrationError) });
      return respond(payloads.illustrationConfig);
    }
    if (request.method() === "GET" && path === `/api/v1/campaigns/${payloads.campaignId}/illustration-segments`) return respond(payloads.illustrationSegments);

    if (request.method() === "PATCH" && path === "/api/v1/users/me/profile") {
      const expectedProfileUpdates = options.expectedProfileUpdates ?? 0;
      if (profileUpdates >= expectedProfileUpdates) {
        unexpected.push(`unexpected profile mutation: ${requestLabel(route)}`);
        await route.abort("blockedbyclient");
        return;
      }
      const body = userProfileUpdateSchema.parse(JSON.parse(request.postData() ?? "{}"));
      user = userProfileResponseSchema.parse({
        user: {
          ...user,
          ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
          ...(body.settings === undefined ? {} : { settings: body.settings })
        }
      }).user;
      profileUpdates += 1;
      return respond({ user });
    }

    unexpected.push(`unhandled API request: ${requestLabel(route)}`);
    await route.abort("blockedbyclient");
  });

  return {
    campaignId: payloads.campaignId,
    assertNoUnexpectedRequests() {
      const expectedProfileUpdates = options.expectedProfileUpdates ?? 0;
      const expectedClassificationCalls = options.expectedClassificationCalls ?? 0;
      if (profileUpdates !== expectedProfileUpdates) {
        unexpected.push(`expected ${expectedProfileUpdates} profile mutation(s), received ${profileUpdates}`);
      }
      if (classificationCalls !== expectedClassificationCalls) {
        unexpected.push(`expected ${expectedClassificationCalls} classification request(s), received ${classificationCalls}`);
      }
      if (unexpected.length) throw new Error(`Quiet Leaf fixture rejected request(s): ${unexpected.join("; ")}`);
    }
  };
}
