import { AsyncLocalStorage } from "node:async_hooks";
import { isMainThread, workerData } from "node:worker_threads";
import { normalizeResolvedPath } from "./path-utils.js";

const DATA_KEY = "mediaFileLocks";
export const MEDIA_FILE_LOCK_OWNER_KEY = "mediaFileLockOwner";
const GLOBAL_KEY = "__discogeniusMediaFileLocks";
const LANES = 256;
const context = new AsyncLocalStorage<Set<number>>();
let owner = 0;

function view(): Int32Array {
  const state = globalThis as Record<string, unknown>;
  if (!(state[GLOBAL_KEY] instanceof SharedArrayBuffer)) {
    const inherited = (workerData as Record<string, unknown> | null)?.[DATA_KEY];
    if (!isMainThread && !(inherited instanceof SharedArrayBuffer)) throw new Error("Media worker did not inherit file admission");
    state[GLOBAL_KEY] = inherited ?? new SharedArrayBuffer((LANES + 1) * 4);
  }
  return new Int32Array(state[GLOBAL_KEY] as SharedArrayBuffer);
}

function allocateOwner(): number { return Atomics.add(view(), 0, 1) + 1; }
function currentOwner(): number {
  if (!owner) owner = Number((workerData as Record<string, unknown> | null)?.[MEDIA_FILE_LOCK_OWNER_KEY]) || allocateOwner();
  return owner;
}
export function mediaFileLockWorkerData(): Record<string, SharedArrayBuffer | number> {
  return { [DATA_KEY]: view().buffer as SharedArrayBuffer, [MEDIA_FILE_LOCK_OWNER_KEY]: allocateOwner() };
}

function lane(file: string): number {
  let hash = 2166136261;
  for (const char of normalizeResolvedPath(file)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) % LANES + 1;
}

/** Bounded shared stripes serialize read/copy/mutate/replace across workers.
 * Hash collisions conservatively serialize unrelated paths. No database lock
 * is held while waiting or performing filesystem work. */
export async function acquireMediaFileLocks(files: string[]): Promise<() => void> {
  const locks = view();
  const token = currentOwner();
  const held = context.getStore();
  const lanes = [...new Set(files.map(lane))].filter(index => !held?.has(index)).sort((a, b) => a - b);
  const acquired: number[] = [];
  const release = () => {
    for (const index of acquired.splice(0).reverse()) {
      if (Atomics.compareExchange(locks, index, token, 0) === token) Atomics.notify(locks, index);
    }
  };
  try {
    for (const index of lanes) {
      while (true) {
        const previous = Atomics.compareExchange(locks, index, 0, token);
        if (previous === 0) break;
        const wait = (Atomics as typeof Atomics & { waitAsync?: (view: Int32Array, index: number, value: number, timeout: number) => { value: string | Promise<string> } }).waitAsync;
        if (wait) await wait(locks, index, previous, 100).value;
        else await new Promise(resolve => setTimeout(resolve, 10));
      }
      acquired.push(index);
    }
    return release;
  } catch (error) { release(); throw error; }
}

export async function withMediaFileLock<T>(file: string, run: () => Promise<T>): Promise<T> {
  const release = await acquireMediaFileLocks([file]);
  const held = new Set(context.getStore());
  held.add(lane(file));
  try { return await context.run(held, run); } finally { release(); }
}

/** Call only after the physical worker has exited, never on a logical timeout. */
export function releaseExitedMediaFileOwner(token: number): void {
  if (token <= 0) return;
  const locks = view();
  for (let index = 1; index <= LANES; index++) {
    if (Atomics.compareExchange(locks, index, token, 0) === token) Atomics.notify(locks, index);
  }
}
