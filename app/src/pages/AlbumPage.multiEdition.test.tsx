/**
 * The Album page must be able to draw itself from `/page` alone.
 *
 * An Album monitored as two Editions whose recordings do not nest needs one
 * track list per Edition, and `/page` already resolves that navigation from
 * canonical acquisition units. `/library-availability` is enrichment: it adds
 * offers, plans and quality to a page that must already be usable without it.
 *
 * These tests pin that boundary, because deriving the tab strip from
 * availability makes a monitored Edition unreachable whenever availability is
 * slow or fails — the page then silently shows one Edition and claims that is
 * all the Library holds.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  QueueStatusContext,
  type QueueStatusContextType,
} from "@/providers/queueStatusContext";
import {
  UltraBlurContext,
  type UltraBlurContextValue,
} from "@/providers/UltraBlurContext";
import {
  ThemeProviderContext,
  type ThemeProviderState,
} from "@/providers/themeContext";
import { getThemeDefaultColors } from "@/ultrablur/colors";
import type { AlbumPageContract, TrackListTabContract } from "@contracts/pages";

const ALBUM_MBID = "9a9d41e9-2080-3293-8676-9e26f44a05b1";
const STANDARD_EDITION_ID = 16909;
const DELUXE_EDITION_ID = 16914;

const getAlbumPage = vi.fn();
const getAlbumLibraryAvailability = vi.fn();
const getAlbumEditionTracks = vi.fn();

vi.mock("@/services/api", () => ({
  api: {
    getAlbumPage: (...args: unknown[]) => getAlbumPage(...args),
    getAlbumLibraryAvailability: (...args: unknown[]) => getAlbumLibraryAvailability(...args),
    getAlbumEditionTracks: (...args: unknown[]) => getAlbumEditionTracks(...args),
    getArtistActivity: () => Promise.resolve(null),
    createGlobalEventStream: () => ({ close() {} }),
  },
}));

const { default: AlbumPage } = await import("@/pages/AlbumPage");

function trackFixture(mbid: string, title: string, position: number) {
  return {
    id: mbid,
    preview_provider: null,
    preview_provider_track_id: null,
    title,
    version: null,
    duration: 214,
    track_number: position,
    volume_number: 1,
    quality: "",
    qualityTags: [],
    artist_name: "Amy Winehouse",
    artist_credits: [{ id: "artist-1", name: "Amy Winehouse", join_phrase: "" }],
    album_title: "Frank",
    musicbrainz_track_id: mbid,
    musicbrainz_recording_id: `rec-${mbid}`,
    musicbrainz_release_id: null,
    downloaded: false,
    is_downloaded: false,
    is_monitored: true,
    monitored_lock: false,
    explicit: false,
    album_id: ALBUM_MBID,
    files: [],
    remoteOffers: [],
  };
}

const STANDARD_TRACKS = [
  trackFixture("trk-std-1", "Stronger Than Me", 1),
  trackFixture("trk-std-2", "You Sent Me Flying", 2),
];

const DELUXE_TRACKS = [
  trackFixture("trk-dlx-1", "Stronger Than Me", 1),
  trackFixture("trk-dlx-2", "Take the Box (live)", 2),
  trackFixture("trk-dlx-3", "Fuck Me Pumps (Mr Bongo remix)", 3),
];

/**
 * Realistic MusicBrainz shapes: `country` arrives as JSON, media formats are
 * already parsed by the API, and exactly one tab carries the default flag.
 */
const PAGE_TABS: TrackListTabContract[] = [
  {
    editionId: DELUXE_EDITION_ID,
    releaseMbid: "rel-deluxe",
    title: "Frank",
    disambiguation: "deluxe edition",
    country: '["GB"]',
    mediaFormats: ["Digital Media"],
    trackCount: 3,
    default: false,
  },
  {
    editionId: STANDARD_EDITION_ID,
    releaseMbid: "rel-standard",
    title: "Frank",
    disambiguation: null,
    country: '["GB"]',
    mediaFormats: ["CD"],
    trackCount: 2,
    default: true,
  },
];

