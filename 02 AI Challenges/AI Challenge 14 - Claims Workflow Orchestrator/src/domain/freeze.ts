/**
 * Recursively applies `Object.freeze` to an object graph in place.
 * Any attempt to mutate properties or array elements in strict mode will throw a TypeError.
 */
export function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    return Object.freeze(value) as unknown as Readonly<T>;
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const prop = record[key];
    if (prop !== null && typeof prop === "object" && !Object.isFrozen(prop)) {
      deepFreeze(prop);
    }
  }

  return Object.freeze(value);
}

/**
 * Clones a value via `structuredClone` and recursively freezes the clone so
 * neither the caller nor external consumers can mutate stored state.
 */
export function cloneAndFreeze<T>(value: T): Readonly<T> {
  return deepFreeze(structuredClone(value));
}

