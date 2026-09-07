/** Keep physical liveness separate from a lease renewal waiting for SQLite. */
export function startExecutionHeartbeat(options: {
  intervalMs: number;
  renew: () => Promise<unknown>;
  onHeartbeat?: () => void;
  onError: (error: unknown) => void;
}): () => Promise<void> {
  let stopped = false;
  let pending: Promise<unknown> | null = null;
  const beat = () => {
    if (stopped) return;
    options.onHeartbeat?.();
    if (pending) return;
    pending = Promise.resolve().then(() => stopped ? undefined : options.renew())
      .catch(options.onError)
      .finally(() => { pending = null; });
  };
  const timer = setInterval(beat, Math.max(1, options.intervalMs));
  timer.unref();
  beat();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await pending;
  };
}
