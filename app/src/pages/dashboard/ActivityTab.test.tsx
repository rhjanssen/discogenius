import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ActivityTab from "@/pages/dashboard/ActivityTab";

const mockRetryItem = vi.fn();
let mockActivityItems: any[] = [];
let mockHasMoreInFlight = false;

vi.mock("@/hooks/useQueueStatus", () => ({
  useQueueStatus: () => ({
    retryItem: mockRetryItem,
  }),
}));

vi.mock("@/hooks/useActivityFeed", () => ({
  useActivityFeed: () => ({
    activityItems: mockActivityItems,
    hasMoreActivity: false,
    isLoadingMoreActivity: false,
    loadMoreActivity: vi.fn(),
    isInitialLoading: false,
    hasRefreshError: false,
    refreshErrorMessage: null,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/hooks/useActivityInFlightFeed", () => ({
  useActivityInFlightFeed: () => ({
    inFlightActivityItems: [],
    hasMoreInFlightActivity: mockHasMoreInFlight,
    isLoadingMoreInFlightActivity: false,
    loadMoreInFlightActivity: vi.fn(),
    isInitialLoading: false,
    hasRefreshError: false,
    refreshErrorMessage: null,
    refresh: vi.fn(),
  }),
}));

describe("ActivityTab retry eligibility", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mockRetryItem.mockReset();
    mockActivityItems = [];
    mockHasMoreInFlight = false;
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

  it("shows Retry for failed DownloadAlbum even when >100 in-flight commands exist, and hides Retry for DownloadMissing", () => {
    mockHasMoreInFlight = true;
    mockActivityItems = [
      {
        id: 101,
        type: "DownloadAlbum",
        status: "failed",
        error: "Provider timed out",
        description: "Bad Blood by Bastille",
        startTime: Date.now() - 10_000,
        endTime: Date.now() - 5_000,
        payload: { providerId: "alb-1", type: "album" },
      },
      {
        id: 102,
        type: "DownloadMissing",
        status: "failed",
        error: "Batch interrupted",
        description: "Download Missing",
        startTime: Date.now() - 8_000,
        endTime: Date.now() - 4_000,
        payload: {},
      },
    ];

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <FluentProvider theme={webLightTheme}>
          <MemoryRouter>
            <ActivityTab activityFilter="all" isActive />
          </MemoryRouter>
        </FluentProvider>,
      );
    });

    const retryButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[aria-label="Retry job"]'),
    );
    expect(retryButtons).toHaveLength(1);
    act(() => {
      retryButtons[0]!.click();
    });
    expect(mockRetryItem).toHaveBeenCalledWith(101, "history");
  });
});
