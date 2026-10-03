import { describe, expect, it, vi } from "vitest";
import {
  createStoryActivityAccessVerifier,
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
    const api = { generation: {}, activity: {} };
    const source = { watch: vi.fn() };
    const workflow = { submit: vi.fn(), resume: vi.fn() };
    const illustrations = { config: vi.fn() };
    const storyMemory = { get: vi.fn(), update: vi.fn() };
    const activity = { dispose: vi.fn() };
    const cache = { dispose: vi.fn() };
    const notifications = { dispose: vi.fn() };
    const factories = {
      createActivity: vi.fn(() => activity),
      createActivityCache: vi.fn(() => cache),
      createActivityVisibility: vi.fn(() => visibility),
      createActivityNotifications: vi.fn(() => notifications),
      createSession: vi.fn(() => session),
      createClock: vi.fn(() => clock),
      createDelay: vi.fn(() => delay),
      createVisibility: vi.fn(() => visibility),
      createIdFactory: vi.fn(() => idFactory),
      createApi: vi.fn(() => api),
      createPendingSubmissions: vi.fn(() => pendingSubmissions),
      createSource: vi.fn(() => source),
      createWorkflow: vi.fn(() => workflow),
      createIllustrations: vi.fn(() => illustrations),
      createStoryMemory: vi.fn(() => storyMemory)
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
    expect(factories.createStoryMemory).toHaveBeenCalledWith({ basePath: "/api/v1", session });
    expect(composition.activity).toBe(activity);
    expect(factories.createActivity).toHaveBeenCalledWith(expect.objectContaining({ api: api.activity, cache, scheduler: delay, notifyTabs: notifications }));
    composition.disposeActivity();
    expect(activity.dispose).toHaveBeenCalledOnce();
    expect(cache.dispose).toHaveBeenCalledOnce();
    expect(notifications.dispose).toHaveBeenCalledOnce();
    expect(composition).toMatchObject({ session, clock, delay, idFactory, pendingSubmissions, api, workflow, illustrations, storyMemory });
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

describe("Story Activity current access proof", () => {
  const scope = { ownerUserId: "owner", campaignId: "campaign", apiBase: "https://nexus.test/api/v1" };
  it("rechecks current owner and campaign on every invocation and rejects owner drift before campaign access", async () => {
    const get = vi.fn().mockResolvedValue({ user: { id: "owner" } });
    const syncStatus = vi.fn().mockResolvedValue({});
    const verify = createStoryActivityAccessVerifier({ session: { get }, generation: { syncStatus } } as never);
    const signal = new AbortController().signal;
    expect(await verify(scope, signal)).toBe(true); expect(await verify(scope, signal)).toBe(true);
    expect(get).toHaveBeenCalledTimes(2); expect(syncStatus).toHaveBeenCalledTimes(2);
    get.mockResolvedValueOnce({ user: { id: "another-owner" } }); expect(await verify(scope, signal)).toBe(false); expect(syncStatus).toHaveBeenCalledTimes(2);
  });
  it("separates definitive denial from transport errors and checks revocation after delayed proof", async () => {
    const get = vi.fn().mockResolvedValue({ user: { id: "owner" } }); const syncStatus = vi.fn();
    const verify = createStoryActivityAccessVerifier({ session: { get }, generation: { syncStatus } } as never);
    const controller = new AbortController();
    for (const statusCode of [401, 403, 404]) { syncStatus.mockRejectedValueOnce({ statusCode }); expect(await verify(scope, controller.signal)).toBe(false); }
    const error = new Error("Transport unavailable"); syncStatus.mockRejectedValueOnce(error); await expect(verify(scope, controller.signal)).rejects.toBe(error);
    syncStatus.mockImplementationOnce(async () => { controller.abort(); }); expect(await verify(scope, controller.signal)).toBe(false);
  });
});
