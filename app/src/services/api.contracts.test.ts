import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readyState = FakeEventSource.OPEN;
  url: string;
  onopen: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  closed = false;

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type: string, payload: unknown) {
    const event = { data: JSON.stringify(payload) } as MessageEvent;
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
}

describe("ApiClient contracts and SSE error handling", () => {
  const originalEventSource = globalThis.EventSource;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    (globalThis as unknown as { EventSource: typeof FakeEventSource }).EventSource = FakeEventSource;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    (globalThis as unknown as { EventSource: typeof EventSource }).EventSource = originalEventSource;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("forwards explicit deletion scope on album, artist, track, and video delete endpoints", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ success: true, deleted: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await api.deleteAlbumFiles("alb-1", { unmonitor: true, allLibraries: true });
    await api.deleteArtistFiles("art-1", { unmonitor: false, libraryId: 2 });
    await api.deleteTrackFiles("trk-1", { allLibraries: true });
    await api.deleteVideoFiles("vid-1", { libraryId: 3 });

    expect(calls[0]?.url).toContain("/v1/album/alb-1/files?");
    expect(calls[0]?.url).toContain("unmonitor=true");
    expect(calls[0]?.url).toContain("allLibraries=true");

    expect(calls[1]?.url).toContain("/v1/artist/art-1/files");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ unmonitor: false, libraryId: 2 });

    expect(calls[2]?.url).toContain("/v1/track/trk-1/files?allLibraries=true");
    expect(calls[3]?.url).toContain("/v1/video/vid-1/files?libraryId=3");
  });

  it("forwards editionId and releaseMbid in getLibraryRenameStatus", async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ renameNeeded: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await api.getLibraryRenameStatus({ albumId: "alb-1", editionId: 42, releaseMbid: "rel-mbid" });
    expect(urls[0]).toContain("editionId=42");
    expect(urls[0]).toContain("releaseMbid=rel-mbid");
  });

  it("subscribes global SSE stream to provider.auth.changed and artist.curated", () => {
    const received: Array<{ event: string; data: unknown }> = [];
    const es = api.createGlobalEventStream((event, data) => {
      received.push({ event, data });
    }) as unknown as FakeEventSource;

    es.emit("provider.auth.changed", { provider: "tidal", status: "needs_reauth" });
    es.emit("artist.curated", { artistId: "art-1" });

    expect(received).toEqual([
      { event: "provider.auth.changed", data: { provider: "tidal", status: "needs_reauth" } },
      { event: "artist.curated", data: { artistId: "art-1" } },
    ]);
    es.close();
  });

  it("invokes onError when download progress SSE closes unexpectedly on the server", () => {
    const onError = vi.fn();
    const es = api.createDownloadProgressStream(vi.fn(), onError) as unknown as FakeEventSource;

    // Simulate HTTP 401/503 server close: EventSource transitions to CLOSED without client calling close().
    es.readyState = FakeEventSource.CLOSED;
    es.onerror?.(new Event("error"));

    expect(onError).toHaveBeenCalledTimes(1);

    // An intentional client close must NOT trigger onError again.
    onError.mockClear();
    es.close();
    es.onerror?.(new Event("error"));
    expect(onError).not.toHaveBeenCalled();
  });
});