function albumPageFixture(): AlbumPageContract {
  return {
    album: {
      id: ALBUM_MBID,
      title: "Frank",
      cover_id: null,
      cover: null,
      cover_art_url: null,
      provider_cover_id: null,
      vibrant_color: null,
      release_date: "2003-10-20",
      type: "ALBUM",
      album_type: "ALBUM",
      quality: "",
      source: "musicbrainz",
      is_monitored: true,
      is_downloaded: false,
      downloaded: 0,
      artist_id: "artist-1",
      artist_name: "Amy Winehouse",
      album_artists: [{ id: "artist-1", name: "Amy Winehouse", join_phrase: "" }],
      include_in_monitoring: 1,
      monitored_lock: false,
      module: "ALBUM",
      group_type: "ALBUM",
    } as AlbumPageContract["album"],
    tracks: STANDARD_TRACKS as unknown as AlbumPageContract["tracks"],
    otherVersions: [],
    associatedVideos: [],
    artistPicture: null,
    artistCoverImageUrl: null,
    trackListTabs: PAGE_TABS,
    initialTrackListEditionId: STANDARD_EDITION_ID,
  };
}

/** Enrichment only: no tab information at all. */
function availabilityFixture() {
  return {
    releaseGroupId: 1,
    releaseGroupMbid: ALBUM_MBID,
    libraries: [
      {
        id: 1,
        name: "Stereo",
        qualityProfile: "Lossless",
        allowedSourceFormats: ["lossless"],
        selections: [],
      },
    ],
    releases: [],
  };
}

/**
 * The queue context is ambient page furniture (download buttons); it has no
 * bearing on track-list navigation, so an inert value keeps the page real
 * without dragging the SSE-backed provider into the test.
 */
const INERT_QUEUE_STATUS = {
  loading: false,
  stats: { pending: 0, downloading: 0, completed: 0, failed: 0, total: 0 },
  isPaused: true,
  progressByJobId: new Map(),
  progressByProviderId: new Map(),
  getProgress: () => undefined,
  getProgressByProviderId: () => undefined,
  addToQueue: async () => undefined,
  processItem: async () => undefined,
  retryItem: async () => undefined,
  deleteItem: async () => undefined,
  reorderItems: async () => true,
  clearCompleted: async () => undefined,
  pauseQueue: async () => undefined,
  resumeQueue: async () => undefined,
  refreshQueueStatus: async () => undefined,
} satisfies QueueStatusContextType;

/** Ambience only — the hero background has no bearing on navigation. */
const INERT_ULTRA_BLUR = {
  colors: getThemeDefaultColors(false),
  artworkUrl: undefined,
  setArtwork: () => undefined,
  setArtworkFromImage: () => undefined,
  isLoading: false,
  isDarkMode: false,
} satisfies UltraBlurContextValue;

const INERT_THEME = {
  theme: "light",
  setTheme: () => undefined,
  isDarkMode: false,
  brandKeyColor: null,
  setBrandKeyColor: () => undefined,
} satisfies ThemeProviderState;

function renderAlbumPage(): { root: Root; container: HTMLDivElement } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <FluentProvider theme={webLightTheme}>
          <ThemeProviderContext.Provider value={INERT_THEME}>
          <UltraBlurContext.Provider value={INERT_ULTRA_BLUR}>
            <QueueStatusContext.Provider value={INERT_QUEUE_STATUS}>
              <MemoryRouter initialEntries={[`/album/${ALBUM_MBID}`]}>
                <Routes>
                  <Route path="/album/:albumId" element={<AlbumPage />} />
                </Routes>
              </MemoryRouter>
            </QueueStatusContext.Provider>
          </UltraBlurContext.Provider>
          </ThemeProviderContext.Provider>
        </FluentProvider>
      </QueryClientProvider>,
    );
  });

  return { root, container };
}

/** Drive React until `condition` holds, so tests never depend on flush counts. */
async function waitFor(condition: () => boolean, description: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    if (condition()) return;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
  }
}

/** Let every already-scheduled React Query update land. */
async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

function tabLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[role="tab"]')].map(
    (tab) => tab.textContent?.trim() ?? "",
  );
}

function selectedTabLabel(container: HTMLElement): string | null {
  const selected = container.querySelector('[role="tab"][aria-selected="true"]');
  return selected?.textContent?.trim() ?? null;
}

function trackTitles(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[data-album-track-id]")].map(
    (row) => row.getAttribute("data-album-track-id") ?? "",
  );
}

