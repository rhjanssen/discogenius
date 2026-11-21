import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueueItemContract } from "@contracts/status";
import { ThemeProviderContext, type ThemeProviderState } from "@/providers/themeContext";
import { QueueHistoryPanel } from "./QueueHistoryPanel";
import { defaultQueueHistoryFilters } from "./queueHistoryFilters";

const LIGHT_THEME = {
  theme: "light",
  setTheme: () => undefined,
  isDarkMode: false,
  brandKeyColor: null,
  setBrandKeyColor: () => undefined,
} satisfies ThemeProviderState;

const RAW_ERROR = "[ImportDownload] Canonical audio tags were not applied for album 433171891: 1 file(s) missing";

const failed: QueueItemContract = {
  id: 42288,
  url: null,
  type: "album",
  provider: "apple-music",
  providerId: "433171891",
  path: null,
  status: "failed",
  progress: 0,
  error: RAW_ERROR,
  failure: {
    category: "import",
    summary: "Import incomplete: 1 file(s) went missing before tagging",
    hint: "Rescan this artist's folder, then retry.",
    action: null,
    detail: RAW_ERROR,
  },
  created_at: "2026-11-21T18:00:00Z",
  updated_at: "2026-11-21T18:08:00Z",
  completed_at: "2026-11-21T18:08:00Z",
  title: "Liverpool Rain",
  artist: "Racoon",
};

function renderPanel(onRetryItem = vi.fn()) {
  render(
    <FluentProvider theme={webLightTheme}>
      <ThemeProviderContext.Provider value={LIGHT_THEME}>
        <MemoryRouter>
          <QueueHistoryPanel
            items={[failed]}
            hasMore={false}
            isLoadingMore={false}
            onLoadMore={() => undefined}
            hasRefreshError={false}
            onRetryFeeds={() => undefined}
            onRetryItem={onRetryItem}
            filters={defaultQueueHistoryFilters}
            onFiltersChange={() => undefined}
          />
        </MemoryRouter>
      </ThemeProviderContext.Provider>
    </FluentProvider>,
  );
  return onRetryItem;
}

afterEach(cleanup);

describe("QueueHistoryPanel", () => {
  it("retries a failed history row by its command id", () => {
    const onRetryItem = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Retry Liverpool Rain" }));
    expect(onRetryItem).toHaveBeenCalledWith(42288, "history");
  });

  it("shows the cause and next step, with the raw error behind Details", async () => {
    renderPanel();

    expect(screen.getByText("Import incomplete: 1 file(s) went missing before tagging")).toBeTruthy();
    expect(screen.getByText("Rescan this artist's folder, then retry.")).toBeTruthy();
    expect(screen.queryByText(RAW_ERROR)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(await screen.findByText(RAW_ERROR)).toBeTruthy();
  });
});
