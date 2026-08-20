import { describe, it, expect, beforeEach } from "vitest";
import {
  CHUNK_RELOAD_STORAGE_KEY,
  clearChunkReloadGuard,
  isChunkLoadError,
  shouldAttemptChunkReload,
} from "./chunkReload";

describe("chunkReload", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("detects dynamic import failures", () => {
    expect(isChunkLoadError(new Error(
      "Failed to fetch dynamically imported module: http://localhost:3737/assets/Library.js",
    ))).toBe(true);
    expect(isChunkLoadError(new Error("boom"))).toBe(false);
  });

  it("allows one recovery reload per tab, then blocks loops", () => {
    expect(shouldAttemptChunkReload()).toBe(true);
    expect(sessionStorage.getItem(CHUNK_RELOAD_STORAGE_KEY)).toBe("1");
    expect(shouldAttemptChunkReload()).toBe(false);
    clearChunkReloadGuard();
    expect(shouldAttemptChunkReload()).toBe(true);
  });
});
