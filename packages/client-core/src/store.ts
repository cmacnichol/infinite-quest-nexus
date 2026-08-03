type DateMutator =
  | "setDate"
  | "setFullYear"
  | "setHours"
  | "setMilliseconds"
  | "setMinutes"
  | "setMonth"
  | "setSeconds"
  | "setTime"
  | "setUTCDate"
  | "setUTCFullYear"
  | "setUTCHours"
  | "setUTCMilliseconds"
  | "setUTCMinutes"
  | "setUTCMonth"
  | "setUTCSeconds"
  | "setYear";

type MutableDate = { setTime: unknown };

export type Immutable<T> =
  T extends MutableDate
    ? Omit<T, DateMutator>
    : T extends (...args: never[]) => unknown
      ? T
      : T extends readonly (infer Item)[]
        ? readonly Immutable<Item>[]
        : T extends object
          ? { readonly [Key in keyof T]: Immutable<T[Key]> }
          : T;

export interface Store<T> {
  get(): Immutable<T>;
  subscribe(listener: (state: Immutable<T>) => void): () => void;
}

export interface WritableStore<T> extends Store<T> {
  set(next: T): void;
  update(reduce: (current: Immutable<T>) => T): void;
}

export function createWritableStore<T>(initial: T): WritableStore<T> {
  let current = initial;
  const listeners = new Set<(state: Immutable<T>) => void>();

  const set = (next: T): void => {
    if (Object.is(current, next)) return;

    current = next;
    for (const listener of [...listeners]) listener(current as Immutable<T>);
  };

  return {
    get: () => current as Immutable<T>,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set,
    update(reduce) {
      set(reduce(current as Immutable<T>));
    }
  };
}
