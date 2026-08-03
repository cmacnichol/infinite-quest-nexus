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

type MutableDate = {
  getDate: unknown;
  getDay: unknown;
  getFullYear: unknown;
  getHours: unknown;
  getMilliseconds: unknown;
  getMinutes: unknown;
  getMonth: unknown;
  getSeconds: unknown;
  getTime: unknown;
  getTimezoneOffset: unknown;
  getUTCDate: unknown;
  getUTCDay: unknown;
  getUTCFullYear: unknown;
  getUTCHours: unknown;
  getUTCMilliseconds: unknown;
  getUTCMinutes: unknown;
  getUTCMonth: unknown;
  getUTCSeconds: unknown;
  setDate: unknown;
  setFullYear: unknown;
  setHours: unknown;
  setMilliseconds: unknown;
  setMinutes: unknown;
  setMonth: unknown;
  setSeconds: unknown;
  setTime: unknown;
  setUTCDate: unknown;
  setUTCFullYear: unknown;
  setUTCHours: unknown;
  setUTCMilliseconds: unknown;
  setUTCMinutes: unknown;
  setUTCMonth: unknown;
  setUTCSeconds: unknown;
  toDateString: unknown;
  toISOString: unknown;
  toJSON: unknown;
  toLocaleDateString: unknown;
  toLocaleString: unknown;
  toLocaleTimeString: unknown;
  toString: unknown;
  toTimeString: unknown;
  toUTCString: unknown;
  valueOf: unknown;
};

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
