import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("GitHub CI test workflow", () => {
  it("runs unit and Docker-provisioned PostgreSQL integration tests", async () => {
    const workflow = await readFile(resolve(".github/workflows/ci.yml"), "utf8");

    expect(workflow).toMatch(/name: Test unit suite\r?\n\s+run: pnpm test:unit/u);
    expect(workflow).toContain("- name: Test PostgreSQL integration suite");
    expect(workflow).toMatch(/run: pnpm test:integration/u);
    expect(workflow).toMatch(
      /name: Reject story exports and sensitive data\r?\n\s+run: pnpm check:data/u
    );
    expect(workflow).toMatch(/name: Type check\r?\n\s+run: pnpm check/u);
    expect(workflow).toMatch(/name: Build application\r?\n\s+run: pnpm build/u);
    expect(workflow).toMatch(
      /name: Validate Compose configuration\r?\n\s+run: POSTGRES_PASSWORD="\$\(openssl rand -hex 32\)" docker compose config --quiet/u
    );
    expect(workflow).toMatch(
      /name: Validate Swarm configuration\r?\n\s+run: docker stack config -c deploy\/swarm\/stack\.yaml >\/dev\/null/u
    );
    expect(workflow).toMatch(
      /name: Build container image\r?\n\s+run: docker build --tag infinitequest-nexus:ci \./u
    );
    expect(workflow).not.toMatch(/services:\r?\n\s+postgres:/u);
    expect(workflow).not.toContain("TEST_DATABASE_URL:");
    expect(workflow).not.toContain("POSTGRES_PASSWORD: compose-validation-only");
    expect(workflow).not.toMatch(/POSTGRES_PASSWORD:\s*\S/u);
    expect(workflow).not.toMatch(/run: pnpm test\r?\n/u);
  });

  it("bounds the PostgreSQL integration suite step", async () => {
    const workflow = await readFile(resolve(".github/workflows/ci.yml"), "utf8");

    expect(workflow).toMatch(
      /name: Test PostgreSQL integration suite\r?\n\s+timeout-minutes: 10\r?\n\s+run: pnpm test:integration/u
    );
  });
});
