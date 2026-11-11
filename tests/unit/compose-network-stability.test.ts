import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function topLevelBlock(source: string, key: string): string | undefined {
  const match = new RegExp(`^${key}:\\n((?:[ \\t]+.*\\n?|\\n)*)`, "m").exec(source);
  return match?.[1];
}

describe("Compose backend network stability", () => {
  // Switching between `compose.yaml` and `compose.yaml + compose.local-single-user.yaml`
  // must not rename the backend network: Compose destroys the old network on the switch
  // and leaves the unchanged postgres container pointing at it ("network ... not found").
  it("lets Compose scope the base backend network to the project instead of a global name", () => {
    const networks = topLevelBlock(readFileSync("compose.yaml", "utf8"), "networks");
    expect(networks, "compose.yaml networks block").toBeDefined();
    expect(networks).toMatch(/^  infinitequest-backend:/m);
    expect(networks).not.toMatch(/^\s+name:/m);
  });

  // A database initialized in local-single-user mode refuses to boot without that mode
  // (settings_policy_required), so `-f compose.yaml` alone must still honor it from .env,
  // together with the loopback bind that keeps the unauthenticated local mode off the network.
  it("forwards the settings access mode and bind address from .env in the base file", () => {
    const compose = readFileSync("compose.yaml", "utf8");
    expect(compose).toContain("INSTANCE_SETTINGS_ACCESS_MODE: ${INSTANCE_SETTINGS_ACCESS_MODE:-}");
    expect(compose).toContain("COMPOSE_APP_BIND_ADDRESS: ${APP_BIND_ADDRESS:-0.0.0.0}");
    expect(compose).toContain('- "${APP_BIND_ADDRESS:-0.0.0.0}:${APP_PORT:-8080}:8080"');
  });

  it("keeps the local single-user overlay from redefining networks", () => {
    const overlay = readFileSync("compose.local-single-user.yaml", "utf8");
    expect(overlay).toContain("COMPOSE_APP_BIND_ADDRESS: 127.0.0.1");
    expect(topLevelBlock(overlay, "networks")).toBeUndefined();
  });
});
