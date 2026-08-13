import { describe, expect, it, vi } from "vitest";
import {
  bootstrapStoryPlayer,
  createStoryPlayerComposition
} from "../../apps/web/src/composition.js";

describe("Story Player composition bootstrap", () => {
  it("shares the exact session and clock instances across the adapters and workflow", () => {
    const session = { authorization: vi.fn(), onUnauthorized: vi.fn() };
    const clock = { now: vi.fn(() => 123) };
    const delay = { wait: vi.fn() };
    const visibility = { current: vi.fn(), changes: vi.fn() };
    const idFactory = { create: vi.fn(() => "id-1") };
    const pendingSubmissions = { load: vi.fn(), save: vi.fn(), clear: vi.fn() };
    const api = { generation: {} };
    const source = { watch: vi.fn() };
    const workflow = { submit: vi.fn(), resume: vi.fn() };
    const illustrations = { config: vi.fn() };
    const factories = {
      createSession: vi.fn(() => session),
      createClock: vi.fn(() => clock),
      createDelay: vi.fn(() => delay),
      createVisibility: vi.fn(() => visibility),
      createIdFactory: vi.fn(() => idFactory),
      createApi: vi.fn(() => api),
      createPendingSubmissions: vi.fn(() => pendingSubmissions),
      createSource: vi.fn(() => source),
      createWorkflow: vi.fn(() => workflow),
      createIllustrations: vi.fn(() => illustrations)
    };

    const composition = createStoryPlayerComposition({
      document: {} as Document,
      storage: {} as Storage,
      eventSourceFactory: null,
      random: () => 0.5
    }, factories as never);

    expect(factories.createApi).toHaveBeenCalledOnce();
    expect(factories.createApi).toHaveBeenCalledWith({ basePath: "/api/v1", session });
    expect(factories.createSource).toHaveBeenCalledWith(expect.objectContaining({
      api: api.generation,
      session,
      clock,
      delay,
      visibility
    }));
    expect(factories.createWorkflow).toHaveBeenCalledWith({
      api: api.generation,
      clock,
      pendingSubmissions,
      source
    });
    expect(factories.createIllustrations).toHaveBeenCalledWith({ basePath: "/api/v1", session });
    expect(composition).toMatchObject({ session, clock, delay, idFactory, pendingSubmissions, api, workflow, illustrations });
    Object.values(factories).forEach((factory) => expect(factory).toHaveBeenCalledOnce());
  });

  it("creates one composition and invokes the initializer exactly once", () => {
    const composition = { idFactory: { create: () => "id-1" } };
    const createComposition = vi.fn(() => composition);
    const initialize = vi.fn();

    expect(bootstrapStoryPlayer(createComposition as never, initialize as never)).toBe(composition);
    expect(createComposition).toHaveBeenCalledOnce();
    expect(initialize).toHaveBeenCalledOnce();
    expect(initialize).toHaveBeenCalledWith(composition);
  });
});
