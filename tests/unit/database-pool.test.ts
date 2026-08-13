import { describe, expect, it } from "vitest";
import {
  initialOwnerId,
  type DatabaseClient,
  type DatabasePool
} from "../../packages/database/src/pool.js";

const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";

type OwnerQueryTarget = DatabaseClient | DatabasePool;

function ownerTarget(query: () => Promise<{ rows: Array<{ id: string }> }>): OwnerQueryTarget {
  return { query } as unknown as OwnerQueryTarget;
}

describe("initialOwnerId", () => {
  it("coalesces concurrent and sequential lookups for one query target", async () => {
    let queryCount = 0;
    let resolveQuery: ((value: { rows: Array<{ id: string }> }) => void) | undefined;
    const target = ownerTarget(() => {
      queryCount += 1;
      return new Promise((resolve) => {
        resolveQuery = resolve;
      });
    });

    const first = initialOwnerId(target);
    const second = initialOwnerId(target);
    const third = initialOwnerId(target);

    await Promise.resolve();
    expect(queryCount).toBe(1);
    resolveQuery?.({ rows: [{ id: OWNER_A }] });
    await expect(Promise.all([first, second, third])).resolves.toEqual([OWNER_A, OWNER_A, OWNER_A]);
    await expect(initialOwnerId(target)).resolves.toBe(OWNER_A);
    expect(queryCount).toBe(1);
  });

  it("keeps separate pools isolated in the same process", async () => {
    let poolAQueries = 0;
    let poolBQueries = 0;
    const poolA = ownerTarget(async () => {
      poolAQueries += 1;
      return { rows: [{ id: OWNER_A }] };
    });
    const poolB = ownerTarget(async () => {
      poolBQueries += 1;
      return { rows: [{ id: OWNER_B }] };
    });

    await expect(initialOwnerId(poolA)).resolves.toBe(OWNER_A);
    await expect(initialOwnerId(poolB)).resolves.toBe(OWNER_B);
    await expect(initialOwnerId(poolA)).resolves.toBe(OWNER_A);
    await expect(initialOwnerId(poolB)).resolves.toBe(OWNER_B);
    expect({ poolAQueries, poolBQueries }).toEqual({ poolAQueries: 1, poolBQueries: 1 });
  });

  it("preserves the bootstrap failure and retries after a rejected lookup", async () => {
    let queryCount = 0;
    const target = ownerTarget(async () => {
      queryCount += 1;
      return queryCount === 1 ? { rows: [] } : { rows: [{ id: OWNER_A }] };
    });

    await expect(initialOwnerId(target)).rejects.toThrow(
      "The initial-owner user has not been bootstrapped. Run migrations first."
    );
    await expect(initialOwnerId(target)).resolves.toBe(OWNER_A);
    await expect(initialOwnerId(target)).resolves.toBe(OWNER_A);
    expect(queryCount).toBe(2);
  });

  it("caches a deliberately distinct transaction client separately from its pool", async () => {
    let poolQueries = 0;
    let clientQueries = 0;
    const pool = ownerTarget(async () => {
      poolQueries += 1;
      return { rows: [{ id: OWNER_A }] };
    });
    const client = ownerTarget(async () => {
      clientQueries += 1;
      return { rows: [{ id: OWNER_B }] };
    });

    await expect(Promise.all([initialOwnerId(pool), initialOwnerId(pool)])).resolves.toEqual([OWNER_A, OWNER_A]);
    await expect(Promise.all([initialOwnerId(client), initialOwnerId(client)])).resolves.toEqual([OWNER_B, OWNER_B]);
    expect({ poolQueries, clientQueries }).toEqual({ poolQueries: 1, clientQueries: 1 });
  });
});
