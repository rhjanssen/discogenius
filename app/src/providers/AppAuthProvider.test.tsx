import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { AppAuthProvider } from "@/providers/AppAuthProvider";
import { LOCALSTORAGE_APP_AUTH_TOKEN_KEY } from "@/providers/appAuthContext";

describe("AppAuthProvider token hydration", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    api.setAuthToken(null);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    root = null;
    container = null;
    localStorage.clear();
    api.setAuthToken(null);
    vi.restoreAllMocks();
  });

  it("sets api auth token synchronously before child effects open SSE streams", async () => {
    const originalEventSource = globalThis.EventSource;
    const openedUrls: string[] = [];
    class SpyEventSource {
      url: string;
      readyState = 1;
      addEventListener() {}
      close() {}
      constructor(url: string) {
        this.url = url;
        openedUrls.push(url);
      }
    }
    (globalThis as unknown as { EventSource: typeof SpyEventSource }).EventSource = SpyEventSource;

    try {
      localStorage.setItem(LOCALSTORAGE_APP_AUTH_TOKEN_KEY, "persisted-admin-token");
      vi.spyOn(api, "isAppAuthActive").mockResolvedValue({ isAuthActive: true, authType: "password" });
      vi.spyOn(api, "verifyAppAuth").mockResolvedValue({ authenticated: true });

      function ChildStreamConsumer() {
        useEffect(() => {
          const es = api.createDownloadProgressStream(() => undefined);
          return () => es.close();
        }, []);
        return null;
      }

      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);

      await act(async () => {
        root!.render(
          <AppAuthProvider>
            <ChildStreamConsumer />
          </AppAuthProvider>,
        );
      });

      expect(openedUrls[0]).toContain("token=persisted-admin-token");
    } finally {
      (globalThis as unknown as { EventSource: typeof EventSource }).EventSource = originalEventSource;
    }
  });
});
