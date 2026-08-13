import { describe, expect, expectTypeOf, it } from "vitest";
import { createWritableStore } from "../../../packages/client-core/src/store.js";
import type { Immutable, Store } from "../../../packages/client-core/src/store.js";

describe("createWritableStore", () => {
  it("commits distinct references synchronously and ignores identical references", () => {
    const initial = { value: 1 };
    const next = { value: 1 };
    const store = createWritableStore(initial);
    const notifications: number[] = [];
    store.subscribe((state) => notifications.push(state.value));

    store.set(initial);
    expect(store.get()).toBe(initial);
    expect(notifications).toEqual([]);

    store.set(next);
    expect(store.get()).toBe(next);
    expect(notifications).toEqual([1]);
  });

  it("updates from the current immutable view", () => {
    const store = createWritableStore({ count: 1 });

    store.update((current) => ({ count: current.count + 1 }));

    expect(store.get()).toEqual({ count: 2 });
  });

  it("notifies a listener snapshot in subscription order", () => {
    const store = createWritableStore(0);
    const calls: string[] = [];
    const late = () => calls.push("late");
    const second = () => calls.push("second");
    const first = () => {
      calls.push("first");
      store.subscribe(late);
      unsubscribeSecond();
    };
    const unsubscribeSecond = store.subscribe(second);
    store.subscribe(first);

    store.set(1);
    expect(calls).toEqual(["second", "first"]);

    store.set(2);
    expect(calls).toEqual(["second", "first", "first", "late"]);
  });

  it("returns an idempotent unsubscribe and does not notify subscribers immediately", () => {
    const store = createWritableStore(0);
    const listener = () => undefined;
    const unsubscribe = store.subscribe(listener);

    unsubscribe();
    unsubscribe();
    store.set(1);

    expect(store.get()).toBe(1);
  });

  it("keeps the committed value when a listener throws and stops that notification pass", () => {
    const store = createWritableStore(0);
    const later = () => {
      throw new Error("later listener must not run");
    };
    store.subscribe(() => {
      throw new Error("listener failed");
    });
    store.subscribe(later);

    expect(() => store.set(1)).toThrow("listener failed");
    expect(store.get()).toBe(1);
  });

  it("exposes deeply immutable read types, including a Date without setters", () => {
    type State = { nested: { values: string[] }; createdAt: Date };
    const store = createWritableStore<State>({ nested: { values: ["a"] }, createdAt: new Date() });
    const read: Store<State> = store;

    expectTypeOf(read.get()).toEqualTypeOf<Immutable<State>>();
    expectTypeOf(read.get().nested.values).toEqualTypeOf<readonly string[]>();
    // @ts-expect-error Immutable arrays do not expose push.
    read.get().nested.values.push("b");
    const immutableDate = read.get().createdAt;
    // @ts-expect-error Immutable Date omits every setter.
    immutableDate.setDate(1);
    // @ts-expect-error Immutable Date omits every setter.
    immutableDate.setFullYear(2026);
    // @ts-expect-error Immutable Date omits every setter.
    immutableDate.setHours(1);
    // @ts-expect-error Immutable Date omits every setter.
    immutableDate.setMilliseconds(1);
    // @ts-expect-error Immutable Date omits every setter.
    immutableDate.setMinutes(1);
    // @ts-expect-error Immutable Date omits every setter.
    immutableDate.setMonth(1);
    // @ts-expect-error Immutable Date omits every setter.
    immutableDate.setSeconds(1);
    // @ts-expect-error Immutable Date omits every setter.
    immutableDate.setTime(0);
    // @ts-expect-error Immutable Date omits every setter.
    immutableDate.setUTCDate(1);
    // @ts-expect-error Immutable Date omits every setter.
    immutableDate.setUTCFullYear(2026);
    // @ts-expect-error Immutable Date omits every setter.
    immutableDate.setUTCHours(1);
    // @ts-expect-error Immutable Date omits every setter.
    immutableDate.setUTCMilliseconds(1);
    // @ts-expect-error Immutable Date omits every setter.
    immutableDate.setUTCMinutes(1);
    // @ts-expect-error Immutable Date omits every setter.
    immutableDate.setUTCMonth(1);
    // @ts-expect-error Immutable Date omits every setter.
    immutableDate.setUTCSeconds(1);
    // @ts-expect-error Immutable Date omits every setter.
    immutableDate.setYear(126);
    expectTypeOf(read.get().createdAt.toISOString).toBeFunction();
  });

  it("keeps ordinary setTime-bearing objects recursively immutable", () => {
    type TimerState = { setTime: () => void; nested: { value: number } };
    const state: Immutable<TimerState> = { setTime: () => undefined, nested: { value: 1 } };

    // @ts-expect-error A non-Date setTime member must not bypass recursive readonly mapping.
    state.nested.value = 2;
  });
});
