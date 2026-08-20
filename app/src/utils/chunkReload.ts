export const CHUNK_RELOAD_STORAGE_KEY = "discogenius:chunk-reload";

export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    message.includes("Failed to fetch dynamically imported module")
    || message.includes("Loading chunk")
    || message.includes("ChunkLoadError")
  );
}

export function clearChunkReloadGuard(): void {
  try {
    sessionStorage.removeItem(CHUNK_RELOAD_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** Returns true if this tab should perform the one-shot recovery reload. */
export function shouldAttemptChunkReload(): boolean {
  try {
    if (sessionStorage.getItem(CHUNK_RELOAD_STORAGE_KEY)) {
      return false;
    }
    sessionStorage.setItem(CHUNK_RELOAD_STORAGE_KEY, "1");
    return true;
  } catch {
    return true;
  }
}

export function reloadForFailedChunk(): void {
  try {
    sessionStorage.setItem(CHUNK_RELOAD_STORAGE_KEY, "1");
  } catch {
    // ignore
  }
  window.location.reload();
}
