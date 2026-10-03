import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { deserialize, serialize } from "node:v8";

type ReadWitness = { replay: () => unknown; expected: unknown };
const planning = new AsyncLocalStorage<ReadWitness[]>();

/** Record the actual query results used by a synchronous decision phase.
 * Rechecking them inside an immediate transaction allows unrelated writers to
 * proceed without accepting a decision made from changed catalogue facts. */
export function prepareSqliteReadPlan<T>(decide: () => T, revision?: () => string): {
  value: T;
  isCurrent: () => boolean;
} {
  if (planning.getStore()) throw new Error("SQLite read plans cannot be nested");
  const witnesses: ReadWitness[] = [];
  const before = revision?.();
  const value = planning.run(witnesses, decide);
  if (value instanceof Promise) throw new Error("SQLite read planning must be synchronous");
  const stableRevision = before === revision?.() ? before : undefined;
  return {
    value,
    // Call only after writer admission and BEGIN IMMEDIATE, before any writes.
    isCurrent: () => (stableRevision !== undefined && revision?.() === stableRevision)
      || witnesses.every(({ replay, expected }) => isDeepStrictEqual(replay(), expected)),
  };
}

export function recordSqlitePlanRead<T>(read: () => T): T {
  const witnesses = planning.getStore();
  const result = read();
  if (witnesses) witnesses.push({ replay: read, expected: deserialize(serialize(result)) });
  return result;
}

export function assertOutsideSqliteReadPlan(): void {
  if (planning.getStore()) throw new Error("SQLite read planning must not write or open a transaction");
}
