import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import { clearChunkReloadGuard } from "./chunkReload";

export function lazyWithRetry<T extends ComponentType<any>>(
  importer: () => Promise<{ default: T }>,
  retries = 2,
): LazyExoticComponent<T> {
  return lazy(async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const loaded = await importer();
        clearChunkReloadGuard();
        return loaded;
      } catch (error) {
        lastError = error;
        if (attempt === retries) {
          break;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 200 * (attempt + 1));
        });
      }
    }
    throw lastError;
  });
}
