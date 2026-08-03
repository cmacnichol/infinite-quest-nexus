import { describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../../packages/database/src/pool.js";
import { createApiGenerationApplication } from "../../services/runtime/src/generation-api-composition.js";

describe("createApiGenerationApplication", () => {
  it("provides every command without querying during construction", () => {
    const query = vi.fn();
    const pool = { query } as unknown as DatabasePool;

    const application = createApiGenerationApplication(pool);

    expect(application).toMatchObject({
      enqueueAppend: expect.any(Function),
      enqueueReplacement: expect.any(Function),
      getJob: expect.any(Function),
      getResult: expect.any(Function),
      retry: expect.any(Function),
      cancel: expect.any(Function),
      discard: expect.any(Function)
    });
    expect(query).not.toHaveBeenCalled();
  });
});