describe("AlbumPage multi-edition navigation", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    getAlbumPage.mockReset().mockResolvedValue(albumPageFixture());
    getAlbumLibraryAvailability.mockReset().mockResolvedValue(availabilityFixture());
    getAlbumEditionTracks.mockReset().mockResolvedValue(DELUXE_TRACKS);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    root = null;
    container = null;
    vi.restoreAllMocks();
  });

  it("draws both track-list tabs from /page while availability is still pending", async () => {
    // Availability never settles for the duration of this test.
    getAlbumLibraryAvailability.mockImplementation(() => new Promise(() => {}));

    ({ root, container } = renderAlbumPage());
    await waitFor(() => tabLabels(container!).length > 0, "the tab strip to render");

    expect(tabLabels(container!)).toHaveLength(2);
    expect(trackTitles(container!)).toEqual(["trk-std-1", "trk-std-2"]);
  });

  it("keeps the page and its tabs when availability rejects", async () => {
    getAlbumLibraryAvailability.mockRejectedValue(new Error("availability unavailable"));

    ({ root, container } = renderAlbumPage());
    await waitFor(() => tabLabels(container!).length > 0, "the tab strip to render");

    expect(container!.textContent).toContain("Frank");
    expect(tabLabels(container!)).toHaveLength(2);
    expect(trackTitles(container!)).toEqual(["trk-std-1", "trk-std-2"]);
  });

  it("marks exactly one default tab and it is initialTrackListEditionId", async () => {
    ({ root, container } = renderAlbumPage());
    await waitFor(() => tabLabels(container!).length > 0, "the tab strip to render");
    await settle();

    const selected = selectedTabLabel(container!);
    expect(
      container!.querySelectorAll('[role="tab"][aria-selected="true"]'),
    ).toHaveLength(1);
    // The standard edition is the default; its label carries its 2-track count.
    expect(selected).toContain("2 tracks");
    expect(getAlbumEditionTracks).not.toHaveBeenCalled();
  });

  it("fetches only the selected edition on switch and reuses initial tracks on return", async () => {
    ({ root, container } = renderAlbumPage());
    await waitFor(() => tabLabels(container!).length > 0, "the tab strip to render");

    const deluxeTab = [...container!.querySelectorAll('[role="tab"]')].find((tab) =>
      tab.textContent?.includes("3 tracks"),
    ) as HTMLElement;
    expect(deluxeTab).toBeTruthy();

    await act(async () => {
      deluxeTab.click();
    });
    await waitFor(
      () => trackTitles(container!).length === DELUXE_TRACKS.length,
      "the deluxe track list to render",
    );

    expect(getAlbumEditionTracks).toHaveBeenCalledTimes(1);
    expect(getAlbumEditionTracks).toHaveBeenCalledWith(
      ALBUM_MBID,
      DELUXE_EDITION_ID,
      expect.anything(),
    );
    expect(trackTitles(container!)).toEqual(["trk-dlx-1", "trk-dlx-2", "trk-dlx-3"]);

    const standardTab = [...container!.querySelectorAll('[role="tab"]')].find((tab) =>
      tab.textContent?.includes("2 tracks"),
    ) as HTMLElement;
    await act(async () => {
      standardTab.click();
    });
    await waitFor(
      () => trackTitles(container!).length === STANDARD_TRACKS.length,
      "the initial track list to render again",
    );
    await settle();

    // Returning to the initial edition uses the tracks /page already delivered.
    expect(getAlbumEditionTracks).toHaveBeenCalledTimes(1);
    expect(trackTitles(container!)).toEqual(["trk-std-1", "trk-std-2"]);
  });

  it("does not lose the selected tab when availability arrives late", async () => {
    let resolveAvailability: ((value: unknown) => void) | null = null;
    getAlbumLibraryAvailability.mockImplementation(
      () => new Promise((resolve) => {
        resolveAvailability = resolve;
      }),
    );

    ({ root, container } = renderAlbumPage());
    await waitFor(() => tabLabels(container!).length > 0, "the tab strip to render");

    const deluxeTab = [...container!.querySelectorAll('[role="tab"]')].find((tab) =>
      tab.textContent?.includes("3 tracks"),
    ) as HTMLElement;
    await act(async () => {
      deluxeTab.click();
    });
    await waitFor(
      () => (selectedTabLabel(container!) ?? "").includes("3 tracks"),
      "the deluxe tab to become selected",
    );

    await act(async () => {
      resolveAvailability?.(availabilityFixture());
    });
    await settle();

    expect(selectedTabLabel(container!)).toContain("3 tracks");
  });
});
