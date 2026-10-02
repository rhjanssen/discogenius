import { workerData } from "node:worker_threads";

const DATA_KEY = "providerRequestCooldowns";
const GLOBAL_KEY = "__discogeniusProviderRequestCooldowns";
const LANES = 128;

/** Cooldowns are shared by HTTP, command and download workers. Colliding
 * provider hashes conservatively share a cooldown rather than bypassing it. */
export class ProviderRequestState {
  readonly buffer: SharedArrayBuffer;
  private readonly deadlines: BigInt64Array;

  constructor(buffer = new SharedArrayBuffer(LANES * 8)) {
    this.buffer = buffer;
    this.deadlines = new BigInt64Array(buffer);
  }

  private lane(provider: string): number {
    let hash = 2166136261;
    for (const char of provider) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return (hash >>> 0) % LANES;
  }

  retryAt(provider: string): number {
    return Number(Atomics.load(this.deadlines, this.lane(provider)));
  }

  defer(provider: string, retryAt: number): number {
    const index = this.lane(provider);
    const next = BigInt(Math.ceil(retryAt));
    let current = Atomics.load(this.deadlines, index);
    while (current < next) {
      const previous = Atomics.compareExchange(this.deadlines, index, current, next);
      if (previous === current) return Number(next);
      current = previous;
    }
    return Number(current);
  }
}

export function providerRequestState(): ProviderRequestState {
  const global = globalThis as Record<string, unknown>;
  if (!(global[GLOBAL_KEY] instanceof ProviderRequestState)) {
    const inherited = (workerData as Record<string, unknown> | null)?.[DATA_KEY];
    global[GLOBAL_KEY] = new ProviderRequestState(inherited instanceof SharedArrayBuffer ? inherited : undefined);
  }
  return global[GLOBAL_KEY] as ProviderRequestState;
}

export function providerRequestWorkerData(): Record<string, SharedArrayBuffer> {
  return { [DATA_KEY]: providerRequestState().buffer };
}

export class ProviderRateLimitError extends Error {
  readonly status = 429;
  constructor(readonly provider: string, readonly retryAt: number) {
    super(`${provider} request limit reached; retry after ${new Date(retryAt).toISOString()}`);
    this.name = "ProviderRateLimitError";
  }
}
