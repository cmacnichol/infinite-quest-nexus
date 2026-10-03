export interface EditSession<T> {
  isDirty(current: T): boolean;
  markSaved(value: T): void;
}

/** Tracks the baseline value for a form that has already been normalized by its caller. */
export function createEditSession<T>(initial: T, equal: (left: T, right: T) => boolean): EditSession<T> {
  let savedValue = initial;

  return {
    isDirty(current) {
      return !equal(savedValue, current);
    },
    markSaved(value) {
      savedValue = value;
    }
  };
}
